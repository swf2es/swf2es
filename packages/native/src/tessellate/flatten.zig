//! A fill's contours, as the player's path commands, flattened to the
//! polygons libtess2 takes, as the player's render/tessellate.ts traces
//! them for its JS fill: the same flatness, segment counts and parametric
//! points, repeated points dropped, a closing point that repeats the first
//! dropped, and a contour of fewer than three points left out.
//!
//! A contour is a run of f64s: a command, then its coordinates. MOVE x y and
//! LINE x y go to the point; CURVE cx cy x y is a quadratic and CUBIC c1x c1y
//! c2x c2y x y a cubic from the pen. The pen starts each contour at 0, 0.
const std = @import("std");

pub const move: f64 = 1;
pub const line: f64 = 2;
pub const curve: f64 = 3;
pub const cubic: f64 = 4;

/// How far a chord may stray from its curve, in pixels: the player's FLATNESS.
const flatness: f64 = 0.02;
/// The most chords one curve flattens to.
pub const most_segments = 256;

/// The chords for a curve whose chords stray `raw` squared over n², as JS
/// clamps Math.ceil of it: a NaN bend gives JS no point between the ends,
/// as one chord does.
fn clamp(raw: f64) u32 {
    if (!(raw >= 1)) {
        return 1;
    }

    if (raw >= most_segments) {
        return most_segments;
    }

    return @intFromFloat(raw);
}

/// The length of (x, y). A plain square root, not Math.hypot's scaled sum:
/// they may differ in the last bit, which moves a count only where it lies
/// within that bit of a whole number, and either count is flat enough.
fn length(x: f64, y: f64) f64 {
    @setFloatMode(.strict);
    return @sqrt(x * x + y * y);
}

/// A quadratic's chords of parameter step 1/n stray at most |p0 - 2c + p2| / 4n².
pub fn quadraticSegments(x: f64, y: f64, cx: f64, cy: f64, ax: f64, ay: f64) u32 {
    @setFloatMode(.strict);
    const bend = length(x - 2 * cx + ax, y - 2 * cy + ay);
    return clamp(@ceil(@sqrt(bend / (4 * flatness))));
}

/// A cubic's chords stray at most 3|Δ²| / 4n² for the larger of its two second differences.
pub fn cubicSegments(x: f64, y: f64, c1x: f64, c1y: f64, c2x: f64, c2y: f64, ax: f64, ay: f64) u32 {
    @setFloatMode(.strict);
    // Math.max: NaN where either is.
    const first = length(x - 2 * c1x + c2x, y - 2 * c1y + c2y);
    const second = length(c1x - 2 * c2x + ax, c1y - 2 * c2y + ay);
    const bend = if (std.math.isNan(first) or std.math.isNan(second)) std.math.nan(f64) else @max(first, second);
    return clamp(@ceil(@sqrt((3 * bend) / (4 * flatness))));
}

/// How many f64s a command takes with its coordinates, or null for no command.
fn width(command: f64) ?usize {
    if (command == move or command == line) {
        return 3;
    }

    if (command == curve) {
        return 5;
    }

    if (command == cubic) {
        return 7;
    }

    return null;
}

/// The most points a contour flattens to, before repeats are dropped, or
/// null where its commands are malformed: an unknown command, or one cut short.
pub fn bound(path: []const f64) ?usize {
    var points: usize = 0;
    var x: f64 = 0;
    var y: f64 = 0;
    var i: usize = 0;
    while (i < path.len) {
        const size = width(path[i]) orelse return null;
        if (size > path.len - i) {
            return null;
        }

        const at = path[i..][0..size];
        if (size == 3) {
            points += 1;
        } else if (size == 5) {
            points += quadraticSegments(x, y, at[1], at[2], at[3], at[4]);
        } else {
            points += cubicSegments(x, y, at[1], at[2], at[3], at[4], at[5], at[6]);
        }

        x = at[size - 2];
        y = at[size - 1];
        i += size;
    }

    return points;
}

/// Points appended to a polygon, each unless it repeats the last.
const Polygon = struct {
    out: []f64,
    len: usize = 0,

    fn append(p: *Polygon, x: f64, y: f64) void {
        if (p.len == 0 or p.out[p.len - 2] != x or p.out[p.len - 1] != y) {
            p.out[p.len] = x;
            p.out[p.len + 1] = y;
            p.len += 2;
        }
    }
};

