// Decodes the actions of an AVM1 block, each where control reaches it
// (assembly/avm1/actions/decode.ts, which says where Flash's readings of
// malformed actions come from: Ruffle's, MIT OR Apache-2.0).
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const Offsets = @import("offsets.zig").Offsets;
const opcodes = @import("opcodes.zig");
const Op = opcodes.Op;
const FunctionFlags = opcodes.FunctionFlags;
const TryFlags = opcodes.TryFlags;

/// Why Flash cannot run an action: adl stops the whole SWF at it.
pub const DecodeError = error{
    /// Its opcode's length, its length, an operand or a nested body runs past the block's end.
    Truncated,
    /// A Push of a value type Flash does not know.
    UnknownPushType,
};

/// A value a Push pushes.
pub const Value = union(enum) {
    string: []const u8,
    /// A float, a double or an integer, all numbers to AVM1, told apart
    /// only by the test build's dumps.
    float: f64,
    double: f64,
    integer: i32,
    null,
    undefined,
    register: u8,
    boolean: bool,
    /// An index into the constant pool, of one byte or two.
    constant8: u8,
    constant16: u16,

    /// The number it pushes, if it pushes one.
    pub fn number(self: Value) ?f64 {
        return switch (self) {
            .float, .double => |n| n,
            .integer => |i| @floatFromInt(i),
            else => null,
        };
    }
};

/// A DefineFunction parameter, and DefineFunction2's register for it, 0 for none.
pub const Param = struct {
    name: []const u8,
    register: u8 = 0,
};

/// Items `first` to `first + count` of one of the block's lists.
pub const Span = struct {
    first: u32 = 0,
    count: u32 = 0,
};

/// A nested body: offsets from `start` to `end`, excluded.
pub const Body = struct {
    start: i32,
    end: i32,
};

pub const Wait = struct {
    frame: u16 = 0,
    /// How many actions a frame not loaded skips.
    skip: u8,
    /// Where the actions it skips end, once `Actions.skip` has set it.
    target: ?i32 = null,
};

pub const Function = struct {
    name: []const u8,
    params: Span,
    /// DefineFunction2's register count and flags.
    registers: u8 = 0,
    flags: FunctionFlags = .{},
    body: Body,
    /// The body's region (flow/regions.zig), made once as the action is first reached.
    region: ?u32 = null,
};

/// Where a Try's catch puts what is caught.
pub const Catch = union(enum) {
    /// A Try too short for its header has none.
    none,
    register: u8,
    variable: []const u8,
};

pub const Try = struct {
    flags: TryFlags = .{},
    catch_into: Catch = .none,
    /// The try body from `start`, the catch's from `catch_start`, the
    /// finally's from `finally_start`, all of them ending at `end`.
    start: i32,
    catch_start: i32,
    finally_start: i32,
    end: i32,
};

/// An action's operands, by its opcode.
pub const Operands = union(enum) {
    none,
    /// GotoFrame.
    frame: u16,
    /// GetUrl.
    url: struct { url: []const u8, target: []const u8 },
    /// StoreRegister.
    register: u8,
    /// ConstantPool: its strings.
    pool: Span,
    /// WaitForFrame and WaitForFrame2, whose frame is on the stack.
    wait: Wait,
    /// SetTarget and GotoLabel.
    name: []const u8,
    /// DefineFunction and DefineFunction2.
    function: Function,
    @"try": Try,
    with: Body,
    /// Push: its values.
    push: Span,
    /// Jump and If: where they go.
    branch: i32,
    /// GetUrl2: its flags, a method of 3 read as none.
    get_url2: u8,
    goto_frame2: struct { play: bool, bias: u16 },
};

