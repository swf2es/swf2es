//! What the bitmap kernels (blur.zig, pixels.zig) share of the player's JS
//! arithmetic: bitmap.ts's premultiply and unmultiply, and JS's ToInt32
//! and Math.round, so that each kernel converts as the JS did.
const std = @import("std");

const reciprocal = blk: {
    var table: [256]u32 = undefined;
    table[0] = 0;
    for (1..256) |a| table[a] = 0xff00 / a;
    break :blk table;
};

/// bitmap.ts's premultiply: `argb` with its colour premultiplied by its alpha.
pub fn premultiply(argb: u32) u32 {
    const a = argb >> 24;
    if (a == 255) return argb;
    if (a == 0) return 0;
    const r = (((argb >> 16) & 0xff) * a + 127) / 255;
    const g = (((argb >> 8) & 0xff) * a + 127) / 255;
    const b = ((argb & 0xff) * a + 127) / 255;
    return (a << 24) | (r << 16) | (g << 8) | b;
}

/// bitmap.ts's unmultiply: a premultiplied pixel with its alpha divided back out.
pub fn unmultiply(pixel: u32) u32 {
    const a = pixel >> 24;
    if (a == 255) return pixel;
    if (a == 0) return 0;
    const k = reciprocal[a];
    const r: u32 = @min(255, (((pixel >> 16) & 0xff) * k + 127) >> 8);
    const g: u32 = @min(255, (((pixel >> 8) & 0xff) * k + 127) >> 8);
    const b: u32 = @min(255, ((pixel & 0xff) * k + 127) >> 8);
    return (a << 24) | (r << 16) | (g << 8) | b;
}

/// JS's ToInt32: NaN and the infinities 0, the rest truncated and wrapped.
pub fn toInt32(x: f64) i32 {
    // Within an int, as nearly every value is, a plain conversion; fmod, a call in Wasm, past it.
    if (x > -2147483649.0 and x < 2147483648.0) return @intFromFloat(@trunc(x));
    if (!std.math.isFinite(x)) return 0;
    const m = @mod(@trunc(x), 4294967296.0);
    return @bitCast(@as(u32, @intFromFloat(m)));
}

/// JS's Math.round: to the nearest, a half up.
pub fn round(x: f64) f64 {
    const r = @floor(x);
    return if (x - r >= 0.5) r + 1 else r;
}

test "premultiply and unmultiply round as the store does" {
    try std.testing.expectEqual(@as(u32, 0x80402010), premultiply(0x80804020));
    try std.testing.expectEqual(@as(u32, 0), premultiply(0x00ffffff));
    try std.testing.expectEqual(@as(u32, 0x807f4020), unmultiply(0x80402010));
}

test "toInt32 wraps as JS does" {
    try std.testing.expectEqual(@as(i32, -2147483648), toInt32(2147483648.0));
    try std.testing.expectEqual(@as(i32, 1), toInt32(4294967297.0));
    try std.testing.expectEqual(@as(i32, 0), toInt32(std.math.inf(f64)));
    try std.testing.expectEqual(@as(i32, -1), toInt32(-1.5));
    try std.testing.expectEqual(@as(f64, 1), round(0.5));
    try std.testing.expectEqual(@as(f64, -1), round(-1.5));
}
