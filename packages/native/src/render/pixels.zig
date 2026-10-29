//! BitmapData's pixel operations that are loops over its pixels, as the
//! player's JS made them before this replaced it: copyChannel, merge,
//! paletteMap and a colour matrix filter over rows a copy reads and writes,
//! colorTransform in place, noise and perlinNoise drawn. Each on
//! unmultiplied ARGB where Flash's results show it works, written back as
//! the store keeps it, premultiplied, and opaque where the store is. A row
//! is read as the pixels before it left it, so that where the source is the
//! destination a move down or right repeats what was written, as in Flash.
//! bitmap.zig wraps them for Wasm.
const std = @import("std");

/// The destination's rows, `w` pixels of `h` rows `dst_stride` apart, and
/// the source's they read, `src_stride` apart, which may be the same block.
pub const Rows = extern struct {
    w: u32,
    h: u32,
    dst: u32,
    dst_stride: u32,
    src: u32,
    src_stride: u32,
    /// Whether the destination store is transparent: an opaque one keeps an alpha of 255.
    transparent: u32,
    unused: u32,
};

/// copyChannel: the source's channel at `from` (-1 for none, which copies 0) into the destination's at `to`.
pub const ChannelParams = extern struct {
    rows: Rows,
    from: i32,
    to: u32,
};

/// merge's multipliers, red, green, blue and alpha, each a uint.
pub const MergeParams = extern struct {
    rows: Rows,
    muls: [4]u32,
};

/// paletteMap's tables, red's, green's, blue's and alpha's, 256 entries each, at `tables`.
pub const PaletteParams = extern struct {
    rows: Rows,
    tables: u32,
    unused: u32,
};

/// A colour matrix filter's map of the source rows into the destination's:
/// (sx, sy) the source pixel of the rows' first; past `near` (none where
/// near_w is 0) a pixel takes `empty`.
pub const MatrixParams = extern struct {
    rows: Rows,
    sx: i32,
    sy: i32,
    near_x: i32,
    near_y: i32,
    near_w: u32,
    near_h: u32,
    empty: u32,
    /// 0xff000000 where the destination is opaque, else 0.
    opaque_alpha: u32,
    matrix: [20]f64,
};

/// colorTransform over w × h pixels at `pixels`, `stride` apart, in place:
/// each channel's multiplier in 256ths and its offset, red, green, blue,
/// alpha, as the JS computed them (doubles, truncated, so any of them).
pub const TransformParams = extern struct {
    w: u32,
    h: u32,
    pixels: u32,
    stride: u32,
    mul: [4]f64,
    add: [4]f64,
};

/// noise over `count` pixels at `pixels`: Park-Miller's generator at
/// `state`, which the call leaves where it got to, values lo + r % span.
pub const NoiseParams = extern struct {
    count: u32,
    pixels: u32,
    state: u32,
    lo: u32,
    span: i32,
    channels: u32,
    gray: u32,
    transparent: u32,
};

const B_SIZE = 0x100;
const PERLIN_N: f64 = 0x1000;
pub const LATTICE = B_SIZE + B_SIZE + 2;

/// perlinNoise's rows y0 to y0 + h of a w-wide bitmap at `pixels`: the
/// generator's lattice (LATTICE i32s) and four channels' gradients (LATTICE
/// × 2 f64s each) as turbulence.ts set them up from the seed, and `octaves`
/// offsets (x, y) at `offsets`.
pub const PerlinParams = extern struct {
    w: u32,
    h: u32,
    y0: u32,
    pixels: u32,
    lattice: u32,
    gradients: u32,
    offsets: u32,
    octaves: u32,
    channels: u32,
    gray: u32,
    fractal: u32,
    stitch: u32,
    transparent: u32,
    unused: u32,
    /// The frequencies, adjusted where stitching.
    fx: f64,
    fy: f64,
    /// Stitching's tile, in lattice cells, at the first octave.
    stitch_w: f64,
    stitch_h: f64,
};