/// One action at an offset of the block. A target may be before the block
/// or past its end.
pub const Action = struct {
    offset: i32,
    op: Op = .end,
    /// Why Flash cannot run it, if it cannot.
    err: ?DecodeError = null,
    /// Where the next action starts: past the operands and any nested body.
    next: i32 = 0,
    operands: Operands = .none,

    pub fn ok(self: *const Action) bool {
        return self.err == null;
    }

    /// Whether control goes on to `fallsTo`.
    pub fn fallsThrough(self: *const Action) bool {
        if (!self.ok()) {
            return false;
        }

        return switch (self.op) {
            .end, .@"return", .throw, .jump => false,
            else => true,
        };
    }

    /// Where control falls to: a With's or Try's body, or the next action.
    pub fn fallsTo(self: *const Action) i32 {
        return switch (self.operands) {
            .with => |body| body.start,
            .@"try" => |t| t.start,
            else => self.next,
        };
    }

    /// Where it may branch to, if it may: a Jump's or an If's target, or
    /// where a WaitForFrame's skip ends.
    pub fn target(self: *const Action) ?i32 {
        if (!self.ok()) {
            return null;
        }

        return switch (self.operands) {
            .branch => |to| to,
            .wait => |w| w.target,
            else => null,
        };
    }

    /// Where a With's or Try's bytes end: their bodies, or the action's next.
    pub fn heldEnd(self: *const Action) i32 {
        return switch (self.operands) {
            .with => |body| @max(body.end, self.next),
            .@"try" => |t| @max(@max(t.catch_start, t.finally_start), @max(t.end, self.next)),
            else => self.next,
        };
    }
};

