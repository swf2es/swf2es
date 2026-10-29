//! What the bitmap kernels' wrapper (bitmap-kernel.ts) calls: the module's
//! arena (arena.zig), which resetArena resets before each call, and
//! convolve.zig's, blur.zig's and pixels.zig's kernels over the input
//! written into it.
const std = @import("std");
const kernel = @import("convolve.zig");
const filters = @import("blur.zig");
const ops = @import("pixels.zig");
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

/// The destination and source rows a copy's params name, within the input: null where they are not.
fn copyRows(r: ops.Rows) ?struct { dst: [*]u32, src: [*]u32 } {
    if (r.transparent > 1 or r.unused != 0) return null;
    const dst_bytes = ops.rowsBytes(r.w, r.h, r.dst_stride) orelse return null;
    const src_bytes = ops.rowsBytes(r.w, r.h, r.src_stride) orelse return null;
    if (!holds(r.dst, dst_bytes, 4) or !holds(r.src, src_bytes, 4)) return null;
    return .{ .dst = @ptrFromInt(r.dst), .src = @ptrFromInt(r.src) };
}

/// copyChannel over the rows the ChannelParams at `address` name: 1, or 0 where they are invalid.
export fn channelPixels(address: usize) usize {
    if (!holds(address, @sizeOf(ops.ChannelParams), @alignOf(ops.ChannelParams))) return 0;
    const p = @as(*const ops.ChannelParams, @ptrFromInt(address)).*;
    const shifts = [_]i32{ -1, 0, 8, 16, 24 };
    if (std.mem.indexOfScalar(i32, &shifts, p.from) == null or p.to > 24 or p.to % 8 != 0) return 0;
    const rows = copyRows(p.rows) orelse return 0;
    ops.copyChannel(rows.dst, rows.src, &p);
    return 1;
}

/// merge over the rows the MergeParams at `address` name: 1, or 0 where they are invalid.
export fn mergePixels(address: usize) usize {
    if (!holds(address, @sizeOf(ops.MergeParams), @alignOf(ops.MergeParams))) return 0;
    const p = @as(*const ops.MergeParams, @ptrFromInt(address)).*;
    const rows = copyRows(p.rows) orelse return 0;
    ops.merge(rows.dst, rows.src, &p);
    return 1;
}

/// paletteMap over the rows the PaletteParams at `address` name: 1, or 0 where they are invalid.
export fn palettePixels(address: usize) usize {
    if (!holds(address, @sizeOf(ops.PaletteParams), @alignOf(ops.PaletteParams))) return 0;
    const p = @as(*const ops.PaletteParams, @ptrFromInt(address)).*;
    if (p.unused != 0 or !holds(p.tables, 1024 * 4, 4)) return 0;
    const rows = copyRows(p.rows) orelse return 0;
    ops.paletteMap(rows.dst, rows.src, &p, @ptrFromInt(p.tables));
    return 1;
}

/// A colour matrix over the rows the MatrixParams at `address` name: 1, or 0 where they are invalid.
export fn matrixPixels(address: usize) usize {
    if (!holds(address, @sizeOf(ops.MatrixParams), @alignOf(ops.MatrixParams))) return 0;
    const p = @as(*const ops.MatrixParams, @ptrFromInt(address)).*;
    if (p.unused != 0) return 0;
    const rows = copyRows(p.rows) orelse return 0;
    ops.colorMatrix(rows.dst, rows.src, &p);
    return 1;
}

/// colorTransform over the pixels the TransformParams at `address` name, in place: 1, or 0 where they are invalid.
export fn transformPixels(address: usize) usize {
    if (!holds(address, @sizeOf(ops.TransformParams), @alignOf(ops.TransformParams))) return 0;
    const p = @as(*const ops.TransformParams, @ptrFromInt(address)).*;
    const bytes = ops.rowsBytes(p.w, p.h, p.stride) orelse return 0;
    if (!holds(p.pixels, bytes, 4)) return 0;
    ops.colorTransform(@ptrFromInt(p.pixels), &p);
    return 1;
}

/// noise over the pixels the NoiseParams at `address` name: the generator's
/// state after them (never 0), or 0 where they are invalid.
export fn noisePixels(address: usize) usize {
    if (!holds(address, @sizeOf(ops.NoiseParams), @alignOf(ops.NoiseParams))) return 0;
    const p = @as(*const ops.NoiseParams, @ptrFromInt(address)).*;
    if (p.state == 0 or p.state >= 2147483647 or p.lo > 255 or p.span > 256 or p.channels > 15 or p.gray > 1 or p.transparent > 1) return 0;
    const bytes = ops.bytesOf(p.count, 4) orelse return 0;
    if (p.count == 0 or !holds(p.pixels, bytes, 4)) return 0;
    return ops.noise(@as([*]u32, @ptrFromInt(p.pixels))[0..p.count], &p);
}

/// perlinNoise over the rows the PerlinParams at `address` name: 1, or 0 where they are invalid.
export fn perlinPixels(address: usize) usize {
    if (!holds(address, @sizeOf(ops.PerlinParams), @alignOf(ops.PerlinParams))) return 0;
    const p = @as(*const ops.PerlinParams, @ptrFromInt(address)).*;
    if (p.channels > 15 or p.gray > 1 or p.fractal > 1 or p.stitch > 1 or p.transparent > 1 or p.unused != 0) return 0;
    const bytes = ops.rowsBytes(p.w, p.h, p.w) orelse return 0;
    const offset_bytes = ops.bytesOf(p.octaves, 16) orelse return 0;
    if (!holds(p.pixels, bytes, 4)) return 0;
    if (!holds(p.lattice, ops.LATTICE * 4, 4)) return 0;
    if (!holds(p.gradients, ops.LATTICE * 2 * 4 * 8, 8)) return 0;
    if (!holds(p.offsets, offset_bytes, 8)) return 0;
    const lattice = @as([*]const i32, @ptrFromInt(p.lattice))[0..ops.LATTICE];
    // The lattice indexes itself and the gradients: every entry a cell of 256.
    for (lattice) |v| {
        if (v < 0 or v > 255) return 0;
    }

    ops.perlin(
        @as([*]u32, @ptrFromInt(p.pixels))[0 .. bytes / 4],
        &p,
        lattice,
        @as([*]const f64, @ptrFromInt(p.gradients))[0 .. ops.LATTICE * 2 * 4],
        @as([*]const f64, @ptrFromInt(p.offsets))[0 .. offset_bytes / 8],
    );
    return 1;
}
