//! BitmapData's pixel operations that are loops over its pixels, as the
//! player's JS made them before this replaced it: copyChannel, merge,
//! paletteMap and a colour matrix filter over rows a copy reads and writes,
//! colorTransform in place, noise and perlinNoise drawn. Each on
//! unmultiplied ARGB where Flash's results show it works, written back as
//! the store keeps it, premultiplied, and opaque where the store is. A row
//! is read as the pixels before it left it, so that where the source is the
//! destination a move down or right repeats what was written, as in Flash.
//! bitmap.zig wraps them for Wasm.
//!
//! perlinNoise's noise (Noise below) is the reference implementation of
//! SVG's feTurbulence, as the player's turbulence.ts ports it:
//! Derived from https://www.w3.org/TR/SVG11/filters.html#feTurbulenceElement,
//! Copyright © 2015 W3C® (MIT, ERCIM, Keio, Beihang), under the W3C software
//! license.
const std = @import("std");
const color = @import("color.zig");
const premultiply = color.premultiply;
const unmultiply = color.unmultiply;
const toInt32 = color.toInt32;

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
    unused: u32,
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

/// What `words` makes of each word.
pub const WordKind = enum(u32) {
    /// An unmultiplied value into an opaque store: alpha 255, which premultiplies to itself.
    solid,
    /// An unmultiplied value into a transparent store.
    premultiply,
    /// A transparent store's pixel as its value.
    unmultiply,
    /// An opaque store's pixel as its value, which it is.
    plain,
};

