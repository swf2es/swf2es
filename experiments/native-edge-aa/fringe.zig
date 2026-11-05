//! A bounded prototype for isolated, opaque convex outlines. The original
//! boundary is retained; internal triangulation edges never receive coverage.
const std = @import("std");
const most = 512;
var input: [most * 2]f64 = undefined;
var output: [most * 19]u32 = undefined;
var inward: [most][2]f64 = undefined;
var inner: [most][2]f64 = undefined;
var outer: [most][2]f64 = undefined;

export fn inputAddress() usize {
    return @intFromPtr(&input);
}

export fn outputAddress() usize {
    return @intFromPtr(&output);
}

fn point(i: usize) [2]f64 {
    return .{ input[i * 2], input[i * 2 + 1] };
}

fn cross(a: [2]f64, b: [2]f64, p: [2]f64) f64 {
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/// Returns the index count, or -1 for an outline outside the prototype's
/// scope. The result has 2*n positions, texels, colours, then its indices.
export fn build(n: usize, pixel: f64, color: u32) i32 {
    if (n < 3 or n > most or !std.math.isFinite(pixel) or pixel <= 0 or color >> 24 != 255) return -1;
    var area: f64 = 0;
    for (0..n) |i| {
        const a = point(i);
        const b = point((i + 1) % n);
        if (!std.math.isFinite(a[0]) or !std.math.isFinite(a[1]) or @abs(a[0]) > 1e12 or @abs(a[1]) > 1e12) return -1;
        area += a[0] * b[1] - a[1] * b[0];
    }
    if (@abs(area) < 1e-10) return -1;
    const sign: f64 = if (area > 0) 1 else -1;

    for (0..n) |i| {
        const a = point(i);
        const b = point((i + 1) % n);
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length = @sqrt(dx * dx + dy * dy);
        if (length < 1e-8) return -1;
        inward[i] = .{ -dy / length * sign, dx / length * sign };
        // This also rejects stars whose consecutive turns all have one sign.
        for (0..n) |j| {
            if (sign * cross(a, b, point(j)) < -1e-8) return -1;
        }
    }

    for (0..n) |i| {
        const a = inward[(i + n - 1) % n];
        const b = inward[i];
        const divisor = 1 + a[0] * b[0] + a[1] * b[1];
        if (divisor < 0.1) return -1;
        const x = (a[0] + b[0]) * (pixel * 0.5 / divisor);
        const y = (a[1] + b[1]) * (pixel * 0.5 / divisor);
        const p = point(i);
        inner[i] = .{ p[0] + x, p[1] + y };
        outer[i] = .{ p[0] - x, p[1] - y };
    }

    // Thin paths and corners where the inward offset folds need another
    // coverage algorithm. Returning -1 retains their original rendering.
    for (0..n) |i| {
        const j = (i + 1) % n;
        const a = point(i);
        const b = point(j);
        if ((inner[j][0] - inner[i][0]) * (b[0] - a[0]) + (inner[j][1] - inner[i][1]) * (b[1] - a[1]) <= 1e-8) return -1;
        for (0..n) |k| {
            if (sign * cross(inner[i], inner[j], inner[k]) < -1e-8) return -1;
        }
    }

    const vertices = n * 2;
    const floats: [*]f32 = @ptrCast(&output);
    for (0..vertices) |i| {
        const p = if (i < n) inner[i] else outer[i - n];
        floats[i * 2] = @floatCast(p[0]);
        floats[i * 2 + 1] = @floatCast(p[1]);
        floats[vertices * 2 + i * 2] = if (i < n) 1 else 0;
        // Untextured geometry has unused texel attributes. A prototype-only
        // shader interprets the negative y as coverage, after colour transforms.
        floats[vertices * 2 + i * 2 + 1] = -1;
        output[vertices * 4 + i] = color;
    }
    var at = vertices * 5;
    for (1..n - 1) |i| {
        output[at..][0..3].* = .{ 0, @intCast(i), @intCast(i + 1) };
        at += 3;
    }
    for (0..n) |i| {
        const j = (i + 1) % n;
        output[at..][0..6].* = .{ @intCast(i), @intCast(n + i), @intCast(j), @intCast(j), @intCast(n + i), @intCast(n + j) };
        at += 6;
    }
    return @intCast(at - vertices * 5);
}

test "opaque rectangle has disjoint core and edge bands" {
    input[0..8].* = .{ 0, 0, 20, 0, 20, 4, 0, 4 };
    try std.testing.expectEqual(30, build(4, 1, 0xffffffff));
    const f: [*]f32 = @ptrCast(&output);
    try std.testing.expectEqual(@as(f32, 0.5), f[0]);
    try std.testing.expectEqual(@as(f32, -0.5), f[8]);
}

test "thin, concave and malformed contours are refused" {
    input[0..8].* = .{ 0, 0, 20, 0, 20, 0.5, 0, 0.5 };
    try std.testing.expectEqual(-1, build(4, 1, 0xffffffff));
    input[0..10].* = .{ 0, 0, 10, 0, 3, 3, 10, 10, 0, 10 };
    try std.testing.expectEqual(-1, build(5, 1, 0xffffffff));
    try std.testing.expectEqual(-1, build(most + 1, 1, 0xffffffff));
    try std.testing.expectEqual(-1, build(4, std.math.nan(f64), 0xffffffff));
}
