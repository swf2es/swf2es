// An AVM1 block as JavaScript: an array of its regions' functions, the
// block's own code first, then its functions' bodies, each written once in
// the dispatcher form (docs/avm1.md, "The dispatcher"; assembly/avm1/emit/block.ts).
// Its actions are actions.zig's, where control goes control.zig's, and its
// operand stack stack.zig's.
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../../output.zig");
const Output = output.Output;
const Error = output.Error;
const decode = @import("../actions/decode.zig");
const Action = decode.Action;
const Actions = decode.Actions;
const pool_ = @import("../flow/pool.zig");
const Pool = pool_.Pool;
const regions_ = @import("../flow/regions.zig");
const Flow = regions_.Flow;
const Region = regions_.Region;
const writeString = @import("strings.zig").writeString;
const UnitKey = @import("units.zig").UnitKey;
const actions = @import("actions.zig");
const control = @import("control.zig");
const stack = @import("stack.zig");

/// Blocks `from` to `to`, excluded, of a region.
pub const Range = struct {
    from: u32,
    to: u32,

    /// Whether block `k` is in the range.
    pub fn has(self: Range, k: u32) bool {
        return self.from <= k and k < self.to;
    }

    /// Whether block `k` is in the range, or the first past it, which a
    /// scope holds over too as it starts.
    pub fn holds(self: Range, k: u32) bool {
        return self.from <= k and k <= self.to;
    }
};

/// The push the last action wrote, whose last value the next action may
/// take as it is: where its statement and that value start, where it ends,
/// and whether values come before it.
pub const Pending = struct {
    statement: u32,
    value: u32,
    end: u32,
    more: bool,
};

