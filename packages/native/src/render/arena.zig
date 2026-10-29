//! The one arena all of the module allocates from: the bitmap kernel, libtess2
//! and the lines alike. It bumps up from __heap_base, growing the memory up to
//! a ceiling, and each export that starts a call resets it (reset), so that
//! nothing else in the module grows the memory or hands out its pages. Each
//! allocation follows a 16-byte header that holds its size, which lets the
//! last one grow or shrink where it is and realloc copy precisely.
//!
//! A reset counts a generation: what a call keeps for a later one (an input
//! written between calls, libtess2's output) is good only while the
//! generation is the one it was made in, so an instance that calls another
//! of the module's families in between reads none of it.
const std = @import("std");

extern var __heap_base: u8;

const page = 65536;
const header_size = 16;

var base: usize = 0;
pub var top: usize = 0;
var spent: usize = 0;
/// Absolute address ceiling, including static data and the C stack.
var ceiling: usize = 128 << 20;
pub var generation: u32 = 0;

/// Everything allocated let go of, for the call about to start.
pub fn reset() void {
    if (base == 0) {
        base = std.mem.alignForward(usize, @intFromPtr(&__heap_base), 16);
    }

    top = base;
    spent = 0;
    generation +%= 1;
}

export fn setLimit(n: usize) void {
    ceiling = n;
}

/// The memory grown to hold up to `end`, within the ceiling.
fn reserve(end: u64) bool {
    if (end > ceiling) {
        return false;
    }

    const have = @as(u64, @wasmMemorySize(0)) * page;
    if (end > have and @wasmMemoryGrow(0, @intCast((end - have + page - 1) / page)) < 0) {
        return false;
    }

    return true;
}

/// `n` bytes, 16-aligned, or 0.
pub export fn alloc(n: usize) usize {
    const start = std.mem.alignForward(u64, top, 16);
    const end = start + header_size + n;
    if (!reserve(end)) {
        return 0;
    }

    const header: *usize = @ptrFromInt(@as(usize, @intCast(start)));
    header.* = n;
    top = @intCast(end);
    spent += n;
    return @intCast(start + header_size);
}

pub export fn malloc(n: usize) ?*anyopaque {
    return @ptrFromInt(alloc(n));
}

export fn free(_: ?*anyopaque) void {}

pub export fn realloc(p: ?*anyopaque, n: usize) ?*anyopaque {
    if (p) |old| {
        const address = @intFromPtr(old);
        const header: *usize = @ptrFromInt(address - header_size);
        const previous = header.*;
        if (n <= previous) {
            header.* = n;
            return old;
        }

        if (@as(u64, address) + previous == top) {
            const end = @as(u64, address) + n;
            if (!reserve(end)) {
                return null;
            }

            header.* = n;
            top = @intCast(end);
            spent += n - previous;
            return old;
        }
    }

    const at = alloc(n);
    if (at == 0) {
        return null;
    }

    if (p) |old| {
        const header: *const usize = @ptrFromInt(@intFromPtr(old) - header_size);
        const from: [*]const u8 = @ptrCast(old);
        const to: [*]u8 = @ptrFromInt(at);
        const count = @min(header.*, n);
        @memcpy(to[0..count], from[0..count]);
    }

    return @ptrFromInt(at);
}

export fn highWater() usize {
    return top - base;
}

export fn allocated() usize {
    // Diagnostic payload bytes reserved since reset, excluding headers and alignment.
    return spent;
}

/// The arena as a Zig allocator: 16-byte alignment at most; the last
/// allocation grows, shrinks and frees where it is, any other only shrinks.
pub const allocator: std.mem.Allocator = .{ .ptr = undefined, .vtable = &.{
    .alloc = allocate,
    .resize = resize,
    .remap = remap,
    .free = release,
} };

fn allocate(_: *anyopaque, len: usize, alignment: std.mem.Alignment, _: usize) ?[*]u8 {
    if (alignment.toByteUnits() > 16) {
        return null;
    }

    const at = alloc(len);
    return if (at == 0) null else @ptrFromInt(at);
}

fn resize(_: *anyopaque, memory: []u8, _: std.mem.Alignment, new_len: usize, _: usize) bool {
    const address = @intFromPtr(memory.ptr);
    const header: *usize = @ptrFromInt(address - header_size);
    const last = address + header.* == top;
    if (new_len <= memory.len) {
        if (last) {
            top = address + new_len;
        }

        spent -= header.* - new_len;
        header.* = new_len;
        return true;
    }

    if (!last or !reserve(@as(u64, address) + new_len)) {
        return false;
    }

    spent += new_len - header.*;
    header.* = new_len;
    top = address + new_len;
    return true;
}

fn remap(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, return_address: usize) ?[*]u8 {
    return if (resize(context, memory, alignment, new_len, return_address)) memory.ptr else null;
}

fn release(_: *anyopaque, memory: []u8, _: std.mem.Alignment, _: usize) void {
    const address = @intFromPtr(memory.ptr);
    const header: *usize = @ptrFromInt(address - header_size);
    if (address + header.* == top) {
        top = address - header_size;
        spent -= header.*;
    }
}
