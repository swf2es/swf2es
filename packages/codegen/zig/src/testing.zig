// The test build's root: every export of the compiler's (root.zig), and
// what the tests and the parity harness read besides, as
// assembly/testing.ts adds to assembly/index.ts. Each stage of the port
// adds the dumps of what it ports here.
const std = @import("std");
const memory = @import("memory.zig");
const root = @import("root.zig");

pub const panic = root.panic;

comptime {
    _ = root;
}

/// How many of the page allocator's chunks are in use.
export fn memoryChunksUsed() u32 {
    memory.arenas();
    return memory.pages().used;
}

/// How far memory reaches past the static data, in bytes: only grows.
export fn memoryReached() u32 {
    memory.arenas();
    return memory.pages().reached();
}

/// A panic, as a failed safety check would be, for the wrapper's tests.
export fn testingPanic() void {
    @panic("a panic for the tests");
}

test {
    _ = root;
}
