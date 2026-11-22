// The test build's root: every export of the compiler's (root.zig), and
// what the tests and the parity harness read besides, as
// assembly/testing.ts adds to assembly/index.ts. Each stage of the port
// adds the dumps of what it ports here.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("options");
const memory = @import("memory.zig");
const root = @import("root.zig");

pub const panic = root.panic;

comptime {
    _ = root;
}

const wasm = builtin.cpu.arch.isWasm();

/// How many of the page allocator's chunks are in use.
export fn memoryChunksUsed() u32 {
    return memory.pages().used;
}

/// How far memory reaches past the static data, in bytes: only grows.
export fn memoryReached() u32 {
    return memory.pages().reached();
}

/// A panic, as a failed safety check would be, for the wrapper's tests.
export fn testingPanic() void {
    @panic("a panic for the tests");
}

/// Recursion until the stack overflows, a trap that is not a panic, for the wrapper's tests.
export fn testingOverflow(depth: u32) u32 {
    var frame: [4096]u8 = undefined;
    frame[depth % frame.len] = @truncate(depth);
    std.mem.doNotOptimizeAway(&frame);
    return @call(.never_inline, testingOverflow, .{depth + 1}) +% frame[(depth * 7) % frame.len];
}

/// The byte the unused stack is painted with.
const paint: u8 = 0x5A;
/// The stack's lowest address the painting starts at: the stack is first
/// in memory and grows down towards 0, where no pointer may point.
const stack_floor = 16;

/// The stack below the caller painted, for stackDeepest to find how deep
/// the calls after reach: what the fuzzers and the corpus size it by.
export fn stackPaint() void {
    if (!wasm) {
        return;
    }

    var marker: u8 = 0;
    std.mem.doNotOptimizeAway(&marker);
    const below = @intFromPtr(&marker) - 1024;
    const stack: [*]volatile u8 = @ptrFromInt(stack_floor);
    for (0..below - stack_floor) |i| {
        stack[i] = paint;
    }
}

/// How many bytes deep the stack has reached since stackPaint, of its options.stack_size.
export fn stackDeepest() u32 {
    if (!wasm) {
        return 0;
    }

    const stack: [*]volatile u8 = @ptrFromInt(stack_floor);
    var at: u32 = 0;
    while (at < options.stack_size - stack_floor and stack[at] == paint) {
        at += 1;
    }

    return options.stack_size - stack_floor - at;
}

test {
    _ = root;
}
