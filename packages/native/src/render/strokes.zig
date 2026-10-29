//! A shape layer's lines as triangles, in one call, the player's only line
//! builder. It began as a port of the player's TS (scene/strokes.ts, before
//! this replaced it) with the same arithmetic in the same order, and keeps
//! JS's semantics where they show: a number's truthiness, Math.hypot as
//! V8's algorithm, atan2 and acos Zig's, which are fdlibm's, as V8's are, and
//! Math.sin and Math.cos the host's own, imported, as engines differ in
//! their last bit, which moves a corner.
//! A line drawn opaque is triangles along its paths (lineTriangles); any
//! other is outlined (outline, triangleRing) and its outline filled non-zero
//! by tessellate.zig, by libtess2 or its bands, as the host's Tessellator
//! fills it. Positions are worked out in f64 and rounded to f32 last, as
//! Float32Array.from rounds them.
//!
//! What it cannot build, it refuses, and the player draws no lines for the
//! layer: an outline it could not fill in its memory; a position that is
//! NaN; and a NaN arc's chords taken back from none.
//!
//! The input is a run of f64s: a, b, c, d (the linear transform), the
//! flatness and the number of lines; each line its half width, caps, join,
//! miter limit, vertex colour, flags (OVERLAPS, drawn as triangles that may
//! overlap; TOGETHER, its paths' outlines filled as one) and number of
//! paths; each path whether it is closed home, its length, and its commands
//! (MOVE x y, LINE x y, CURVE cx cy x y, CUBIC c1x c1y c2x c2y x y), a
//! fill's closing line already added.
//!
//! Its memory is the module's arena (arena.zig): lineInput resets it, and
//! each lineBuild lets go of all but the input.
const std = @import("std");
const arena = @import("arena.zig");
const tessellate = @import("tessellate.zig");

const allocator = arena.allocator;

extern "env" fn sine(x: f64) f64;
extern "env" fn cosine(x: f64) f64;

const MOVE: f64 = 1;
const LINE: f64 = 2;
const CURVE: f64 = 3;
const CUBIC: f64 = 4;

const OVERLAPS: usize = 1;
const TOGETHER: usize = 2;

const Error = error{ OutOfMemory, Malformed, Refused };

/// The input lineInput reserved, where the arena stood after it, and the arena's generation then.
var input: []f64 = &.{};
var input_top: usize = 0;
var input_generation: u32 = 0;
var positions: std.ArrayList(f32) = .empty;
/// Each line's colour from its first vertex on: the colours are written once, where they go.
var runs: std.ArrayList(Run) = .empty;
var indices: std.ArrayList(u32) = .empty;
/// A path flattened, and backwards for its outline's way back.
var points: std.ArrayList(f64) = .empty;
var reversed: std.ArrayList(f64) = .empty;
/// A turn's or a cap's points, a closed outline's right side, and triangleRing's outer side.
var between: std.ArrayList(f64) = .empty;
var right: std.ArrayList(f64) = .empty;
var ring: std.ArrayList(f64) = .empty;
var corners: std.ArrayList(i32) = .empty;
/// Each segment's way and length (segmentWays).
var ways: std.ArrayList(Way) = .empty;
/// The outline contours a fill takes, one after another, and where each ends, in f64s.
var outlines: std.ArrayList(f64) = .empty;
var ends: std.ArrayList(u32) = .empty;
/// What lineBuild made, laid out in one block for one copy (positions, colours, indices):
/// where the block is, its vertices and its indices.
var layout: [3]u32 = @splat(0);
var color: u32 = 0;
/// Whether a position came out NaN.
var nan_seen = false;

const Way = struct { x: f64, y: f64, length: f64 };
const Run = extern struct { start: u32, color: u32 };

/// The arena reset, and room for `n` f64s of input in it, or 0.
export fn lineInput(n: usize) usize {
    arena.reset();
    input_generation = arena.generation;
    input = allocator.alloc(f64, n) catch &.{};
    input_top = arena.top;
    return if (input.len == n) @intFromPtr(input.ptr) else 0;
}

export fn lineHeader() usize {
    return @intFromPtr(&layout);
}

