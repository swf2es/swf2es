// The AVM1 compiler as the wasm exports it (assembly/avm1/compile.ts): a
// SWF's action blocks compiled to one module, each block alone, and each
// unit alone. Nothing is kept from one SWF to the next but the module whose
// entries are asked for next, and the SWFs held for their units.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../memory.zig");
const output = @import("../output.zig");
const Output = output.Output;
const Error = output.Error;
const module_ = @import("emit/module.zig");
const ModuleEmitter = module_.ModuleEmitter;
const units = @import("emit/units.zig");
const BlockRange = units.BlockRange;
const UnitKey = units.UnitKey;

/// A SWF's decompressed bytes, and its action blocks' ranges in them.
pub const Swf = struct {
    bytes: []const u8,
    blocks: []const BlockRange,
};

/// The module moduleBytes kept for moduleEntries and moduleUnits, in an
/// arena of its own, freed whole when another is kept or none is: its text,
/// its entries' and units' places in it, and what the units depend on.
const Written = struct {
    arena: memory.Arena,
    text: []const u8,
    entries: []const module_.Text,
    listed: []const module_.Listed,
    units: []const module_.Unit,
    codes: []const module_.Text,
};

var written: ?Written = null;

/// Lets go of the module kept last, if one is.
fn forget() void {
    if (written) |*w| {
        w.arena.deinit();
        written = null;
    }
}

/// The module of `swf`'s blocks, a SWF of `version`; with `keep`, kept for
/// its entries and units in an arena over `lasting`. One that runs out of
/// memory keeps nothing.
pub fn moduleBytes(gpa: Allocator, lasting: Allocator, swf: Swf, version: i32, keep: bool) Error![]const u8 {
    forget();
    const emitter = try ModuleEmitter.create(gpa);
    try emitter.module(swf.bytes, swf.blocks, version);
    const text = emitter.out.written();
    if (!keep) {
        return text;
    }

    var arena: memory.Arena = .init(lasting);
    errdefer arena.deinit();
    const kept = arena.allocator();
    // Made apart, then kept: made in place, a copy that ran out of memory
    // would leave `written` set with half its fields.
    var w: Written = .{
        .arena = undefined,
        .text = try kept.dupe(u8, text),
        .entries = try kept.dupe(module_.Text, emitter.entries.items),
        .listed = try kept.dupe(module_.Listed, emitter.listed.items),
        .units = try kept.dupe(module_.Unit, emitter.units.items),
        .codes = try kept.dupe(module_.Text, emitter.codes.items),
    };
    w.arena = arena;
    written = w;
    return w.text;
}

/// The blocks' entries in the module moduleBytes kept last: for each, its
/// index, U+0001, its entry, U+0002, as domainModuleEntries writes a method's.
pub fn moduleEntries(gpa: Allocator) Error![]const u8 {
    const w = written orelse return "";
    const text = w.text;
    var entries: Output = try .init(gpa);
    for (w.entries, 0..) |entry, k| {
        try entries.writer().print("{d}\x01{s}\x02", .{ k, text[entry.start..entry.end] });
    }

    return entries.written();
}

/// The units of the module moduleBytes kept last: for each, its key,
/// U+0001, the four numbers it was compiled for as V.far's, joined with
/// commas, U+0001, its high and reach joined with a comma, U+0001, its
/// entry, U+0002.
pub fn moduleUnits(gpa: Allocator) Error![]const u8 {
    const w = written orelse return "";
    const text = w.text;
    const all = w.units;
    const codes = w.codes;
    var entries: Output = try .init(gpa);
    for (w.listed) |listed| {
        const unit = all[listed.unit];
        const key = unit.key;
        const code = codes[unit.code.?];
        try entries.writer().print("{f}\x01{d},{d},{d},{d}\x01{d},{d}\x01{s}\x02", .{
            listed.key, key.at,     key.end,                    key.bound, @intFromBool(key.five),
            unit.high,  unit.reach, text[code.start..code.end],
        });
    }

    return entries.written();
}

/// The high and reach of the unit unitBytes compiled last.
pub var unit_limits: [2]f64 = .{ 0, 0 };

