// libtess2 for wasm32-freestanding, with the curves of a layer's fills
// flattened first (flatten.zig). The host resets this bounded bump arena
// before each call, a fill (run) or a layer's fills (layer), and copies the
// resulting geometry into owned buffers.
// The vendored C uses its allocator callbacks; libc allocation and longjmp
// are provided here so no C wrapper or libc is needed.
const std = @import("std");
const c = @import("c");
const flatten = @import("flatten.zig");

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

export fn reset() void {
    if (base == 0) {
        base = std.mem.alignForward(usize, @intFromPtr(&__heap_base), 16);
    }

    top = base;
    spent = 0;
    tess = null;
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

/// What one fill may hold: more is rejected, as too slow to tessellate in a frame.
const most_contours = 100000;
const most_points = 1000000;

/// Whether a fill's input is fit for libtess2: `coords` holds the points
/// `ends` closes contours at, every contour has three points or more, and
/// every coordinate is finite and within libtess2's range.
fn valid(coords: []const f64, ends: []const u32, nonzero: i32) bool {
    if (ends.len > most_contours or coords.len > most_points * 2 or nonzero < 0 or nonzero > 1) {
        return false;
    }

    for (coords) |value| {
        if (!std.math.isFinite(value) or value < c.TESS_MIN_VALID_INPUT_VALUE or value > c.TESS_MAX_VALID_INPUT_VALUE) {
            return false;
        }
    }

    var at: usize = 0;
    for (ends) |end| {
        if (end < at or end > coords.len / 2 or end - at < 3) {
            return false;
        }

        at = end;
    }

    return at == coords.len / 2;
}

/// Tessellates a valid fill into `tess`: 0, -1 where libtess2 fails, or -3
/// where its output is not fit to draw (a coordinate not finite or an index
/// past the vertices), which the host then fills itself.
fn tessellate(coords: []const f64, ends: []const u32, nonzero: bool) i32 {
    var allocator = std.mem.zeroes(c.TESSalloc);
    allocator.memalloc = get;
    allocator.memrealloc = grow;
    allocator.memfree = drop;
    // A small intersection reserve; denser crossings can still grow the queue.
    allocator.extraVertices = @intCast(coords.len / 8 + 16);
    tess = c.tessNewTess(&allocator);
    const t = tess orelse return -1;

    var at: usize = 0;
    for (ends) |end| {
        c.tessAddContour(t, 2, coords.ptr + at * 2, @sizeOf(f64) * 2, @intCast(end - at));
        at = end;
    }

    const normal = [_]f64{ 0, 0, 1 };
    const rule = if (nonzero) c.TESS_WINDING_NONZERO else c.TESS_WINDING_ODD;
    if (c.tessTesselate(t, rule, c.TESS_POLYGONS, 3, 2, &normal) == 0) {
        tess = null;
        return -1;
    }

    const result = output(t);
    for (result.positions) |value| {
        if (!std.math.isFinite(value)) {
            tess = null;
            return -3;
        }
    }

    for (result.indices) |index| {
        if (index < 0 or @as(usize, @intCast(index)) >= result.positions.len / 2) {
            tess = null;
            return -3;
        }
    }

    return 0;
}

/// A successful tessellation's positions and triangles, in libtess2's memory.
fn output(t: *c.TESStesselator) struct { positions: []const f64, indices: []const c.TESSindex } {
    const vertex_count: usize = @intCast(c.tessGetVertexCount(t));
    const triangle_count: usize = @intCast(c.tessGetElementCount(t));
    return .{
        .positions = c.tessGetVertices(t)[0 .. vertex_count * 2],
        .indices = c.tessGetElements(t)[0 .. triangle_count * 3],
    };
}

export fn run(coords: [*]const f64, count: usize, ends: [*]const u32, contours: usize, nonzero: i32) i32 {
    tess = null;
    if (contours > most_contours or count > most_points or !valid(coords[0 .. count * 2], ends[0..contours], nonzero)) {
        return -2;
    }

    return tessellate(coords[0 .. count * 2], ends[0..contours], nonzero == 1);
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

/// A layer's output (layer), followed in memory by a Range for each fill.
const Layer = extern struct {
    /// The fills' positions, x then y, one fill after another.
    positions: u32,
    /// Their triangles, each index counted from the layer's first vertex.
    indices: u32,
    vertex_count: u32,
    index_count: u32,
    /// 2 through 65,536 vertices, else 4: the host's rule for a fill's indices.
    index_size: u32,
};

/// Where a fill's output lies in its layer's.
const Range = extern struct {
    /// run's: 0, -1 where libtess2 failed, which may be the layer's memory
    /// and is worth trying alone, -2 where the input was rejected, or -3.
    status: i32,
    vertex_start: u32,
    vertex_count: u32,
    index_start: u32,
    index_count: u32,
};

/// A fill's contours, `commands[from..]` up to each of `ends`, flattened
/// (flatten.zig) into the arena and tessellated into `tess`: run's status,
/// with `tess` left null for a fill of no polygon. Its scratch is the
/// caller's to let go.
fn flattened(commands: []const f64, from: usize, ends: []const u32, rule: u8) i32 {
    if (ends.len > most_contours) {
        return -2;
    }

    var most: usize = 0;
    var start = from;
    for (ends) |end| {
        most += flatten.bound(commands[start..end]) orelse return -2;
        if (most > most_points) {
            return -2;
        }

        start = end;
    }

    const points_at = alloc(most * 2 * @sizeOf(f64));
    const kept_at = alloc(ends.len * @sizeOf(u32));
    if (points_at == 0 or kept_at == 0) {
        return -1;
    }

    const points = @as([*]f64, @ptrFromInt(points_at))[0 .. most * 2];
    const kept = @as([*]u32, @ptrFromInt(kept_at))[0..ends.len];
    var written: usize = 0;
    var contours: usize = 0;
    start = from;
    for (ends) |end| {
        const added = flatten.polygon(commands[start..end], points[written * 2 ..]);
        start = end;
        // Fewer than three points enclose nothing, and the JS fill leaves them out too.
        if (added >= 3) {
            written += added;
            kept[contours] = @intCast(written);
            contours += 1;
        }
    }

    const coords = points[0 .. written * 2];
    if (!valid(coords, kept[0..contours], rule)) {
        return -2;
    }

    if (contours == 0) {
        return 0;
    }

    return tessellate(coords, kept[0..contours], rule == 1);
}

/// Tessellates every fill of a layer in one call, as run would each
/// alone once flatten.zig has flattened its contours: `count` fills, the
/// contours of fill i ending at `ends[fills[i - 1]..fills[i]]`, each end
/// counted in f64s from the start of `commands`, where each contour's path
/// commands follow the last's, and its rule in `rules[i]`. Each fill's
/// scratch goes once its output is kept. Returns the Layer's address, or 0
/// where the arguments disagree or the layer's own output does not fit, for
/// the host to try each fill alone.
export fn layer(commands: [*]const f64, length: usize, ends: [*]const u32, contours: usize, fills: [*]const u32, rules: [*]const u8, count: usize) usize {
    tess = null;
    const head = alloc(@sizeOf(Layer) + count * @sizeOf(Range));
    const kept = alloc(count * @sizeOf(usize));
    if (head == 0 or kept == 0) {
        return 0;
    }

    const ranges = @as([*]Range, @ptrFromInt(head + @sizeOf(Layer)))[0..count];
    const chunks = @as([*]usize, @ptrFromInt(kept))[0..count];
    var command: usize = 0;
    var contour: usize = 0;
    var vertex_total: u64 = 0;
    var index_total: u64 = 0;
    for (ranges, chunks, 0..) |*range, *chunk, i| {
        const last = fills[i];
        if (last < contour or last > contours) {
            return 0;
        }

        const own = ends[contour..last];
        contour = last;
        const from = command;
        for (own) |end| {
            if (end < command or end > length) {
                return 0;
            }

            command = end;
        }

        range.* = .{ .status = 0, .vertex_start = 0, .vertex_count = 0, .index_start = 0, .index_count = 0 };
        chunk.* = 0;
        const mark = top;
        range.status = flattened(commands[0..length], from, own, rules[i]);
        if (range.status != 0 or tess == null) {
            top = mark;
            tess = null;
            continue;
        }

        // Its output, copied past the scratch and then down over it.
        const result = output(tess.?);
        const position_bytes = result.positions.len * @sizeOf(f64);
        const bytes = position_bytes + result.indices.len * @sizeOf(c.TESSindex);
        const staged = alloc(bytes);
        if (staged == 0) {
            range.status = -1;
            top = mark;
            tess = null;
            continue;
        }

        const to: [*]u8 = @ptrFromInt(staged);
        @memcpy(to[0..position_bytes], std.mem.sliceAsBytes(result.positions));
        @memcpy(to[position_bytes..bytes], std.mem.sliceAsBytes(result.indices));
        const at = std.mem.alignForward(usize, mark, 16);
        @memmove(@as([*]u8, @ptrFromInt(at))[0..bytes], to[0..bytes]);
        top = at + bytes;
        tess = null;

        chunk.* = at;
        range.vertex_start = @intCast(vertex_total);
        range.vertex_count = @intCast(result.positions.len / 2);
        range.index_start = @intCast(index_total);
        range.index_count = @intCast(result.indices.len);
        vertex_total += range.vertex_count;
        index_total += range.index_count;
    }

    if (command != length or contour != contours or vertex_total > std.math.maxInt(u32)) {
        return 0;
    }

    const index_size: usize = if (vertex_total <= 0x10000) 2 else 4;
    const positions = alloc(@intCast(vertex_total * 2 * @sizeOf(f64)));
    const indices_at = alloc(@intCast(index_total * index_size));
    if (positions == 0 or indices_at == 0) {
        return 0;
    }

    const all_positions = @as([*]f64, @ptrFromInt(positions));
    for (ranges, chunks) |range, chunk| {
        if (chunk == 0) {
            continue;
        }

        const from = @as([*]const f64, @ptrFromInt(chunk))[0 .. range.vertex_count * 2];
        @memcpy(all_positions[range.vertex_start * 2 ..][0..from.len], from);
        const local = @as([*]const c.TESSindex, @ptrFromInt(chunk + from.len * @sizeOf(f64)))[0..range.index_count];
        if (index_size == 2) {
            gather(u16, @as([*]u16, @ptrFromInt(indices_at))[range.index_start..][0..local.len], local, range.vertex_start);
        } else {
            gather(u32, @as([*]u32, @ptrFromInt(indices_at))[range.index_start..][0..local.len], local, range.vertex_start);
        }
    }

    const header: *Layer = @ptrFromInt(head);
    header.* = .{
        .positions = @intCast(positions),
        .indices = @intCast(indices_at),
        .vertex_count = @intCast(vertex_total),
        .index_count = @intCast(index_total),
        .index_size = @intCast(index_size),
    };
    return head;
}

/// A fill's indices, checked in range by tessellate, counted from the layer's first vertex.
fn gather(comptime T: type, to: []T, from: []const c.TESSindex, start: u32) void {
    for (to, from) |*index, local| {
        index.* = @intCast(@as(u32, @intCast(local)) + start);
    }
}
