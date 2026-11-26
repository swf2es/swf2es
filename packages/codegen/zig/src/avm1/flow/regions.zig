// A block's regions and, in each, its blocks: what the dispatcher writes as
// a case each (assembly/avm1/flow/regions.ts, which explains regions,
// homes, units, and With and Try bodies).
const std = @import("std");
const Allocator = std.mem.Allocator;
const decode = @import("../actions/decode.zig");
const Action = decode.Action;
const Actions = decode.Actions;
const Offsets = @import("../actions/offsets.zig").Offsets;

/// How many actions all of a block's regions may hold together. Each region
/// holds what it reaches, so functions that jump back over a large block
/// hold it each; past this, the block is too large to compile.
pub const max_visits = 1 << 21;

/// How many bytes decoding a block may read, per byte of it and besides.
pub const max_read_per_byte = 8;
pub const max_read_besides = 1 << 20;

pub const Error = error{TooLarge} || Allocator.Error;

pub const Kind = enum {
    block,
    function,
    /// Code a region goes on to outside its home: it returns where control goes next.
    unit,
};

pub const Region = struct {
    kind: Kind,
    start: i32,
    end: i32,
    /// The region it was first reached from; none for the block.
    parent: ?u32 = null,
    /// The index of the action that first opened it; none for the block.
    opener: ?u32 = null,
    minimum: i32 = 0,
    /// Its home, from `low` to `high`, excluded: the code it is compiled with.
    low: i32 = 0,
    high: i32 = 0,
    /// Whether it keeps all it reaches though its home was less (Flow.walk).
    kept: bool = false,

    /// Its actions' indices in `Actions.actions`, by offset.
    actions: std.ArrayList(u32) = .empty,
    /// Its blocks' first offsets, ascending.
    blocks: std.ArrayList(i32) = .empty,
    /// Block k's actions are `order[block_first[k]..block_first[k + 1]]`.
    block_first: std.ArrayList(u32) = .empty,
    order: std.ArrayList(u32) = .empty,

    fn reset(self: *Region, kind: Kind, start: i32, end: i32, parent: ?u32, opener: ?u32, minimum: i32) void {
        self.kind = kind;
        self.start = start;
        self.end = end;
        self.parent = parent;
        self.opener = opener;
        self.minimum = minimum;
        self.low = minimum;
        self.high = end;
        self.kept = false;
        self.clear();
    }

    fn deinit(self: *Region, gpa: Allocator) void {
        self.actions.deinit(gpa);
        self.blocks.deinit(gpa);
        self.block_first.deinit(gpa);
        self.order.deinit(gpa);
    }

    fn clear(self: *Region) void {
        self.actions.clearRetainingCapacity();
        self.blocks.clearRetainingCapacity();
        self.block_first.clearRetainingCapacity();
        self.order.clearRetainingCapacity();
    }

    /// Whether control at `offset` is in the region's home, its compiled code.
    pub fn runs(self: *const Region, offset: i32) bool {
        return offset >= self.low and offset < self.high;
    }

    /// Whether control at `offset` is still in the region, home or not.
    pub fn continues(self: *const Region, offset: i32) bool {
        return offset >= self.minimum and offset < self.end;
    }

    /// Its home is all it reaches: nothing goes on in a unit.
    pub fn whole(self: *const Region) bool {
        return self.low == self.minimum and self.high == self.end;
    }

    pub fn blockCount(self: *const Region) u32 {
        return @intCast(self.blocks.items.len);
    }

    /// The indices of block `k`'s actions, in order.
    pub fn blockActions(self: *const Region, k: u32) []const u32 {
        return self.order.items[self.block_first.items[k]..self.block_first.items[k + 1]];
    }

    /// The index of the first block at or after `offset`, the count of blocks past them all.
    pub fn firstFrom(self: *const Region, offset: i32) u32 {
        return @intCast(std.sort.lowerBound(i32, self.blocks.items, offset, orderI32));
    }

    /// The index of the block that starts at `offset`, which must start one.
    pub fn blockAt(self: *const Region, offset: i32) u32 {
        // As firstFrom, but never past the last block.
        const blocks = self.blocks.items;
        return @intCast(std.sort.lowerBound(i32, blocks[0 .. @max(blocks.len, 1) - 1], offset, orderI32));
    }
};