/// A block's actions, decoded on demand, each offset once: control may reach
/// an offset inside another action, and from several regions. Strings are
/// slices of the SWF's bytes, without their zero; what they read as depends
/// on the SWF's version, which the emitter knows.
pub const Actions = struct {
    gpa: Allocator,
    bytes: []const u8 = &.{},
    start: i32 = 0,
    len: i32 = 0,
    /// The offsets from 0 that lookup tables keep dense.
    dense: i32 = 0,

    /// In the order they were decoded; they stay where they are as more are.
    actions: memory.Rows(Action) = .{},
    /// By offset, the index of the action there plus one; 0 before it is decoded.
    at: Offsets = .{},
    strings: std.ArrayList([]const u8) = .empty,
    params: std.ArrayList(Param) = .empty,
    values: std.ArrayList(Value) = .empty,

    /// How many bytes decoding has read, strings looked through included: a
    /// block crafted so that many offsets decode long Pushes or look through
    /// the same long run of bytes for a string's zero costs this, not its size.
    read: i64 = 0,
    /// How far decoding has looked, as an offset: the bytes past it, and
    /// whether the block ends before it, change nothing decoded so far.
    reach: i64 = 0,

    reader: Reader = .{},

    pub fn deinit(self: *Actions) void {
        self.actions.deinit(self.gpa);
        self.at.deinit(self.gpa);
        self.strings.deinit(self.gpa);
        self.params.deinit(self.gpa);
        self.values.deinit(self.gpa);
    }

    /// The block `len` bytes from `start` in `bytes`, the offsets from 0 to
    /// `dense` (all of them if null) those the compile mostly reaches.
    pub fn reset(self: *Actions, bytes: []const u8, start: i32, len: i32, dense: ?i32) Allocator.Error!void {
        self.bytes = bytes;
        self.start = start;
        self.len = len;
        self.dense = if (dense) |d| @min(d, len) else len;
        try self.at.reset(self.gpa, self.dense);
        self.actions.clearRetainingCapacity();
        self.strings.clearRetainingCapacity();
        self.params.clearRetainingCapacity();
        self.values.clearRetainingCapacity();
        self.read = 0;
        self.reach = 0;
        self.reader = .{};
    }

    /// The lowest offset there is: the SWF's first byte.
    pub fn minimum(self: *const Actions) i32 {
        return -self.start;
    }

    /// The index of the action decoded at `offset`, if one is.
    pub inline fn indexAt(self: *const Actions, offset: i32) ?u32 {
        const known = self.at.get(offset);
        return if (known == 0) null else @intCast(known - 1);
    }

    pub inline fn get(self: *const Actions, index: u32) *Action {
        return self.actions.at(index);
    }

    pub fn poolStrings(self: *const Actions, pool: Span) []const []const u8 {
        return self.strings.items[pool.first..][0..pool.count];
    }

    pub fn pushValues(self: *const Actions, push: Span) []const Value {
        return self.values.items[push.first..][0..push.count];
    }

    pub fn functionParams(self: *const Actions, function: Function) []const Param {
        return self.params.items[function.params.first..][0..function.params.count];
    }

    /// The action at `offset`, from `minimum` to the block's length, excluded.
    pub fn decode(self: *Actions, offset: i32) Allocator.Error!*Action {
        if (self.indexAt(offset)) |index| {
            return self.get(index);
        }

        const action = try self.actions.addOne(self.gpa);
        action.* = .{ .offset = offset };
        try self.operands(action);
        try self.at.set(self.gpa, offset, @intCast(self.actions.len));
        return action;
    }

    /// The actions one after the other from `offset`, without following jumps.
    pub fn sequence(self: *Actions, offset: i32) Sequence {
        return .{ .actions = self, .offset = offset };
    }

    pub const Sequence = struct {
        actions: *Actions,
        offset: i32,

        pub fn next(self: *Sequence) Allocator.Error!?*Action {
            if (self.offset >= self.actions.len) {
                return null;
            }

            const action = try self.actions.decode(self.offset);
            self.offset = action.next;
            return action;
        }
    };

    /// Sets a WaitForFrame's target: where the actions it skips end, read one
    /// after the other. Not done as it is decoded, since the actions it skips
    /// may be WaitForFrames too.
    pub fn skip(self: *Actions, action: *Action) Allocator.Error!void {
        const wait = &action.operands.wait;
        if (wait.target != null) {
            return;
        }

        var actions = self.sequence(action.next);
        for (0..wait.skip) |_| {
            _ = try actions.next() orelse break;
        }

        self.looks(@as(i64, actions.offset) + 1);
        wait.target = actions.offset;
    }

    fn operands(self: *Actions, action: *Action) Allocator.Error!void {
        const end = self.len;
        const op: Op = @fromBackingInt(@intCast(self.byteAt(action.offset)));
        action.op = op;
        self.looks(@as(i64, action.offset) + 1);
        if (!op.hasOperands()) {
            action.next = action.offset + 1;
            return;
        }

        const r = &self.reader;
        r.* = .{ .pos = action.offset + 1 };
        var len: i32 = self.readU16();
        if (r.failed) {
            // Only the opcode was read.
            action.err = error.Truncated;
            action.next = action.offset + 1;
            return;
        }

        const start = r.pos;
        // Nested bodies' sizes, which the position passes without reading.
        var bodies: i32 = 0;
        action.operands = switch (op) {
            .goto_frame => .{ .frame = self.readU16() },
            .get_url => .{ .url = .{ .url = self.readString() orelse "", .target = self.readString() orelse "" } },
            .store_register => .{ .register = self.readU8() },
            .constant_pool => .{ .pool = try self.readPool() },
            .wait_for_frame => .{ .wait = .{ .frame = self.readU16(), .skip = self.readU8() } },
            .set_target, .goto_label => .{ .name = self.readString() orelse "" },
            .wait_for_frame2 => .{ .wait = .{ .skip = self.readU8() } },
            .define_function, .define_function2 => blk: {
                const function = try self.readFunction(op == .define_function2);
                bodies = function.body.end - function.body.start;
                break :blk .{ .function = function };
            },
            .@"try" => blk: {
                if (len < 7) {
                    // Too short for its header: a Try with empty bodies, after it.
                    const at = start + len;
                    break :blk .{ .@"try" = .{ .start = at, .catch_start = at, .finally_start = at, .end = at } };
                }

                const t = self.readTry();
                bodies = t.end - t.start;
                break :blk .{ .@"try" = t };
            },
            .with => blk: {
                bodies = self.readU16();
                break :blk .{ .with = self.readBody(bodies) };
            },
            .push => .{ .push = try self.readPush(start + len, action) },
            .jump, .@"if" => .{ .branch = self.readI16() },
            .get_url2 => blk: {
                const flags = self.readU8();
                // A method of 3 is none.
                const method = opcodes.geturl_method_mask;
                break :blk .{ .get_url2 = if (flags & method == method) flags & ~method else flags };
            },
            .goto_frame2 => blk: {
                const flags = self.readU8();
                break :blk .{ .goto_frame2 = .{ .play = flags & 1 != 0, .bias = if (flags & 2 != 0) self.readU16() else 0 } };
            },
            else => .none,
        };
        len += bodies;

        self.read += @as(i64, r.pos - start - bodies);
        // Wherever the operands ended, the next action is where the length says.
        // A length past the block's end, read or not, is as truncated: adl
        // stops the whole SWF there, even with the bytes that follow in it.
        const next = @as(i64, start) + len;
        // Reads that went well end at `pos`; those that failed looked as they did.
        self.looks(r.pos);
        self.looks(next);
        if (next > end) {
            r.failed = true;
        }

        action.next = @intCast(@min(next, end));
        if (r.failed) {
            action.err = error.Truncated;
            return;
        }

        if (action.operands == .branch) {
            action.operands.branch += action.next;
        }
    }

    fn readPool(self: *Actions) Allocator.Error!Span {
        const count = self.readU16();
        var pool: Span = .{ .first = @intCast(self.strings.items.len) };
        for (0..count) |_| {
            // A string without its zero ends the pool, not the action.
            const string = self.readString() orelse {
                self.reader.failed = false;
                break;
            };
            try self.strings.append(self.gpa, string);
            pool.count += 1;
        }

        return pool;
    }

    /// The header and body of a DefineFunction or DefineFunction2.
    fn readFunction(self: *Actions, two: bool) Allocator.Error!Function {
        const name = self.readString() orelse "";
        const params = self.readU16();
        var function: Function = .{
            .name = name,
            .params = .{ .first = @intCast(self.params.items.len), .count = params },
            .body = undefined,
        };
        if (two) {
            function.registers = self.readU8();
            function.flags = @bitCast(self.readU16() & FunctionFlags.mask);
        }

        for (0..params) |_| {
            if (self.reader.failed) {
                break;
            }

            const register: u8 = if (two) self.readU8() else 0;
            const param = self.readString() orelse break;
            try self.params.append(self.gpa, .{ .name = param, .register = register });
        }

        function.body = self.readBody(self.readU16());
        return function;
    }

    /// Try's header and bodies.
    fn readTry(self: *Actions) Try {
        const flags: TryFlags = @bitCast(self.readU8() & TryFlags.mask);
        const try_size = self.readU16();
        const catch_size = self.readU16();
        const finally_size = self.readU16();
        const catch_into: Catch = if (flags.catch_in_register)
            .{ .register = self.readU8() }
        else
            .{ .variable = self.readString() orelse "" };
        const at = self.reader.pos;
        const t: Try = .{
            .flags = flags,
            .catch_into = catch_into,
            .start = at,
            .catch_start = at + try_size,
            .finally_start = at + try_size + catch_size,
            .end = at + try_size + catch_size + finally_size,
        };
        self.looks(t.end);
        if (t.end > self.len) {
            self.reader.failed = true;
        }

        self.reader.pos = t.end;
        return t;
    }

    /// A nested body of `size` bytes from here.
    fn readBody(self: *Actions, size: i32) Body {
        const r = &self.reader;
        const body: Body = .{ .start = r.pos, .end = r.pos + size };
        self.looks(body.end);
        if (body.end > self.len) {
            r.failed = true;
        }

        r.pos = body.end;
        return body;
    }

    /// Push's values, until its end.
    fn readPush(self: *Actions, end: i32, action: *Action) Allocator.Error!Span {
        const r = &self.reader;
        var push: Span = .{ .first = @intCast(self.values.items.len) };
        while (r.pos < end and !r.failed) {
            const value: Value = switch (@as(opcodes.PushType, @fromBackingInt(@intCast(self.readU8())))) {
                .string => .{ .string = self.readString() orelse "" },
                .float => .{ .float = @as(f32, @bitCast(self.readU32())) },
                .null => .null,
                .undefined => .undefined,
                .register => .{ .register = self.readU8() },
                .constant8 => .{ .constant8 = self.readU8() },
                .boolean => .{ .boolean = self.readU8() != 0 },
                .double => blk: {
                    // The high word first, each word little-endian.
                    const high: u64 = self.readU32();
                    const low: u64 = self.readU32();
                    break :blk .{ .double = @bitCast((high << 32) | low) };
                },
                .integer => .{ .integer = @bitCast(self.readU32()) },
                .constant16 => .{ .constant16 = self.readU16() },
                _ => {
                    action.err = error.UnknownPushType;
                    return push;
                },
            };
            if (r.failed) {
                break;
            }

            try self.values.append(self.gpa, value);
            push.count += 1;
        }

        return push;
    }

    /// Decoding looked up to `offset`, excluded, or found the block ends before it.
    fn looks(self: *Actions, offset: i64) void {
        self.reach = @max(self.reach, offset);
    }

    fn byteAt(self: *const Actions, p: i32) u8 {
        return self.bytes[@intCast(self.start + p)];
    }

    // The operand reader keeps AS's: a read past the end fails, the reader
    // stays failed, and the reads after it go on from where it was, as
    // AS's do. How far they look and how many bytes they pass decide `reach`
    // and `read`, the budget a block too large to compile runs out of, so
    // reads that stopped at the first failure would compile some blocks
    // otherwise.

    fn readU8(self: *Actions) u8 {
        const r = &self.reader;
        const p = r.pos;
        if (p >= self.len) {
            self.looks(@as(i64, p) + 1);
            r.failed = true;
            return 0;
        }

        r.pos = p + 1;
        return self.byteAt(p);
    }

    fn readU16(self: *Actions) u16 {
        const r = &self.reader;
        const p = r.pos;
        if (p + 2 > self.len) {
            self.looks(@as(i64, p) + 2);
            r.failed = true;
            return 0;
        }

        r.pos = p + 2;
        const at: usize = @intCast(self.start + p);
        return std.mem.readInt(u16, self.bytes[at..][0..2], .little);
    }

    fn readI16(self: *Actions) i16 {
        return @bitCast(self.readU16());
    }

    fn readU32(self: *Actions) u32 {
        const r = &self.reader;
        const p = r.pos;
        if (p + 4 > self.len) {
            self.looks(@as(i64, p) + 4);
            r.failed = true;
            return 0;
        }

        r.pos = p + 4;
        const at: usize = @intCast(self.start + p);
        return std.mem.readInt(u32, self.bytes[at..][0..4], .little);
    }

    /// A string up to its zero, or null, with the reader failed and the
    /// position where it was, if no zero ends it.
    fn readString(self: *Actions) ?[]const u8 {
        const r = &self.reader;
        const from = r.pos;
        // The position may be before the block, never before the SWF.
        const rest = if (from < self.len) self.bytes[@intCast(self.start + from)..@intCast(self.start + self.len)] else "";
        const zero = std.mem.indexOfScalar(u8, rest, 0);
        const p: i32 = if (zero) |z| from + @as(i32, @intCast(z)) else @max(from, self.len);
        self.read += @as(i64, p - from);
        const z = zero orelse {
            self.looks(@as(i64, p) + 1);
            r.failed = true;
            return null;
        };

        r.pos = p + 1;
        return rest[0..z];
    }
};