/// The layer in the first `length` f64s of the input, its geometry for the
/// header to describe: 0; -1 out of memory, -2 malformed, or -3 refused.
export fn lineBuild(length: usize) i32 {
    layout = @splat(0);
    // A reset since, by another of the module's calls, leaves no input.
    if (input_generation != arena.generation or length > input.len) {
        return -2;
    }

    // All but the input let go of: the last call's lists with it.
    arena.top = input_top;
    inline for (.{ &positions, &indices, &points, &reversed, &between, &right, &ring, &outlines, &ends }) |list| {
        list.* = .empty;
    }

    corners = .empty;
    ways = .empty;
    runs = .empty;
    nan_seen = false;
    layer(input[0..length]) catch |e| return switch (e) {
        error.OutOfMemory => -1,
        error.Malformed => -2,
        error.Refused => -3,
    };
    if (nan_seen) {
        return -3;
    }

    // One block, the colours written where they go: two copies out, the colours filled in JS,
    // measured slower.
    const v = positions.items.len / 2;
    const n = indices.items.len;
    const out = allocator.alloc(u32, v * 3 + n) catch return -1;
    @memcpy(out[0 .. v * 2], @as([]const u32, @ptrCast(positions.items)));
    for (runs.items, 0..) |run, k| {
        const end = if (k + 1 < runs.items.len) runs.items[k + 1].start else v;
        @memset(out[v * 2 + run.start .. v * 2 + end], run.color);
    }

    @memcpy(out[v * 3 ..], indices.items);
    layout = .{ @intCast(@intFromPtr(out.ptr)), @intCast(v), @intCast(n) };
    return 0;
}

fn count(value: f64, most: usize) Error!usize {
    if (!(value >= 0) or value > @as(f64, @floatFromInt(most))) {
        return error.Malformed;
    }

    return @intFromFloat(value);
}

/// The layer's lines as seen through the linear transform on the stage, in its axes, each at least
/// its half width, as one geometry in their order. A line of whole alpha drawn opaque draws as
/// lineTriangles, its overlaps unseen, and only another is outlined and tessellated.
fn layer(in: []const f64) Error!void {
    if (in.len < 6) {
        return error.Malformed;
    }

    const a = in[0];
    const b = in[1];
    const c = in[2];
    const d = in[3];
    const flatness = in[4];
    const lines = try count(in[5], in.len);
    var i: usize = 6;
    for (0..lines) |_| {
        if (in.len - i < 7) {
            return error.Malformed;
        }

        const h = in[i];
        const caps = try count(in[i + 1], 2);
        const join = try count(in[i + 2], 2);
        const limit = in[i + 3];
        color = @intCast(try count(in[i + 4], 0xffffffff));
        try colorFrom(@intCast(positions.items.len / 2));
        const flags = try count(in[i + 5], 3);
        const paths = try count(in[i + 6], in.len);
        i += 7;
        for (0..paths) |_| {
            if (in.len - i < 2) {
                return error.Malformed;
            }

            const home = in[i] != 0;
            const length = try count(in[i + 1], in.len - i - 2);
            const path = in[i + 2 ..][0..length];
            i += 2 + length;
            // A move alone draws nothing, where a move and a line back to it draw a dot.
            if (length <= 3) {
                continue;
            }

            try polyline(path, a, b, c, d, flatness);
            const p = points.items;
            const closed = home or (p.len > 4 and p[0] == p[p.len - 2] and p[1] == p[p.len - 1]);
            if (flags & OVERLAPS != 0) {
                try lineTriangles(p, closed, h, caps, join, limit, flatness);
                continue;
            }

            if (!closed or !try triangleRing(p, h, caps, join, limit, flatness)) {
                try outline(p, closed, h, caps, join, limit, flatness);
            }

            // adl blends a line's paths over each other where they overlap, each filled as one;
            // but drawTriangles' outlines, which it keeps as one path, once.
            if (flags & TOGETHER == 0) {
                try fillUsable();
            }
        }

        try fillUsable();
    }
}

/// Math.hypot of two, as V8 computes it: normalised to the larger, summed with Kahan's compensation.
fn hypot(x: f64, y: f64) f64 {
    var magnitudes: [2]f64 = .{ 0, 0 };
    var nan = false;
    var max: f64 = 0;
    inline for (.{ x, y }, &magnitudes) |value, *magnitude| {
        if (std.math.isNan(value)) {
            nan = true;
        } else {
            magnitude.* = @abs(value);
            if (magnitude.* > max) {
                max = magnitude.*;
            }
        }
    }

    if (max == std.math.inf(f64)) {
        return max;
    }

    if (nan) {
        return std.math.nan(f64);
    }

    if (max == 0) {
        return 0;
    }

    var sum: f64 = 0;
    var compensation: f64 = 0;
    inline for (magnitudes) |magnitude| {
        const n = magnitude / max;
        const summand = n * n - compensation;
        const preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }

    return @sqrt(sum) * max;
}