/// Flattens a contour that `bound` measured into `out`, which holds at
/// least twice its bound, returning the points written: a closing point
/// that repeats the first is dropped.
pub fn polygon(path: []const f64, out: []f64) usize {
    @setFloatMode(.strict);
    var p: Polygon = .{ .out = out };
    var x: f64 = 0;
    var y: f64 = 0;
    var i: usize = 0;
    while (i < path.len) {
        const command = path[i];
        if (command == move or command == line) {
            x = path[i + 1];
            y = path[i + 2];
            p.append(x, y);
            i += 3;
            continue;
        }

        if (command == cubic) {
            const c1x = path[i + 1];
            const c1y = path[i + 2];
            const c2x = path[i + 3];
            const c2y = path[i + 4];
            const ax = path[i + 5];
            const ay = path[i + 6];
            const n = cubicSegments(x, y, c1x, c1y, c2x, c2y, ax, ay);
            const steps: f64 = @floatFromInt(n);
            for (1..n) |k| {
                const t = @as(f64, @floatFromInt(k)) / steps;
                const u = 1 - t;
                p.append(
                    u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ax,
                    u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ay,
                );
            }

            p.append(ax, ay);
            x = ax;
            y = ay;
            i += 7;
            continue;
        }

        const cx = path[i + 1];
        const cy = path[i + 2];
        const ax = path[i + 3];
        const ay = path[i + 4];
        const n = quadraticSegments(x, y, cx, cy, ax, ay);
        const steps: f64 = @floatFromInt(n);
        for (1..n) |k| {
            const t = @as(f64, @floatFromInt(k)) / steps;
            const u = 1 - t;
            p.append(u * u * x + 2 * u * t * cx + t * t * ax, u * u * y + 2 * u * t * cy + t * t * ay);
        }

        p.append(ax, ay);
        x = ax;
        y = ay;
        i += 5;
    }

    if (p.len > 2 and out[0] == out[p.len - 2] and out[1] == out[p.len - 1]) {
        p.len -= 2;
    }

    return p.len / 2;
}

const testing = std.testing;

fn flattened(path: []const f64, buffer: []f64) []const f64 {
    const points = polygon(path, buffer[0 .. (bound(path).?) * 2]);
    return buffer[0 .. points * 2];
}

test "lines keep their points, repeats and the closing point dropped" {
    var buffer: [16]f64 = undefined;
    const path = [_]f64{ move, 0, 0, line, 10, 0, line, 10, 0, line, 10, 10, line, 0, 0 };
    try testing.expectEqualSlices(f64, &.{ 0, 0, 10, 0, 10, 10 }, flattened(&path, &buffer));
}

test "a quadratic's chords and points are the player's" {
    // bend = |(0,0) - 2(5,10) + (10,0)| = 20: ceil(sqrt(20 / 0.08)) = 16 chords.
    try testing.expectEqual(@as(u32, 16), quadraticSegments(0, 0, 5, 10, 10, 0));
    var buffer: [64]f64 = undefined;
    const path = [_]f64{ move, 0, 0, curve, 5, 10, 10, 0 };
    const points = flattened(&path, &buffer);
    try testing.expectEqual(@as(usize, 17 * 2), points.len);
    // t = 1/2: (5, 5).
    try testing.expectEqual(@as(f64, 5), points[16]);
    try testing.expectEqual(@as(f64, 5), points[17]);
}

test "a cubic's chords are bounded by its larger second difference" {
    // Δ² = (0,0) - 2(0,10) + (10,10) = (10,-10) and (0,10) - 2(10,10) + (10,0) = (-10,-10).
    const n = cubicSegments(0, 0, 0, 10, 10, 10, 10, 0);
    try testing.expectEqual(@as(u32, @intFromFloat(@ceil(@sqrt(3 * @sqrt(200.0) / 0.08)))), n);
}

test "curves are clamped to one chord and to 256" {
    try testing.expectEqual(@as(u32, 1), quadraticSegments(0, 0, 5, 0, 10, 0));
    try testing.expectEqual(@as(u32, 1), quadraticSegments(0, 0, std.math.nan(f64), 0, 10, 0));
    try testing.expectEqual(@as(u32, 1), cubicSegments(0, 0, 1, 0, std.math.nan(f64), 0, 10, 0));
    try testing.expectEqual(@as(u32, 256), quadraticSegments(0, 0, 1e6, 1e6, 0, 0));
    try testing.expectEqual(@as(u32, 256), quadraticSegments(0, 0, std.math.inf(f64), 0, 0, 0));
}

test "malformed commands are rejected" {
    try testing.expectEqual(@as(?usize, null), bound(&.{ move, 0 }));
    try testing.expectEqual(@as(?usize, null), bound(&.{ 5, 0, 0 }));
    try testing.expectEqual(@as(?usize, null), bound(&.{ std.math.nan(f64), 0, 0 }));
    try testing.expectEqual(@as(?usize, null), bound(&.{ move, 0, 0, cubic, 1, 2, 3, 4, 5 }));
    try testing.expectEqual(@as(?usize, 0), bound(&.{}));
}

test "a degenerate curve flattens to its ends" {
    var buffer: [8]f64 = undefined;
    const path = [_]f64{ move, 3, 4, curve, 3, 4, 3, 4 };
    try testing.expectEqualSlices(f64, &.{ 3, 4 }, flattened(&path, &buffer));
}
