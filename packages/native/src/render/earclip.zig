// Small simple contours need neither a sweep nor new vertices. Reject
// anything whose simplicity or next ear cannot be established.
const std = @import("std");

const most_points = 64;
const Point = struct { x: f64, y: f64 };
const Bounds = struct {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,

    fn edge(a: Point, b: Point) Bounds {
        return .{ .min_x = @min(a.x, b.x), .max_x = @max(a.x, b.x), .min_y = @min(a.y, b.y), .max_y = @max(a.y, b.y) };
    }

    fn separated(a: Bounds, b: Bounds) bool {
        return a.max_x < b.min_x or b.max_x < a.min_x or a.max_y < b.min_y or b.max_y < a.min_y;
    }
};

fn turn(a: Point, b: Point, c: Point) ?f64 {
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return if (std.math.isFinite(cross)) cross else null;
}

/// Indices into the original points, or null to use the general filler.
/// The caller releases allocations on failure, including a partial triangulation.
pub fn fill(allocator: std.mem.Allocator, coords: []const f64) ?[]const i32 {
    const n = coords.len / 2;
    if (coords.len % 2 != 0 or n < 3 or n > most_points) {
        return null;
    }

    var points: [most_points]Point = undefined;
    var links: [most_points]usize = undefined;
    var bounds: [most_points]Bounds = undefined;
    var first: usize = 0;
    for (0..n) |i| {
        const p: Point = .{ .x = coords[i * 2], .y = coords[i * 2 + 1] };
        if (!std.math.isFinite(p.x) or !std.math.isFinite(p.y)) {
            return null;
        }

        points[i] = p;
        links[i] = (i + 1) % n;
        if (p.x < points[first].x or (p.x == points[first].x and p.y < points[first].y)) {
            first = i;
        }
    }

    for (0..n) |i| {
        bounds[i] = Bounds.edge(points[i], points[links[i]]);
    }

    for (0..n) |i| {
        const a = points[i];
        const b = points[links[i]];
        if (a.x == b.x and a.y == b.y) {
            return null;
        }

        const c = points[links[links[i]]];
        const cross = turn(a, b, c) orelse return null;
        // Adjacent edges may share only their endpoint, including along a straight run.
        if (cross == 0 and ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) <= 0) {
            return null;
        }

        for (i + 1..n) |j| {
            if (j == i + 1 or (i == 0 and j == n - 1)) {
                continue;
            }

            if (bounds[i].separated(bounds[j])) {
                continue;
            }

            const d = points[j];
            const e = points[links[j]];
            const p = turn(a, b, d) orelse return null;
            const q = turn(a, b, e) orelse return null;
            const r = turn(d, e, a) orelse return null;
            const s = turn(d, e, b) orelse return null;
            // Inclusive: touching and collinear overlap also belong to the general filler.
            if (p == 0 or q == 0 or r == 0 or s == 0 or ((p > 0) != (q > 0) and (r > 0) != (s > 0))) {
                return null;
            }
        }
    }

    // The lowest of the leftmost points is a convex corner of a simple polygon.
    const corner = turn(points[(first + n - 1) % n], points[first], points[links[first]]) orelse return null;
    if (corner == 0) {
        return null;
    }

    const sign: f64 = if (corner > 0) 1 else -1;
    const indices = allocator.alloc(i32, (n - 2) * 3) catch return null;
    var remaining = n;
    var written: usize = 0;
    var a: usize = first;
    var missed: usize = 0;
    while (remaining > 3) {
        const b = links[a];
        const c = links[b];
        const cross = turn(points[a], points[b], points[c]) orelse return null;
        var ear = cross * sign > 0;
        if (ear) {
            const min_x = @min(points[a].x, @min(points[b].x, points[c].x));
            const max_x = @max(points[a].x, @max(points[b].x, points[c].x));
            const min_y = @min(points[a].y, @min(points[b].y, points[c].y));
            const max_y = @max(points[a].y, @max(points[b].y, points[c].y));
            var p = links[c];
            while (p != a) : (p = links[p]) {
                const point = points[p];
                if (point.x < min_x or point.x > max_x or point.y < min_y or point.y > max_y) {
                    continue;
                }

                const p0 = turn(points[a], points[b], point) orelse return null;
                const p1 = turn(points[b], points[c], point) orelse return null;
                const p2 = turn(points[c], points[a], point) orelse return null;
                if (p0 * sign >= 0 and p1 * sign >= 0 and p2 * sign >= 0) {
                    ear = false;
                    break;
                }
            }
        }

        if (ear) {
            indices[written..][0..3].* = .{ @intCast(a), @intCast(b), @intCast(c) };
            written += 3;
            links[a] = c;
            remaining -= 1;
            missed = 0;
        } else {
            missed += 1;
            if (missed == remaining) {
                return null;
            }
        }

        a = links[a];
    }

    const b = links[a];
    const c = links[b];
    const cross = turn(points[a], points[b], points[c]) orelse return null;
    if (cross * sign < 0) {
        return null;
    }

    indices[written..][0..3].* = .{ @intCast(a), @intCast(b), @intCast(c) };
    return indices;
}

fn inside(coords: []const f64, p: Point) bool {
    var winding: i32 = 0;
    const n = coords.len / 2;
    for (0..n) |i| {
        const j = (i + 1) % n;
        const a: Point = .{ .x = coords[i * 2], .y = coords[i * 2 + 1] };
        const b: Point = .{ .x = coords[j * 2], .y = coords[j * 2 + 1] };
        const cross = turn(a, b, p).?;
        if (a.y <= p.y and b.y > p.y and cross > 0) {
            winding += 1;
        }
        if (a.y > p.y and b.y <= p.y and cross < 0) {
            winding -= 1;
        }
    }

    return winding != 0;
}

