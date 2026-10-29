//! What the bitmap kernels' wrapper (bitmap-kernel.ts) calls: the module's
//! arena (arena.zig), which resetArena resets before each call, and
//! convolve.zig's and blur.zig's kernels over the input written into it.
const std = @import("std");
const kernel = @import("convolve.zig");
const filters = @import("blur.zig");
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

/// Blurs the pixels the BlurParams at `address` name, in place: their
/// address, or 0 where the params are invalid or memory runs out.
export fn blurFilter(address: usize) usize {
    if (!holds(address, @sizeOf(filters.BlurParams), @alignOf(filters.BlurParams))) return 0;
    // A copy, which the blocks the call writes into, wherever they lie in the input, leave be.
    const params = @as(*const filters.BlurParams, @ptrFromInt(address)).*;
    const p = &params;
    if (!filters.validBlur(p)) return 0;
    const count = @as(usize, p.w) * p.h;
    if (!holds(p.pixels, count * @sizeOf(u32), @alignOf(u32))) return 0;
    const pixels = @as([*]u32, @ptrFromInt(p.pixels))[0..count];
    filters.blurPixels(arena.allocator, pixels, p) catch return 0;
    return p.pixels;
}

/// Places the layer the LayerParams at `address` describe over its pixels,
/// in place: their address, or 0 where the params are invalid or memory
/// runs out.
export fn layerFilter(address: usize) usize {
    if (!holds(address, @sizeOf(filters.LayerParams), @alignOf(filters.LayerParams))) return 0;
    // A copy, which the blocks the call writes into, wherever they lie in the input, leave be.
    const params = @as(*const filters.LayerParams, @ptrFromInt(address)).*;
    const p = &params;
    if (!filters.validLayer(p)) return 0;
    const count = @as(usize, p.w) * p.h;
    if (!holds(p.pixels, count * @sizeOf(u32), @alignOf(u32))) return 0;
    var reads: [2][]u8 = .{ &.{}, &.{} };
    for (0..p.reads) |k| {
        const r = p.read[k];
        const n = @as(usize, r.rw) * r.rh;
        if (!holds(r.alpha, n, 1)) return 0;
        reads[k] = @as([*]u8, @ptrFromInt(r.alpha))[0..n];
    }

    const gradient = p.kind == .gradient_glow or p.kind == .gradient_bevel;
    if (gradient and !holds(p.table, 256 * @sizeOf(u32), @alignOf(u32))) return 0;
    const table: []const u32 = if (gradient) @as([*]const u32, @ptrFromInt(p.table))[0..256] else &.{};
    const pixels = @as([*]u32, @ptrFromInt(p.pixels))[0..count];
    filters.layer(arena.allocator, pixels, reads[0..p.reads], p, table) catch return 0;
    return p.pixels;
}