/// Math.sign.
fn sign(x: f64) f64 {
    if (x > 0) {
        return 1;
    }

    if (x < 0) {
        return -1;
    }

    return x;
}

/// Math.min(most, Math.max(1, raw)) for a whole `raw`, as a loop bound: NaN runs no step.
fn steps(raw: f64, most: f64) usize {
    if (std.math.isNan(raw)) {
        return 0;
    }

    return @intFromFloat(@min(most, @max(1, raw)));
}

/// A run of points from `start` of `list`.
const Points = struct {
    list: *std.ArrayList(f64),
    start: usize,

    fn len(self: Points) usize {
        return self.list.items.len - self.start;
    }

    fn push(self: Points, x: f64, y: f64) Error!void {
        try self.list.appendSlice(allocator, &.{ x, y });
    }

    /// (x, y), unless it is the point last put.
    fn put(self: Points, x: f64, y: f64) Error!void {
        const items = self.list.items;
        const n = items.len;
        if (n - self.start < 2 or items[n - 2] != x or items[n - 1] != y) {
            try self.push(x, y);
        }
    }

    /// `length -= 2`, which throws in JS where there is no point to take.
    fn drop(self: Points) Error!void {
        if (self.len() < 2) {
            return error.Refused;
        }

        self.list.items.len -= 2;
    }
};

fn add(x: f64, y: f64) Error!void {
    const n = points.items.len;
    if (n == 0 or points.items[n - 2] != x or points.items[n - 1] != y) {
        try points.appendSlice(allocator, &.{ x, y });
    }
}

/// `path` through (a b c d) flattened as fills.ts's trace flattens it, each point once, into `points`.
fn polyline(path: []const f64, a: f64, b: f64, c: f64, d: f64, flatness: f64) Error!void {
    points.clearRetainingCapacity();
    var x: f64 = 0;
    var y: f64 = 0;
    var i: usize = 0;
    while (i < path.len) {
        const command = path[i];
        const size: usize = if (command == MOVE or command == LINE) 3 else if (command == CURVE) 5 else if (command == CUBIC) 7 else return error.Malformed;
        if (size > path.len - i) {
            return error.Malformed;
        }

        // The command's points through the transform.
        var q: [6]f64 = undefined;
        var k: usize = 0;
        while (k < size - 1) : (k += 2) {
            const px = path[i + 1 + k];
            const py = path[i + 2 + k];
            q[k] = a * px + c * py;
            q[k + 1] = b * px + d * py;
        }

        i += size;
        switch (size) {
            3 => {
                x = q[0];
                y = q[1];
                try add(x, y);
            },
            5 => {
                const cx = q[0];
                const cy = q[1];
                const ax = q[2];
                const ay = q[3];
                const bend = hypot(x - 2 * cx + ax, y - 2 * cy + ay);
                const n = steps(@ceil(@sqrt(bend / (4 * flatness))), 256);
                const total: f64 = @floatFromInt(n);
                for (1..@max(n, 1)) |s| {
                    const t = @as(f64, @floatFromInt(s)) / total;
                    const u = 1 - t;
                    try add(u * u * x + 2 * u * t * cx + t * t * ax, u * u * y + 2 * u * t * cy + t * t * ay);
                }

                try add(ax, ay);
                x = ax;
                y = ay;
            },
            else => {
                const c1x = q[0];
                const c1y = q[1];
                const c2x = q[2];
                const c2y = q[3];
                const ax = q[4];
                const ay = q[5];
                const first = hypot(x - 2 * c1x + c2x, y - 2 * c1y + c2y);
                const second = hypot(c1x - 2 * c2x + ax, c1y - 2 * c2y + ay);
                const bend = if (std.math.isNan(first) or std.math.isNan(second)) std.math.nan(f64) else @max(first, second);
                const n = steps(@ceil(@sqrt((3 * bend) / (4 * flatness))), 256);
                const total: f64 = @floatFromInt(n);
                for (1..@max(n, 1)) |s| {
                    const t = @as(f64, @floatFromInt(s)) / total;
                    const u = 1 - t;
                    try add(
                        u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ax,
                        u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ay,
                    );
                }

                try add(ax, ay);
                x = ax;
                y = ay;
            },
        }
    }
}

/// The widest angle a chord of an arc of radius `r` may span.
fn arcStep(r: f64, flatness: f64) f64 {
    return if (r > flatness) 2 * std.math.acos(1 - flatness / r) else std.math.pi;
}

