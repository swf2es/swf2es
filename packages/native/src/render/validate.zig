//! A check of lyon's triangles (lyon.zig) against the fill they are meant to be, before they are
//! drawn: lyon fills contours that come within hundredths of a pixel of each other wrongly in
//! places under the even-odd rule, covering wedges more than once or not at all, and says
//! nothing. Along a set of horizontal scanlines over the fill's box, the triangles' coverage of
//! every stretch between two crossings must be what the contours' winding there says the rule
//! fills: once where it fills, never where it does not. Stretches narrower than a twip, or than
//! the positions' f32 rounding, say nothing, as the triangles' edges and the contours' differ by
//! that much. Scanlines see every point of a stretch where samples would see a few, at the cost
//! of one pass over the triangles and the edges.
//!
//! The check is a pure function of the points and triangles, so a fill goes the same way on
//! every run.
const std = @import("std");

/// Scanlines over the fill's box, each a little off the twip grid that vertices lie on: 256, a
/// line every pixel or two over a deck, as lyon's wrong wedges can be under three pixels tall
/// (48 let one through in the fuzz), for about 11 ms of lyon's 153 on a deck of 95 contours.
const lines = 256;
const offset = 0.5123456789;
/// The most crossings looked at, a point or triangle, past which the triangles are taken as
/// wrong: lyon's monotone pieces keep its triangles short, and many that span the box are not
/// what it gives densely crossing contours.
const crossings_per_point = 64;

const Crossing = struct {
    x: f64,
    /// +1 where a triangle starts along the line and -1 where one ends.
    cover: i8,
    /// The contour's edge's direction across the line, +1 or -1.
    winding: i8,
};

fn leftOf(_: void, a: Crossing, b: Crossing) bool {
    return a.x < b.x;
}

/// Where the edge from (ax, ay) to (bx, by) crosses the line at `y`, half-open in y so that a
/// line through a vertex crosses each closed polygon an even number of times; its x computed
/// from the lower end, so that two triangles that share an edge agree on it to the bit.
fn across(ax: f64, ay: f64, bx: f64, by: f64, y: f64) ?f64 {
    if (ay == by) {
        return null;
    }

    const up = ay < by;
    const lx = if (up) ax else bx;
    const ly = if (up) ay else by;
    const hx = if (up) bx else ax;
    const hy = if (up) by else ay;
    if (y < ly or y >= hy) {
        return null;
    }

    return lx + (y - ly) * (hx - lx) / (hy - ly);
}

/// The scanlines a span from `y0` to `y1` crosses: those whose y lies in [y0, y1), give or take
/// one at either end, which `across` then rules out. `per` is lines a unit.
fn span(y0: f64, y1: f64, top: f64, per: f64) struct { first: usize, end: usize } {
    const a = @ceil((y0 - top) * per - offset) - 1;
    const b = @ceil((y1 - top) * per - offset) + 1;
    const first: usize = @intFromFloat(std.math.clamp(a, 0, lines));
    const end: usize = @intFromFloat(std.math.clamp(b, 0, lines));
    return .{ .first = first, .end = @max(first, end) };
}

/// Whether `positions` (x then y) and `indices` (three a triangle) cover the closed contours of
/// `coords`, each ending at its point in `ends`, as `nonzero` or the even-odd rule fills them;
/// false too where the scratch does not fit in `allocator`.
pub fn covers(allocator: std.mem.Allocator, coords: []const f64, ends: []const u32, nonzero: bool, positions: []const f64, indices: []const i32) bool {
    return check(allocator, coords, ends, nonzero, positions, indices) catch false;
}

fn check(allocator: std.mem.Allocator, coords: []const f64, ends: []const u32, nonzero: bool, positions: []const f64, indices: []const i32) !bool {
    var top: f64 = std.math.inf(f64);
    var bottom: f64 = -std.math.inf(f64);
    var farthest: f64 = 0;
    for (0..coords.len / 2) |i| {
        const x = coords[i * 2];
        const y = coords[i * 2 + 1];
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (@abs(x) > farthest) farthest = @abs(x);
        if (@abs(y) > farthest) farthest = @abs(y);
    }

    const step = (bottom - top) / lines;
    if (!(step > 0) or !std.math.isFinite(step)) {
        return true;
    }

    var ys: [lines]f64 = undefined;
    for (&ys, 0..) |*y, k| {
        y.* = top + (@as(f64, @floatFromInt(k)) + offset) * step;
    }

    // A twip, or what f32 positions this far out round to, a few times over.
    const tolerance = @max(1.0 / 20.0, farthest * 0x1p-20);

    // Every crossing found in one pass over the triangles and one over the edges, then sorted
    // by line, by counting, and along each line.
    var found: std.ArrayList(Found) = .empty;
    defer found.deinit(allocator);
    const most = (coords.len / 2 + indices.len / 3 + lines) * crossings_per_point;
    if (!try visit(allocator, &found, most, coords, ends, positions, indices, top, 1 / step, &ys)) {
        return false;
    }

    var firsts: [lines + 1]usize = @splat(0);
    for (found.items) |item| {
        firsts[item.line + 1] += 1;
    }

    for (1..lines + 1) |k| {
        firsts[k] += firsts[k - 1];
    }

    const all = try allocator.alloc(Crossing, found.items.len);
    defer allocator.free(all);
    var filled = firsts;
    for (found.items) |item| {
        all[filled[item.line]] = item.crossing;
        filled[item.line] += 1;
    }

    for (0..lines) |k| {
        const line = all[firsts[k]..firsts[k + 1]];
        std.sort.pdq(Crossing, line, {}, leftOf);
        var cover: i32 = 0;
        var winding: i32 = 0;
        var i: usize = 0;
        while (i < line.len) {
            const x = line[i].x;
            while (i < line.len and line[i].x == x) : (i += 1) {
                cover += line[i].cover;
                winding += line[i].winding;
            }

            if (i == line.len or line[i].x - x <= tolerance) {
                continue;
            }

            const fills = if (nonzero) winding != 0 else @mod(winding, 2) == 1;
            if (cover != @intFromBool(fills)) {
                return false;
            }
        }
    }

    return true;
}

