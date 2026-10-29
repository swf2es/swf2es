// libtess2 for wasm32-freestanding, with the curves of a layer's fills
// flattened first (flatten.zig), and the band filler (bands.zig) for what
// libtess2 refuses or fails at. The host resets the module's bounded bump
// arena (arena.zig) before each call, a fill (run) or a layer's fills (layer), and copies the
// resulting geometry into owned buffers.
// The vendored C uses its allocator callbacks; libc allocation and longjmp
// are provided here so no C wrapper or libc is needed.
const std = @import("std");
const c = @import("c");
const flatten = @import("flatten.zig");
const arena = @import("arena.zig");
const bands = @import("bands.zig");

extern "env" fn failure(code: c_int) noreturn;

/// A fill's positions, two a vertex, and triangles, three indices each.
pub const Output = struct {
    positions: []const f64,
    indices: []const c.TESSindex,
};

/// The last fill's output, libtess2's or the band filler's, in the arena.
var out: ?Output = null;
/// The arena's generation `out` was made in: another's reset leaves it none.
var made_in: u32 = 0;
/// Off once libtess2 has unwound an instance through `failure`: the host
/// then fills the call again in a new instance by the bands alone.
var libtess = true;

export fn reset() void {
    arena.reset();
    out = null;
}

export fn bandsOnly(on: i32) void {
    libtess = on == 0;
}

/// The last fill's output, if no reset has let its memory go since.
pub fn current() ?Output {
    return if (made_in == arena.generation) out else null;
}

/// The last fill's output let go of, its memory the caller's to reuse.
pub fn clear() void {
    out = null;
}

fn get(_: ?*anyopaque, n: c_uint) callconv(.c) ?*anyopaque {
    return arena.malloc(n);
}

fn grow(_: ?*anyopaque, p: ?*anyopaque, n: c_uint) callconv(.c) ?*anyopaque {
    return arena.realloc(p, n);
}

fn drop(_: ?*anyopaque, _: ?*anyopaque) callconv(.c) void {}

// The host catches this exception and discards the instance. It must never
// resume an arena whose C stack was unwound without real setjmp support.
export fn longjmp(_: ?*anyopaque, code: c_int) noreturn {
    failure(code);
}

/// What one fill may hold: more is rejected, as too slow to tessellate in a frame.
const most_contours = 100000;
const most_points = 1000000;