/// The chords of an arc about (cx, cy) of radius `r`, from `from` turning `sweep`, past its start.
fn arc(out: Points, cx: f64, cy: f64, r: f64, from: f64, sweep: f64, most: f64) Error!void {
    const pieces = steps(@ceil(@abs(sweep) / most), 256);
    const total: f64 = @floatFromInt(pieces);
    try out.list.ensureUnusedCapacity(allocator, pieces * 2);
    for (1..pieces + 1) |i| {
        const angle = from + (sweep * @as(f64, @floatFromInt(i))) / total;
        out.list.appendSliceAssumeCapacity(&.{ cx + r * cosine(angle), cy + r * sine(angle) });
    }
}

/// The unit direction from point `i` to point `j` of `p`.
fn direction(p: []const f64, i: usize, j: usize) [2]f64 {
    const dx = p[j * 2] - p[i * 2];
    const dy = p[j * 2 + 1] - p[i * 2 + 1];
    const l = hypot(dx, dy);
    return .{ dx / l, dy / l };
}

/// Each of the first `segments` segments of `p` (n points), closing back to the first: its way and length.
fn segmentWays(p: []const f64, n: usize, segments: usize) Error![]Way {
    try ways.resize(allocator, segments);
    const w = ways.items;
    for (w, 0..) |*way, k| {
        const i = k * 2;
        const j = ((k + 1) % n) * 2;
        const dx = p[j] - p[i];
        const dy = p[j + 1] - p[i + 1];
        const l = hypot(dx, dy);
        way.* = .{ .x = dx / l, .y = dy / l, .length = l };
    }

    return w;
}

/// JS truthiness of a number.
inline fn truthy(x: f64) bool {
    return x != 0 and !std.math.isNan(x);
}

/// One side of `p` (n points), `h` out on the left of its way (s 1) or the right (-1).
fn side(out: Points, p: []const f64, n: usize, closed: bool, h: f64, s: f64, join: usize, limit: f64, step: f64) Error!void {
    const segments = if (closed) n else n - 1;
    const w = try segmentWays(p, n, segments);
    var started = false;
    for (0..segments) |k| {
        const i = k;
        const j = (k + 1) % n;
        const tx = w[k].x;
        const ty = w[k].y;
        const nx = ty * s * h;
        const ny = -tx * s * h;
        if (!started) {
            try out.put(p[i * 2] + nx, p[i * 2 + 1] + ny);
        }

        started = false;
        if (!closed and k == segments - 1) {
            try out.put(p[j * 2] + nx, p[j * 2 + 1] + ny);
            break;
        }

        const ux = w[j].x;
        const uy = w[j].y;
        const mx = uy * s * h;
        const my = -ux * s * h;
        const x = p[j * 2];
        const y = p[j * 2 + 1];
        const cross = tx * uy - ty * ux;
        const dot = tx * ux + ty * uy;
        const outer = cross * s > 0 or (cross == 0 and dot < 0);
        if (!outer) {
            const back = if (closed and k == segments - 1) -1 else gentleBack(h, cross, dot, w[k].length, w[j].length);
            if (back >= 0) {
                try out.put(x + nx - tx * back, y + ny - ty * back);
                started = true;
                continue;
            }

            try out.put(x + nx, y + ny);
            try out.put(x, y);
            try out.put(x + mx, y + my);
            started = true;
            continue;
        }

        try out.put(x + nx, y + ny);
        try outerJoin(out, x, y, nx, ny, mx, my, tx, ty, ux, uy, cross, dot, h, join, limit, step);
        try out.put(x + mx, y + my);
        started = true;
    }
}

/// The points a turn at (x, y) from one way to the next puts onto `out` between its outer side's
/// corners, as `join` joins it: a round join's arc, a miter's tip or the cut the limit (half widths)
/// makes of it, a bevel's none.
fn outerJoin(out: Points, x: f64, y: f64, nx: f64, ny: f64, mx: f64, my: f64, tx: f64, ty: f64, ux: f64, uy: f64, cross: f64, dot: f64, h: f64, join: usize, limit: f64, step: f64) Error!void {
    switch (join) {
        0 => {
            const turn = std.math.atan2(@abs(cross), dot);
            const way = if (cross != 0) sign(nx * my - ny * mx) else sign(nx * ty - ny * tx);
            try arc(out, x, y, h, std.math.atan2(ny, nx), way * turn, step);
            try out.drop();
        },
        2 => {
            const turn = std.math.atan2(@abs(cross), dot);
            const ratio = 1 / cosine(turn / 2);
            var bx = nx + mx;
            var by = ny + my;
            const l = hypot(bx, by);
            if (truthy(l)) {
                bx = bx / l;
                by = by / l;
            } else {
                bx = tx;
                by = ty;
            }

            if (ratio <= limit) {
                try out.push(x + bx * h * ratio, y + by * h * ratio);
                return;
            }

            // Cut where the limit, `limit` half widths out along the bisector, crosses each side.
            const reach = limit * h;
            inline for (.{ .{ nx, ny, tx, ty }, .{ mx, my, -ux, -uy } }) |cut| {
                const along = cut[2] * bx + cut[3] * by;
                const t = if (truthy(along)) (reach - (cut[0] * bx + cut[1] * by)) / along else 0;
                try out.push(x + cut[0] + cut[2] * t, y + cut[1] + cut[3] * t);
            }
        },
        else => {},
    }
}

