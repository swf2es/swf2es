// The compiler's exports, as assembly/index.ts gives them, behind a byte
// ABI that packages/codegen/src/zig.ts lifts to the signatures of asc's
// glue (docs/zig-codegen.md, section 3).
//
// Every call starts with input(), which the host calls before each export
// with room for the call's arrays and strings (0 bytes when it has none),
// and no export starts a call itself: one place resets the call's arena
// and the last call's failure, so no export can forget to, and none can
// free what input() staged. The host writes the arrays and strings there
// and passes each as its address and length. What a call hands out (an
// address, outputLength() bytes) stays where it is until the next call's
// input(). outputLength() and codegenError() read the last call and start
// none. Inside, everything returns errors; here they become
// codegenError()'s code, set by the call that failed, which then hands out
// nothing: running out of memory never traps. Compiling is a pure function
// of the calls: no import but env.abort, no clock, no randomness.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const memory = @import("memory.zig");
const output = @import("output.zig");
const avm1 = @import("avm1/compile.zig");
const units = @import("avm1/emit/units.zig");

pub const panic = if (builtin.cpu.arch.isWasm()) @import("panic.zig") else std.debug.FullPanic(std.debug.defaultPanic);

/// Must equal COMPILER_VERSION in packages/codegen/src/index.ts.
const compiler_version = "0.0.0";

/// codegenError()'s codes.
const out_of_memory = 1;

var handed_length: u32 = 0;
var failure: u32 = 0;

/// The call's allocator, which input() reset.
pub fn gpa() Allocator {
    std.debug.assert(memory.arenasReady());
    return memory.call.allocator();
}

pub fn handOut(bytes: []const u8) usize {
    handed_length = @intCast(bytes.len);
    return @intFromPtr(bytes.ptr);
}

/// Nothing handed out, and why.
pub fn fail(err: Allocator.Error) usize {
    switch (err) {
        error.OutOfMemory => failure = out_of_memory,
    }

    handed_length = 0;
    return 0;
}

/// Start a call: all the last call held given back, and room for `size`
/// bytes of its arrays and strings, 8-aligned; 0 if memory cannot grow.
pub export fn input(size: u32) usize {
    memory.arenas();
    failure = 0;
    handed_length = 0;
    memory.call.reset();
    const room = gpa().alignedAlloc(u8, .@"8", @max(size, 8)) catch |err| return fail(err);
    return @intFromPtr(room.ptr);
}

/// How many bytes the last call that handed some out gave.
pub export fn outputLength() u32 {
    return handed_length;
}

/// Why the last call failed: 0 if it did not, 1 out of memory.
pub export fn codegenError() u32 {
    return failure;
}

pub export fn compilerVersion() usize {
    return handOut(compiler_version);
}

/// The version at the start of an ABC block, major << 16 | minor; -1 if it is too short.
pub export fn abcVersion(abc: [*]const u8, length: u32) i32 {
    if (length < 4) {
        return -1;
    }

    const minor: u32 = std.mem.readInt(u16, abc[0..2], .little);
    const major: u32 = std.mem.readInt(u16, abc[2..4], .little);
    // Wrapped, as AssemblyScript's i32 shift does: a major of 0x8000 or more is negative.
    return @bitCast((major << 16) | minor);
}

/// Nothing handed out, as AssemblyScript's handOut(null): address 0.
fn handOutNone() usize {
    handed_length = 0;
    return 0;
}

/// A staged array: its address and length, as the wrapper passes it.
fn staged(comptime T: type, at: [*]const T, len: u32) []const T {
    return at[0..len];
}

/// A SWF's bytes and its blocks' ranges, as many as there are both offsets and lengths.
fn swfOf(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32) Allocator.Error!avm1.Swf {
    const count = @min(offsets_len, lengths_len);
    const blocks = try gpa().alloc(units.BlockRange, count);
    for (blocks, staged(i32, offsets, count), staged(i32, lengths, count)) |*block, offset, length| {
        block.* = .{ .offset = offset, .length = length };
    }

    return .{ .bytes = staged(u8, swf, swf_len), .blocks = blocks };
}

/// What writing a module fails with, as codegenError() reports it: the
/// writer fails only as its buffer cannot grow.
pub fn failWriting(err: output.Error) usize {
    return fail(switch (err) {
        error.OutOfMemory, error.WriteFailed => error.OutOfMemory,
    });
}

// The AVM1 compiler (avm1/compile.zig), as assembly/avm1/compile.ts exports it.

pub export fn actionsModuleBytes(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32, version: i32, keep: bool) usize {
    const s = swfOf(swf, swf_len, offsets, offsets_len, lengths, lengths_len) catch |err| return fail(err);
    return handOut(avm1.moduleBytes(gpa(), memory.pages().allocator(), s, version, keep) catch |err| return failWriting(err));
}

pub export fn actionsModuleEntries() usize {
    return handOut(avm1.moduleEntries(gpa()) catch |err| return failWriting(err));
}

pub export fn actionsModuleUnits() usize {
    return handOut(avm1.moduleUnits(gpa()) catch |err| return failWriting(err));
}

pub export fn actionsEmitEach(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32, version: i32, blocks: [*]const u8, blocks_len: u32, reuse: bool) usize {
    return actionsEmitEachBytes(swf, swf_len, offsets, offsets_len, lengths, lengths_len, version, blocks, blocks_len, reuse);
}