fn orderI32(a: i32, b: i32) std.math.Order {
    return std.math.order(a, b);
}

/// Where control may go from an action, as `Successors` lists it.
pub const Edge = struct {
    offset: i32,
    /// Where a throw lands, a Try's catch or finally, with nothing of the
    /// region's state but its registers.
    handler: bool = false,
};

/// Where control may go from an action, in the order the flow follows it:
/// past a With's body (for undefined or null), to a Try's handlers, to its
/// target, then on to where it falls.
pub const Successors = struct {
    action: *const Action,
    step: u3 = 0,

    pub fn next(self: *Successors) ?Edge {
        const action = self.action;
        if (!action.ok()) {
            return null;
        }

        while (true) {
            const step = self.step;
            self.step += 1;
            switch (step) {
                0 => if (action.operands == .with) return .{ .offset = action.next },
                1 => if (action.operands == .@"try" and action.operands.@"try".flags.catch_block)
                    return .{ .offset = action.operands.@"try".catch_start, .handler = true },
                2 => if (action.operands == .@"try" and action.operands.@"try".flags.finally_block)
                    return .{ .offset = action.operands.@"try".finally_start, .handler = true },
                3 => if (action.target()) |to| return .{ .offset = to },
                4 => if (action.fallsThrough()) return .{ .offset = action.fallsTo() },
                else => return null,
            }
        }
    }
};

pub fn successors(action: *const Action) Successors {
    return .{ .action = action };
}

/// A With's or Try's offset, and where its bodies end.
const Held = struct {
    at: i32,
    end: i32,
};