const RECIPROCAL: [256]u32 = blk: {
    var table: [256]u32 = undefined;
    table[0] = 0;
    for (1..256) |a| table[a] = 0xff00 / a;
    break :blk table;
};

/// A premultiplied pixel with its alpha divided back out (bitmap.ts's unmultiply).
pub fn unmultiply(pixel: u32) u32 {
    const a = pixel >> 24;
    if (a == 255) return pixel;
    if (a == 0) return 0;
    const k = RECIPROCAL[a];
    const r: u32 = @min(255, (((pixel >> 16) & 0xff) * k + 127) >> 8);
    const g: u32 = @min(255, (((pixel >> 8) & 0xff) * k + 127) >> 8);
    const b: u32 = @min(255, ((pixel & 0xff) * k + 127) >> 8);
    return (a << 24) | (r << 16) | (g << 8) | b;
}

/// `argb` with its colour premultiplied by its alpha (bitmap.ts's premultiply).
pub fn premultiply(argb: u32) u32 {
    const a = argb >> 24;
    if (a == 255) return argb;
    if (a == 0) return 0;
    const r = (((argb >> 16) & 0xff) * a + 127) / 255;
    const g = (((argb >> 8) & 0xff) * a + 127) / 255;
    const b = ((argb & 0xff) * a + 127) / 255;
    return (a << 24) | (r << 16) | (g << 8) | b;
}

/// `argb` as a store keeps it: premultiplied, and opaque where it is.
fn keep(transparent: bool, argb: u32) u32 {
    return premultiply(if (transparent) argb else argb | 0xff000000);
}

/// Whether rows of `w` by `h` with `stride` lie within `n` pixels.
pub fn fits(w: u32, h: u32, stride: u32, n: usize) bool {
    if (w == 0 or h == 0 or w > stride) return false;
    return (@as(u64, h) - 1) * stride + w <= n;
}

/// Each destination pixel of `p` made by `f` of the source's and its own, unmultiplied.
inline fn copied(dst: [*]u32, src: [*]const u32, p: Rows, comptime f: anytype, ctx: anytype) void {
    const transparent = p.transparent != 0;
    for (0..p.h) |row| {
        const d = dst + row * p.dst_stride;
        const s = src + row * p.src_stride;
        for (0..p.w) |i| {
            d[i] = keep(transparent, f(ctx, unmultiply(s[i]), unmultiply(d[i])));
        }
    }
}

pub fn copyChannel(dst: [*]u32, src: [*]const u32, p: *const ChannelParams) void {
    const Ctx = struct {
        from: i32,
        to: u5,
        fn f(c: @This(), s: u32, d: u32) u32 {
            const v: u32 = if (c.from < 0) 0 else (s >> @intCast(c.from)) & 0xff;
            return (d & ~(@as(u32, 0xff) << c.to)) | (v << c.to);
        }
    };
    copied(dst, src, p.rows, Ctx.f, Ctx{ .from = p.from, .to = @intCast(p.to) });
}

pub fn merge(dst: [*]u32, src: [*]const u32, p: *const MergeParams) void {
    const Ctx = struct {
        muls: [4]i64,
        fn mix(s: u32, d: u32, shift: u5, m: i64) u32 {
            const v = @as(i64, (s >> shift) & 0xff) * m + @as(i64, (d >> shift) & 0xff) * (256 - m);
            return @as(u32, @intCast(@divFloor(v, 256) & 0xff)) << shift;
        }
        fn f(c: @This(), s: u32, d: u32) u32 {
            return mix(s, d, 24, c.muls[3]) | mix(s, d, 16, c.muls[0]) | mix(s, d, 8, c.muls[1]) | mix(s, d, 0, c.muls[2]);
        }
    };
    copied(dst, src, p.rows, Ctx.f, Ctx{ .muls = .{ p.muls[0], p.muls[1], p.muls[2], p.muls[3] } });
}

