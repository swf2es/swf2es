//! JPEG XR decoding for ATF textures: jxrlib's decoder and its glue,
//! compiled unchanged beside jxr.c, behind the few calls index.ts makes.
//! Each call works in a bump arena that the host resets first; jxrlib's
//! malloc, calloc and realloc take from it, and its free returns nothing,
//! since the arena goes as a whole at the next reset.
const std = @import("std");

pub const panic = std.debug.no_panic;

const page = 65536;

// Statuses, as jxr.c's; a call returns one.
const DONE = 0;

var base: usize = 0;
var top: usize = 0;

var result: usize = 0;
var result_width: u32 = 0;
var result_height: u32 = 0;

extern fn swf2es_jxr_decode(data: [*]const u8, size: usize, format: c_int, limit: c_uint, out: *[*]u8, width: *c_uint, height: *c_uint) c_int;

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
    result_width = 0;
    result_height = 0;
}

/// `n` bytes, 16-aligned, growing memory as needed; 0 when it cannot.
export fn alloc(n: usize) usize {
    if (base == 0) {
        reset();
    }

    const start = std.mem.alignForward(u64, top, 16);
    if (!reserve(start +| n)) {
        return 0;
    }

    top = @intCast(start + n);
    return @intCast(start);
}

// Each block of jxrlib's carries its size 16 bytes before it, for realloc.
const header = 16;

export fn malloc(n: usize) ?*anyopaque {
    const p = alloc(n +| header);
    if (p == 0) {
        return null;
    }

    @as(*usize, @ptrFromInt(p)).* = n;
    return @ptrFromInt(p + header);
}

export fn calloc(count: usize, n: usize) ?*anyopaque {
    const size = std.math.mul(usize, count, n) catch return null;
    const p = malloc(size) orelse return null;
    @memset(@as([*]u8, @ptrCast(p))[0..size], 0);
    return p;
}

export fn realloc(old: ?*anyopaque, n: usize) ?*anyopaque {
    const p = malloc(n) orelse return null;
    if (old) |o| {
        const size = @as(*usize, @ptrFromInt(@intFromPtr(o) - header)).*;
        @memcpy(@as([*]u8, @ptrCast(p))[0..@min(size, n)], @as([*]const u8, @ptrCast(o))[0..@min(size, n)]);
    }

    return p;
}

export fn free(_: ?*anyopaque) void {}

export fn resultPointer() usize {
    return result;
}

export fn resultWidth() u32 {
    return result_width;
}

export fn resultHeight() u32 {
    return result_height;
}

/// Decode the JPEG XR file of `length` bytes at `input`, which must be of
/// `format` (jxr.c's) and at most `limit` pixels a side: its pixels at
/// resultPointer(), top-down rows with no padding.
export fn decodeImage(input: usize, length: usize, format: c_int, limit: c_uint) i32 {
    var out: [*]u8 = undefined;
    var width: c_uint = 0;
    var height: c_uint = 0;
    const status = swf2es_jxr_decode(@ptrFromInt(input), length, format, limit, &out, &width, &height);
    if (status != DONE) {
        return status;
    }

    result = @intFromPtr(out);
    result_width = width;
    result_height = height;
    return DONE;
}