pub const Flow = struct {
    gpa: Allocator,
    actions: *Actions,
    regions: std.ArrayList(*Region) = .empty,
    /// Whether a region keeps all it reaches though its home is less (see `walk`).
    widened: bool = false,
    visits: u32 = 0,
    // Per offset, the region (plus one) that last visited it, made it a block
    // start, or counted its fall-through predecessors, which `preds` holds.
    visited: Offsets = .{},
    started: Offsets = .{},
    counted: Offsets = .{},
    preds: Offsets = .{},
    work: std.ArrayList(i32) = .empty,
    max_read: i64 = 0,
    offsets: std.ArrayList(i32) = .empty,
    reusable: std.ArrayList(*Region) = .empty,
    // The home of the code being compiled, and what the region being walked reached outside it.
    home_low: i32 = 0,
    home_high: i32 = 0,
    far: bool = false,
    ranges: std.ArrayList([2]u32) = .empty,
    /// The offsets of the actions control leaves the home from.
    far_from: std.ArrayList(i32) = .empty,
    held: std.ArrayList(Held) = .empty,

    /// Frees what the flow holds; an arena's would go with it anyway.
    pub fn deinit(self: *Flow) void {
        const gpa = self.gpa;
        for (self.reusable.items) |region| {
            region.deinit(gpa);
            gpa.destroy(region);
        }

        self.reusable.deinit(gpa);
        self.regions.deinit(gpa);
        inline for (.{ &self.visited, &self.started, &self.counted, &self.preds }) |offsets| {
            offsets.deinit(gpa);
        }
        inline for (.{ &self.work, &self.offsets, &self.ranges, &self.far_from, &self.held }) |list| {
            list.deinit(gpa);
        }
    }

    /// The regions of the code from `start`, a block's or a unit's (`kind`),
    /// which runs until control is at or past `end`, compiled within its
    /// home, `low` to `high`; a block's by default, its own bytes.
    /// error.TooLarge if they would hold more than max_visits actions, or
    /// decoding them would read more than max_read_per_byte bytes per byte.
    pub fn analyze(self: *Flow, kind: Kind, start: i32, end: ?i32, low: i32, high: ?i32) Error!void {
        const n = self.actions.len;
        const dense = self.actions.dense;
        self.widened = false;
        self.visits = 0;
        self.regions.clearRetainingCapacity();
        self.home_low = low;
        self.home_high = high orelse n;
        self.max_read = @as(i64, n) * max_read_per_byte + max_read_besides;
        try self.visited.reset(self.gpa, dense);
        try self.started.reset(self.gpa, dense);
        try self.counted.reset(self.gpa, dense);
        try self.preds.reset(self.gpa, dense);
        _ = try self.newRegion(kind, start, end orelse n, null, null);
        // Regions found while walking are walked in turn.
        var r: u32 = 0;
        while (r < self.regions.items.len) : (r += 1) {
            try self.walk(r);
        }
    }

    fn walk(self: *Flow, r: u32) Error!void {
        const region = self.regions.items[r];
        const tag: i32 = @intCast(r + 1);
        try self.reach(region, tag);
        try self.settle(region, tag);
        // A unit hands on even what is past its region's end: one whose home is all of it may
        // widen too.
        const whole = region.whole() and region.kind != .unit;
        if (!self.far or whole or !(self.locals(region) or try self.leavesHeld(region))) {
            return;
        }

        // What a unit cannot run, the region keeps, reaching all it reaches as before.
        for (self.offsets.items) |p| {
            try self.visited.set(self.gpa, p, 0);
            try self.started.set(self.gpa, p, 0);
            try self.counted.set(self.gpa, p, 0);
        }

        region.clear();
        region.low = region.minimum;
        region.high = region.end;
        region.kept = true;
        self.widened = true;
        try self.reach(region, tag);
        try self.settle(region, tag);
    }

    /// The region's actions and blocks, of the offsets it reaches.
    fn settle(self: *Flow, region: *Region, tag: i32) Error!void {
        const offsets = self.offsets.items;
        std.mem.sortUnstable(i32, offsets, {}, std.sort.asc(i32));
        for (offsets) |p| {
            try region.actions.append(self.gpa, self.actions.indexAt(p).?);
        }

        try self.blocks(region, tag, offsets);
    }

    /// Whether control may leave the home while a With or a Try holds: from
    /// the With or the Try, or from a block of its bodies or the first past
    /// them, which a With's scope holds over too, as the emitter's ranges
    /// have them (docs/avm1.md, "With and Try").
    fn leavesHeld(self: *Flow, region: *Region) Error!bool {
        if (self.held.items.len == 0) {
            return false;
        }

        const from = self.far_from.items;
        std.mem.sortUnstable(i32, from, {}, std.sort.asc(i32));
        self.ranges.clearRetainingCapacity();
        for (self.held.items) |held| {
            if (includes(from, held.at)) {
                return true;
            }

            const body = (try self.actions.decode(held.at)).fallsTo();
            try self.ranges.append(self.gpa, .{ region.firstFrom(body), region.firstFrom(held.end) });
        }

        for (0..region.blockCount()) |k| {
            const leaves = for (region.blockActions(@intCast(k))) |index| {
                if (includes(from, self.actions.get(index).offset)) {
                    break true;
                }
            } else false;
            if (!leaves) {
                continue;
            }

            for (self.ranges.items) |range| {
                if (range[0] <= k and k <= range[1]) {
                    return true;
                }
            }
        }

        return false;
    }

    /// Whether the region is a DefineFunction2's body with registers of its own.
    fn locals(self: *Flow, region: *Region) bool {
        if (region.kind != .function) {
            return false;
        }

        const opener = self.actions.get(region.opener.?);
        return opener.op == .define_function2 and opener.operands.function.registers > 0;
    }

    /// The offsets the region reaches in its home, in `offsets`.
    fn reach(self: *Flow, region: *Region, tag: i32) Error!void {
        const actions = self.actions;
        self.offsets.clearRetainingCapacity();
        self.work.clearRetainingCapacity();
        self.far = false;
        self.far_from.clearRetainingCapacity();
        self.held.clearRetainingCapacity();
        try self.follow(region, tag, region.start, region.start);

        while (self.work.pop()) |p| {
            if (self.visited.get(p) == tag) {
                continue;
            }

            self.visits += 1;
            if (self.visits > max_visits) {
                return error.TooLarge;
            }

            try self.visited.set(self.gpa, p, tag);
            try self.offsets.append(self.gpa, p);
            const action = try actions.decode(p);
            if (actions.read > self.max_read) {
                return error.TooLarge;
            }

            if (!action.ok()) {
                continue;
            }

            switch (action.operands) {
                .wait => try actions.skip(action),
                .function => |*function| if (function.region == null) {
                    const opener = actions.indexAt(p).?;
                    function.region = try self.newRegion(.function, function.body.start, function.body.end, @intCast(tag - 1), opener);
                },
                .with, .@"try" => try self.held.append(self.gpa, .{ .at = p, .end = action.heldEnd() }),
                else => {},
            }

            var edges = successors(action);
            while (edges.next()) |edge| {
                try self.follow(region, tag, edge.offset, p);
            }
        }
    }

    /// Control to `offset` from the action at `from`. A unit's own code hands
    /// every offset in the SWF to V.far, which knows where the region ends,
    /// so for a unit each goes on elsewhere.
    fn follow(self: *Flow, region: *Region, tag: i32, offset: i32, from: i32) Allocator.Error!void {
        if (!region.runs(offset)) {
            const goes_on = if (region.kind == .unit) offset >= region.minimum else region.continues(offset);
            if (goes_on) {
                self.far = true;
                try self.far_from.append(self.gpa, from);
            }
        } else if (self.visited.get(offset) != tag) {
            try self.work.append(self.gpa, offset);
        }
    }

    fn newRegion(self: *Flow, kind: Kind, start: i32, end: i32, parent: ?u32, opener: ?u32) Allocator.Error!u32 {
        const index = self.regions.items.len;
        const minimum = self.actions.minimum();
        const region = if (index < self.reusable.items.len) self.reusable.items[index] else blk: {
            const made = try self.gpa.create(Region);
            errdefer self.gpa.destroy(made);
            made.* = .{ .kind = kind, .start = start, .end = end };
            try self.reusable.append(self.gpa, made);
            break :blk made;
        };
        region.reset(kind, start, end, parent, opener, minimum);

        // A body that starts outside the home, as one past a unit's may, keeps all it reaches.
        if (start >= self.home_low and start < self.home_high) {
            region.low = @max(region.low, self.home_low);
            region.high = @min(region.high, self.home_high);
        }

        try self.regions.append(self.gpa, region);
        return @intCast(index);
    }

    /// Makes `offset` a block start, if the region holds it.
    fn markStart(self: *Flow, region: *Region, tag: i32, offset: i32) Allocator.Error!void {
        if (region.runs(offset) and self.visited.get(offset) == tag) {
            try self.started.set(self.gpa, offset, tag);
        }
    }

    /// A block starts at the region's start, at a branch's target, after a
    /// conditional branch, at a With's or Try's bodies' bounds, and where code
    /// from two actions falls through, as actions that overlap can; every
    /// other action follows the one before it.
    fn blocks(self: *Flow, region: *Region, tag: i32, offsets: []const i32) Error!void {
        try self.markStart(region, tag, region.start);
        for (offsets) |offset| {
            const action = try self.actions.decode(offset);
            if (!action.ok()) {
                continue;
            }

            switch (action.operands) {
                .with => |body| {
                    for ([_]i32{ body.start, body.end, action.next }) |bound| {
                        try self.markStart(region, tag, bound);
                    }
                    continue;
                },
                .@"try" => |t| {
                    for ([_]i32{ t.start, t.catch_start, action.next, t.finally_start, t.end }) |bound| {
                        try self.markStart(region, tag, bound);
                    }
                    continue;
                },
                else => {},
            }

            const target = action.target();
            if (target) |to| {
                try self.markStart(region, tag, to);
            }

            const next = action.next;
            if (!action.fallsThrough() or !region.runs(next)) {
                continue;
            }

            if (target != null) {
                try self.started.set(self.gpa, next, tag);
            } else if (self.counted.get(next) != tag) {
                try self.counted.set(self.gpa, next, tag);
                try self.preds.set(self.gpa, next, 1);
            } else {
                const count = self.preds.get(next) + 1;
                try self.preds.set(self.gpa, next, count);
                if (count > 1) {
                    try self.started.set(self.gpa, next, tag);
                }
            }
        }

        for (offsets) |first| {
            if (self.started.get(first) != tag) {
                continue;
            }

            try region.blocks.append(self.gpa, first);
            try region.block_first.append(self.gpa, @intCast(region.order.items.len));
            var chain: Chain = .{ .flow = self, .region = region, .tag = tag, .offset = first };
            while (try chain.next()) |index| {
                try region.order.append(self.gpa, index);
            }
        }

        try region.block_first.append(self.gpa, @intCast(region.order.items.len));
    }

    /// The actions of the block that starts at `offset`: each falls through
    /// to the next, until one does not, or control leaves the home, or
    /// reaches another block's start.
    const Chain = struct {
        flow: *Flow,
        region: *const Region,
        tag: i32,
        offset: ?i32,

        fn next(self: *Chain) Allocator.Error!?u32 {
            const p = self.offset orelse return null;
            const index = self.flow.actions.indexAt(p).?;
            const action = try self.flow.actions.decode(p);
            self.offset = null;
            if (action.fallsThrough()) {
                const to = action.fallsTo();
                if (self.region.runs(to) and self.flow.started.get(to) != self.tag) {
                    self.offset = to;
                }
            }

            return index;
        }
    };
};