fn check(coords: []const f64) !void {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const indices = fill(arena.allocator(), coords) orelse return error.NotTriangulated;
    try std.testing.expectEqual((coords.len / 2 - 2) * 3, indices.len);
    var polygon: f64 = 0;
    const n = coords.len / 2;
    for (0..n) |i| {
        const j = (i + 1) % n;
        polygon += coords[i * 2] * coords[j * 2 + 1] - coords[j * 2] * coords[i * 2 + 1];
    }

    var triangles: f64 = 0;
    var i: usize = 0;
    while (i < indices.len) : (i += 3) {
        var triangle: [3]Point = undefined;
        for (0..3) |j| {
            try std.testing.expect(indices[i + j] >= 0 and indices[i + j] < n);
            const k: usize = @intCast(indices[i + j]);
            triangle[j] = .{ .x = coords[k * 2], .y = coords[k * 2 + 1] };
        }

        const a = triangle[0];
        const b = triangle[1];
        const c = triangle[2];
        const cross = turn(a, b, c).?;
        triangles += @abs(cross);
        if (cross == 0) {
            continue;
        }

        try std.testing.expect((cross > 0) == (polygon > 0));
        // Interior barycentric samples approach every edge as well as the centre.
        for (1..10) |u| {
            for (1..11 - u) |v| {
                const x: f64 = @as(f64, @floatFromInt(u)) / 11;
                const y: f64 = @as(f64, @floatFromInt(v)) / 11;
                try std.testing.expect(inside(coords, .{
                    .x = a.x * x + b.x * y + c.x * (1 - x - y),
                    .y = a.y * x + b.y * y + c.y * (1 - x - y),
                }));
            }
        }
    }

    try std.testing.expectApproxEqAbs(@abs(polygon), triangles, @max(1, triangles) * 1e-12);
}

fn both(coords: []const f64) !void {
    try check(coords);
    var reversed: [most_points * 2]f64 = undefined;
    const n = coords.len / 2;
    for (0..n) |i| {
        reversed[i * 2] = coords[(n - i - 1) * 2];
        reversed[i * 2 + 1] = coords[(n - i - 1) * 2 + 1];
    }

    try check(reversed[0..coords.len]);
}

test "triangles tile concave contours in either winding, including collinear runs" {
    try both(&.{ 0, 0, 6, 0, 6, 2, 2, 2, 2, 6, 0, 6 });
    try both(&.{ 0, 0, 3, 0, 6, 0, 6, 2, 4, 2, 2, 2, 2, 6, 0, 6, 0, 3 });
    // A comb and a strip winding into a spiral.
    try both(&.{ 0, 0, 10, 0, 10, 8, 8, 8, 8, 2, 6, 2, 6, 8, 4, 8, 4, 2, 2, 2, 2, 8, 0, 8 });
    try both(&.{ 0, 0, 12, 0, 12, 12, 0, 12, 0, 3, 9, 3, 9, 9, 3, 9, 3, 6, 6, 6, 6, 7, 4, 7, 4, 8, 8, 8, 8, 4, 1, 4, 1, 11, 11, 11, 11, 1, 0, 1 });
}

test "a crescent of two flattened quadratics, through the size limit" {
    for ([_]usize{ 8, 16, 32 }) |steps| {
        var coords: [most_points * 2]f64 = undefined;
        for (0..steps + 1) |i| {
            const t = @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(steps));
            coords[i * 2] = 100 * t;
            coords[i * 2 + 1] = 60 * t * (1 - t);
        }
        for (steps + 1..steps * 2) |i| {
            const t = @as(f64, @floatFromInt(steps * 2 - i)) / @as(f64, @floatFromInt(steps));
            coords[i * 2] = 100 * t;
            coords[i * 2 + 1] = 24 * t * (1 - t);
        }

        try both(coords[0 .. steps * 4]);
    }
}

test "crossings, touches, repetitions, overlapping adjacent edges and invalid input fall back" {
    const fixtures = [_][]const f64{
        &.{ 0, 0, 10, 10, 0, 10, 10, 0 },
        &.{ 0, 0, 10, 0, 10, 10, 5, 0, 0, 10 },
        &.{ 0, 0, 10, 0, 10, 10, 0, 0, 0, 10 },
        &.{ 0, 0, 10, 0, 10, 0, 0, 10 },
        &.{ 0, 0, 10, 0, 5, 0, 5, 10, 0, 10 },
        &.{ 0, 0, 5, 0, 10, 0 },
        &.{ 0, 0, 1e308, 0, 0, 1e308 },
        &.{ 0, 0, std.math.nan(f64), 0, 0, 1 },
        &.{ 0, 0, 1, 0, 0, std.math.inf(f64) },
        &.{ 0, 0, 1, 0, 0 },
        &.{},
    };
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    for (fixtures) |coords| {
        try std.testing.expect(fill(arena.allocator(), coords) == null);
    }
    const large: [(most_points + 1) * 2]f64 = @splat(0);
    try std.testing.expect(fill(arena.allocator(), &large) == null);
    try std.testing.expect(fill(std.testing.failing_allocator, &.{ 0, 0, 1, 0, 0, 1 }) == null);
}