pub fn paletteMap(dst: [*]u32, src: [*]const u32, p: *const PaletteParams, tables: *const [1024]u32) void {
    const Ctx = struct {
        t: *const [1024]u32,
        fn f(c: @This(), s: u32, _: u32) u32 {
            return c.t[(s >> 16) & 0xff] +% c.t[256 + ((s >> 8) & 0xff)] +% c.t[512 + (s & 0xff)] +% c.t[768 + (s >> 24)];
        }
    };
    copied(dst, src, p.rows, Ctx.f, Ctx{ .t = tables });
}

const V4 = @Vector(4, f64);

/// The matrix's columns across its four rows, red's, green's, blue's and alpha's, for one product each.
const Columns = struct {
    c: [5]V4,

    fn of(m: *const [20]f64) Columns {
        var out: Columns = undefined;
        inline for (0..5) |k| out.c[k] = .{ m[k], m[5 + k], m[10 + k], m[15 + k] };
        return out;
    }

    /// Each row of straight (r, g, b, a), summed in the JS's order.
    fn map(self: *const Columns, r: f64, g: f64, b: f64, a: f64) V4 {
        return self.c[0] * @as(V4, @splat(r)) + self.c[1] * @as(V4, @splat(g)) + self.c[2] * @as(V4, @splat(b)) + self.c[3] * @as(V4, @splat(a)) + self.c[4];
    }
};

/// 255 / a for each alpha, 0 for none: what a pixel's channels are scaled by to straight colour.
const UNPREMULTIPLY: [256]f64 = blk: {
    var t: [256]f64 = undefined;
    t[0] = 0;
    for (1..256) |a| t[a] = 255.0 / @as(f64, @floatFromInt(a));
    break :blk t;
};

/// Each lane rounded as JS's Math.round does, a half up, and clamped to a byte; NaN 0.
fn bytes(v: V4) @Vector(4, u32) {
    const f = @floor(v);
    const half: V4 = @splat(0.5);
    const rounded = @select(f64, v - f >= half, f + @as(V4, @splat(1)), f);
    const zero: V4 = @splat(0);
    const clamped = @select(f64, rounded > zero, @select(f64, rounded < @as(V4, @splat(255)), rounded, @as(V4, @splat(255))), zero);
    // NaN fails both comparisons and is 0.
    return @intFromFloat(clamped);
}

/// A colour matrix's pixel `px`: its straight colour mapped, premultiplied
/// by the new alpha and truncated.
fn matrixOf(columns: *const Columns, px: u32) u32 {
    const a = px >> 24;
    const s = UNPREMULTIPLY[a];
    const v = bytes(columns.map(
        @as(f64, @floatFromInt((px >> 16) & 0xff)) * s,
        @as(f64, @floatFromInt((px >> 8) & 0xff)) * s,
        @as(f64, @floatFromInt(px & 0xff)) * s,
        @floatFromInt(a),
    ));
    const na = v[3];
    return (na << 24) | ((v[0] * na / 255) << 16) | ((v[1] * na / 255) << 8) | (v[2] * na / 255);
}

/// A colour matrix over the rows: each row in fours from its start, a four
/// read whole before it is written, the rest one by one, as adl does; past
/// `near` a pixel takes `empty`. A pixel like the last one mapped takes its map.
pub fn colorMatrix(dst: [*]u32, src: [*]const u32, p: *const MatrixParams) void {
    const columns = Columns.of(&p.matrix);
    var last: u32 = 0;
    var last_map = matrixOf(&columns, 0);
    var four: [4]u32 = undefined;
    for (0..p.rows.h) |row| {
        const d = dst + row * p.rows.dst_stride;
        const s = src + row * p.rows.src_stride;
        const y = @as(i64, p.sy) + @as(i64, @intCast(row));
        const in_rows = p.near_w != 0 and y >= p.near_y and y < @as(i64, p.near_y) + p.near_h;
        var col: usize = 0;
        while (col < p.rows.w) {
            const n: usize = if (p.rows.w - col >= 4) 4 else 1;
            for (0..n) |k| {
                const x = @as(i64, p.sx) + @as(i64, @intCast(col + k));
                if (!in_rows or x < p.near_x or x >= @as(i64, p.near_x) + p.near_w) {
                    four[k] = p.empty;
                    continue;
                }

                const px = s[col + k];
                if (px != last) {
                    last = px;
                    last_map = matrixOf(&columns, px);
                }

                four[k] = last_map;
            }

            for (0..n) |k| d[col + k] = four[k] | p.opaque_alpha;
            col += n;
        }
    }
}