/// A SWF held from one call to the next for its blocks and units, in an
/// arena of its own: a block or a unit is small, and copying the SWF in for
/// each would cost more than compiling it.
const Held = struct {
    handle: i32,
    arena: memory.Arena,
    swf: Swf,
};

/// The SWFs held, by the handle the host gave each; it lets them go.
var held: std.ArrayList(Held) = .empty;

pub fn heldAt(handle: i32) ?usize {
    for (held.items, 0..) |h, i| {
        if (h.handle == handle) {
            return i;
        }
    }

    return null;
}

/// Hold a copy of `swf` by `handle`, in an arena over `lasting`; one that
/// runs out of memory holds nothing.
pub fn hold(lasting: Allocator, handle: i32, swf: Swf) Allocator.Error!void {
    release(handle);
    try held.ensureUnusedCapacity(memory.global.allocator(), 1);
    var arena: memory.Arena = .init(lasting);
    errdefer arena.deinit();
    const kept = arena.allocator();
    const copy: Swf = .{ .bytes = try kept.dupe(u8, swf.bytes), .blocks = try kept.dupe(BlockRange, swf.blocks) };
    held.appendAssumeCapacity(.{ .handle = handle, .arena = arena, .swf = copy });
}

pub fn release(handle: i32) void {
    if (heldAt(handle)) |i| {
        var h = held.orderedRemove(i);
        h.arena.deinit();
    }
}

pub fn heldCount() u32 {
    return @intCast(held.items.len);
}

/// emitEach of the SWF held by `handle`, which a block needs whole for its
/// backward jumps: copied in once, not for each block the JIT compiles.
/// Nothing if none is held.
pub fn heldEmitEach(gpa: Allocator, handle: i32, version: i32, blocks: []const u8) Error![]const u8 {
    const i = heldAt(handle) orelse return "";
    return emitEach(gpa, held.items[i].swf, version, blocks, true);
}

/// unitBytes of the SWF held by `handle`; null if none is.
pub fn heldUnitBytes(gpa: Allocator, handle: i32, version: i32, key: UnitKey) Error!?[]const u8 {
    const i = heldAt(handle) orelse return null;
    return try unitBytes(gpa, held.items[i].swf, version, key);
}

/// A unit of the SWF compiled alone, as V.far asks for it when control first
/// reaches it, byte for byte its entry in the module's units; its high and
/// reach, as the module's units give them, after in unit_limits.
pub fn unitBytes(gpa: Allocator, swf: Swf, version: i32, key: UnitKey) Error![]const u8 {
    const emitter = try ModuleEmitter.create(gpa);
    try emitter.unitAlone(swf.bytes, swf.blocks, version, key);
    unit_limits = .{ @floatFromInt(emitter.blocks.unit_high), @floatFromInt(emitter.blocks.unit_reach) };
    return emitter.out.written();
}

/// Blocks of the SWF compiled alone, as the JIT may compile each when it
/// first runs: `blocks` are their indices, comma-separated, in the order to
/// compile them; `reuse` compiles them all with one emitter, else each with
/// a new one. Written as moduleEntries writes them; an index with no block
/// names nothing.
pub fn emitEach(gpa: Allocator, swf: Swf, version: i32, blocks: []const u8, reuse: bool) Error![]const u8 {
    var entries: Output = try .init(gpa);
    var emitter = try ModuleEmitter.create(gpa);
    var indices = std.mem.tokenizeScalar(u8, blocks, ',');
    while (indices.next()) |item| {
        const k = parseI32(item);
        if (k < 0 or k >= swf.blocks.len) {
            continue;
        }

        if (!reuse) {
            emitter = try ModuleEmitter.create(gpa);
        }

        const out = emitter.out;
        out.shrink(0);
        emitter.blocks.version = version;
        const block = swf.blocks[@intCast(k)];
        try emitter.blocks.block(swf.bytes, block.offset, block.length);
        emitter.blocks.units.clearRetainingCapacity();
        try entries.writer().print("{d}\x01{s}\x02", .{ k, out.written() });
    }

    return entries.written();
}

