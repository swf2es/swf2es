// A contour that goes once along an axis and once back, as a crescent or a
// leaf of two curves does, is shown simple in one pass along that axis, its
// two chains compared as they go, where ear clipping's own check looks at
// every pair of its edges. A thin one is cut into triangles of its own
// points in another pass, a strip between the chains; a wide one is left to
// ear clipping, told it is simple, as a strip's triangles all reach across
// it, and their long sides cost a rasteriser more than ears' short ones.
const std = @import("std");

/// The most points of a contour cut here; its scratch is three words a point.
const most_points = 4096;
/// A contour is thin whose chains are on average at most this many of their points' steps apart.
const thin_steps = 4;

/// What is found of a contour: its triangles, indices into its points; or that it is simple, for
/// ear clipping to cut; or nothing, as it turns back along both axes, its chains touch or cross,
/// or its numbers are past telling.
pub const Found = union(enum) {
    triangles: []const i32,
    simple,
    unknown,
};

/// A contour's points along one axis: `u` along it, `v` across.
fn Along(comptime across: bool) type {
    return struct {
        coords: []const f64,

        inline fn u(self: @This(), i: usize) f64 {
            return self.coords[i * 2 + @intFromBool(across)];
        }

        inline fn v(self: @This(), i: usize) f64 {
            return self.coords[i * 2 + @intFromBool(!across)];
        }

        /// Which side of the line from `a` to `b` point `p` is on, 0 on it.
        inline fn turn(self: @This(), a: usize, b: usize, p: usize) f64 {
            return (self.u(b) - self.u(a)) * (self.v(p) - self.v(a)) - (self.v(b) - self.v(a)) * (self.u(p) - self.u(a));
        }
    };
}

/// The caller releases the allocations, the scratch left before the triangles too.
pub fn fill(allocator: std.mem.Allocator, coords: []const f64) Found {
    const n = coords.len / 2;
    if (coords.len % 2 != 0 or n < 3) {
        return .unknown;
    }

    // Along the longer way of its box first, which a thin contour lies along.
    var least: [2]f64 = .{ coords[0], coords[1] };
    var most = least;
    for (coords, 0..) |value, i| {
        if (!std.math.isFinite(value)) {
            return .unknown;
        }

        least[i % 2] = @min(least[i % 2], value);
        most[i % 2] = @max(most[i % 2], value);
    }

    if (most[1] - least[1] > most[0] - least[0]) {
        const found = along(true, allocator, coords, n);
        return if (found == .unknown) along(false, allocator, coords, n) else found;
    }

    const found = along(false, allocator, coords, n);
    return if (found == .unknown) along(true, allocator, coords, n) else found;
}

