// A SWF's AVM1 blocks as one ES module, with the units they go on in
// (assembly/avm1/emit/module.ts, which shows the module's shape).
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../../output.zig");
const Output = output.Output;
const Error = Allocator.Error;
const BlockEmitter = @import("block.zig").BlockEmitter;
const units = @import("units.zig");
const BlockRange = units.BlockRange;
const UnitKey = units.UnitKey;

/// A key of the module's units: V.far's first choice names only the offset
/// and the SWF 5 flag, "at,five"; a region's own all four numbers.
pub const Key = struct {
    unit: UnitKey,
    short: bool,

    /// The key as the module names it.
    pub fn write(self: Key, out: *Output) Allocator.Error!void {
        try out.int(self.unit.at);
        if (!self.short) {
            try out.byte(',');
            try out.int(self.unit.end);
            try out.byte(',');
            try out.int(self.unit.bound);
        }

        try out.text(if (self.unit.five) ",1" else ",0");
    }

    fn of(unit: UnitKey, short: bool) Key {
        // The first choice's key leaves the region out.
        return .{ .unit = if (short) .{ .at = unit.at, .end = 0, .bound = 0, .five = unit.five } else unit, .short = short };
    }
};

/// Where some text is in the output.
pub const Text = struct {
    start: u32,
    end: u32,
};

/// A unit compiled for `key`: its code among the module's units, none
/// where it was dropped, and what it depends on (BlockEmitter.unit).
pub const Unit = struct {
    key: UnitKey,
    code: ?u32,
    high: i64,
    reach: i64,
    /// Where control goes on from it: the offsets its own code returns, and its V.far calls.
    exits: Span,
    calls: Span,
};

pub const Span = struct {
    first: u32,
    count: u32,

    fn of(list: anytype, from: usize) Span {
        return .{ .first = @intCast(from), .count = @intCast(list.items.len - from) };
    }

    fn in(self: Span, items: anytype) @TypeOf(items) {
        return items[self.first..][0..self.count];
    }
};

/// A unit in the module's units, by its key.
pub const Listed = struct {
    key: Key,
    unit: u32,
};

/// The distinct units' code, each once, by its text in the output: the
/// table holds their indices, hashed and compared by the bytes.
const Codes = struct {
    out: *const Output,
    texts: []const Text,

    pub fn hash(self: Codes, code: u32) u64 {
        return std.hash.Wyhash.hash(0, self.bytes(code));
    }

    pub fn eql(self: Codes, a: u32, b: u32) bool {
        return std.mem.eql(u8, self.bytes(a), self.bytes(b));
    }

    fn bytes(self: Codes, code: u32) []const u8 {
        const text = self.texts[code];
        return self.out.written()[text.start..text.end];
    }
};

/// Looks a code up by its bytes, before it is one.
const CodeBytes = struct {
    codes: Codes,

    pub fn hash(_: CodeBytes, bytes: []const u8) u64 {
        return std.hash.Wyhash.hash(0, bytes);
    }

    pub fn eql(self: CodeBytes, bytes: []const u8, code: u32) bool {
        return std.mem.eql(u8, bytes, self.codes.bytes(code));
    }
};

const CodeSet = std.HashMapUnmanaged(u32, void, Codes, std.hash_map.default_max_load_percentage);