/// colorTransform's channel: v × mul / 256 floored, the offset added, clamped; NaN 0.
fn transformed(v: u32, mul: f64, add: f64) u32 {
    const t = @floor(@as(f64, @floatFromInt(v)) * mul / 256) + add;
    if (!(t > 0)) return 0;
    return if (t >= 255) 255 else @intFromFloat(t);
}

/// colorTransform in place: each pixel's straight channels transformed and
/// written premultiplied as c × (a + 1) >> 8; a pixel of alpha 0 left.
pub fn colorTransform(pixels: [*]u32, p: *const TransformParams) void {
    for (0..p.h) |row| {
        const line = pixels + row * p.stride;
        for (0..p.w) |i| {
            const px = line[i];
            const a0 = px >> 24;
            if (a0 == 0) continue;
            const a = transformed(a0, p.mul[3], p.add[3]);
            var out = a << 24;
            inline for (.{ 16, 8, 0 }, 0..) |shift, c| {
                const straight: u32 = @min(255, ((px >> shift) & 0xff) * 255 / a0);
                const v = transformed(straight, p.mul[c], p.add[c]);
                out |= (if (a == 255) v else (v * (a + 1)) >> 8) << shift;
            }
            line[i] = out;
        }
    }
}

const M: u64 = 2147483647;

/// noise: each pixel's channels drawn in R, G, B order, then alpha, which
/// only a transparent bitmap draws; gray draws one for all three colours.
/// A colour left out is 0, an alpha left out 255. Returns the generator's state.
pub fn noise(pixels: []u32, p: *const NoiseParams) u32 {
    var x: u64 = p.state;
    const span = p.span;
    const lo = p.lo;
    const alpha = (p.channels & 8) != 0 and p.transparent != 0;
    const transparent = p.transparent != 0;
    for (pixels) |*px| {
        var c: [4]u32 = .{ 0, 0, 0, 255 };
        if (p.gray != 0) {
            c[0] = draw(&x, lo, span);
            c[1] = c[0];
            c[2] = c[0];
        } else {
            inline for (0..3) |k| {
                if (p.channels & (1 << k) != 0) c[k] = draw(&x, lo, span);
            }
        }

        if (alpha) c[3] = draw(&x, lo, span);
        px.* = keep(transparent, (c[3] << 24) | (c[0] << 16) | (c[1] << 8) | c[2]);
    }

    return @intCast(x);
}

fn draw(x: *u64, lo: u32, span: i32) u32 {
    if (span <= 0) return lo;
    x.* = (x.* * 16807) % M;
    return lo + @as(u32, @intCast(x.* % @as(u64, @intCast(span))));
}

/// JS's ToInt32 of a double: wrapped modulo 2^32, NaN and infinities 0.
fn toInt32(v: f64) i32 {
    if (@abs(v) < 2147483648.0) return @intFromFloat(@trunc(v));
    if (!std.math.isFinite(v)) return 0;
    const m = @mod(@trunc(v), 4294967296.0);
    return @bitCast(@as(u32, @intFromFloat(m)));
}

/// A double to int as x86's conversion makes it: out of range, or NaN, -2^31.
fn x86Int(v: f64) f64 {
    return if (v > -2147483649.0 and v < 2147483648.0) @trunc(v) else -2147483648.0;
}

const Stitch = struct { width: f64, height: f64, wrap_x: f64, wrap_y: f64 };

