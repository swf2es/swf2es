//! Which fills go to lyon (lyon.zig) rather than libtess2: those of many contours stacked on one
//! another that cross densely, as a deck of near-identical outlines each turned a little from
//! the last. libtess2's sweep keeps its active edges in a sorted list and gives every crossing a
//! vertex of its own, so such a fill takes it time that grows with the square of its crossings,
//! seconds for a hundred contours; lyon's takes a tenth of that. Every other fill stays with
//! libtess2, which fills a few self-crossing even-odd ones correctly that lyon covers twice in
//! places.
//!
//! The test is a pure function of the points, so a fill goes the same way on every run.
const std = @import("std");

/// The fewest contours and points of a fill worth counting the crossings of.
pub const least_contours = 4;
pub const least_points = 1000;
/// How deep the contours' boxes must stack, their areas' sum over the fill's box's area, before
/// their crossings are counted: a deck of N contours stacks N deep, while the ordinary shapes of
/// four contours and a thousand points or more measured, in Ruffle's corpus and in real SWFs,
/// stack six deep at most, and are spared the count.
const least_depth = 8;
/// The crossings that make a fill dense. A deck of wobbly contours of 200 points crosses about 9
/// times the square of its contours: libtess2 takes 6 ms over 12 of them in wasm and 11 over 15,
/// against lyon's 3, and seconds over a hundred, against lyon's tenth of one. Ordinary shapes of
/// as many contours and points cross a few dozen times at most.
pub const threshold = 1000;
/// Pairs of edges that share a cell looked at, a point, before giving up on a fill as not dense:
/// edges that lie along one another without crossing, as an outline traced twice, are not what
/// this looks for, and must not cost it the square of their number.
const pairs_per_point = 64;
/// Cell entries a point, past which the edges are too long for the grid to sort them.
const entries_per_point = 8;
/// A cell's side, in edges' mean extent, and the most cells a point.
const cell_extents = 2;
const cells_per_point = 4;

/// Whether the closed contours of `coords`, each ending at its point in `ends`, stack
/// `least_depth` deep and cross each other or themselves `threshold` times or more, counting
/// proper crossings alone: not edges that meet at a point or lie along one another. False where
/// the scratch does not fit in `allocator`.
pub fn dense(allocator: std.mem.Allocator, coords: []const f64, ends: []const u32) bool {
    const n = coords.len / 2;
    if (ends.len < least_contours or n < least_points or depth(coords, ends) < least_depth) {
        return false;
    }

    const found = count(allocator, coords, ends, threshold, n * pairs_per_point) catch return false;
    return found >= threshold;
}

/// The contours' boxes' areas summed, over the area of the box of them all; 0 for a fill whose
/// box has none.
fn depth(coords: []const f64, ends: []const u32) f64 {
    var left: f64 = std.math.inf(f64);
    var right: f64 = -std.math.inf(f64);
    var top: f64 = std.math.inf(f64);
    var bottom: f64 = -std.math.inf(f64);
    var stacked: f64 = 0;
    var start: usize = 0;
    for (ends) |end| {
        var x0: f64 = std.math.inf(f64);
        var x1: f64 = -std.math.inf(f64);
        var y0: f64 = std.math.inf(f64);
        var y1: f64 = -std.math.inf(f64);
        // Comparisons rather than @min and @max, which wasm's NaN rules make slower, as the
        // coordinates are finite.
        for (start..end) |a| {
            const x = coords[a * 2];
            const y = coords[a * 2 + 1];
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }

        stacked += (x1 - x0) * (y1 - y0);
        left = @min(left, x0);
        right = @max(right, x1);
        top = @min(top, y0);
        bottom = @max(bottom, y1);
        start = end;
    }

    const area = (right - left) * (bottom - top);
    return if (area > 0 and std.math.isFinite(stacked)) stacked / area else 0;
}

/// An edge from point `from` to point `to`, with its extent, and the grid's columns and rows
/// that extent covers.
const Edge = struct {
    from: u32,
    to: u32,
    x0: f64,
    x1: f64,
    y0: f64,
    y1: f64,
    c0: u32 = 0,
    c1: u32 = 0,
    r0: u32 = 0,
    r1: u32 = 0,
};

/// A square grid over the edges, its cells about twice an edge long.
const Grid = struct {
    left: f64,
    top: f64,
    /// Cells a unit.
    scale: f64,
    columns: usize,
    rows: usize,

    fn column(grid: Grid, x: f64) u32 {
        return @intCast(@min(grid.columns - 1, @as(usize, @intFromFloat((x - grid.left) * grid.scale))));
    }

    fn row(grid: Grid, y: f64) u32 {
        return @intCast(@min(grid.rows - 1, @as(usize, @intFromFloat((y - grid.top) * grid.scale))));
    }
};