/// AS QUIRK, KEPT AS IS: AssemblyScript's i32.parse (strtol) of ASCII: a
/// sign, a radix prefix, digits up to the first that is not one, wrapping as
/// i32 arithmetic does.
pub fn parseI32(s: []const u8) i32 {
    var p: usize = 0;
    var len = s.len;
    while (p < s.len and isSpace(s[p])) {
        p += 1;
        len -= 1;
    }

    if (len == 0) {
        return 0;
    }

    var sign: i32 = 1;
    if (s[p] == '-' or s[p] == '+') {
        len -= 1;
        if (len == 0) {
            return 0;
        }

        if (s[p] == '-') {
            sign = -1;
        }
        p += 1;
    }

    var radix: u32 = 10;
    if (s[p] == '0' and len > 2) {
        switch (s[p + 1] | 32) {
            'b' => radix = 2,
            'o' => radix = 8,
            'x' => radix = 16,
            else => {},
        }

        if (radix != 10) {
            p += 2;
            len -= 2;
        }
    }

    var num: i32 = 0;
    const initial = len;
    while (len > 0) : (len -= 1) {
        var code: u32 = s[p];
        if (code -% '0' < 10) {
            code -= '0';
        } else if (code -% 'A' <= 'Z' - 'A') {
            code -= 'A' - 10;
        } else if (code -% 'a' <= 'z' - 'a') {
            code -= 'a' - 10;
        }

        if (code >= radix) {
            if (len == initial) {
                return 0;
            }
            break;
        }

        num = num *% @as(i32, @intCast(radix)) +% @as(i32, @intCast(code));
        p += 1;
    }

    return sign *% num;
}

fn isSpace(c: u8) bool {
    return c == 0x20 or (c >= 0x09 and c <= 0x0d);
}

test "indices parse as AssemblyScript's i32.parse reads them" {
    try std.testing.expectEqual(12, parseI32("12"));
    try std.testing.expectEqual(-3, parseI32("-3"));
    try std.testing.expectEqual(0, parseI32("x"));
    try std.testing.expectEqual(7, parseI32("7x"));
    try std.testing.expectEqual(255, parseI32("0xff"));
    try std.testing.expectEqual(0, parseI32("4294967296"));
}

/// A SWF of the tests' block, the block alone.
fn testSwf() Swf {
    const block = &@import("emit/block.zig").test_block;
    const ranges = struct {
        const blocks = [_]BlockRange{.{ .offset = 0, .length = block.len }};
    };
    return .{ .bytes = block, .blocks = &ranges.blocks };
}

/// Every entry of the AVM1 compiler, as the host calls them one after
/// another, its calls' memory from `source` as the module's from its pages;
/// what it keeps and holds let go after, as it is when they fail.
fn everyEntry(source: Allocator, _: *memory.Pages) !void {
    memory.arenas();
    defer {
        forget();
        release(1);
    }

    var arena: memory.Arena = .init(source);
    defer arena.deinit();
    calls(arena.allocator(), source) catch |err| switch (err) {
        // The writer fails only as its buffer cannot grow.
        error.OutOfMemory, error.WriteFailed => return error.OutOfMemory,
    };
}

fn calls(gpa: Allocator, lasting: Allocator) Error!void {
    const swf = testSwf();
    const len: i32 = @intCast(swf.bytes.len);
    const whole: UnitKey = .{ .at = 0, .end = len, .bound = len, .five = false };
    _ = try moduleBytes(gpa, lasting, swf, 6, true);
    _ = try moduleEntries(gpa);
    _ = try moduleUnits(gpa);
    _ = try emitEach(gpa, swf, 6, "0,1,0", false);
    _ = try unitBytes(gpa, swf, 6, whole);
    try hold(lasting, 1, swf);
    _ = try heldEmitEach(gpa, 1, 6, "0");
    _ = try heldUnitBytes(gpa, 1, 6, whole);
}

test "every entry may run out of memory anywhere, and leaves nothing kept or held" {
    try memory.atEveryMemorySize(everyEntry);
}

test "every run every entry takes may fail, and leaves nothing behind" {
    const t = try memory.TestPages.init(64 << 20);
    defer t.deinit();
    try std.testing.checkAllAllocationFailures(t.pages.allocator(), everyEntry, .{&t.pages});
    try std.testing.expectEqual(0, t.pages.used);
}