const Noise = struct {
    lattice: []const i32,
    gradients: []const f64,

    fn noise2(n: Noise, channel: usize, x: f64, y: f64, stitch: ?*const Stitch) f64 {
        const tx = x + PERLIN_N;
        var bx0 = x86Int(tx);
        var bx1 = bx0 + 1;
        const rx0 = tx - x86Int(tx);
        const rx1 = rx0 - 1;
        const ty = y + PERLIN_N;
        var by0 = x86Int(ty);
        var by1 = by0 + 1;
        const ry0 = ty - x86Int(ty);
        const ry1 = ry0 - 1;
        if (stitch) |s| {
            if (bx0 >= s.wrap_x) bx0 -= s.width;
            if (bx1 >= s.wrap_x) bx1 -= s.width;
            if (by0 >= s.wrap_y) by0 -= s.height;
            if (by1 >= s.wrap_y) by1 -= s.height;
        }

        const ix0: usize = @intCast(toInt32(bx0) & 0xff);
        const ix1: usize = @intCast(toInt32(bx1) & 0xff);
        const iy0: usize = @intCast(toInt32(by0) & 0xff);
        const iy1: usize = @intCast(toInt32(by1) & 0xff);
        const i: usize = @intCast(n.lattice[ix0]);
        const j: usize = @intCast(n.lattice[ix1]);
        const b00: usize = @intCast(n.lattice[i + iy0]);
        const b10: usize = @intCast(n.lattice[j + iy0]);
        const b01: usize = @intCast(n.lattice[i + iy1]);
        const b11: usize = @intCast(n.lattice[j + iy1]);
        const sx = rx0 * rx0 * (3 - 2 * rx0);
        const sy = ry0 * ry0 * (3 - 2 * ry0);
        const g = n.gradients[channel * LATTICE * 2 ..];
        const p00 = rx0 * g[b00 * 2] + ry0 * g[b00 * 2 + 1];
        const p10 = rx1 * g[b10 * 2] + ry0 * g[b10 * 2 + 1];
        const a = p00 + sx * (p10 - p00);
        const p01 = rx0 * g[b01 * 2] + ry1 * g[b01 * 2 + 1];
        const p11 = rx1 * g[b11 * 2] + ry1 * g[b11 * 2 + 1];
        const b = p01 + sx * (p11 - p01);
        return a + sy * (b - a);
    }

    fn turbulence(n: Noise, channel: usize, x: f64, y: f64, p: *const PerlinParams, offsets: []const f64) f64 {
        var stitch: Stitch = .{
            .width = p.stitch_w,
            .height = p.stitch_h,
            .wrap_x = PERLIN_N + p.stitch_w,
            .wrap_y = PERLIN_N + p.stitch_h,
        };
        const stitching = p.stitch != 0;
        var sum: f64 = 0;
        var ratio: f64 = 1;
        for (0..p.octaves) |o| {
            const v = n.noise2(channel, (x + offsets[o * 2]) * p.fx * ratio, (y + offsets[o * 2 + 1]) * p.fy * ratio, if (stitching) &stitch else null);
            sum += (if (p.fractal != 0) v else @abs(v)) / ratio;
            ratio *= 2;
            if (stitching) {
                stitch.width *= 2;
                stitch.wrap_x = 2 * stitch.wrap_x - PERLIN_N;
                stitch.height *= 2;
                stitch.wrap_y = 2 * stitch.wrap_y - PERLIN_N;
            }
        }

        return sum;
    }
};

/// A byte as Flash makes it of a noise: saturating, the half added before
/// the halving; past an int, as wild noise goes, 0.
fn noiseByte(fractal: bool, n: f64) u32 {
    const v = if (fractal) (n * 255 + 255 + 0.5) / 2 else n * 255 + 0.5;
    if (!(v < 2147483648.0)) return 0;
    if (v >= 255) return 255;
    return if (v > 0) @intFromFloat(@trunc(v)) else 0;
}

