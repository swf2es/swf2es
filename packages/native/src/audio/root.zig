// SWF's ADPCM and Nellymoser sound for wasm32-freestanding, behind the
// calls src/audio/index.ts makes. Each call works in a bump arena that the
// host resets first: the host allocates the input there, and the output
// follows it, at resultPointer(). A Nellymoser stream's state is the host's,
// copied in and out at a pointer of its own.
const std = @import("std");
const adpcm = @import("adpcm.zig");
const nellymoser = @import("nellymoser.zig");

pub const panic = std.debug.no_panic;

const page = 65536;

var base: usize = 0;
var top: usize = 0;
var result: usize = 0;

/// Memory up to `end`, grown if need be.
fn reserve(end: u64) bool {
    const have: u64 = @as(u64, @wasmMemorySize(0)) * page;
    if (end <= have) {
        return true;
    }

    if (end > 0xffff_0000) {
        return false;
    }

    return @wasmMemoryGrow(0, @intCast((end - have + page - 1) / page)) >= 0;
}

/// Forget everything allocated; memory is kept for the next call.
export fn reset() void {
    // The arena starts where memory first ended, past the data and the stack.
    if (base == 0) {
        base = @wasmMemorySize(0) * page;
    }

    top = base;
    result = 0;
}

/// `n` bytes, 16-aligned, growing memory as needed; 0 when it cannot.
export fn alloc(n: usize) usize {
    if (base == 0) {
        reset();
    }

    const start = std.mem.alignForward(u64, top, 16);
    if (!reserve(start + n)) {
        return 0;
    }

    top = @intCast(start + n);
    return @intCast(start);
}

export fn resultPointer() usize {
    return result;
}

/// The `length` bytes of ADPCM at `input` in `channels`, 1 or 2, as 16-bit
/// samples, channels interleaved: how many; -1 when memory runs out.
export fn decodeAdpcm(input: usize, length: usize, channels: u32) i32 {
    const capacity = adpcm.capacity(length, channels);
    const out = alloc(capacity * 2);
    if (out == 0) {
        return -1;
    }

    result = out;
    const data = @as([*]const u8, @ptrFromInt(input))[0..length];
    const samples = @as([*]i16, @ptrFromInt(out))[0..capacity];
    return @intCast(adpcm.decode(data, channels, samples));
}

/// The size of a Nellymoser stream's state, which the host keeps.
export fn nellymoserStateSize() usize {
    return @sizeOf(nellymoser.State);
}

/// The state a Nellymoser stream starts in, written at `state`.
export fn nellymoserStart(state: usize) void {
    @as(*nellymoser.State, @ptrFromInt(state)).* = nellymoser.State.initial;
}

/// The whole 64-byte blocks of the `length` bytes of Nellymoser at `input`
/// as samples from -1 to 1, 256 a block, the stream's state at `state`
/// carried from its last call to its next: how many; -1 when memory runs
/// out.
export fn decodeNellymoser(input: usize, length: usize, state: usize) i32 {
    const count = length / nellymoser.block_len * nellymoser.block_samples;
    const out = alloc(count * 4);
    if (out == 0) {
        return -1;
    }

    result = out;
    const data = @as([*]const u8, @ptrFromInt(input))[0..length];
    const samples = @as([*]f32, @ptrFromInt(out))[0..count];
    return @intCast(nellymoser.decode(@ptrFromInt(state), data, samples));
}