/// Whether a fill's input can be filled: `coords` holds the points `ends`
/// closes contours at, every contour has three points or more, and every
/// coordinate is finite.
fn valid(coords: []const f64, ends: []const u32, nonzero: i32) bool {
    if (ends.len > most_contours or coords.len > most_points * 2 or nonzero < 0 or nonzero > 1) {
        return false;
    }

    for (coords) |value| {
        if (!std.math.isFinite(value)) {
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

/// Tessellates a valid fill into `out`: 0, or -1 where neither libtess2 nor
/// the bands could fill it in the memory left.
fn tessellate(coords: []const f64, ends: []const u32, nonzero: bool) i32 {
    out = null;
    made_in = arena.generation;
    const mark = arena.top;
    // One convex contour, a triangle above all, as a drawing redrawn every frame draws thousands:
    // a fan, which either rule fills alike, and no sweep.
    if (libtess and ends.len == 1) {
        if (fan(coords)) |result| {
            out = result;
            return 0;
        }

        arena.top = mark;
    }

    if (libtess and inRange(coords)) {
        if (libtess2(coords, ends, nonzero)) |result| {
            out = result;
            return 0;
        }

        arena.top = mark;
    }

    // What libtess2 refused, failed at or gave unfit to draw, or the coordinates past its range.
    const result = bands.fill(arena.allocator, coords, ends, nonzero) orelse {
        arena.top = mark;
        return -1;
    };
    out = .{ .positions = result.positions, .indices = result.indices };
    return 0;
}

/// `coords`, one contour, as a fan from its first point, its positions
/// those given: null where the contour is not convex, as where it turns
/// both ways, or turns one way but winds round more than once, which its
/// edges' going back and forth along an axis more than twice shows; or
/// where memory runs out.
fn fan(coords: []const f64) ?Output {
    const n = coords.len / 2;
    if (n < 3) {
        return null;
    }

    var left = false;
    var right = false;
    var x_turns: u32 = 0;
    var y_turns: u32 = 0;
    // The edge before, and the last ways along x and along y, that moved at all.
    var ex: f64 = 0;
    var ey: f64 = 0;
    var sx: f64 = 0;
    var sy: f64 = 0;
    // Round twice, counting on the second: each turn and change of way of the closed contour once.
    for (0..2 * n) |i| {
        const a = i % n;
        const b = (a + 1) % n;
        const dx = coords[b * 2] - coords[a * 2];
        const dy = coords[b * 2 + 1] - coords[a * 2 + 1];
        if (dx == 0 and dy == 0) {
            continue;
        }

        if (i >= n) {
            const cross = ex * dy - ey * dx;
            if (cross > 0) left = true;
            if (cross < 0) right = true;
            if (dx != 0 and sx != 0 and (dx > 0) != (sx > 0)) x_turns += 1;
            if (dy != 0 and sy != 0 and (dy > 0) != (sy > 0)) y_turns += 1;
        }

        ex = dx;
        ey = dy;
        if (dx != 0) sx = dx;
        if (dy != 0) sy = dy;
    }

    if (left and right) {
        return null;
    }

    if (x_turns > 2 or y_turns > 2 or !std.math.isFinite(coords[0])) {
        return null;
    }

    const triangles = arena.allocator.alloc(c.TESSindex, (n - 2) * 3) catch return null;
    for (0..n - 2) |k| {
        triangles[k * 3] = 0;
        triangles[k * 3 + 1] = @intCast(k + 1);
        triangles[k * 3 + 2] = @intCast(k + 2);
    }

    return .{ .positions = coords, .indices = triangles };
}

fn inRange(coords: []const f64) bool {
    for (coords) |value| {
        if (value < c.TESS_MIN_VALID_INPUT_VALUE or value > c.TESS_MAX_VALID_INPUT_VALUE) {
            return false;
        }
    }

    return true;
}

/// libtess2's fill of `coords`, in its memory: null where it fails, or its
/// output is not fit to draw (a coordinate not finite or an index past the
/// vertices).
fn libtess2(coords: []const f64, ends: []const u32, nonzero: bool) ?Output {
    var allocator = std.mem.zeroes(c.TESSalloc);
    allocator.memalloc = get;
    allocator.memrealloc = grow;
    allocator.memfree = drop;
    // A small intersection reserve; denser crossings can still grow the queue.
    allocator.extraVertices = @intCast(coords.len / 8 + 16);
    const t = c.tessNewTess(&allocator) orelse return null;

    var at: usize = 0;
    for (ends) |end| {
        c.tessAddContour(t, 2, coords.ptr + at * 2, @sizeOf(f64) * 2, @intCast(end - at));
        at = end;
    }

    const normal = [_]f64{ 0, 0, 1 };
    const rule = if (nonzero) c.TESS_WINDING_NONZERO else c.TESS_WINDING_ODD;
    if (c.tessTesselate(t, rule, c.TESS_POLYGONS, 3, 2, &normal) == 0) {
        return null;
    }

    const vertex_count: usize = @intCast(c.tessGetVertexCount(t));
    const triangle_count: usize = @intCast(c.tessGetElementCount(t));
    const result: Output = .{
        .positions = c.tessGetVertices(t)[0 .. vertex_count * 2],
        .indices = c.tessGetElements(t)[0 .. triangle_count * 3],
    };
    for (result.positions) |value| {
        if (!std.math.isFinite(value)) {
            return null;
        }
    }

    for (result.indices) |index| {
        if (index < 0 or @as(usize, @intCast(index)) >= vertex_count) {
            return null;
        }
    }

    return result;
}

export fn run(coords: [*]const f64, count: usize, ends: [*]const u32, contours: usize, nonzero: i32) i32 {
    if (contours > most_contours or count > most_points) {
        out = null;
        return -2;
    }

    return fill(coords[0 .. count * 2], ends[0..contours], nonzero);
}

/// run's checks and tessellation of `coords`, each contour ending at its
/// point in `ends`: run's status, its output in `out`.
pub fn fill(coords: []const f64, ends: []const u32, nonzero: i32) i32 {
    out = null;
    if (!valid(coords, ends, nonzero)) {
        return -2;
    }

    return tessellate(coords, ends, nonzero == 1);
}

export fn vertices() usize {
    return if (current()) |value| @intFromPtr(value.positions.ptr) else 0;
}

export fn indices() usize {
    return if (current()) |value| @intFromPtr(value.indices.ptr) else 0;
}

export fn vertexCount() u32 {
    return if (current()) |value| @intCast(value.positions.len / 2) else 0;
}

export fn triangleCount() u32 {
    return if (current()) |value| @intCast(value.indices.len / 3) else 0;
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
    /// run's: 0, -1 where it ran out of memory, which may be the layer's
    /// and is worth trying alone, or -2 where the input was rejected.
    status: i32,
    vertex_start: u32,
    vertex_count: u32,
    index_start: u32,
    index_count: u32,
};

/// A fill's contours, `commands[from..]` up to each of `ends`, flattened
/// (flatten.zig) into the arena and tessellated into `out`: run's status,
/// with `out` left null for a fill of no polygon. Its scratch is the
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

    const points_at = arena.alloc(most * 2 * @sizeOf(f64));
    const kept_at = arena.alloc(ends.len * @sizeOf(u32));
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
        // Fewer than three points enclose nothing.
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
    out = null;
    const head = arena.alloc(@sizeOf(Layer) + count * @sizeOf(Range));
    const kept = arena.alloc(count * @sizeOf(usize));
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
        const mark = arena.top;
        range.status = flattened(commands[0..length], from, own, rules[i]);
        const result = out orelse {
            arena.top = mark;
            continue;
        };
        if (range.status != 0) {
            arena.top = mark;
            out = null;
            continue;
        }

        // Its output, copied past the scratch and then down over it.
        const position_bytes = result.positions.len * @sizeOf(f64);
        const bytes = position_bytes + result.indices.len * @sizeOf(c.TESSindex);
        const staged = arena.alloc(bytes);
        if (staged == 0) {
            range.status = -1;
            arena.top = mark;
            out = null;
            continue;
        }

        const to: [*]u8 = @ptrFromInt(staged);
        @memcpy(to[0..position_bytes], std.mem.sliceAsBytes(result.positions));
        @memcpy(to[position_bytes..bytes], std.mem.sliceAsBytes(result.indices));
        const at = std.mem.alignForward(usize, mark, 16);
        @memmove(@as([*]u8, @ptrFromInt(at))[0..bytes], to[0..bytes]);
        arena.top = at + bytes;
        out = null;

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
    const positions = arena.alloc(@intCast(vertex_total * 2 * @sizeOf(f64)));
    const indices_at = arena.alloc(@intCast(index_total * index_size));
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
