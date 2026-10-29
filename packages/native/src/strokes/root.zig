//! A shape layer's opaque lines as triangles, in one call: the player's
//! scene/strokes.ts (layerStrokes for lines drawn opaque, polyline, and
//! lineTriangles with outerJoin, cap and gentleBack), ported with the same
//! arithmetic in the same order, so that its output is the TS's: every
//! position computed in f64 and rounded to f32 last, as Float32Array.from
//! rounds it. Math.hypot is V8's algorithm, not a plain square root, as a
//! last bit of a direction moves a corner and may flip a comparison.
//!
//! The input is a run of f64s: a, b, c, d (the linear transform), the
//! flatness and the number of lines; each line its half width, caps, join,
//! miter limit, vertex colour and number of paths; each path whether it is
//! closed home, its length, and its commands (MOVE x y, LINE x y, CURVE cx
//! cy x y, CUBIC c1x c1y c2x c2y x y), a fill's closing line already added.
const std = @import("std");

pub const panic = std.debug.no_panic;

const allocator = std.heap.wasm_allocator;

const MOVE: f64 = 1;
const LINE: f64 = 2;
const CURVE: f64 = 3;
const CUBIC: f64 = 4;

const Error = error{ OutOfMemory, Malformed };

var input_buffer: std.ArrayList(f64) = .empty;
var positions: std.ArrayList(f32) = .empty;
var colors: std.ArrayList(u32) = .empty;
var indices: std.ArrayList(u32) = .empty;
var points: std.ArrayList(f64) = .empty;
var between: std.ArrayList(f64) = .empty;
var corners: std.ArrayList(i32) = .empty;
/// Each segment's unit direction and length, as direction() and gentleBack() take them.
var ways: std.ArrayList(Way) = .empty;
/// The geometry laid out in one block for one copy: positions, colours, indices.
var block: std.ArrayList(u32) = .empty;
/// Where the block is, its vertices and its indices.
var header: [3]u32 = .{ 0, 0, 0 };
var color: u32 = 0;

const Way = struct { x: f64, y: f64, length: f64 };

export fn headerAt() usize {
    return @intFromPtr(&header);
}

/// The geometry built last as one block, for the header to describe: 0, or -1 out of memory.
export fn pack() i32 {
    const v = colors.items.len;
    const n = indices.items.len;
    block.resize(allocator, v * 3 + n) catch return -1;
    const out = block.items;
    @memcpy(out[0 .. v * 2], @as([]const u32, @ptrCast(positions.items)));
    @memcpy(out[v * 2 .. v * 3], colors.items);
    @memcpy(out[v * 3 ..], indices.items);
    header = .{ @intCast(@intFromPtr(out.ptr)), @intCast(v), @intCast(n) };
    return 0;
}

/// Room for `n` f64s of input, or 0.
export fn input(n: usize) usize {
    input_buffer.resize(allocator, n) catch return 0;
    return @intFromPtr(input_buffer.items.ptr);
}

export fn positionsAt() usize {
    return @intFromPtr(positions.items.ptr);
}

export fn colorsAt() usize {
    return @intFromPtr(colors.items.ptr);
}

export fn indicesAt() usize {
    return @intFromPtr(indices.items.ptr);
}

export fn vertexCount() usize {
    return colors.items.len;
}

export fn indexCount() usize {
    return indices.items.len;
}

/// The layer in the first `length` f64s of the input: 0, -1 out of memory, -2 malformed.
export fn build(length: usize) i32 {
    positions.clearRetainingCapacity();
    colors.clearRetainingCapacity();
    indices.clearRetainingCapacity();
    if (length > input_buffer.items.len) {
        return -2;
    }

    layer(input_buffer.items[0..length]) catch |e| return switch (e) {
        error.OutOfMemory => -1,
        error.Malformed => -2,
    };
    return 0;
}

fn count(value: f64, most: usize) Error!usize {
    if (!(value >= 0) or value > @as(f64, @floatFromInt(most))) {
        return error.Malformed;
    }

    return @intFromFloat(value);
}

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
        if (in.len - i < 6) {
            return error.Malformed;
        }

        const h = in[i];
        const caps = try count(in[i + 1], 2);
        const join = try count(in[i + 2], 2);
        const limit = in[i + 3];
        color = @intCast(try count(in[i + 4], 0xffffffff));
        const paths = try count(in[i + 5], in.len);
        i += 6;
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
            try lineTriangles(p, closed, h, caps, join, limit, flatness);
        }
    }
}