pub const BlockEmitter = struct {
    gpa: Allocator,
    out: *Output,
    actions: Actions,
    /// Over `actions`: the emitter is made once and stays where it is.
    flow: Flow,
    /// The SWF's version, which decides how its strings read (strings.zig).
    version: i32 = 0,
    /// The registers of the region being written, its own `let`s `r0` up to
    /// this: a DefineFunction2's count, 0 for any other region, whose
    /// registers are the four global ones.
    registers: u8 = 0,
    /// The block being written.
    k: u32 = 0,
    /// Whether the region has a With or a Try: without, it is written as before.
    holds: bool = false,
    /// The ranges a Try's handlers, or a finally's throw or Return, hold
    /// over: control leaving one goes through V.leave.
    handled: std.ArrayList(Range) = .empty,
    /// The ranges scopes hold over, With and catch bodies, and the first
    /// action past each: control going anywhere else goes through V.leave,
    /// and the block past one is `late`, V.scopes after its first action.
    scoped: std.ArrayList(Range) = .empty,
    late: std.ArrayList(bool) = .empty,
    /// The finally bodies, which a throw or a Return may leave held to the exit.
    finallies: std.ArrayList(Range) = .empty,
    /// The try and catch bodies of Trys with a finally, which a Return runs first.
    returns: std.ArrayList(Range) = .empty,
    /// Whether the region has a Try, whose throws its dispatcher catches.
    tries: bool = false,
    /// The registers the region's catches take values into.
    catch_registers: std.ArrayList(u8) = .empty,
    pending: ?Pending = null,
    scratch: std.ArrayList(u8) = .empty,
    /// The value `detach` took, if it took one.
    detached: ?[]const u8 = null,
    /// Whether the region being written is a unit's own, which returns where control goes.
    in_unit: bool = false,
    /// Whether the unit being written runs as a SWF 5's function, `V5`.
    unit_five: bool = false,
    /// Whether the region being written runs as a SWF 5's function.
    five: bool = false,
    /// The units the code written so far goes on in through V.far.
    units: std.ArrayList(UnitKey) = .empty,
    /// The offsets in the SWF a unit's own code returns, where control goes on.
    exits: std.ArrayList(i32) = .empty,
    /// What the last unit written depends on: the same unit runs for a region
    /// that ends at or past `unit_high`, its actions' bytes ending at or past
    /// `unit_reach` (V.far); -1 for neither, only its own.
    unit_high: i64 = 0,
    unit_reach: i64 = 0,
    pools: std.ArrayList(Pool) = .empty,
    pool_work: std.ArrayList(u32) = .empty,

    pub fn destroy(self: *BlockEmitter) void {
        const gpa = self.gpa;
        self.flow.deinit();
        self.actions.deinit();
        inline for (.{
            &self.handled,         &self.scoped,  &self.late,  &self.finallies, &self.returns,
            &self.catch_registers, &self.scratch, &self.units, &self.exits,     &self.pools,
            &self.pool_work,
        }) |list| {
            list.deinit(gpa);
        }
        gpa.destroy(self);
    }

    pub fn create(gpa: Allocator, out: *Output) Allocator.Error!*BlockEmitter {
        const self = try gpa.create(BlockEmitter);
        self.* = .{ .gpa = gpa, .out = out, .actions = .{ .gpa = gpa }, .flow = undefined };
        self.flow = .{ .gpa = gpa, .actions = &self.actions };
        return self;
    }

    /// The block's entry, retaining the surrounding SWF for backward jumps.
    pub fn block(self: *BlockEmitter, swf: []const u8, offset: i32, len: i32) Error!void {
        const fits = offset >= 0 and len >= 0 and @as(i64, offset) + len <= swf.len;
        try self.actions.reset(if (fits) swf else &.{}, if (fits) offset else 0, if (fits) len else 0, null);
        const analyzed = self.flow.analyze(.block, 0, null, 0, null);
        self.unit_five = false;
        try self.regions(analyzed);
    }

    /// The unit of the code at `at` in the SWF, of a region that runs until
    /// control is at or past `end`, its actions read up to `bound`; `as_five`
    /// if it runs as a SWF 5's function. Written as a block is, its own code
    /// returning where control goes on: an offset in the SWF, -1 where the
    /// region ends, -2 where it returns `cx.ret`.
    ///
    /// Its home is the bytes from `at` up to `high` (units.zig): what it
    /// reaches there, a loop that stays there included, runs in one function,
    /// and a jump back before `at` goes on in another unit.
    pub fn unit(self: *BlockEmitter, swf: []const u8, at: i32, end: i32, bound: i32, as_five: bool, high: i32) Error!void {
        const home = high - at;
        try self.actions.reset(swf, at, bound - at, home);
        const analyzed = self.flow.analyze(.unit, 0, end - at, 0, home);
        self.unit_five = as_five;
        const calls = self.units.items.len;
        try self.regions(analyzed);
        // A region that keeps all it reaches, which may reach the region's end,
        // a call of V.far, which names the bound, or an action that the bytes'
        // end cut short, which more bytes might not, make the unit this
        // region's alone.
        const own = if (analyzed) |_| self.flow.widened else |_| true;
        if (own or self.units.items.len > calls or self.actions.reach > bound - at) {
            self.unit_high = -1;
            self.unit_reach = -1;
        } else {
            self.unit_high = high;
            self.unit_reach = at + self.actions.reach;
        }
    }

    /// The regions `analyzed`, or a block too large to compile.
    fn regions(self: *BlockEmitter, analyzed: regions_.Error!void) Error!void {
        const w = self.out.writer();
        try w.writeByte('[');
        analyzed catch |err| switch (err) {
            error.TooLarge => return w.writeAll("function (cx) {\nV.tooLarge();\n}]"),
            error.OutOfMemory => |e| return e,
        };

        for (self.flow.regions.items, 0..) |region, i| {
            if (i > 0) {
                try w.writeAll(", ");
            }

            try self.writeRegion(region);
        }

        try w.writeByte(']');
    }

    fn writeRegion(self: *BlockEmitter, region: *const Region) Error!void {
        const w = self.out.writer();
        self.registers = 0;
        self.in_unit = region.kind == .unit;
        self.five = if (region.kind == .function) self.version < 5 else self.in_unit and self.unit_five;
        if (region.kind != .function) {
            try w.writeAll("function (cx) {\nconst st = cx.st;\n");
            if (self.five) {
                try w.writeAll("const V = V5;\n");
            }
        } else {
            // A body is called with its `this` and its arguments; a SWF 4's runs as a SWF 5's.
            try w.writeAll("function (cx, self, args) {\nconst st = cx.st;\n");
            if (self.version < 5) {
                try w.writeAll("const V = V5;\n");
            }

            const opener = self.actions.get(region.opener.?);
            if (opener.op == .define_function2) {
                self.registers = opener.operands.function.registers;
                try self.preload(opener.operands.function);
            }
        }

        const n = region.blockCount();
        if (n == 0) {
            return w.writeAll("}");
        }

        try pool_.poolsOf(self.gpa, &self.actions, region, &self.pools, &self.pool_work);
        try control.heldRanges(self, region);
        const dispatch = n > 1 or control.jumpsWithin(&self.actions, region);
        if (dispatch) {
            try w.print("let b = {d};\n", .{region.blockAt(region.start)});
            try w.writeAll(if (self.tries) "for (;;) try { for (;;) switch (b) {\n" else "for (;;) switch (b) {\n");
            if (self.holds) {
                try w.writeAll(if (self.in_unit) "case -1:\nreturn -2;\n" else "case -1:\nreturn cx.ret;\n");
            }
        }

        for (0..n) |k| {
            if (dispatch) {
                try w.print("case {d}:\n", .{k});
            }

            self.k = @intCast(k);
            try self.code(region, self.pools.items[k]);
        }

        if (!dispatch) {
            try w.writeAll("}");
        } else if (self.tries) {
            try w.writeAll("} } catch (e) {\nb = V.caught(cx, e, b);\n");
            try control.catchInto(self);
            try w.writeAll("}\n}");
        } else {
            try w.writeAll("}\n}");
        }
    }

    /// Block `k` of the region, which starts with pool `pool`.
    fn code(self: *BlockEmitter, region: *const Region, entry: Pool) Error!void {
        const w = self.out.writer();
        const k = self.k;
        var pool = entry;
        self.pending = null;
        // A late block's first action runs in the scopes whose body it is past, which come off
        // after it, as control goes on in the block. A With there pushes its object over them, and
        // they come off with it (adl); a Try's handlers go over them once they are off.
        var late = self.holds and self.late.items[k];
        const indices = region.blockActions(k);
        for (indices) |index| {
            const action = self.actions.get(index);
            if (late and action.ok()) {
                if (action.op == .@"try") {
                    try control.scopes(self, k);
                    late = false;
                } else if (action.op == .with or !action.fallsThrough()) {
                    late = false;
                }
            }

            try actions.writeAction(self, region, action, pool);
            pool = pool_.poolAfter(&self.actions, index, pool);
            if (late) {
                try control.scopes(self, k);
                late = false;
            }
        }

        // Where control goes from the block's end; a Jump or a Return has gone already.
        const last = self.actions.get(indices[indices.len - 1]);
        if (!last.fallsThrough()) {
            if (!last.ok()) {
                try control.end(self);
            } else switch (last.op) {
                .end => {
                    try control.exit(self);
                    try w.writeByte('\n');
                },
                .jump, .@"return" => {},
                else => try control.end(self),
            }

            return;
        }

        // The next block in the switch is the next case.
        const to = last.fallsTo();
        if (!region.runs(to) or region.blockAt(to) != k + 1) {
            try control.goto(self, region, to);
            try w.writeByte('\n');
        } else if (control.leaves(self.handled.items, k, k + 1)) {
            try w.print("b = V.leave(cx, {d}); continue;\n", .{k + 1});
        } else if (self.tries) {
            // A throw takes the block it is thrown in from `b`.
            try w.print("b = {d};\n", .{k + 1});
        }
    }

    /// A DefineFunction2's registers, `let`s, and what it loads into them as
    /// it is called: its preloads in order from r1, each where its flag is
    /// set (one that is also suppressed undefined, but `arguments`), then its
    /// parameters that have one. A register past the count takes nothing.
    fn preload(self: *BlockEmitter, function: decode.Function) Error!void {
        const w = self.out.writer();
        const count = self.registers;
        if (count == 0) {
            return;
        }

        try w.writeAll("let ");
        for (0..count) |r| {
            if (r > 0) {
                try w.writeAll(", ");
            }

            try w.print("r{d}", .{r});
        }
        try w.writeAll(";\n");

        const flags = function.flags;
        var r: u8 = 1;
        if (flags.preload_this) {
            try self.load(r, if (flags.suppress_this) "undefined" else "self");
            r += 1;
        }

        if (flags.preload_arguments) {
            try self.load(r, "V.argumentsOf(cx, args)");
            r += 1;
        }

        if (flags.preload_super) {
            try self.load(r, if (flags.suppress_super) "undefined" else "V.superOf(cx, self)");
            r += 1;
        }

        if (flags.preload_root) {
            try self.load(r, "V.root(cx)");
            r += 1;
        }

        // A clip without a parent, the root, has no register for it: _global takes it.
        if (flags.preload_parent and r < count) {
            try w.print("{{ const p = V.parentOf(cx); if (p !== undefined) {{ r{d} = p;", .{r});
            if (flags.preload_global and r + 1 < count) {
                try w.print(" r{d} = cx.global;", .{r + 1});
            }
            try w.writeAll(" }");
            if (flags.preload_global) {
                try w.print(" else {{ r{d} = cx.global; }}", .{r});
            }
            try w.writeAll(" }\n");
        } else if (flags.preload_global and !flags.preload_parent) {
            try self.load(r, "cx.global");
        }

        for (self.actions.functionParams(function), 0..) |param, i| {
            if (param.register > 0 and param.register < count) {
                try w.print("r{d} = args[{d}];\n", .{ param.register, i });
            }
        }
    }

    /// `r<register> = <value>;`, where the region has the register.
    fn load(self: *BlockEmitter, r: u8, value: []const u8) Error!void {
        if (r >= self.registers) {
            return;
        }

        try self.out.writer().print("r{d} = {s};\n", .{ r, value });
    }

    /// Register `r` as an expression: the region's own, or one of the four
    /// global ones, the movie's; any other is none.
    pub fn register(self: *BlockEmitter, r: u8) Error!bool {
        if (r < self.registers) {
            try self.out.writer().print("r{d}", .{r});
            return true;
        }

        if (r < 4) {
            try self.out.writer().print("cx.g[{d}]", .{r});
            return true;
        }

        return false;
    }

    /// Try: its bodies as ranges of blocks, where a throw lands for the catch
    /// (-1 out of the region, -2 for none), and the catch's variable or register.
    pub fn @"try"(self: *BlockEmitter, region: *const Region, t: decode.Try) Error!void {
        const w = self.out.writer();
        const finally_from = region.firstFrom(t.finally_start);
        const finally_to = if (t.flags.finally_block) region.firstFrom(t.end) else finally_from;
        const catch_block: i64 = if (!t.flags.catch_block) -2 else if (region.runs(t.catch_start)) region.blockAt(t.catch_start) else -1;
        try w.print("V.try(cx, {d}, {d}, {d}, {d}, {d}, ", .{ region.firstFrom(t.start), region.firstFrom(t.catch_start), finally_from, finally_to, catch_block });
        switch (t.catch_into) {
            .register => |r| try w.print("{d}", .{r}),
            .variable => |name| try self.string(name),
            // Too short for its header: no catch.
            .none => try w.writeAll("\"\""),
        }
        try w.writeAll(");\n");
    }

    pub fn string(self: *BlockEmitter, s: []const u8) Error!void {
        try writeString(self.out.writer(), s, self.version >= 6);
    }
};

