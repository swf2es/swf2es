//! The Wasm module bitmap.ts loads: a bump arena the caller resets before
//! each call, and convolve.zig's kernel over the input written into it.
const std = @import("std");
const kernel = @import("convolve.zig");

pub const panic = std.debug.no_panic;
extern var __heap_base: u8;
const page = 65536;

/// One call's memory: the input from resetArena, then the kernel's scratch
/// and output, all freed together by the next resetArena.
const arena = struct {
    var top: usize = 0;
    var input_start: usize = 0;
    var input_end: usize = 0;

    const allocator: std.mem.Allocator = .{ .ptr = undefined, .vtable = &.{
        .alloc = alloc,
        .resize = std.mem.Allocator.noResize,
        .remap = std.mem.Allocator.noRemap,
        .free = std.mem.Allocator.noFree,
    } };

    fn reserve(end: usize) bool {
        if (end > kernel.memory_limit) return false;
        const have = @wasmMemorySize(0) * page;
        return end <= have or @wasmMemoryGrow(0, (end - have + page - 1) / page) >= 0;
    }

    fn alloc(_: *anyopaque, len: usize, alignment: std.mem.Alignment, _: usize) ?[*]u8 {
        const at = alignment.forward(top);
        const end = std.math.add(usize, at, len) catch return null;
        if (!reserve(end)) return null;
        top = end;
        return @ptrFromInt(at);
    }

    /// Whether [at, at + bytes) lies in the input and is aligned.
    fn holds(at: usize, bytes: usize, alignment: usize) bool {
        return at >= input_start and at <= input_end and at % alignment == 0 and bytes <= input_end - at;
    }
};

/// Frees everything the last call allocated and reserves `bytes` of input
/// for the next, returning its address or 0 where memory cannot grow.
export fn resetArena(bytes: usize) usize {
    arena.top = std.mem.alignForward(usize, @intFromPtr(&__heap_base), 16);
    arena.input_start = arena.top;
    arena.input_end = arena.top;
    const input = arena.allocator.alloc(u8, bytes) catch return 0;
    arena.input_end = arena.top;
    return @intFromPtr(input.ptr);
}

export fn capacity() usize {
    return @wasmMemorySize(0) * page;
}

/// Convolves per the Params at `address` in the input: the output's
/// address, or 0 where the params are invalid or memory runs out.
export fn convolve(address: usize) usize {
    if (!arena.holds(address, @sizeOf(kernel.Params), @alignOf(kernel.Params))) return 0;
    const p: *const kernel.Params = @ptrFromInt(address);
    if (!kernel.validate(p)) return 0;
    const count: usize = p.nw * p.nh;
    const taps: usize = p.cols * p.rows;
    if (!arena.holds(p.pixels, count * @sizeOf(u32), @alignOf(u32))) return 0;
    if (!arena.holds(p.matrix, taps * @sizeOf(f64), @alignOf(f64))) return 0;
    const pixels = @as([*]const u32, @ptrFromInt(p.pixels))[0..count];
    const matrix = @as([*]const f64, @ptrFromInt(p.matrix))[0..taps];
    const out = kernel.convolve(arena.allocator, p, pixels, matrix) catch return 0;
    return @intFromPtr(out.ptr);
}
