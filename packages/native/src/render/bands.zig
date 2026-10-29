//! Fills any contours by either rule as trapezoids, where libtess2 refuses
//! them (tessellate.zig): the fill cut at every vertex's height and every
//! height two edges cross at, so that within each band the edges keep their
//! order and each span the rule fills is a trapezoid between two of them.
//! Bands meet along horizontal lines, where one band's corners may fall
//! within the next's edges: without a crack as drawn in the stage's axes,
//! though a turn of the stage, rounding the corners to f32, may leave a
//! hairline there, which the fills libtess2 refuses are rare enough to
//! bear. Its output is libtess2's: positions, two a vertex, and triangles,
//! three indices each.
const std = @import("std");

/// Pairs of edges a call may test for a crossing: more is too slow for a frame.
const most_pairs: u64 = 1 << 26;

pub const Output = struct {
    positions: []const f64,
    indices: []const i32,
};

const Edge = struct {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    /// +1 where the contour runs down the edge, -1 where up.
    winding: i32,

    fn x(self: Edge, y: f64) f64 {
        if (y <= self.y0) {
            return self.x0;
        }

        if (y >= self.y1) {
            return self.x1;
        }

        return self.x0 + (y - self.y0) * (self.x1 - self.x0) / (self.y1 - self.y0);
    }
};

/// An edge's run across a band: where it enters and where it leaves.
const Span = struct {
    top: f64,
    bottom: f64,
    winding: i32,

    fn before(_: void, a: Span, b: Span) bool {
        return a.top + a.bottom < b.top + b.bottom;
    }
};

fn byTop(_: void, a: Edge, b: Edge) bool {
    return a.y0 < b.y0;
}

fn ascending(_: void, a: f64, b: f64) bool {
    return a < b;
}

/// `coords` filled by the non-zero rule or even-odd, each contour ending at
/// its point in `ends`: null where a coordinate is not finite, or memory or
/// the pairs to test run out.
pub fn fill(allocator: std.mem.Allocator, coords: []const f64, ends: []const u32, nonzero: bool) ?Output {
    return build(allocator, coords, ends, nonzero) catch null;
}

fn build(allocator: std.mem.Allocator, coords: []const f64, ends: []const u32, nonzero: bool) !Output {
    for (coords) |value| {
        if (!std.math.isFinite(value)) {
            return error.NotFinite;
        }
    }

    var edges: std.ArrayList(Edge) = .empty;
    var heights: std.ArrayList(f64) = .empty;
    var start: usize = 0;
    for (ends) |end| {
        if (end < start or end > coords.len / 2) {
            return error.Malformed;
        }

        for (start..end) |i| {
            const j = if (i + 1 == end) start else i + 1;
            const ax = coords[i * 2];
            const ay = coords[i * 2 + 1];
            const bx = coords[j * 2];
            const by = coords[j * 2 + 1];
            // A level edge bounds no band: the bands above and below it end at its height.
            if (ay == by) {
                continue;
            }

            try edges.append(allocator, if (ay < by)
                .{ .x0 = ax, .y0 = ay, .x1 = bx, .y1 = by, .winding = 1 }
            else
                .{ .x0 = bx, .y0 = by, .x1 = ax, .y1 = ay, .winding = -1 });
            try heights.appendSlice(allocator, &.{ ay, by });
        }

        start = end;
    }

    // Heap sorts: the least code (pdq's and the stable sort's cost the module tens of kilobytes),
    // and a fallback's speed matters less.
    std.sort.heap(Edge, edges.items, {}, byTop);
    std.sort.heap(f64, heights.items, {}, ascending);

    var positions: std.ArrayList(f64) = .empty;
    var indices: std.ArrayList(i32) = .empty;
    var active: std.ArrayList(Edge) = .empty;
    var spans: std.ArrayList(Span) = .empty;
    var pairs: u64 = 0;
    var next: usize = 0;
    var k: usize = 0;
    while (k + 1 < heights.items.len) : (k += 1) {
        const top = heights.items[k];
        const bottom = heights.items[k + 1];
        if (bottom == top) {
            continue;
        }

        // The edges across this band: those that ended above it go, those that start at its top come in.
        var kept: usize = 0;
        for (active.items) |edge| {
            if (edge.y1 > top) {
                active.items[kept] = edge;
                kept += 1;
            }
        }

        active.shrinkRetainingCapacity(kept);
        while (next < edges.items.len and edges.items[next].y0 <= top) : (next += 1) {
            if (edges.items[next].y1 > top) {
                try active.append(allocator, edges.items[next]);
            }
        }

        // The band cut again at each height two of its edges cross at, the highest first.
        var from = top;
        while (from < bottom) {
            pairs += @as(u64, active.items.len) * active.items.len / 2;
            if (pairs > most_pairs) {
                return error.TooSlow;
            }

            const to = firstCrossing(active.items, from, bottom);
            spans.clearRetainingCapacity();
            for (active.items) |edge| {
                try spans.append(allocator, .{ .top = edge.x(from), .bottom = edge.x(to), .winding = edge.winding });
            }

            std.sort.heap(Span, spans.items, {}, Span.before);
            try trapezoids(allocator, spans.items, from, to, nonzero, &positions, &indices);
            from = to;
        }
    }

    if (positions.items.len / 2 > std.math.maxInt(i32)) {
        return error.TooLarge;
    }

    return .{ .positions = positions.items, .indices = indices.items };
}