/// Math.hypot of two, as V8 computes it: normalised to the larger, summed with Kahan's compensation.
fn hypot(x: f64, y: f64) f64 {
    const ax = @abs(x);
    const ay = @abs(y);
    const nan = std.math.isNan(x) or std.math.isNan(y);
    var max: f64 = 0;
    if (!std.math.isNan(x) and ax > max) {
        max = ax;
    }

    if (!std.math.isNan(y) and ay > max) {
        max = ay;
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
    for ([2]f64{ ax, ay }) |value| {
        const n = value / max;
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

/// The chords of an arc about (cx, cy) of radius `r`, from `from` turning `sweep`, past its start.
/// The widest piece of an arc of the last radius and flatness: a line's every join and cap shares it.
var arc_r: f64 = std.math.nan(f64);
var arc_flatness: f64 = std.math.nan(f64);
var arc_most: f64 = 0;

fn arc(cx: f64, cy: f64, r: f64, from: f64, sweep: f64, flatness: f64) Error!void {
    if (r != arc_r or flatness != arc_flatness) {
        arc_r = r;
        arc_flatness = flatness;
        arc_most = if (r > flatness) 2 * std.math.acos(1 - flatness / r) else std.math.pi;
    }

    const most = arc_most;
    const pieces = steps(@ceil(@abs(sweep) / most), 256);
    const total: f64 = @floatFromInt(pieces);
    try between.ensureUnusedCapacity(allocator, pieces * 2);
    for (1..pieces + 1) |i| {
        const angle = from + (sweep * @as(f64, @floatFromInt(i))) / total;
        between.appendSliceAssumeCapacity(&.{ cx + r * @cos(angle), cy + r * @sin(angle) });
    }
}

/// Drops the last point of `between`, as JS's `length -= 2`.
fn dropLast() void {
    between.items.len -= @min(between.items.len, 2);
}

/// JS truthiness of a number.
inline fn truthy(x: f64) bool {
    return x != 0 and !std.math.isNan(x);
}

/// strokes.ts's outerJoin, onto `between`.
fn outerJoin(x: f64, y: f64, nx: f64, ny: f64, mx: f64, my: f64, tx: f64, ty: f64, ux: f64, uy: f64, cross: f64, dot: f64, h: f64, join: usize, limit: f64, flatness: f64) Error!void {
    switch (join) {
        0 => {
            const turn = std.math.atan2(@abs(cross), dot);
            const way = if (cross != 0) sign(nx * my - ny * mx) else sign(nx * ty - ny * tx);
            try arc(x, y, h, std.math.atan2(ny, nx), way * turn, flatness);
            dropLast();
        },
        2 => {
            const turn = std.math.atan2(@abs(cross), dot);
            const ratio = 1 / @cos(turn / 2);
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
                try between.appendSlice(allocator, &.{ x + bx * h * ratio, y + by * h * ratio });
                return;
            }

            const reach = limit * h;
            const cuts = [2][4]f64{ .{ nx, ny, tx, ty }, .{ mx, my, -ux, -uy } };
            for (cuts) |cut| {
                const along = cut[2] * bx + cut[3] * by;
                const t = if (truthy(along)) (reach - (cut[0] * bx + cut[1] * by)) / along else 0;
                try between.appendSlice(allocator, &.{ x + cut[0] + cut[2] * t, y + cut[1] + cut[3] * t });
            }
        },
        else => {},
    }
}

/// strokes.ts's gentleBack.
/// The segments' lengths are those direction() took: hypot is the same of (dx, dy) and (-dx, -dy).
fn gentleBack(before: f64, after: f64, h: f64, cross: f64, dot: f64) f64 {
    const back = (h * @abs(cross)) / (1 + dot);
    return if (dot > 0 and 2 * back <= before and 2 * back <= after) back else -1;
}

/// strokes.ts's cap, onto `between`.
fn cap(p: []const f64, i: usize, tx: f64, ty: f64, h: f64, kind: usize, flatness: f64) Error!void {
    const x = p[i * 2];
    const y = p[i * 2 + 1];
    const lx = ty * h;
    const ly = -tx * h;
    switch (kind) {
        0 => try arc(x, y, h, std.math.atan2(ly, lx), std.math.pi, flatness),
        2 => try between.appendSlice(allocator, &.{ x + lx + tx * h, y + ly + ty * h, x - lx + tx * h, y - ly + ty * h, x - lx, y - ly }),
        else => try between.appendSlice(allocator, &.{ x - lx, y - ly }),
    }
}

fn vertex(x: f64, y: f64) Error!i32 {
    const at: i32 = @intCast(colors.items.len);
    try positions.appendSlice(allocator, &.{ @floatCast(x), @floatCast(y) });
    try colors.append(allocator, color);
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

/// strokes.ts's lineTriangles.
fn lineTriangles(p: []const f64, closed: bool, h: f64, caps: usize, join: usize, limit: f64, flatness: f64) Error!void {
    var n = p.len / 2;
    if (closed and n > 1 and p[0] == p[(n - 1) * 2] and p[1] == p[(n - 1) * 2 + 1]) {
        n -= 1;
    }

    between.clearRetainingCapacity();
    if (n == 1) {
        if (caps == 0) {
            const first = try vertex(p[0] + h, p[1]);
            try arc(p[0], p[1], h, 0, 2 * std.math.pi, flatness);
            dropLast();
            try fan(try vertex(p[0], p[1]), first, first, 0);
        }

        return;
    }

    const segments = if (closed) n else n - 1;
    try ways.resize(allocator, segments);
    const w = ways.items;
    for (0..segments) |k| {
        const i = k * 2;
        const j = ((k + 1) % n) * 2;
        const dx = p[j] - p[i];
        const dy = p[j + 1] - p[i + 1];
        const l = hypot(dx, dy);
        w[k] = .{ .x = dx / l, .y = dy / l, .length = l };
    }

    try corners.resize(allocator, segments * CORNERS);
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
        const t = w[before];
        const u = w[j];
        const tx = t.x;
        const ty = t.y;
        const ux = u.x;
        const uy = u.y;
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
        const back = gentleBack(t.length, u.length, h, cross, dot);
        const outerEnd = try vertex(x + nx, y + ny);
        const outerStart = try vertex(x + mx, y + my);
        const center = if (back >= 0) try vertex(x - nx - tx * back, y - ny - ty * back) else try vertex(x, y);
        const innerEnd = if (back >= 0) center else try vertex(x - nx, y - ny);
        const innerStart = if (back >= 0) center else try vertex(x - mx, y - my);
        const left = s == 1;
        c[end + (if (left) END_L else END_R)] = outerEnd;
        c[end + (if (left) END_R else END_L)] = innerEnd;
        c[start + (if (left) START_L else START_R)] = outerStart;
        c[start + (if (left) START_R else START_L)] = innerStart;
        if (back < 0) {
            c[end + END_M] = center;
            c[start + START_M] = center;
        }

        try outerJoin(x, y, nx, ny, mx, my, tx, ty, ux, uy, cross, dot, h, join, limit, flatness);
        try fan(center, outerEnd, outerStart, 0);
    }

    for (0..segments) |k| {
        const at = k * CORNERS;
        const middle = c[at + START_M];
        const from = if (middle >= 0) middle else c[at + START_L];
        const endMiddle = c[at + END_M];
        try triangle(from, c[at + START_R], c[at + END_R]);
        if (endMiddle >= 0) {
            try triangle(from, c[at + END_R], endMiddle);
            try triangle(from, endMiddle, c[at + END_L]);
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

    const ends = [2][2]usize{ .{ n - 1, n - 2 }, .{ 0, 1 } };
    const sides = [2][2]i32{
        .{ c[(n - 2) * CORNERS + END_L], c[(n - 2) * CORNERS + END_R] },
        .{ c[START_R], c[START_L] },
    };
    // Out of the start is its first segment's way back: negated exactly, as JS's division gives it.
    const outs = [2]Way{ w[n - 2], .{ .x = -w[0].x, .y = -w[0].y, .length = w[0].length } };
    for (ends, sides, outs) |e, side, t| {
        try cap(p, e[0], t.x, t.y, h, caps, flatness);
        dropLast();
        if (between.items.len == 0) {
            continue;
        }

        const first = try vertex(between.items[0], between.items[1]);
        try fan(side[0], first, side[1], 2);
    }
}