fn expectBlock(bytes: []const u8, version: i32, js: []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const gpa = arena.allocator();

    var out: Output = try .init(gpa);
    const emitter = try BlockEmitter.create(gpa, &out);
    emitter.version = version;
    try emitter.block(bytes, 0, @intCast(bytes.len));
    try std.testing.expectEqualStrings(js, out.written());
}

test "a push folds into the action that pops it" {
    // Push "hi"; Trace.
    try expectBlock(&.{ 0x96, 4, 0, 0, 'h', 'i', 0, 0x26 }, 6,
        \\[function (cx) {
        \\const st = cx.st;
        \\V.trace(cx, "hi");
        \\return;
        \\}]
    );
}

test "a loop goes through the dispatcher and counts down the budget" {
    // Play; Jump back to it.
    try expectBlock(&.{ 0x06, 0x99, 2, 0, 0xfa, 0xff }, 6,
        \\[function (cx) {
        \\const st = cx.st;
        \\let b = 0;
        \\for (;;) switch (b) {
        \\case 0:
        \\V.play(cx);
        \\if (--V.budget < 0) V.timeout(cx); b = 0; continue;
        \\}
        \\}]
    );
}

test "a known constant pool's strings are the pushes' literals" {
    // ConstantPool "a", "b"; Push constant 1, constant 5 (past the pool); Trace; Trace.
    try expectBlock(&.{ 0x88, 6, 0, 2, 0, 'a', 0, 'b', 0, 0x96, 4, 0, 8, 1, 8, 5, 0x26, 0x26 }, 6,
        \\[function (cx) {
        \\const st = cx.st;
        \\V.constantPool(cx, ["a", "b"]);
        \\st.push("b");
        \\V.trace(cx, undefined);
        \\V.trace(cx, st.pop());
        \\return;
        \\}]
    );
}