/// A crossing and the line it lies on.
const Found = struct { line: u32, crossing: Crossing };

/// The crossings of the triangles and the contours' edges with the lines, appended to `found`:
/// false where there would be more than `most`.
fn visit(allocator: std.mem.Allocator, found: *std.ArrayList(Found), most: usize, coords: []const f64, ends: []const u32, positions: []const f64, indices: []const i32, top: f64, per: f64, ys: *const [lines]f64) !bool {
    var t: usize = 0;
    while (t + 2 < indices.len) : (t += 3) {
        const a: usize = @intCast(indices[t]);
        const b: usize = @intCast(indices[t + 1]);
        const c: usize = @intCast(indices[t + 2]);
        const ay = positions[a * 2 + 1];
        const by = positions[b * 2 + 1];
        const cy = positions[c * 2 + 1];
        // Comparisons rather than @min and @max, which wasm's NaN rules make slower.
        var low = ay;
        var high = ay;
        if (by < low) low = by;
        if (by > high) high = by;
        if (cy < low) low = cy;
        if (cy > high) high = cy;
        const crossed = span(low, high, top, per);
        if (crossed.first == crossed.end) {
            continue;
        }

        const ax = positions[a * 2];
        const bx = positions[b * 2];
        const cx = positions[c * 2];
        for (crossed.first..crossed.end) |k| {
            const y = ys[k];
            var xs: [3]f64 = undefined;
            var n: usize = 0;
            inline for (.{ .{ ax, ay, bx, by }, .{ bx, by, cx, cy }, .{ cx, cy, ax, ay } }) |edge| {
                if (across(edge[0], edge[1], edge[2], edge[3], y)) |x| {
                    xs[n] = x;
                    n += 1;
                }
            }

            // Two, or none for a line the span's rounding put a hair past the triangle.
            if (n != 2 or xs[0] == xs[1]) {
                continue;
            }

            if (found.items.len + 2 > most) {
                return false;
            }

            const left = if (xs[0] < xs[1]) xs[0] else xs[1];
            const right = if (xs[0] < xs[1]) xs[1] else xs[0];
            try found.append(allocator, .{ .line = @intCast(k), .crossing = .{ .x = left, .cover = 1, .winding = 0 } });
            try found.append(allocator, .{ .line = @intCast(k), .crossing = .{ .x = right, .cover = -1, .winding = 0 } });
        }
    }

    var start: usize = 0;
    for (ends) |end| {
        for (start..end) |p| {
            const q = if (p + 1 == end) start else p + 1;
            const px = coords[p * 2];
            const py = coords[p * 2 + 1];
            const qx = coords[q * 2];
            const qy = coords[q * 2 + 1];
            const crossed = if (py < qy) span(py, qy, top, per) else span(qy, py, top, per);
            for (crossed.first..crossed.end) |k| {
                const x = across(px, py, qx, qy, ys[k]) orelse continue;
                if (found.items.len + 1 > most) {
                    return false;
                }

                try found.append(allocator, .{ .line = @intCast(k), .crossing = .{ .x = x, .cover = 0, .winding = if (py < qy) 1 else -1 } });
            }
        }

        start = end;
    }

    return true;
}

const testing = std.testing;

const square = [_]f64{ 0, 0, 10, 0, 10, 10, 0, 10 };

test "two triangles covering a square once cover it" {
    const positions = square;
    const indices = [_]i32{ 0, 1, 2, 0, 2, 3 };
    try testing.expect(covers(testing.allocator, &square, &.{4}, false, &positions, &indices));
    try testing.expect(covers(testing.allocator, &square, &.{4}, true, &positions, &indices));
}

test "a triangle missing, or one drawn twice, is caught" {
    const positions = square;
    try testing.expect(!covers(testing.allocator, &square, &.{4}, false, &positions, &.{ 0, 1, 2 }));
    try testing.expect(!covers(testing.allocator, &square, &.{4}, false, &positions, &.{ 0, 1, 2, 0, 2, 3, 0, 1, 2 }));
}

test "a hole filled under the even-odd rule is caught, and under the non-zero rule is right" {
    // A square and a smaller one inside it wound the same way: even-odd leaves the inner one out.
    const coords = [_]f64{ 0, 0, 10, 0, 10, 10, 0, 10, 2, 2, 8, 2, 8, 8, 2, 8 };
    const ends = [_]u32{ 4, 8 };
    const whole = [_]i32{ 0, 1, 2, 0, 2, 3 };
    try testing.expect(covers(testing.allocator, &coords, &ends, true, &coords, &whole));
    try testing.expect(!covers(testing.allocator, &coords, &ends, false, &coords, &whole));
    // The ring between the two squares, as eight triangles.
    const ring = [_]i32{ 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7 };
    try testing.expect(covers(testing.allocator, &coords, &ends, false, &coords, &ring));
    try testing.expect(!covers(testing.allocator, &coords, &ends, true, &coords, &ring));
}

test "triangles off by less than a twip pass" {
    const positions = [_]f64{ 0, 0, 10.01, 0, 10.01, 10, 0, 10 };
    try testing.expect(covers(testing.allocator, &square, &.{4}, false, &positions, &.{ 0, 1, 2, 0, 2, 3 }));
}