/// How far a turn of half width `h` cuts back each segment's inner side where the two cross: within
/// the half of each next to it, at a turn of less than a right angle; -1 where it is sharper or the
/// segments shorter, and the inner sides go through the turn's own point.
fn gentleBack(h: f64, cross: f64, dot: f64, length_in: f64, length_out: f64) f64 {
    const back = (h * @abs(cross)) / (1 + dot);
    return if (dot > 0 and 2 * back <= length_in and 2 * back <= length_out) back else -1;
}

/// A cap at a point of a polyline, facing out along its way, from one side to the other, onto `out`.
fn cap(out: Points, p: []const f64, i: usize, tx: f64, ty: f64, h: f64, kind: usize, step: f64) Error!void {
    const x = p[i * 2];
    const y = p[i * 2 + 1];
    const lx = ty * h;
    const ly = -tx * h;
    switch (kind) {
        0 => try arc(out, x, y, h, std.math.atan2(ly, lx), std.math.pi, step),
        2 => {
            try out.push(x + lx + tx * h, y + ly + ty * h);
            try out.push(x - lx + tx * h, y - ly + ty * h);
            try out.push(x - lx, y - ly);
        },
        else => try out.push(x - lx, y - ly),
    }
}

/// A new outline contour, after the last.
fn contour() Points {
    return .{ .list = &outlines, .start = outlines.items.len };
}

/// The contour begun last, ended where the outlines are.
fn close() Error!void {
    try ends.append(allocator, @intCast(outlines.items.len));
}

/// Outline contour `k`.
fn contourAt(k: usize) []f64 {
    const from = if (k == 0) 0 else ends.items[k - 1];
    return outlines.items[from..ends.items[k]];
}

/// The outline of a polyline as contours to fill non-zero, after the outlines': an open one is one
/// contour, out along its left side, around its end cap, back along its right side and around its
/// start cap; a closed one is two, its left side forward and its right side back. A single point
/// with round caps is a dot; with others, nothing.
fn outline(p: []const f64, closed: bool, h: f64, caps: usize, join: usize, limit: f64, flatness: f64) Error!void {
    var n = p.len / 2;
    if (closed and n > 1 and p[0] == p[(n - 1) * 2] and p[1] == p[(n - 1) * 2 + 1]) {
        n -= 1;
    }

    if (n == 0) {
        return error.Refused;
    }

    if (n == 1) {
        if (caps != 0) {
            return;
        }

        try arc(contour(), p[0], p[1], h, 0, 2 * std.math.pi, arcStep(h, flatness));
        return close();
    }

    const step = arcStep(h, flatness);
    if (closed and n >= 2) {
        try side(contour(), p, n, true, h, 1, join, limit, step);
        try close();
        // There and back: its left side, joined at both ends, is the whole outline.
        if (n == 2) {
            return;
        }

        right.clearRetainingCapacity();
        try side(.{ .list = &right, .start = 0 }, p, n, true, h, -1, join, limit, step);
        const r = right.items;
        try outlines.ensureUnusedCapacity(allocator, r.len);
        var i = r.len;
        while (i >= 2) {
            i -= 2;
            outlines.appendSliceAssumeCapacity(&.{ r[i], r[i + 1] });
        }

        return close();
    }

    // Out along the left side, around the end, back along the right side (the reversed points' left).
    reversed.clearRetainingCapacity();
    try reversed.ensureUnusedCapacity(allocator, n * 2);
    var i = n;
    while (i > 0) {
        i -= 1;
        reversed.appendSliceAssumeCapacity(&.{ p[i * 2], p[i * 2 + 1] });
    }

    const back = reversed.items;
    const out = contour();
    try side(out, p, n, false, h, 1, join, limit, step);
    const e = direction(p, n - 2, n - 1);
    try cap(out, p, n - 1, e[0], e[1], h, caps, step);
    try out.drop();
    try side(out, back, n, false, h, 1, join, limit, step);
    const s = direction(back, n - 2, n - 1);
    try cap(out, back, n - 1, s[0], s[1], h, caps, step);
    try out.drop();
    return close();
}