/// perlinNoise's rows: each pixel's channels a turbulence, one of the
/// generator's four for each channel asked for in turn, a channel left out
/// its least and alpha opaque, written as they come, not premultiplied.
pub fn perlin(pixels: []u32, p: *const PerlinParams, lattice: []const i32, gradients: []const f64, offsets: []const f64) void {
    const n: Noise = .{ .lattice = lattice, .gradients = gradients };
    const fractal = p.fractal != 0;
    for (0..p.h) |row| {
        const y: f64 = @floatFromInt(p.y0 + row);
        for (0..p.w) |col| {
            const x: f64 = @floatFromInt(col);
            var v: [4]f64 = undefined;
            if (p.gray != 0) {
                v[0] = n.turbulence(0, x, y, p, offsets);
                v[1] = v[0];
                v[2] = v[0];
                v[3] = if (p.channels & 8 != 0) n.turbulence(1, x, y, p, offsets) else 1;
            } else {
                var channel: usize = 0;
                inline for (0..4) |c| {
                    v[c] = if (c == 3) 1 else -1;
                    if (p.channels & (1 << c) != 0) {
                        v[c] = n.turbulence(channel, x, y, p, offsets);
                        channel += 1;
                    }
                }
            }

            const a: u32 = if (p.transparent != 0) noiseByte(fractal, v[3]) else 255;
            pixels[row * p.w + col] = (a << 24) | (noiseByte(fractal, v[0]) << 16) | (noiseByte(fractal, v[1]) << 8) | noiseByte(fractal, v[2]);
        }
    }
}

test "premultiply and unmultiply round as the store does" {
    try std.testing.expectEqual(@as(u32, 0x80402010), premultiply(0x80804020));
    try std.testing.expectEqual(@as(u32, 0), premultiply(0x00ffffff));
    try std.testing.expectEqual(@as(u32, 0x807f4020), unmultiply(0x80402010));
}

test "merge mixes each channel by its multiplier, unclamped and wrapped" {
    var dst = [_]u32{0xff000000};
    const src = [_]u32{0xffffffff};
    const p: MergeParams = .{ .rows = .{ .w = 1, .h = 1, .dst = 0, .dst_stride = 1, .src = 0, .src_stride = 1, .transparent = 1, .unused = 0 }, .muls = .{ 128, 0, 256, 256 } };
    merge(&dst, &src, &p);
    try std.testing.expectEqual(@as(u32, 0xff7f00ff), dst[0]);
}

test "a copy in place reads what the pixels before it wrote" {
    // copyChannel red to blue along a row moved right by one: the second pixel reads the first's new value.
    var px = [_]u32{ 0xff120000, 0xff340000, 0xff560000 };
    const p: ChannelParams = .{ .rows = .{ .w = 2, .h = 1, .dst = 0, .dst_stride = 3, .src = 0, .src_stride = 3, .transparent = 1, .unused = 0 }, .from = 16, .to = 0 };
    copyChannel(px[1..].ptr, px[0..].ptr, &p);
    try std.testing.expectEqual(@as(u32, 0xff340012), px[1]);
    try std.testing.expectEqual(@as(u32, 0xff560034), px[2]);
}

test "noise draws the same sequence however it is split" {
    var whole: [64]u32 = undefined;
    var parts: [64]u32 = undefined;
    const p: NoiseParams = .{ .count = 64, .pixels = 0, .state = 7, .lo = 10, .span = 200, .channels = 15, .gray = 0, .transparent = 1 };
    _ = noise(&whole, &p);
    var half = p;
    half.state = noise(parts[0..32], &p);
    _ = noise(parts[32..], &half);
    try std.testing.expectEqualSlices(u32, &whole, &parts);
}

test "toInt32 wraps as JS does" {
    try std.testing.expectEqual(@as(i32, -2147483648), toInt32(2147483648.0));
    try std.testing.expectEqual(@as(i32, 1), toInt32(4294967297.0));
    try std.testing.expectEqual(@as(i32, 0), toInt32(std.math.inf(f64)));
    try std.testing.expectEqual(@as(i32, -1), toInt32(-1.5));
}