/// setPixels', setVector's, getPixels' and getVector's words, `count` at
/// `words`, each made in place the store's pixel of a value or the value
/// of a pixel (`kind`, a WordKind). `swap` where the values' bytes lie in
/// the other order than the store's words, as a big-endian ByteArray's
/// do: reversed before a value is taken, and after one is made.
pub const WordsParams = extern struct {
    count: u32,
    words: u32,
    kind: u32,
    swap: u32,
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

/// `argb` as a store keeps it: premultiplied, and opaque where it is.
fn keep(transparent: bool, argb: u32) u32 {
    return premultiply(if (transparent) argb else argb | 0xff000000);
}

/// The bytes of `h` rows of `w` pixels `stride` apart, worked out in 64
/// bits: null for no rows, a stride under a row, or more than a 32-bit
/// memory holds, which a wrapped product would let through.
pub fn rowsBytes(w: u32, h: u32, stride: u32) ?usize {
    if (w == 0 or h == 0 or w > stride) return null;
    const n = ((@as(u64, h) - 1) * stride + w) * 4;
    return if (n > std.math.maxInt(u32)) null else @intCast(n);
}

/// The bytes of `count` things of `size` bytes, worked out in 64 bits: null past a 32-bit memory.
pub fn bytesOf(count: u64, size: u64) ?usize {
    const n = count * size;
    return if (count > std.math.maxInt(u32) or n > std.math.maxInt(u32)) null else @intCast(n);
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

/// copyPixels' merge, a pixel premultiplied over another as Flash blends them: s + ((d * (256 -
/// sa)) >> 8) a channel, at most 255, and d where s is clear.
fn overOne(s: u32, d: u32) u32 {
    const sa = s >> 24;
    if (sa == 255) return s;
    if (sa == 0) return d;
    const k = 256 - sa;
    var out: u32 = 0;
    inline for (.{ 0, 8, 16, 24 }) |shift| {
        const c: u32 = @min(255, ((s >> shift) & 0xff) + ((((d >> shift) & 0xff) * k) >> 8));
        out |= c << shift;
    }

    return out;
}

/// `overOne` four pixels at a time, a byte of each channel widened to 16 bits: d * (256 - sa)
/// is at most 65,280.
fn overFour(s: @Vector(4, u32), d: @Vector(4, u32)) @Vector(4, u32) {
    const sb: @Vector(16, u8) = @bitCast(s);
    const db: @Vector(16, u8) = @bitCast(d);
    // Each pixel's alpha, its fourth byte, in all four of its lanes.
    const alpha = @shuffle(u8, sb, undefined, @Vector(16, i32){ 3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15 });
    const a16: @Vector(16, u16) = @intCast(alpha);
    const k = @as(@Vector(16, u16), @splat(256)) - a16;
    const s16: @Vector(16, u16) = @intCast(sb);
    const d16: @Vector(16, u16) = @intCast(db);
    const sum = @min(s16 + ((d16 * k) >> @splat(8)), @as(@Vector(16, u16), @splat(255)));
    const blended: @Vector(16, u8) = @intCast(sum);
    const clear = alpha == @as(@Vector(16, u8), @splat(0));
    return @bitCast(@select(u8, clear, db, blended));
}

/// copyPixels with mergeAlpha, or into an opaque store: each source pixel over the
/// destination's, both premultiplied, and opaque where the store is. The source is never
/// the destination here: copyPixels blends in place by its own loop, in Flash's order.
pub fn over(dst: [*]u32, src: [*]const u32, p: Rows) void {
    const solid: u32 = if (p.transparent != 0) 0 else 0xff000000;
    const solids: @Vector(4, u32) = @splat(solid);
    for (0..p.h) |row| {
        const d = dst + row * p.dst_stride;
        const s = src + row * p.src_stride;
        var i: usize = 0;
        while (i + 4 <= p.w) : (i += 4) {
            d[i..][0..4].* = overFour(s[i..][0..4].*, d[i..][0..4].*) | solids;
        }

        while (i < p.w) : (i += 1) {
            d[i] = overOne(s[i], d[i]) | solid;
        }
    }
}

/// `premultiply` four pixels at a time: a channel times alpha over 255, to the nearest, is
/// (t + (t >> 8)) >> 8 of t = c * a + 128, with no division; red and blue at once in the two
/// halves of a word, each product at most 65,153.
fn premultiplyFour(v: @Vector(4, u32)) @Vector(4, u32) {
    const V = @Vector(4, u32);
    const halves: V = @splat(0x00ff00ff);
    const a = v >> @splat(24);
    const rb = (v & halves) * a + @as(V, @splat(0x00800080));
    const g = ((v >> @splat(8)) & @as(V, @splat(0xff))) * a + @as(V, @splat(0x80));
    return (v & @as(V, @splat(0xff000000))) |
        (((rb + ((rb >> @splat(8)) & halves)) >> @splat(8)) & halves) |
        ((g + (g >> @splat(8))) & @as(V, @splat(0xff00)));
}

/// `unmultiply` four pixels at a time: each one's reciprocal looked up, then its channels
/// multiplied by it together.
fn unmultiplyFour(v: @Vector(4, u32)) @Vector(4, u32) {
    // Solid pixels, as most of an image's are, are their values.
    if (@reduce(.And, v >= @as(@Vector(4, u32), @splat(0xff000000)))) return v;
    const a: [4]u32 = v >> @splat(24);
    const k = @Vector(4, u32){ color.reciprocal[a[0]], color.reciprocal[a[1]], color.reciprocal[a[2]], color.reciprocal[a[3]] };
    var out = v & @as(@Vector(4, u32), @splat(0xff000000));
    inline for (.{ 0, 8, 16 }) |shift| {
        const c = (v >> @splat(shift)) & @as(@Vector(4, u32), @splat(0xff));
        const channel: @Vector(4, u32) = @min((c * k + @as(@Vector(4, u32), @splat(127))) >> @splat(8), @as(@Vector(4, u32), @splat(255)));
        out |= channel << @splat(shift);
    }

    return out;
}

/// What `words` makes of one word.
fn wordOne(w: u32, comptime kind: WordKind, comptime swap: bool) u32 {
    const value = if (swap and kind != .unmultiply and kind != .plain) @byteSwap(w) else w;
    const made = switch (kind) {
        .solid => value | 0xff000000,
        .premultiply => premultiply(value),
        .unmultiply => unmultiply(value),
        .plain => value,
    };
    return if (swap and (kind == .unmultiply or kind == .plain)) @byteSwap(made) else made;
}

/// `wordOne` of four words.
fn wordFour(v: @Vector(4, u32), comptime kind: WordKind, comptime swap: bool) @Vector(4, u32) {
    const value = if (swap and kind != .unmultiply and kind != .plain) @byteSwap(v) else v;
    const made = switch (kind) {
        .solid => value | @as(@Vector(4, u32), @splat(0xff000000)),
        .premultiply => premultiplyFour(value),
        .unmultiply => unmultiplyFour(value),
        .plain => value,
    };
    return if (swap and (kind == .unmultiply or kind == .plain)) @byteSwap(made) else made;
}

/// One kind's loop, with nothing to decide inside it.
fn wordsOf(px: []u32, comptime kind: WordKind, comptime swap: bool) void {
    var i: usize = 0;
    while (i + 4 <= px.len) : (i += 4) {
        px[i..][0..4].* = wordFour(px[i..][0..4].*, kind, swap);
    }

    while (i < px.len) : (i += 1) {
        px[i] = wordOne(px[i], kind, swap);
    }
}

/// A bitmap's pixels set from values or read as them, whole runs at once: see WordsParams.
pub fn words(px: []u32, kind: WordKind, swap: bool) void {
    switch (kind) {
        inline else => |k| if (swap) wordsOf(px, k, true) else wordsOf(px, k, false),
    }
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
    // An opaque destination's alpha whole.
    const opaque_alpha: u32 = if (p.rows.transparent != 0) 0 else 0xff000000;
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

            for (0..n) |k| d[col + k] = four[k] | opaque_alpha;
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

test "merge mixes each channel by its multiplier, unclamped and wrapped" {
    var dst = [_]u32{0xff000000};
    const src = [_]u32{0xffffffff};
    const p: MergeParams = .{ .rows = .{ .w = 1, .h = 1, .dst = 0, .dst_stride = 1, .src = 0, .src_stride = 1, .transparent = 1, .unused = 0 }, .muls = .{ 128, 0, 256, 256 } };
    merge(&dst, &src, &p);
    try std.testing.expectEqual(@as(u32, 0xff7f00ff), dst[0]);
}

test "over four pixels at a time is over one at a time, for every alpha and odd colours" {
    var prng = std.Random.DefaultPrng.init(17);
    const random = prng.random();
    var src: [4 * 67]u32 = undefined;
    var dst: [4 * 67]u32 = undefined;
    var expected: [4 * 67]u32 = undefined;
    for (0..2000) |round| {
        for (&src, &dst) |*s, *d| {
            // Every source alpha, its colour premultiplied or not, as a store may hold it.
            const a: u32 = if (round % 3 == 0) random.uintAtMost(u32, 255) else switch (random.uintLessThan(u32, 3)) {
                0 => 0,
                1 => 255,
                else => random.uintAtMost(u32, 255),
            };
            const rgb = random.int(u32) & 0xffffff;
            s.* = if (round % 2 == 0) premultiply((a << 24) | rgb) else (a << 24) | rgb;
            d.* = random.int(u32);
        }

        const transparent: u32 = @intCast(round % 2);
        for (&expected, src, dst) |*e, s, d| {
            e.* = overOne(s, d) | @as(u32, if (transparent != 0) 0 else 0xff000000);
        }

        // 67 pixels a row: sixteen of four and three left over.
        over(&dst, &src, .{ .w = 67, .h = 4, .dst = 0, .dst_stride = 67, .src = 0, .src_stride = 67, .transparent = transparent, .unused = 0 });
        try std.testing.expectEqualSlices(u32, &expected, &dst);
    }

    try std.testing.expectEqual(@as(u32, 0x80402010), overOne(0x00ffffff, 0x80402010));
    try std.testing.expectEqual(@as(u32, 0xffffffff), overOne(0xffffffff, 0x80402010));
    // Half a red over white: 128 + 255 * 128 / 256 = 255, and 0 + 127 for green and blue.
    try std.testing.expectEqual(@as(u32, 0xffff7f7f), overOne(0x80800000, 0xffffffff));
}

test "premultiplying without a division rounds as the division does, for every alpha and channel" {
    for (0..256) |a| {
        for (0..256) |c| {
            const argb: u32 = @intCast((a << 24) | (c << 16) | ((255 - c) << 8) | (c ^ 0x5a));
            const four = premultiplyFour(@splat(argb));
            try std.testing.expectEqual(premultiply(argb), four[0]);
            try std.testing.expectEqual(premultiply(argb), four[3]);
            // Whatever a store holds, premultiplied or not.
            const back = unmultiplyFour(@splat(argb));
            try std.testing.expectEqual(unmultiply(argb), back[0]);
            try std.testing.expectEqual(unmultiply(argb), back[2]);
        }
    }
}

test "words four at a time are words one at a time, of every kind and in either byte order" {
    var prng = std.Random.DefaultPrng.init(23);
    const random = prng.random();
    // 67 words: sixteen of four and three left over.
    var px: [67]u32 = undefined;
    var expected: [67]u32 = undefined;
    for (0..400) |round| {
        for (&px) |*p| {
            p.* = switch (random.uintLessThan(u32, 4)) {
                0 => random.int(u32) & 0xffffff,
                1 => random.int(u32) | 0xff000000,
                else => random.int(u32),
            };
        }

        const swap = round % 2 == 0;
        const kind: WordKind = @fromBackingInt(@intCast((round / 2) % 4));
        for (&expected, px) |*e, p| {
            const value = if (swap) @byteSwap(p) else p;
            e.* = switch (kind) {
                .solid => value | 0xff000000,
                .premultiply => premultiply(value),
                .unmultiply => if (swap) @byteSwap(unmultiply(p)) else unmultiply(p),
                .plain => value,
            };
        }

        words(&px, kind, swap);
        try std.testing.expectEqualSlices(u32, &expected, &px);
    }

    var value = [_]u32{0x4020ff80};
    words(&value, .premultiply, true);
    try std.testing.expectEqual(premultiply(0x80ff2040), value[0]);
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

test "extents that a 32-bit product would wrap are refused" {
    try std.testing.expectEqual(@as(?usize, null), rowsBytes(1, 65537, 65536));
    try std.testing.expectEqual(@as(?usize, null), rowsBytes(0x40000001, 1, 0x40000001));
    try std.testing.expectEqual(@as(?usize, null), rowsBytes(4, 2, 3));
    try std.testing.expectEqual(@as(?usize, null), bytesOf(0x40000001, 4));
    try std.testing.expectEqual(@as(?usize, null), bytesOf(65536 * 65536, 4));
    try std.testing.expectEqual(@as(?usize, 16 * 4 + 8 * 4), rowsBytes(8, 2, 16));
}