/// Twice a contour's signed area, positive turning clockwise on a y-down stage.
fn contourArea(p: []const f64) f64 {
    var sum: f64 = 0;
    if (p.len == 0) {
        return sum;
    }

    var j = p.len - 2;
    var i: usize = 0;
    while (i < p.len) : (i += 2) {
        sum += p[j] * p[i + 1] - p[i] * p[j + 1];
        j = i;
    }

    return sum;
}

/// A closed triangle's outline as two plain contours, after the outlines': its outer side, and the
/// triangle inset by the half width, wound the other way, so that its inner side never passes
/// through its corners, which a drawTriangles mesh's neighbours share and libtess2's sweep was seen
/// to drop part of a ring at: false, adding none, for any path
/// but a closed triangle, for outline() to outline.
fn triangleRing(p: []const f64, h: f64, caps: usize, join: usize, limit: f64, flatness: f64) Error!bool {
    const closes = p.len == 8 and p[0] == p[6] and p[1] == p[7];
    if (p.len != 6 and !closes) {
        return false;
    }

    const area = contourArea(p[0..6]);
    if (area == 0) {
        return false;
    }

    // Its outer side the larger of outline()'s contours. None, and outline() again would make none.
    const first = ends.items.len;
    const mark = outlines.items.len;
    try outline(p, true, h, caps, join, limit, flatness);
    var outer: ?usize = null;
    var outer_area: f64 = 0;
    for (first..ends.items.len) |k| {
        const size = @abs(contourArea(contourAt(k)));
        if (outer == null or size > outer_area) {
            outer = k;
            outer_area = size;
        }
    }

    const kept = outer orelse return true;
    ring.clearRetainingCapacity();
    try ring.appendSlice(allocator, contourAt(kept));
    outlines.items.len = mark;
    ends.items.len = first;
    try outlines.appendSlice(allocator, ring.items);
    try close();
    const perimeter = hypot(p[2] - p[0], p[3] - p[1]) + hypot(p[4] - p[2], p[5] - p[3]) + hypot(p[0] - p[4], p[1] - p[5]);
    if ((2 * @abs(area)) / perimeter <= h) {
        return true;
    }

    // Each corner where the sides next to it, moved in by h, cross.
    var inset: [6]f64 = undefined;
    const s = sign(area);
    inline for (0..3) |i| {
        const x = p[i * 2];
        const y = p[i * 2 + 1];
        const u = direction(p, (i + 2) % 3, i);
        const v = direction(p, i, (i + 1) % 3);
        const ax = -u[1] * s * h;
        const ay = u[0] * s * h;
        const bx = -v[1] * s * h;
        const by = v[0] * s * h;
        const t = ((bx - ax) * -v[1] - (by - ay) * -v[0]) / (u[0] * -v[1] - u[1] * -v[0]);
        inset[i * 2] = x + ax + u[0] * t;
        inset[i * 2 + 1] = y + ay + u[1] * t;
    }

    // Wound against the outer side, so that it is the ring's hole.
    if (sign(contourArea(&inset)) == sign(contourArea(ring.items))) {
        try outlines.appendSlice(allocator, &.{ inset[4], inset[5], inset[2], inset[3], inset[0], inset[1] });
    } else {
        try outlines.appendSlice(allocator, &inset);
    }

    try close();
    return true;
}

