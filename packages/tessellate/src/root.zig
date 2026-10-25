// libtess2 for wasm32-freestanding. The host resets this bounded bump arena
// before each fill and copies the resulting geometry into owned buffers.
// The vendored C uses its allocator callbacks; libc allocation and longjmp
// are provided here so no C wrapper or libc is needed.
const std = @import("std");
const c = @import("c");
const joining = @import("contours.zig");

pub const panic = std.debug.no_panic;

extern var __heap_base: u8;
extern "env" fn failure(code: c_int) noreturn;

const page = 65536;
var base: usize = 0;
var top: usize = 0;
var spent: usize = 0;
// Absolute address ceiling, including static data and the C stack.
var ceiling: usize = 128 << 20;
var tess: ?*c.TESStesselator = null;
var joined = [_]u32{ 0, 0, 0, 0 };

export fn reset() void {
    if (base == 0) {
        base = std.mem.alignForward(usize, @intFromPtr(&__heap_base), 16);
    }

    top = base;
    spent = 0;
    tess = null;
    joined = .{ 0, 0, 0, 0 };
}

export fn setLimit(n: usize) void {
    ceiling = n;
}

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

export fn alloc(n: usize) usize {
    const start = std.mem.alignForward(u64, top, 16);
    const end = start + 16 + n;
    if (!reserve(end)) {
        return 0;
    }

    // The header lets realloc copy precisely the preceding allocation.
    const header: *usize = @ptrFromInt(@as(usize, @intCast(start)));
    header.* = n;
    top = @intCast(end);
    spent += n;
    return @intCast(start + 16);
}

export fn malloc(n: usize) ?*anyopaque {
    return @ptrFromInt(alloc(n));
}

export fn free(_: ?*anyopaque) void {}

export fn realloc(p: ?*anyopaque, n: usize) ?*anyopaque {
    if (p) |old| {
        const address = @intFromPtr(old);
        const header: *usize = @ptrFromInt(address - 16);
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
        const header: *const usize = @ptrFromInt(@intFromPtr(old) - 16);
        const from: [*]const u8 = @ptrCast(old);
        const to: [*]u8 = @ptrFromInt(at);
        const count = @min(header.*, n);
        @memcpy(to[0..count], from[0..count]);
    }

    return @ptrFromInt(at);
}

fn get(_: ?*anyopaque, n: c_uint) callconv(.c) ?*anyopaque {
    return malloc(n);
}

fn grow(_: ?*anyopaque, p: ?*anyopaque, n: c_uint) callconv(.c) ?*anyopaque {
    return realloc(p, n);
}

fn drop(_: ?*anyopaque, _: ?*anyopaque) callconv(.c) void {}

// The host catches this exception and discards the instance. It must never
// resume an arena whose C stack was unwound without real setjmp support.
export fn longjmp(_: ?*anyopaque, code: c_int) noreturn {
    failure(code);
}

export fn highWater() usize {
    return top - base;
}

export fn allocated() usize {
    // Diagnostic payload bytes reserved since reset, excluding headers and alignment.
    return spent;
}

// A descriptor keeps output access to one call; all views are copied before arena reuse.
export fn joinContours(edges: [*]const joining.Edge, count: usize) usize {
    tess = null;
    joined = .{ 0, 0, 0, 0 };
    if (count == 0 or count > 262144) return 0;
    const at = alloc(count * 160 + 65536);
    if (at == 0) return 0;
    const buffer: [*]u8 = @ptrFromInt(at);
    var arena = std.heap.FixedBufferAllocator.init(buffer[0 .. count * 160 + 65536]);
    const result = joining.join(edges[0..count], arena.allocator()) catch return 0;
    joined = .{
        @intFromPtr(result.commands.ptr),
        @intCast(result.commands.len),
        @intFromPtr(result.offsets.ptr),
        @intCast(result.offsets.len - 1),
    };
    return @intFromPtr(&joined);
}

export fn run(coords: [*]const f64, count: usize, ends: [*]const u32, contours: usize, nonzero: i32) i32 {
    tess = null;
    if (contours > 100000 or count > 1000000 or nonzero < 0 or nonzero > 1) {
        return -2;
    }

    for (coords[0 .. count * 2]) |value| {
        if (!std.math.isFinite(value) or value < c.TESS_MIN_VALID_INPUT_VALUE or value > c.TESS_MAX_VALID_INPUT_VALUE) {
            return -2;
        }
    }

    var at: usize = 0;
    for (ends[0..contours]) |end| {
        if (end < at or end > count or end - at < 3) {
            return -2;
        }

        at = end;
    }

    if (at != count) {
        return -2;
    }

    var allocator = std.mem.zeroes(c.TESSalloc);
    allocator.memalloc = get;
    allocator.memrealloc = grow;
    allocator.memfree = drop;
    // A small intersection reserve; denser crossings can still grow the queue.
    allocator.extraVertices = @intCast(count / 4 + 16);
    tess = c.tessNewTess(&allocator);
    if (tess == null) {
        return -1;
    }

    at = 0;
    for (ends[0..contours]) |end| {
        c.tessAddContour(tess, 2, coords + at * 2, @sizeOf(f64) * 2, @intCast(end - at));
        at = end;
    }

    const normal = [_]f64{ 0, 0, 1 };
    const rule = if (nonzero == 1) c.TESS_WINDING_NONZERO else c.TESS_WINDING_ODD;
    if (c.tessTesselate(tess, rule, c.TESS_POLYGONS, 3, 2, &normal) == 0) {
        tess = null;
        return -1;
    }

    return 0;
}

export fn vertices() usize {
    return if (tess) |value| @intFromPtr(c.tessGetVertices(value)) else 0;
}

export fn indices() usize {
    return if (tess) |value| @intFromPtr(c.tessGetElements(value)) else 0;
}

export fn vertexCount() u32 {
    return if (tess) |value| @intCast(c.tessGetVertexCount(value)) else 0;
}

export fn triangleCount() u32 {
    return if (tess) |value| @intCast(c.tessGetElementCount(value)) else 0;
}