/// Whether the ascending `values` hold `value`.
fn includes(values: []const i32, value: i32) bool {
    return std.sort.binarySearch(i32, values, value, orderI32) != null;
}

test "a loop's head starts a block, and a function's body is a region" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const gpa = arena.allocator();

    // 0: Play; 1: DefineFunction "" () { Stop }; 10: Stop; 11: Jump back to 0.
    const block = [_]u8{
        0x06,
        0x9b,
        5,
        0,
        0,
        0,
        0,
        1,
        0,
        0x07,
        0x07,
        0x99,
        2,
        0,
        0xf0,
        0xff,
    };
    var actions: Actions = .{ .gpa = gpa };
    try actions.reset(&block, 0, block.len, null);
    var flow: Flow = .{ .gpa = gpa, .actions = &actions };
    try flow.analyze(.block, 0, null, 0, null);
    try std.testing.expectEqual(2, flow.regions.items.len);
    const main = flow.regions.items[0];
    try std.testing.expectEqualSlices(i32, &.{0}, main.blocks.items);
    try std.testing.expectEqual(4, main.blockActions(0).len);
    const body = flow.regions.items[1];
    try std.testing.expectEqual(.function, body.kind);
    try std.testing.expectEqual(9, body.start);
    try std.testing.expectEqual(10, body.end);
}