fn along(comptime across: bool, allocator: std.mem.Allocator, coords: []const f64, n: usize) Found {
    const p: Along(across) = .{ .coords = coords };
    var low: usize = 0;
    var high: usize = 0;
    for (1..n) |i| {
        if (p.u(i) < p.u(low)) low = i;
        if (p.u(i) > p.u(high)) high = i;
    }

    // Out from the lowest to the highest, strictly up; back to the lowest, strictly down. Twice
    // the area on the way.
    var steps: usize = 0;
    var area: f64 = 0;
    var i = low;
    while (i != high) : (steps += 1) {
        const next = if (i + 1 == n) 0 else i + 1;
        if (!(p.u(next) > p.u(i))) {
            return .unknown;
        }

        area += p.u(i) * p.v(next) - p.u(next) * p.v(i);
        i = next;
    }

    while (i != low) : (steps += 1) {
        const next = if (i + 1 == n) 0 else i + 1;
        if (!(p.u(next) < p.u(i))) {
            return .unknown;
        }

        area += p.u(i) * p.v(next) - p.u(next) * p.v(i);
        i = next;
    }

    if (steps != n) {
        return .unknown;
    }

    // Both chains walked from the lowest point, whichever's next point comes first along the axis:
    // `out` and `back` are those next points, and the points before them the starts of the edges
    // the other chain's next point lies along. Each point's side of that edge must be the same,
    // the chain out's one way and the chain back's the other, and never on it: then the chains
    // meet only at their ends, as between two points along the axis the gap between them is linear.
    const first_out = if (low + 1 == n) 0 else low + 1;
    const first_back = if (low == 0) n - 1 else low - 1;
    var out = first_out;
    var back = first_back;
    var out_from = low;
    var back_from = low;
    var side: f64 = 0;
    for (0..n - 2) |_| {
        var cross: f64 = 0;
        if (out != high and (back == high or p.u(out) <= p.u(back))) {
            cross = p.turn(back_from, back, out);
            out_from = out;
            out = if (out + 1 == n) 0 else out + 1;
        } else {
            cross = -p.turn(out_from, out, back);
            back_from = back;
            back = if (back == 0) n - 1 else back - 1;
        }

        if (!std.math.isFinite(cross) or cross == 0 or (side != 0 and (cross > 0) != (side > 0))) {
            return .unknown;
        }

        side = cross;
    }

    // Thin: the gap between the chains, the area over the length, at most `thin_steps` of the
    // points' steps along it, the length over half the points.
    const length = p.u(high) - p.u(low);
    const count: f64 = @floatFromInt(n);
    if (n > most_points or !(@abs(area) * count <= 4 * thin_steps * length * length)) {
        return .simple;
    }

    // The points in order along the axis, as the walk above took them; `outward` tells a point of
    // the chain out.
    const order = allocator.alloc(u32, n) catch return .simple;
    const outward = allocator.alloc(bool, n) catch return .simple;
    const stack = allocator.alloc(u32, n) catch return .simple;
    const indices = allocator.alloc(i32, (n - 2) * 3) catch return .simple;
    out = first_out;
    back = first_back;
    order[0] = @intCast(low);
    outward[0] = true;
    for (1..n - 1) |k| {
        outward[k] = out != high and (back == high or p.u(out) <= p.u(back));
        if (outward[k]) {
            order[k] = @intCast(out);
            out = if (out + 1 == n) 0 else out + 1;
        } else {
            order[k] = @intCast(back);
            back = if (back == 0) n - 1 else back - 1;
        }
    }

    order[n - 1] = @intCast(high);
    outward[n - 1] = true;

    // A monotone polygon's triangles, by the stack of points not yet cut off: a point of the other
    // chain sees them all; one of the same chain, those its diagonal to lies inside for.
    var written: usize = 0;
    var top: usize = 2;
    stack[0] = 0;
    stack[1] = 1;
    for (2..n) |j| {
        const last = stack[top - 1];
        if (j == n - 1 or outward[j] != outward[last]) {
            for (0..top - 1) |s| {
                if (written == indices.len) return .simple;
                indices[written..][0..3].* = .{ @intCast(order[stack[s]]), @intCast(order[stack[s + 1]]), @intCast(order[j]) };
                written += 3;
            }

            stack[0] = last;
            stack[1] = @intCast(j);
            top = 2;
            continue;
        }

        // The chain out has the inside on the side the chain back lies on, the chain back the other.
        const inward: f64 = if (outward[j] == (side > 0)) -1 else 1;
        var kept = last;
        top -= 1;
        while (top > 0) {
            const cross = p.turn(order[stack[top - 1]], order[kept], order[j]);
            if (!std.math.isFinite(cross)) return .simple;
            if (!(cross * inward > 0)) break;
            if (written == indices.len) return .simple;
            indices[written..][0..3].* = .{ @intCast(order[stack[top - 1]]), @intCast(order[kept]), @intCast(order[j]) };
            written += 3;
            kept = stack[top - 1];
            top -= 1;
        }

        stack[top] = kept;
        stack[top + 1] = @intCast(j);
        top += 2;
    }

    return if (written == indices.len) .{ .triangles = indices } else .simple;
}

fn inside(coords: []const f64, x: f64, y: f64) bool {
    var winding: i32 = 0;
    const n = coords.len / 2;
    for (0..n) |i| {
        const j = (i + 1) % n;
        const ax = coords[i * 2];
        const ay = coords[i * 2 + 1];
        const bx = coords[j * 2];
        const by = coords[j * 2 + 1];
        const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if (ay <= y and by > y and cross > 0) winding += 1;
        if (ay > y and by <= y and cross < 0) winding -= 1;
    }

    return winding != 0;
}

/// What is found of the contour: simple, or cut where `cut`, its triangles' areas the polygon's
/// and every one of them within it.
fn check(coords: []const f64, cut: bool) !void {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const found = fill(arena.allocator(), coords);
    if (!cut) {
        try std.testing.expect(found == .simple);
        return;
    }

    try std.testing.expect(found == .triangles);
    const indices = found.triangles;
    const n = coords.len / 2;
    try std.testing.expectEqual((n - 2) * 3, indices.len);
    var polygon: f64 = 0;
    for (0..n) |i| {
        const j = (i + 1) % n;
        polygon += coords[i * 2] * coords[j * 2 + 1] - coords[j * 2] * coords[i * 2 + 1];
    }

    var triangles: f64 = 0;
    var i: usize = 0;
    while (i < indices.len) : (i += 3) {
        var x: [3]f64 = undefined;
        var y: [3]f64 = undefined;
        for (0..3) |j| {
            try std.testing.expect(indices[i + j] >= 0 and indices[i + j] < n);
            const at: usize = @intCast(indices[i + j]);
            x[j] = coords[at * 2];
            y[j] = coords[at * 2 + 1];
        }

        const cross = (x[1] - x[0]) * (y[2] - y[0]) - (y[1] - y[0]) * (x[2] - x[0]);
        triangles += @abs(cross);
        if (cross == 0) {
            continue;
        }

        // Interior barycentric samples approach every edge as well as the centre.
        for (1..10) |s| {
            for (1..11 - s) |t| {
                const a: f64 = @as(f64, @floatFromInt(s)) / 11;
                const b: f64 = @as(f64, @floatFromInt(t)) / 11;
                try std.testing.expect(inside(coords, x[0] * a + x[1] * b + x[2] * (1 - a - b), y[0] * a + y[1] * b + y[2] * (1 - a - b)));
            }
        }
    }

    try std.testing.expectApproxEqAbs(@abs(polygon), triangles, @max(1, triangles) * 1e-12);
}