pub const ModuleEmitter = struct {
    gpa: Allocator,
    out: *Output,
    blocks: *BlockEmitter,
    /// Where each block's entry is in `out`.
    entries: std.ArrayList(Text) = .empty,
    /// The module's units, in the order the blocks and units found them.
    listed: std.ArrayList(Listed) = .empty,
    /// Every unit compiled.
    units: std.ArrayList(Unit) = .empty,
    /// Where each distinct unit's code is in `out`.
    codes: std.ArrayList(Text) = .empty,
    exits: std.ArrayList(i32) = .empty,
    calls: std.ArrayList(UnitKey) = .empty,
    work: std.ArrayList(UnitKey) = .empty,
    // The unit compiled last, and whether it was the first with its code.
    last_added: bool = false,

    pub fn create(gpa: Allocator) Allocator.Error!*ModuleEmitter {
        const self = try gpa.create(ModuleEmitter);
        errdefer gpa.destroy(self);
        const out = try gpa.create(Output);
        errdefer gpa.destroy(out);
        out.* = try .init(gpa);
        errdefer out.deinit();
        self.* = .{ .gpa = gpa, .out = out, .blocks = try .create(gpa, out) };
        return self;
    }

    /// Frees what the emitter holds, its output too.
    pub fn destroy(self: *ModuleEmitter) void {
        const gpa = self.gpa;
        self.blocks.destroy();
        self.out.deinit();
        gpa.destroy(self.out);
        inline for (.{ &self.entries, &self.listed, &self.units, &self.codes, &self.exits, &self.calls, &self.work }) |items| {
            items.deinit(gpa);
        }
        gpa.destroy(self);
    }

    /// The module of the blocks `blocks` of `swf`, a SWF of `version`; a
    /// range not within the SWF is an empty block.
    pub fn module(self: *ModuleEmitter, swf: []const u8, blocks: []const BlockRange, version: i32) Error!void {
        const out = self.out;
        const emitter = self.blocks;
        out.shrink(0);
        inline for (.{ &self.entries, &self.listed, &self.units, &self.codes, &self.exits, &self.calls }) |items| {
            items.clearRetainingCapacity();
        }
        emitter.version = version;
        emitter.units.clearRetainingCapacity();
        emitter.exits.clearRetainingCapacity();
        try self.prologue("export default function (rt) {\n", version);
        const opening = out.len();
        try out.text("return [\n");
        for (blocks) |block| {
            const start = out.len();
            try emitter.block(swf, block.offset, block.length);
            try self.entries.append(self.gpa, .{ .start = start, .end = out.len() });
            try out.text(",\n");
        }

        if (emitter.units.items.len == 0) {
            return out.text("];\n}\n");
        }

        // The blocks give the runtime the module's units as they are made, so V.far finds them.
        try out.text("];\nrt.adoptUnits(b, units(rt));\nreturn b;\n}\n");
        try out.insert(opening, "const b = ");
        out.remove(opening + 10, 7);
        for (self.entries.items) |*entry| {
            entry.start += 3;
            entry.end += 3;
        }

        try self.prologue("export function units(rt) {\n", version);
        try out.text("const u = [\n");
        try self.unitsOf(swf, blocks);
        try out.text("];\nreturn {\n");
        for (self.listed.items) |listed| {
            const unit = self.units.items[listed.unit];
            try out.byte('"');
            try listed.key.write(out);
            try out.text("\": [u[");
            try out.uint(unit.code.?);
            try out.text("], ");
            try out.int(unit.high);
            try out.text(", ");
            try out.int(unit.reach);
            try out.text("],\n");
        }

        try out.text("};\n}\n");
    }

    /// Every unit V.far may ask for, as it asks: control going on at an
    /// offset of a region, from a block's code or a unit's, in the order the
    /// blocks and units found it.
    fn unitsOf(self: *ModuleEmitter, swf: []const u8, blocks: []const BlockRange) Error!void {
        const gpa = self.gpa;
        const size: i32 = @intCast(swf.len);
        var compiled: std.AutoHashMapUnmanaged(UnitKey, u32) = .empty;
        defer compiled.deinit(gpa);
        var asked: std.AutoHashMapUnmanaged(UnitKey, void) = .empty;
        defer asked.deinit(gpa);
        var listed: std.AutoHashMapUnmanaged(Key, void) = .empty;
        defer listed.deinit(gpa);
        var codes: CodeSet = .empty;
        defer codes.deinit(gpa);
        const work = &self.work;
        work.clearRetainingCapacity();
        try work.appendSlice(gpa, self.blocks.units.items);

        var i: usize = 0;
        while (i < work.items.len) : (i += 1) {
            const key = work.items[i];
            if ((try asked.getOrPut(gpa, key)).found_existing) {
                continue;
            }

            // The unit of a region and bytes that end with the stretch between blocks bounds `at` is
            // in, if it runs for this region too, else the region's own.
            const first = units.segmentEnd(blocks, size, key.at);
            const choice: UnitKey = .{ .at = key.at, .end = first, .bound = first, .five = key.five };
            var unit = try self.compile(swf, blocks, choice, &compiled, &codes, false);
            const high = self.units.items[unit].high;
            if (high >= 0) {
                try self.list(Key.of(key, true), unit, &listed);
            } else if (key.end != first or key.bound != first) {
                // A region's own alone, and not this region's: V.far never runs it.
                self.drop(unit, &codes);
            }

            if (high < 0 or high > key.end or self.units.items[unit].reach > key.bound) {
                unit = try self.compile(swf, blocks, key, &compiled, &codes, true);
                try self.list(Key.of(key, false), unit, &listed);
            }

            const done = self.units.items[unit];
            for (done.exits.in(self.exits.items)) |exit| {
                if (exit < key.end) {
                    try work.append(gpa, .{ .at = exit, .end = key.end, .bound = key.bound, .five = key.five });
                }
            }

            try work.appendSlice(gpa, done.calls.in(self.calls.items));
        }
    }

    /// The code of `unit`, just compiled, out of the module's units where it
    /// was the first with that code: no key names it.
    fn drop(self: *ModuleEmitter, unit: u32, codes: *CodeSet) void {
        if (!self.last_added) {
            return;
        }

        const code: u32 = @intCast(self.codes.items.len - 1);
        _ = codes.removeContext(code, .{ .out = self.out, .texts = self.codes.items });
        self.out.shrink(self.codes.pop().?.start);
        self.units.items[unit].code = null;
    }

    /// `unit` in the module's units by `key`, once.
    fn list(self: *ModuleEmitter, key: Key, unit: u32, listed: *std.AutoHashMapUnmanaged(Key, void)) Error!void {
        if ((try listed.getOrPut(self.gpa, key)).found_existing) {
            return;
        }

        try self.listed.append(self.gpa, .{ .key = key, .unit = unit });
    }

    /// The unit of `key`, compiled once: its index in `units`; its code
    /// written again if dropped where it `runs`.
    fn compile(
        self: *ModuleEmitter,
        swf: []const u8,
        blocks: []const BlockRange,
        key: UnitKey,
        compiled: *std.AutoHashMapUnmanaged(UnitKey, u32),
        codes: *CodeSet,
        runs: bool,
    ) Error!u32 {
        const gpa = self.gpa;
        const out = self.out;
        const emitter = self.blocks;
        // One whose code was dropped is written again where it is to run.
        self.last_added = false;
        if (compiled.get(key)) |known| {
            if (self.units.items[known].code != null or !runs) {
                return known;
            }
        }

        const unit: u32 = @intCast(self.units.items.len);
        try compiled.put(gpa, key, unit);
        const start = out.len();
        emitter.exits.clearRetainingCapacity();
        emitter.units.clearRetainingCapacity();
        try self.unitCode(swf, blocks, key);
        const exits_from = self.exits.items.len;
        try self.exits.appendSlice(gpa, emitter.exits.items);
        const calls_from = self.calls.items.len;
        try self.calls.appendSlice(gpa, emitter.units.items);
        var done: Unit = .{
            .key = key,
            .code = null,
            .high = emitter.unit_high,
            .reach = emitter.unit_reach,
            .exits = .of(self.exits, exits_from),
            .calls = .of(self.calls, calls_from),
        };

        // A unit whose code another has already is that one's.
        const context: Codes = .{ .out = out, .texts = self.codes.items };
        const found = try codes.getOrPutContextAdapted(gpa, out.written()[start..], CodeBytes{ .codes = context }, context);
        self.last_added = !found.found_existing;
        if (found.found_existing) {
            out.shrink(start);
            done.code = found.key_ptr.*;
            try self.units.append(gpa, done);
            return unit;
        }

        const code: u32 = @intCast(self.codes.items.len);
        try self.codes.append(gpa, .{ .start = start, .end = out.len() });
        found.key_ptr.* = code;
        done.code = code;
        try self.units.append(gpa, done);
        try out.text(",\n");
        return unit;
    }

    /// The unit V.far runs for control at `key.at` in `swf`, as the module
    /// writes it, with its high and reach in `blocks`.
    pub fn unitAlone(self: *ModuleEmitter, swf: []const u8, blocks: []const BlockRange, version: i32, key: UnitKey) Error!void {
        self.out.shrink(0);
        self.blocks.version = version;
        try self.unitCode(swf, blocks, key);
        self.blocks.units.clearRetainingCapacity();
        self.blocks.exits.clearRetainingCapacity();
    }

    /// One that no code can ask for, its offset not before its region's end, returns at once.
    fn unitCode(self: *ModuleEmitter, swf: []const u8, blocks: []const BlockRange, key: UnitKey) Error!void {
        const emitter = self.blocks;
        if (key.at < 0 or key.at >= key.end or key.end > key.bound or key.bound > swf.len) {
            try self.out.text("[function (cx) {\nreturn -1;\n}]");
            emitter.unit_high = -1;
            emitter.unit_reach = -1;
            return;
        }

        const high = units.unitHigh(blocks, @intCast(swf.len), key.at, key.end);
        try emitter.unit(swf, key.at, key.end, key.bound, key.five, high);
    }

    fn prologue(self: *ModuleEmitter, opening: []const u8, version: i32) Error!void {
        const out = self.out;
        try out.text(opening);
        try out.text("const V = rt.version(");
        try out.int(version);
        // A SWF 4's functions run as a SWF 5's, as Flash runs them (block.zig).
        try out.text(if (version < 5) ");\nconst V5 = rt.version(5);\n" else ");\n");
    }
};