/// The proper crossings of the contours' edges, counted up to `enough`; or as many as were found
/// once `budget` pairs of edges in a cell have been looked at.
fn count(allocator: std.mem.Allocator, coords: []const f64, ends: []const u32, enough: usize, budget: usize) !usize {
    const n = coords.len / 2;
    const edges = try allocator.alloc(Edge, n);
    defer allocator.free(edges);

    var left: f64 = std.math.inf(f64);
    var right: f64 = -std.math.inf(f64);
    var top: f64 = std.math.inf(f64);
    var bottom: f64 = -std.math.inf(f64);
    var extent: f64 = 0;
    var start: usize = 0;
    var i: usize = 0;
    for (ends) |end| {
        for (start..end) |a| {
            const b = if (a + 1 == end) start else a + 1;
            const ax = coords[a * 2];
            const ay = coords[a * 2 + 1];
            const bx = coords[b * 2];
            const by = coords[b * 2 + 1];
            const edge: Edge = .{ .from = @intCast(a), .to = @intCast(b), .x0 = @min(ax, bx), .x1 = @max(ax, bx), .y0 = @min(ay, by), .y1 = @max(ay, by) };
            edges[i] = edge;
            left = @min(left, ax);
            right = @max(right, ax);
            top = @min(top, ay);
            bottom = @max(bottom, ay);
            extent += @max(edge.x1 - edge.x0, edge.y1 - edge.y0);
            i += 1;
        }

        start = end;
    }

    // Cells about twice an edge's mean extent, but no more of them than four a point.
    const width = right - left;
    const height = bottom - top;
    const most: f64 = @floatFromInt(n * cells_per_point);
    const cell = @max(cell_extents * extent / @as(f64, @floatFromInt(n)), @sqrt(width * height / most), @max(width, height) / most);
    if (!(cell > 0) or !std.math.isFinite(cell) or !std.math.isFinite(width) or !std.math.isFinite(height)) {
        return 0;
    }

    const grid: Grid = .{
        .left = left,
        .top = top,
        .scale = 1 / cell,
        .columns = @intFromFloat(@min(most, @floor(width / cell) + 1)),
        .rows = @intFromFloat(@min(most, @floor(height / cell) + 1)),
    };
    // At most three times `most`, the side being at least both of its bounds.
    const cells = grid.columns * grid.rows;

    // Each edge in every cell its extent covers, the cells' edges in one array by counting.
    const firsts = try allocator.alloc(u32, cells + 1);
    defer allocator.free(firsts);
    @memset(firsts, 0);
    var entries: usize = 0;
    for (edges) |*edge| {
        edge.c0 = grid.column(edge.x0);
        edge.c1 = grid.column(edge.x1);
        edge.r0 = grid.row(edge.y0);
        edge.r1 = grid.row(edge.y1);
        entries += @as(usize, edge.c1 - edge.c0 + 1) * (edge.r1 - edge.r0 + 1);
        if (entries > n * entries_per_point) {
            return 0;
        }

        for (edge.r0..edge.r1 + 1) |r| {
            for (edge.c0..edge.c1 + 1) |c| {
                firsts[r * grid.columns + c + 1] += 1;
            }
        }
    }

    for (1..cells + 1) |k| {
        firsts[k] += firsts[k - 1];
    }

    const members = try allocator.alloc(u32, entries);
    defer allocator.free(members);
    const filled = try allocator.alloc(u32, cells);
    defer allocator.free(filled);
    @memcpy(filled, firsts[0..cells]);
    for (edges, 0..) |edge, e| {
        for (edge.r0..edge.r1 + 1) |r| {
            for (edge.c0..edge.c1 + 1) |c| {
                members[filled[r * grid.columns + c]] = @intCast(e);
                filled[r * grid.columns + c] += 1;
            }
        }
    }

    var found: usize = 0;
    var looked: usize = 0;
    for (0..cells) |k| {
        const own = members[firsts[k]..firsts[k + 1]];
        for (own, 0..) |e, at| {
            const a = edges[e];
            for (own[at + 1 ..]) |f| {
                looked += 1;
                if (looked > budget) {
                    return found;
                }

                const b = edges[f];
                if (b.x0 > a.x1 or a.x0 > b.x1 or b.y0 > a.y1 or a.y0 > b.y1 or !cross(coords, a, b)) {
                    continue;
                }

                // A pair in several cells counts in the one that holds its extents' overlap's
                // corner, the first cell both cover.
                if (@as(usize, @max(a.r0, b.r0)) * grid.columns + @max(a.c0, b.c0) == k) {
                    found += 1;
                    if (found >= enough) {
                        return found;
                    }
                }
            }
        }
    }

    return found;
}

