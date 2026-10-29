//! What bitmap/index.ts calls: the module's arena (arena.zig), which
//! resetArena resets before each call, and convolve.zig's kernel over the
//! input written into it.
const std = @import("std");
const kernel = @import("convolve.zig");
const arena = @import("arena.zig");

const page = 65536;

/// The input resetArena reserved, and the arena's generation then: a reset
/// since, by another of the module's calls, leaves no input.
var input_start: usize = 0;
var input_end: usize = 0;
var input_generation: u32 = 0;

/// Whether [at, at + bytes) lies in the input and is aligned.
fn holds(at: usize, bytes: usize, alignment: usize) bool {
    return input_generation == arena.generation and at >= input_start and at <= input_end and at % alignment == 0 and bytes <= input_end - at;
}

/// Frees everything the last call allocated and reserves `bytes` of input
/// for the next, returning its address or 0 where memory cannot grow.
export fn resetArena(bytes: usize) usize {
    arena.reset();
    input_generation = arena.generation;
    input_start = 0;
    input_end = 0;
    const input = arena.alloc(bytes);
    if (input == 0) {
        return 0;
    }

    input_start = input;
    input_end = input + bytes;
    return input;
}

export fn capacity() usize {
    return @wasmMemorySize(0) * page;
}

/// Convolves per the Params at `address` in the input: the output's
/// address, or 0 where the params are invalid or memory runs out.
export fn convolve(address: usize) usize {
    if (!holds(address, @sizeOf(kernel.Params), @alignOf(kernel.Params))) return 0;
    const p: *const kernel.Params = @ptrFromInt(address);
    if (!kernel.validate(p)) return 0;
    const count: usize = p.nw * p.nh;
    const taps: usize = p.cols * p.rows;
    if (!holds(p.pixels, count * @sizeOf(u32), @alignOf(u32))) return 0;
    if (!holds(p.matrix, taps * @sizeOf(f64), @alignOf(f64))) return 0;
    const pixels = @as([*]const u32, @ptrFromInt(p.pixels))[0..count];
    const matrix = @as([*]const f64, @ptrFromInt(p.matrix))[0..taps];
    const out = kernel.convolve(arena.allocator, p, pixels, matrix) catch return 0;
    return @intFromPtr(out.ptr);
}