/// An outline the tessellator fills: its contours of three points or more filled non-zero, by
/// libtess2 or its bands, as the host's Tessellator fills them, onto the geometry; refused where
/// neither could fill them in the memory left.
fn fillUsable() Error!void {
    defer {
        outlines.clearRetainingCapacity();
        ends.clearRetainingCapacity();
    }

    // The contours too short to cover anything left out, and the others' ends counted in points.
    var written: usize = 0;
    var kept: usize = 0;
    var from: usize = 0;
    for (ends.items) |end| {
        const length = end - from;
        if (length >= 6) {
            std.mem.copyForwards(f64, outlines.items[written..][0..length], outlines.items[from..end]);
            written += length;
            ends.items[kept] = @intCast(written / 2);
            kept += 1;
        }

        from = end;
    }

    if (kept == 0) {
        return;
    }

    // libtess2's scratch goes once its output is kept, which is copied past the scratch and then
    // down over it, as tessellate.zig's layer keeps a fill's.
    const mark = arena.top;
    const status = tessellate.fill(outlines.items[0..written], ends.items[0..kept], 1);
    const result = tessellate.current() orelse {
        arena.top = mark;
        return if (status == -1) error.OutOfMemory else error.Refused;
    };
    if (status != 0) {
        tessellate.clear();
        arena.top = mark;
        return error.Refused;
    }

    const position_bytes = result.positions.len * @sizeOf(f64);
    const bytes = position_bytes + result.indices.len * @sizeOf(u32);
    const staged = arena.alloc(bytes);
    tessellate.clear();
    if (staged == 0) {
        arena.top = mark;
        return error.OutOfMemory;
    }

    const stage: [*]u8 = @ptrFromInt(staged);
    @memcpy(stage[0..position_bytes], std.mem.sliceAsBytes(result.positions));
    @memcpy(stage[position_bytes..bytes], std.mem.sliceAsBytes(result.indices));
    arena.top = mark;
    const kept_at = arena.alloc(bytes);
    if (kept_at == 0) {
        return error.OutOfMemory;
    }

    const to: [*]u8 = @ptrFromInt(kept_at);
    std.mem.copyForwards(u8, to[0..bytes], stage[0..bytes]);
    const out_positions = @as([*]const f64, @ptrFromInt(kept_at))[0..result.positions.len];
    const out_indices = @as([*]const i32, @ptrFromInt(kept_at + position_bytes))[0..result.indices.len];

    const base: u32 = @intCast(positions.items.len / 2);
    try positions.ensureUnusedCapacity(allocator, out_positions.len);
    for (out_positions) |value| {
        positions.appendAssumeCapacity(@floatCast(value));
    }

    try indices.ensureUnusedCapacity(allocator, out_indices.len);
    for (out_indices) |index| {
        indices.appendAssumeCapacity(@as(u32, @intCast(index)) + base);
    }
}

/// The vertices from `start` on in `color`, the line's.
fn colorFrom(start: u32) Error!void {
    if (runs.items.len > 0 and runs.items[runs.items.len - 1].start == start) {
        runs.items[runs.items.len - 1].color = color;
        return;
    }

    try runs.append(allocator, .{ .start = start, .color = color });
}

fn vertex(x: f64, y: f64) Error!i32 {
    const at: i32 = @intCast(positions.items.len / 2);
    if (std.math.isNan(x) or std.math.isNan(y)) {
        nan_seen = true;
    }

    try positions.appendSlice(allocator, &.{ @floatCast(x), @floatCast(y) });
    return at;
}

fn triangle(a: i32, b: i32, c: i32) Error!void {
    try indices.appendSlice(allocator, &.{ @bitCast(a), @bitCast(b), @bitCast(c) });
}

/// A fan about `center` over `first`, the points in `between` from `from`, and `last`.
fn fan(center: i32, first: i32, last: i32, from: usize) Error!void {
    var previous = first;
    var k = from;
    while (k < between.items.len) : (k += 2) {
        const next = try vertex(between.items[k], between.items[k + 1]);
        try triangle(center, previous, next);
        previous = next;
    }

    try triangle(center, previous, last);
    between.clearRetainingCapacity();
}

const CORNERS: usize = 6;
const START_L: usize = 0;
const START_R: usize = 1;
const START_M: usize = 2;
const END_L: usize = 3;
const END_R: usize = 4;
const END_M: usize = 5;