/// The contour and itself reversed, turned a quarter and started from each of its points.
fn every(coords: []const f64, expected: enum { cut, simple, unknown }) !void {
    var turned: [256]f64 = undefined;
    const n = coords.len / 2;
    for (0..n) |start| {
        for ([_]bool{ false, true }) |reversed| {
            for ([_]bool{ false, true }) |quarter| {
                for (0..n) |i| {
                    const from = ((if (reversed) n - 1 - i else i) + start) % n;
                    turned[i * 2] = if (quarter) -coords[from * 2 + 1] else coords[from * 2];
                    turned[i * 2 + 1] = if (quarter) coords[from * 2] else coords[from * 2 + 1];
                }

                switch (expected) {
                    .cut => try check(turned[0 .. n * 2], true),
                    .simple => try check(turned[0 .. n * 2], false),
                    .unknown => try std.testing.expect(fill(std.testing.failing_allocator, turned[0 .. n * 2]) == .unknown),
                }
            }
        }
    }
}

test "thin contours once along an axis and back are cut into their own triangles" {
    // A triangle and a dart, of so few points that any strip is as short as their ears.
    try every(&.{ 0, 0, 4, 1, 2, 5 }, .cut);
    try every(&.{ 0, 0, 10, 4, 0, 8, 3, 4 }, .cut);
    // A saw over a flat edge, and a saw over a saw with points one above another.
    try every(&.{ 0, 0, 120, 0, 100, 5, 80, 1, 60, 6, 40, 2, 20, 7 }, .cut);
    try every(&.{ 0, 0, 20, -3, 40, -1, 60, -4, 80, -2, 100, 0, 80, 5, 60, 2, 40, 6, 20, 1 }, .cut);
    // Runs of points in a line, along both chains.
    try every(&.{ 0, 0, 20, 0, 40, 0, 60, 0, 80, 3, 60, 6, 40, 6, 20, 6, -10, 3 }, .cut);
}

test "a wide one is simple, for ear clipping" {
    // A round of 24 points, one of them pressed in.
    var coords: [48]f64 = undefined;
    for (0..24) |i| {
        const angle = @as(f64, @floatFromInt(i)) * std.math.pi / 12;
        const radius: f64 = if (i == 6) 7 else 10;
        coords[i * 2] = radius * @cos(angle);
        coords[i * 2 + 1] = radius * @sin(angle);
    }

    try every(&coords, .simple);
}

test "a crescent of two flattened quadratics, past ear clipping's size" {
    for ([_]usize{ 8, 32, 60 }) |steps| {
        var coords: [256]f64 = undefined;
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

        try every(coords[0 .. steps * 4], .cut);
    }
}

test "crossings, touches, turns back along both axes and invalid input are not known simple" {
    // Chains that cross, and that cross twice.
    try every(&.{ 0, 0, 10, 10, 20, 0, 10, -1, 5, 8 }, .unknown);
    try every(&.{ 0, 0, 5, 5, 10, -5, 15, 5, 20, 0, 10, 1 }, .unknown);
    // A point of one chain on the other, and both chains along one line from their end.
    try every(&.{ 0, 0, 5, 0, 10, 0, 6, 4, 5, 0, 4, 4 }, .unknown);
    try every(&.{ 0, 0, 4, 4, 10, 0, 2, 2 }, .unknown);
    // Not monotone along either axis: an L, and a square, its edges straight up.
    try every(&.{ 0, 0, 6, 0, 6, 2, 2, 2, 2, 6, 0, 6 }, .unknown);
    try every(&.{ 0, 0, 10, 0, 10, 10, 0, 10 }, .unknown);
    // A bow, all in a line, and coordinates that are no numbers or past multiplying.
    try every(&.{ 0, 0, 10, 10, 0, 10, 10, 0 }, .unknown);
    try every(&.{ 0, 0, 5, 0, 10, 0 }, .unknown);
    try every(&.{ 0, 0, std.math.nan(f64), 0, 0, 1 }, .unknown);
    try every(&.{ 0, 0, 1, 0, 0, std.math.inf(f64) }, .unknown);
    try every(&.{ 0, 0, 1e308, 1, -1e308, 2 }, .unknown);
    try std.testing.expect(fill(std.testing.failing_allocator, &.{ 0, 0, 1, 0, 0 }) == .unknown);
    try std.testing.expect(fill(std.testing.failing_allocator, &.{}) == .unknown);
    // Without memory for its triangles, a thin one is still simple.
    try std.testing.expect(fill(std.testing.failing_allocator, &.{ 0, 0, 40, 1, 20, 3 }) == .simple);
}