/// A block with something of every kind, for the tests that fail allocations.
pub const test_block = [_]u8{
    0x88, 6, 0, 2, 0, 'a', 0, 'b', 0, // ConstantPool "a", "b"
    0x96, 5, 0, 8, 0, 0, 'x', 0, // Push pool 0, "x"
    0x9b, 8, 0, 'f', 0, 1, 0, 'p', 0, 8, 0, // DefineFunction f(p)
    0x96, 3, 0, 0, 'p', 0, 0x1c, 0x3e, // its body: return p
    0x94, 2, 0, 2, 0, 0x06, 0x07, // With { Play; Stop }
    0x8f, 9, 0, 3, 1, 0, 1, 0, 1, 0, 'e', 0, 0x06, 0x07, 0x06, // Try, catch e, finally
    0x8a, 3, 0, 1, 0, 1, 0x07, // WaitForFrame 1, skipping a Stop
    0x96, 2, 0, 5, 1, 0x9d, 2, 0, 0xb5, 0xff, // Push true; If back to the start
    0x99, 2, 0, 0x00, 0x80, // Jump far back, before the block
};

/// A block, or the unit of all its bytes, written, all freed after.
fn emitAll(gpa: Allocator, block: []const u8, as_unit: bool) !void {
    var out: Output = try .init(gpa);
    defer out.deinit();
    const emitter = try BlockEmitter.create(gpa, &out);
    defer emitter.destroy();
    emitter.version = 6;
    const len: i32 = @intCast(block.len);
    const emitted = if (as_unit) emitter.unit(block, 0, len, len, false, len) else emitter.block(block, 0, len);
    emitted catch |err| switch (err) {
        // The writer fails only as its buffer cannot grow.
        error.WriteFailed => return error.OutOfMemory,
        error.OutOfMemory => |e| return e,
    };
}

test "every allocation writing a block or a unit makes may fail, and it gives it back" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, emitAll, .{ &test_block, false });
    try std.testing.checkAllAllocationFailures(std.testing.allocator, emitAll, .{ &test_block, true });
}