/// Which side of the line through `a` and `b` point `c` lies on: 1 left, -1 right, 0 on it.
fn side(coords: []const f64, a: u32, b: u32, c: u32) i32 {
    const ax = coords[a * 2];
    const ay = coords[a * 2 + 1];
    const turn = (coords[b * 2] - ax) * (coords[c * 2 + 1] - ay) - (coords[b * 2 + 1] - ay) * (coords[c * 2] - ax);
    return @as(i32, @intFromBool(turn > 0)) - @intFromBool(turn < 0);
}

/// Whether two edges cross at a point inside both.
fn cross(coords: []const f64, a: Edge, b: Edge) bool {
    const p = side(coords, a.from, a.to, b.from);
    const q = side(coords, a.from, a.to, b.to);
    const r = side(coords, b.from, b.to, a.from);
    const s = side(coords, b.from, b.to, a.to);
    return p * q < 0 and r * s < 0;
}

const testing = std.testing;

fn deck(allocator: std.mem.Allocator, contours: usize, points: usize, turn: f64) !struct { coords: []f64, ends: []u32 } {
    const coords = try allocator.alloc(f64, contours * points * 2);
    const ends = try allocator.alloc(u32, contours);
    for (0..contours) |c| {
        const a = @as(f64, @floatFromInt(c)) * turn;
        for (0..points) |k| {
            const u = @as(f64, @floatFromInt(k)) / @as(f64, @floatFromInt(points)) * std.math.pi * 2;
            const r = 200 + 12 * @sin(u * 9);
            const x = r * @cos(u) * 0.7;
            const y = r * @sin(u);
            const at = (c * points + k) * 2;
            coords[at] = 300 + x * @cos(a) - y * @sin(a);
            coords[at + 1] = 300 + x * @sin(a) + y * @cos(a);
        }

        ends[c] = @intCast((c + 1) * points);
    }

    return .{ .coords = coords, .ends = ends };
}

/// Every pair of edges looked at, for the count to agree with.
fn brute(coords: []const f64, ends: []const u32) usize {
    var found: usize = 0;
    var start: usize = 0;
    var list: std.ArrayList(Edge) = .empty;
    defer list.deinit(testing.allocator);
    for (ends) |end| {
        for (start..end) |a| {
            const b = if (a + 1 == end) start else a + 1;
            list.append(testing.allocator, .{ .from = @intCast(a), .to = @intCast(b), .x0 = 0, .x1 = 0, .y0 = 0, .y1 = 0 }) catch unreachable;
        }

        start = end;
    }

    for (list.items, 0..) |a, i| {
        for (list.items[i + 1 ..]) |b| {
            if (cross(coords, a, b)) {
                found += 1;
            }
        }
    }

    return found;
}

test "the grid's count finds every crossing a look at each pair does" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    for ([_]usize{ 2, 5, 12 }) |contours| {
        const d = try deck(arena.allocator(), contours, 120, 0.004);
        const all = brute(d.coords, d.ends);
        try testing.expect(all > 0);
        try testing.expectEqual(all, try count(testing.allocator, d.coords, d.ends, std.math.maxInt(usize), std.math.maxInt(usize)));
    }
}

test "a crossing deck is dense and an ordinary fill is not" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const crossing = try deck(arena.allocator(), 20, 200, 0.004);
    try testing.expect(dense(testing.allocator, crossing.coords, crossing.ends));
    // Ten crossing contours are too few to be worth it, and as many traced twice cross nowhere.
    const few = try deck(arena.allocator(), 10, 200, 0.004);
    try testing.expect(!dense(testing.allocator, few.coords, few.ends));
    const traced = try deck(arena.allocator(), 40, 200, 0);
    try testing.expect(!dense(testing.allocator, traced.coords, traced.ends));

    // A grid of squares, side by side and touching: many contours, no crossing.
    const side_count = 16;
    const coords = try arena.allocator().alloc(f64, side_count * side_count * 8);
    const ends = try arena.allocator().alloc(u32, side_count * side_count);
    for (0..side_count * side_count) |k| {
        const x: f64 = @floatFromInt(k % side_count);
        const y: f64 = @floatFromInt(k / side_count);
        @memcpy(coords[k * 8 ..][0..8], &[_]f64{ x, y, x + 1, y, x + 1, y + 1, x, y + 1 });
        ends[k] = @intCast((k + 1) * 4);
    }

    try testing.expect(!dense(testing.allocator, coords, ends));
    try testing.expectEqual(0, try count(testing.allocator, coords, ends, std.math.maxInt(usize), std.math.maxInt(usize)));
}

test "fewer than four contours or a thousand points are never counted" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const three = try deck(arena.allocator(), 3, 1000, 0.004);
    try testing.expect(!dense(testing.allocator, three.coords, three.ends));
    const small = try deck(arena.allocator(), 40, 24, 0.004);
    try testing.expect(!dense(testing.allocator, small.coords, small.ends));
}