/// The highest height below `from` and above `bottom` that two of `edges`
/// cross at, else `bottom`. A crossing too near `from` to make a band of its
/// own is left to the sort, as the edges meet there.
fn firstCrossing(edges: []const Edge, from: f64, bottom: f64) f64 {
    const least = (bottom - from) * 1e-9;
    var to = bottom;
    for (edges, 0..) |a, i| {
        const a_top = a.x(from);
        const a_bottom = a.x(bottom);
        for (edges[i + 1 ..]) |b| {
            const b_top = b.x(from);
            const b_bottom = b.x(bottom);
            const gap_top = a_top - b_top;
            const gap_bottom = a_bottom - b_bottom;
            if (!(gap_top * gap_bottom < 0)) {
                continue;
            }

            const y = from + (bottom - from) * gap_top / (gap_top - gap_bottom);
            if (y > from + least and y < to) {
                to = y;
            }
        }
    }

    return to;
}

/// The spans the rule fills between `spans`, sorted left to right across
/// the band from `top` to `bottom`, as trapezoids: two triangles each, one
/// where a side has come to a point.
fn trapezoids(
    allocator: std.mem.Allocator,
    spans: []const Span,
    top: f64,
    bottom: f64,
    nonzero: bool,
    positions: *std.ArrayList(f64),
    indices: *std.ArrayList(i32),
) !void {
    var winding: i32 = 0;
    for (spans, 0..) |left, i| {
        winding += left.winding;
        const inside = if (nonzero) winding != 0 else (winding & 1) != 0;
        if (!inside or i + 1 == spans.len) {
            continue;
        }

        const right = spans[i + 1];
        const flat_top = left.top == right.top;
        const flat_bottom = left.bottom == right.bottom;
        if (flat_top and flat_bottom) {
            continue;
        }

        const first: i32 = @intCast(positions.items.len / 2);
        try positions.appendSlice(allocator, &.{ left.top, top, right.top, top, right.bottom, bottom, left.bottom, bottom });
        if (!flat_top) {
            try indices.appendSlice(allocator, &.{ first, first + 1, first + 2 });
        }

        if (!flat_bottom) {
            try indices.appendSlice(allocator, &.{ first, first + 2, first + 3 });
        }
    }
}

/// The area `out`'s triangles cover, each counted once.
fn area(out: Output) f64 {
    var sum: f64 = 0;
    var i: usize = 0;
    while (i < out.indices.len) : (i += 3) {
        const a: usize = @intCast(out.indices[i]);
        const b: usize = @intCast(out.indices[i + 1]);
        const c: usize = @intCast(out.indices[i + 2]);
        const p = out.positions;
        sum += @abs((p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[c * 2] - p[a * 2]) * (p[b * 2 + 1] - p[a * 2 + 1])) / 2;
    }

    return sum;
}

test "a square is one trapezoid" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const out = fill(arena.allocator(), &.{ 0, 0, 10, 0, 10, 10, 0, 10 }, &.{4}, true).?;
    try std.testing.expectEqual(@as(usize, 6), out.indices.len);
    try std.testing.expectApproxEqAbs(@as(f64, 100), area(out), 1e-9);
}

test "a concave fill and a hole, by either rule" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    // A U: a 30 by 30 square less the 10 by 20 notch cut down from its top.
    const u = [_]f64{ 0, 0, 10, 0, 10, 20, 20, 20, 20, 0, 30, 0, 30, 30, 0, 30 };
    try std.testing.expectApproxEqAbs(@as(f64, 700), area(fill(arena.allocator(), &u, &.{8}, true).?), 1e-9);
    // A square with a square inside it running the same way: non-zero fills the hole, even-odd leaves it.
    const nested = [_]f64{ 0, 0, 30, 0, 30, 30, 0, 30, 10, 10, 20, 10, 20, 20, 10, 20 };
    try std.testing.expectApproxEqAbs(@as(f64, 900), area(fill(arena.allocator(), &nested, &.{ 4, 8 }, true).?), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 800), area(fill(arena.allocator(), &nested, &.{ 4, 8 }, false).?), 1e-9);
}

test "a bow tie crossing itself" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    // Two triangles meeting at (5, 5), each of area 25, by either rule.
    const bow = [_]f64{ 0, 0, 10, 10, 10, 0, 0, 10 };
    try std.testing.expectApproxEqAbs(@as(f64, 50), area(fill(arena.allocator(), &bow, &.{4}, true).?), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 50), area(fill(arena.allocator(), &bow, &.{4}, false).?), 1e-9);
}

test "a pentagram: non-zero fills its centre, even-odd does not" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var star: [10]f64 = undefined;
    for (0..5) |i| {
        const angle = std.math.pi / 2.0 + @as(f64, @floatFromInt(i * 2)) * 2.0 * std.math.pi / 5.0;
        star[i * 2] = 100 * @cos(angle);
        star[i * 2 + 1] = 100 * @sin(angle);
    }

    const all = area(fill(arena.allocator(), &star, &.{5}, true).?);
    const odd = area(fill(arena.allocator(), &star, &.{5}, false).?);
    // The centre pentagon's area, from the star's: what even-odd leaves out.
    const inner = 100 * @sin(std.math.pi / 10.0) / @sin(7.0 * std.math.pi / 10.0);
    const pentagon = 2.5 * inner * inner * @sin(2.0 * std.math.pi / 5.0);
    try std.testing.expectApproxEqRel(pentagon, all - odd, 1e-9);
}

test "what it refuses" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expect(fill(arena.allocator(), &.{ 0, 0, std.math.nan(f64), 0, 0, 10 }, &.{3}, true) == null);
    try std.testing.expect(fill(arena.allocator(), &.{ 0, 0, 10, 0, 0, 10 }, &.{4}, true) == null);
}