/// A polyline of a line drawn opaque as triangles that may overlap, where an overlap draws the same
/// pixels again: a quad along each segment, each turn's outer wedge as the line joins it
/// (outerJoin) and the caps, which cover what outline's contours do, with no tessellator. Segments
/// share their corners at a gentle turn (gentleBack); at a sharper one they overlap, each with a
/// corner at the turn's own point too, which its wedge fans from. No vertex lies on another's edge.
fn lineTriangles(p: []const f64, closed: bool, h: f64, caps: usize, join: usize, limit: f64, flatness: f64) Error!void {
    var n = p.len / 2;
    if (closed and n > 1 and p[0] == p[(n - 1) * 2] and p[1] == p[(n - 1) * 2 + 1]) {
        n -= 1;
    }

    if (n == 0) {
        return error.Refused;
    }

    between.clearRetainingCapacity();
    const turn: Points = .{ .list = &between, .start = 0 };
    if (n == 1) {
        if (caps == 0) {
            const first = try vertex(p[0] + h, p[1]);
            try arc(turn, p[0], p[1], h, 0, 2 * std.math.pi, arcStep(h, flatness));
            try turn.drop();
            try fan(try vertex(p[0], p[1]), first, first, 0);
        }

        return;
    }

    const segments = if (closed) n else n - 1;
    try corners.resize(allocator, segments * CORNERS);
    const w = try segmentWays(p, n, segments);
    const step = arcStep(h, flatness);
    const c = corners.items;
    for (0..segments) |k| {
        c[k * CORNERS + START_M] = -1;
        c[k * CORNERS + END_M] = -1;
    }

    if (!closed) {
        const s = w[0];
        c[START_L] = try vertex(p[0] + s.y * h, p[1] - s.x * h);
        c[START_R] = try vertex(p[0] - s.y * h, p[1] + s.x * h);
        const e = w[n - 2];
        const x = p[(n - 1) * 2];
        const y = p[(n - 1) * 2 + 1];
        const end = (n - 2) * CORNERS;
        c[end + END_L] = try vertex(x + e.y * h, y - e.x * h);
        c[end + END_R] = try vertex(x - e.y * h, y + e.x * h);
    }

    var j: usize = if (closed) 0 else 1;
    while (j < (if (closed) n else n - 1)) : (j += 1) {
        const before = (j + n - 1) % n;
        const x = p[j * 2];
        const y = p[j * 2 + 1];
        const tx = w[before].x;
        const ty = w[before].y;
        const ux = w[j].x;
        const uy = w[j].y;
        const cross = tx * uy - ty * ux;
        const dot = tx * ux + ty * uy;
        const end = before * CORNERS;
        const start = j * CORNERS;
        if (cross == 0 and dot > 0) {
            const l = try vertex(x + ty * h, y - tx * h);
            c[end + END_L] = l;
            c[start + START_L] = l;
            const r = try vertex(x - ty * h, y + tx * h);
            c[end + END_R] = r;
            c[start + START_R] = r;
            continue;
        }

        const s: f64 = if (cross < 0) -1 else 1;
        const nx = ty * s * h;
        const ny = -tx * s * h;
        const mx = uy * s * h;
        const my = -ux * s * h;
        const back = gentleBack(h, cross, dot, w[before].length, w[j].length);
        const outer_end = try vertex(x + nx, y + ny);
        const outer_start = try vertex(x + mx, y + my);
        const center = if (back >= 0) try vertex(x - nx - tx * back, y - ny - ty * back) else try vertex(x, y);
        const inner_end = if (back >= 0) center else try vertex(x - nx, y - ny);
        const inner_start = if (back >= 0) center else try vertex(x - mx, y - my);
        const left = s == 1;
        c[end + (if (left) END_L else END_R)] = outer_end;
        c[end + (if (left) END_R else END_L)] = inner_end;
        c[start + (if (left) START_L else START_R)] = outer_start;
        c[start + (if (left) START_R else START_L)] = inner_start;
        if (back < 0) {
            c[end + END_M] = center;
            c[start + START_M] = center;
        }

        try outerJoin(turn, x, y, nx, ny, mx, my, tx, ty, ux, uy, cross, dot, h, join, limit, step);
        try fan(center, outer_end, outer_start, 0);
    }

    for (0..segments) |k| {
        const at = k * CORNERS;
        const middle = c[at + START_M];
        const from = if (middle >= 0) middle else c[at + START_L];
        const end_middle = c[at + END_M];
        try triangle(from, c[at + START_R], c[at + END_R]);
        if (end_middle >= 0) {
            try triangle(from, c[at + END_R], end_middle);
            try triangle(from, end_middle, c[at + END_L]);
        } else {
            try triangle(from, c[at + END_R], c[at + END_L]);
        }

        if (middle >= 0) {
            try triangle(from, c[at + END_L], c[at + START_L]);
        }
    }

    if (closed or caps == 1) {
        return;
    }

    // Each end facing out along its segment, fanned from the corner on the left of the way out round
    // to the one on its right. Out of the start is its first segment's way back, negated exactly as
    // JS's division gives it.
    const last = (n - 2) * CORNERS;
    inline for (.{
        .{ n - 1, w[n - 2].x, w[n - 2].y, c[last + END_L], c[last + END_R] },
        .{ 0, -w[0].x, -w[0].y, c[START_R], c[START_L] },
    }) |e| {
        try cap(turn, p, e[0], e[1], e[2], h, caps, step);
        try turn.drop();
        if (between.items.len > 0) {
            const first = try vertex(between.items[0], between.items[1]);
            try fan(e[3], first, e[4], 2);
        }
    }
}
