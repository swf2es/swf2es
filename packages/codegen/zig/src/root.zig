// The compiler's exports, as assembly/index.ts gives them, behind a byte
// ABI that packages/codegen/src/zig.ts lifts to the signatures of asc's
// glue (docs/zig-codegen.md, section 3).
//
// A call that takes arrays or strings is staged: the host asks input() for
// room, which starts the call, writes them there, and passes each as its
// address and length. Any other call starts itself. Starting a call resets
// the call's arena, so what a call hands out (an address, outputLength()
// bytes) stays where it is until the next one starts. Inside, everything
// returns errors; here they become codegenError()'s code, set by the call
// that failed, which then hands out nothing: running out of memory never
// traps. Compiling is a pure function of the calls: no import but
// env.abort, no clock, no randomness.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const memory = @import("memory.zig");

pub const panic = if (builtin.cpu.arch.isWasm()) @import("panic.zig") else std.debug.FullPanic(std.debug.defaultPanic);

/// Must equal COMPILER_VERSION in packages/codegen/src/index.ts.
const version = "0.0.0";

/// codegenError()'s codes.
const out_of_memory = 1;

var handed_length: u32 = 0;
var failure: u32 = 0;

/// The call's allocator, all the last call held given back.
fn begin() Allocator {
    memory.arenas();
    failure = 0;
    handed_length = 0;
    memory.call.reset();
    return memory.call.allocator();
}

/// The allocator of a call input() started.
fn staged() Allocator {
    return memory.call.allocator();
}

fn handOut(bytes: []const u8) usize {
    handed_length = @intCast(bytes.len);
    return @intFromPtr(bytes.ptr);
}

/// Nothing handed out, and why.
fn fail(err: Allocator.Error) usize {
    switch (err) {
        error.OutOfMemory => failure = out_of_memory,
    }

    handed_length = 0;
    return 0;
}

/// Room for `size` bytes of the next call's arrays and strings, 8-aligned,
/// which starts that call; 0 if memory cannot grow.
export fn input(size: u32) usize {
    const gpa = begin();
    const room = gpa.alignedAlloc(u8, .@"8", @max(size, 8)) catch |err| return fail(err);
    return @intFromPtr(room.ptr);
}

/// How many bytes the last call that handed some out gave.
export fn outputLength() u32 {
    return handed_length;
}

/// Why the last call failed: 0 if it did not, 1 out of memory.
export fn codegenError() u32 {
    return failure;
}

export fn compilerVersion() usize {
    _ = begin();
    return handOut(version);
}

/// The version at the start of an ABC block, major << 16 | minor; -1 if it is too short.
export fn abcVersion(abc: [*]const u8, length: u32) i32 {
    _ = staged();
    if (length < 4) {
        return -1;
    }

    const minor: u32 = std.mem.readInt(u16, abc[0..2], .little);
    const major: u32 = std.mem.readInt(u16, abc[2..4], .little);
    // Wrapped, as AssemblyScript's i32 shift does: a major of 0x8000 or more is negative.
    return @bitCast((major << 16) | minor);
}

/// Bytes staged as the wrapper stages them, for the tests.
fn stage(bytes: []const u8) [*]const u8 {
    const at: [*]u8 = @ptrFromInt(input(@intCast(bytes.len)));
    @memcpy(at[0..bytes.len], bytes);
    return at;
}

test "a call hands out what stays until the next one starts" {
    const at: [*]const u8 = @ptrFromInt(compilerVersion());
    try std.testing.expectEqualStrings(version, at[0..outputLength()]);
    try std.testing.expectEqual(0, codegenError());
}

test "abcVersion reads the minor and major versions, little-endian, as assembly/index.ts does" {
    try std.testing.expectEqual((46 << 16) | 16, abcVersion(stage(&.{ 16, 0, 46, 0, 99 }), 5));
    try std.testing.expectEqual(@as(i32, @bitCast(@as(u32, 0xffff_fffe))), abcVersion(stage(&.{ 0xfe, 0xff, 0xff, 0xff }), 4));
    try std.testing.expectEqual(-1, abcVersion(stage(&.{ 16, 0, 46 }), 3));
    try std.testing.expectEqual(-1, abcVersion(stage(&.{}), 0));
}

test "input starts a call: the last one's arena is given back" {
    _ = input(3 * memory.chunk_size);
    const used = memory.pages().used;
    _ = input(10);
    try std.testing.expect(memory.pages().used < used);
}

test {
    _ = memory;
}