const Reader = struct {
    pos: i32 = 0,
    failed: bool = false,
};

test "a Push decodes its values, and a cut one is truncated" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();

    // Push "a", 1 (integer), true; then a Jump of -10 cut short.
    const block = [_]u8{ 0x96, 10, 0, 0, 'a', 0, 7, 1, 0, 0, 0, 5, 1, 0x99, 2, 0, 0xf6 };
    var actions: Actions = .{ .gpa = arena.allocator() };
    try actions.reset(&block, 0, block.len, null);
    const push = try actions.decode(0);
    try std.testing.expect(push.ok());
    try std.testing.expectEqual(13, push.next);
    const values = actions.pushValues(push.operands.push);
    try std.testing.expectEqualStrings("a", values[0].string);
    try std.testing.expectEqual(1, values[1].number().?);
    try std.testing.expect(values[2].boolean);
    const jump = try actions.decode(push.next);
    try std.testing.expectEqual(error.Truncated, jump.err.?);
    try std.testing.expectEqual(18, actions.reach);
    try std.testing.expect(try actions.decode(0) == push);
}

test "a WaitForFrame's skip ends past the actions it skips" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();

    // WaitForFrame 1, skipping 2: Play and Stop; then End.
    const block = [_]u8{ 0x8a, 3, 0, 1, 0, 2, 0x06, 0x07, 0x00 };
    var actions: Actions = .{ .gpa = arena.allocator() };
    try actions.reset(&block, 0, block.len, null);
    const wait = try actions.decode(0);
    try actions.skip(wait);
    try std.testing.expectEqual(8, wait.target().?);

    var all = actions.sequence(0);
    var ops: [4]Op = undefined;
    var n: usize = 0;
    while (try all.next()) |action| : (n += 1) {
        ops[n] = action.op;
    }

    try std.testing.expectEqualSlices(Op, &.{ .wait_for_frame, .play, .stop, .end }, ops[0..n]);
}