test "an action's successors, in the order the flow follows them" {
    // A Try with a catch and a finally: its handlers, then its try body.
    const action: Action = .{ .offset = 0, .op = .@"try", .next = 20, .operands = .{ .@"try" = .{
        .flags = .{ .catch_block = true, .finally_block = true },
        .start = 10,
        .catch_start = 14,
        .finally_start = 17,
        .end = 20,
    } } };
    var edges = successors(&action);
    try std.testing.expectEqual(Edge{ .offset = 14, .handler = true }, edges.next().?);
    try std.testing.expectEqual(Edge{ .offset = 17, .handler = true }, edges.next().?);
    try std.testing.expectEqual(Edge{ .offset = 10 }, edges.next().?);
    try std.testing.expectEqual(null, edges.next());
}

/// A block with something of every kind, for the tests that fail allocations.
const test_block = [_]u8{
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

/// A block decoded and its regions found, all freed after.
fn analyzeAll(gpa: Allocator, block: []const u8) !void {
    var actions: Actions = .{ .gpa = gpa };
    defer actions.deinit();
    try actions.reset(block, 0, @intCast(block.len), null);
    var flow: Flow = .{ .gpa = gpa, .actions = &actions };
    defer flow.deinit();
    flow.analyze(.block, 0, null, 0, null) catch |err| switch (err) {
        error.TooLarge => return error.TestUnexpectedResult,
        error.OutOfMemory => |e| return e,
    };
}

test "every allocation decoding and the flow make may fail, and they give it back" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, analyzeAll, .{&test_block});
}