pub export fn actionsEmitEachBytes(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32, version: i32, blocks: [*]const u8, blocks_len: u32, reuse: bool) usize {
    const s = swfOf(swf, swf_len, offsets, offsets_len, lengths, lengths_len) catch |err| return fail(err);
    return handOut(avm1.emitEach(gpa(), s, version, staged(u8, blocks, blocks_len), reuse) catch |err| return failWriting(err));
}

pub export fn actionsHold(handle: i32, swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32) void {
    const s = swfOf(swf, swf_len, offsets, offsets_len, lengths, lengths_len) catch |err| {
        _ = fail(err);
        return;
    };
    avm1.hold(memory.pages().allocator(), handle, s) catch |err| {
        _ = fail(err);
    };
}

pub export fn actionsRelease(handle: i32) void {
    avm1.release(handle);
}

pub export fn actionsHeldCount() i32 {
    return @intCast(avm1.heldCount());
}

pub export fn actionsHeldEmitEachBytes(handle: i32, version: i32, blocks: [*]const u8, blocks_len: u32) usize {
    const text = avm1.heldEmitEach(gpa(), handle, version, staged(u8, blocks, blocks_len)) catch |err| return failWriting(err);
    return if (avm1.heldAt(handle) == null) handOutNone() else handOut(text);
}

pub export fn actionsHeldUnitBytes(handle: i32, version: i32, at: i32, end: i32, bound: i32, five: bool) usize {
    const key: units.UnitKey = .{ .at = at, .end = end, .bound = bound, .five = five };
    const code = avm1.heldUnitBytes(gpa(), handle, version, key) catch |err| return failWriting(err);
    return if (code) |text| handOut(text) else handOutNone();
}

pub export fn actionsUnitBytes(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32, version: i32, at: i32, end: i32, bound: i32, five: bool) usize {
    const s = swfOf(swf, swf_len, offsets, offsets_len, lengths, lengths_len) catch |err| return fail(err);
    const key: units.UnitKey = .{ .at = at, .end = end, .bound = bound, .five = five };
    return handOut(avm1.unitBytes(gpa(), s, version, key) catch |err| return failWriting(err));
}

/// Where the high and reach of the unit compiled last are, two f64s.
pub export fn actionsUnitLimits() usize {
    return @intFromPtr(&avm1.unit_limits);
}

/// Bytes staged as the wrapper stages them, for the tests.
fn stage(bytes: []const u8) [*]const u8 {
    const at: [*]u8 = @ptrFromInt(input(@intCast(bytes.len)));
    @memcpy(at[0..bytes.len], bytes);
    return at;
}

test "a call hands out what stays until the next one starts" {
    _ = input(0);
    const at: [*]const u8 = @ptrFromInt(compilerVersion());
    try std.testing.expectEqualStrings(compiler_version, at[0..outputLength()]);
    try std.testing.expectEqual(0, codegenError());
}

test "abcVersion reads the minor and major versions, little-endian, as assembly/index.ts does" {
    try std.testing.expectEqual((46 << 16) | 16, abcVersion(stage(&.{ 16, 0, 46, 0, 99 }), 5));
    try std.testing.expectEqual(@as(i32, @bitCast(@as(u32, 0xffff_fffe))), abcVersion(stage(&.{ 0xfe, 0xff, 0xff, 0xff }), 4));
    try std.testing.expectEqual(-1, abcVersion(stage(&.{ 16, 0, 46 }), 3));
    try std.testing.expectEqual(-1, abcVersion(stage(&.{}), 0));
}

test "input starts a call: the last one's arena and failure are given back" {
    try std.testing.expectEqual(0, input(0xffff_ffff));
    try std.testing.expectEqual(1, codegenError());
    _ = input(3 * memory.chunk_size);
    try std.testing.expectEqual(0, codegenError());
    const used = memory.pages().used;
    _ = input(10);
    try std.testing.expect(memory.pages().used < used);
}

test {
    _ = memory;
    _ = output;
    _ = @import("dtoa.zig");
    _ = @import("parse.zig");
    _ = @import("avm1/actions/opcodes.zig");
    _ = @import("avm1/actions/offsets.zig");
    _ = @import("avm1/actions/decode.zig");
    _ = @import("avm1/flow/regions.zig");
    _ = @import("avm1/flow/pool.zig");
    _ = @import("avm1/emit/strings.zig");
    _ = @import("avm1/emit/units.zig");
    _ = @import("avm1/emit/block.zig");
    _ = @import("avm1/emit/actions.zig");
    _ = @import("avm1/emit/control.zig");
    _ = @import("avm1/emit/stack.zig");
    _ = @import("avm1/emit/module.zig");
    _ = avm1;
    _ = @import("avm2/abc/reader.zig");
    _ = @import("avm2/abc/constants.zig");
    _ = @import("avm2/abc/opcodes.zig");
    _ = @import("avm2/abc/pool.zig");
    _ = @import("avm2/abc/abc.zig");
    _ = @import("avm2/abc/methods.zig");
    _ = @import("avm2/abc/traits.zig");
    _ = @import("avm2/abc/classes.zig");
    _ = @import("avm2/abc/bodies.zig");
    _ = @import("avm2/abc/parse.zig");
}