const test_block = @import("block.zig").test_block;

/// The module of two blocks, the second at `at` in the first, whose jump
/// back before it goes on in units.
fn moduleOf(gpa: Allocator, swf: []const u8, at: i32) (Error || error{TestUnexpectedResult})!void {
    const emitter = try ModuleEmitter.create(gpa);
    defer emitter.destroy();
    const len: i32 = @intCast(swf.len);
    try emitter.module(swf, &.{ .{ .offset = 0, .length = len }, .{ .offset = at, .length = len - at } }, 6);
    if (emitter.listed.items.len == 0) {
        return error.TestUnexpectedResult;
    }
}

fn moduleAll(gpa: Allocator, swf: []const u8, at: i32) !void {
    try moduleOf(gpa, swf, at);
}

/// As production runs it: in an arena over the allocator, freed whole.
fn moduleInArena(gpa: Allocator, swf: []const u8, at: i32) !void {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    try moduleAll(arena.allocator(), swf, at);
}

test "every allocation a module's compile makes may fail, and it gives it back" {
    // The second block starts at the With, past the function: its If back reaches the first's bytes.
    const at = 36;
    try std.testing.checkAllAllocationFailures(std.testing.allocator, moduleAll, .{ &test_block, at });
    try std.testing.checkAllAllocationFailures(std.testing.allocator, moduleInArena, .{ &test_block, at });
}
