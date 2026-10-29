//! BitmapData's blur, glow, drop shadow, bevel and gradient glow and bevel,
//! on the CPU, as adl computes them and the player's JS did before this
//! replaced it: a blur's runs truncated to 8 bits each, a glow's alpha from
//! the blur so truncated times strength, a bevel's from the difference of
//! two reads of it. The arithmetic is the JS's, in the same order in f64,
//! so the pixels are its to the bit; where the JS converted a number to an
//! int, toInt32 does as it did. bitmap.zig wraps it for Wasm.
const std = @import("std");
const color = @import("color.zig");
const premultiply = color.premultiply;
const unmultiply = color.unmultiply;
const toInt32 = color.toInt32;
const round = color.round;

pub const Error = error{OutOfMemory};

/// The blur filter: `pixels` (w × h, premultiplied ARGB) blurred in place.
pub const BlurParams = extern struct {
    w: u32,
    h: u32,
    quality: u32,
    pixels: u32,
    blur_x: f64,
    blur_y: f64,
};

pub const Kind = enum(u32) { glow, shadow, bevel, gradient_glow, gradient_bevel, _ };

/// LayerParams.flags.
pub const Flags = packed struct(u32) {
    /// A glow's or a shadow's `inner`.
    inner: bool = false,
    knockout: bool = false,
    hide_object: bool = false,
    /// A bevel's or a gradient filter's type: inner, outer, else full.
    type_inner: bool = false,
    type_outer: bool = false,
    /// The reads blur 255 less the alpha, as an inner glow blurs what the source leaves.
    invert: bool = false,
    unused: u26 = 0,
};

/// A block of the source whose alpha is blurred: rw × rh bytes at `alpha`,
/// blurred in place, cut at (x, y) from the block its moves read, past
/// which it read nothing.
pub const Read = extern struct {
    alpha: u32,
    rw: u32,
    rh: u32,
    x: i32,
    y: i32,
    unused: u32,
};

/// A read of a blurred block at each pixel of the layer, moved by (x, y).
pub const Move = extern struct {
    read: u32,
    unused: u32,
    x: f64,
    y: f64,
};

/// A glow's, a shadow's, a bevel's or a gradient one's layer over the
/// source's pixels shown, w × h at `pixels`, which take its result.
pub const LayerParams = extern struct {
    kind: Kind,
    flags: Flags,
    w: u32,
    h: u32,
    pixels: u32,
    quality: u32,
    reads: u32,
    moves: u32,
    read: [2]Read,
    move: [2]Move,
    blur_x: f64,
    blur_y: f64,
    strength: f64,
    alpha: f64,
    highlight_alpha: f64,
    shadow_alpha: f64,
    color: u32,
    highlight_color: u32,
    shadow_color: u32,
    /// A gradient filter's 256 premultiplied colours.
    table: u32,
};

comptime {
    // The offsets the TS writes the fields at.
    std.debug.assert(@sizeOf(BlurParams) == 32);
    std.debug.assert(@offsetOf(LayerParams, "read") == 32);
    std.debug.assert(@offsetOf(LayerParams, "move") == 80);
    std.debug.assert(@offsetOf(LayerParams, "blur_x") == 128);
    std.debug.assert(@offsetOf(LayerParams, "color") == 176);
    std.debug.assert(@sizeOf(LayerParams) == 192);
}

/// What the kernels take of a plane's sides: as the player's rects are, and
/// of no more pixels than Flash's bitmaps hold, many times over.
const most_side = 0x100000;
const most_pixels: u64 = 1 << 28;

fn sized(w: u32, h: u32) bool {
    return w > 0 and h > 0 and w <= most_side and h <= most_side and @as(u64, w) * h <= most_pixels;
}

/// A blur as the player keeps it: 0 to 255, or NaN, which blurs nothing.
fn blurry(v: f64) bool {
    return std.math.isNan(v) or (v >= 0 and v <= 255);
}

fn unit(v: f64) bool {
    return v >= 0 and v <= 1;
}

/// Whether BlurParams are as the player gives them: else the kernels refuse
/// them rather than compute what the JS never did.
pub fn validBlur(p: *const BlurParams) bool {
    return sized(p.w, p.h) and p.quality <= 15 and blurry(p.blur_x) and blurry(p.blur_y);
}

/// Whether LayerParams are as the player gives them: blurs, quality,
/// strength (0 to 255) and alphas (0 to 1) as its filters keep them,
/// colours of 24 bits, and moves within an int.
pub fn validLayer(p: *const LayerParams) bool {
    if (@backingInt(p.kind) > @backingInt(Kind.gradient_bevel) or p.flags.unused != 0) return false;
    if (!sized(p.w, p.h) or p.quality > 15 or !blurry(p.blur_x) or !blurry(p.blur_y)) return false;
    if (!(p.strength >= 0 and p.strength <= 255)) return false;
    if (!unit(p.alpha) or !unit(p.highlight_alpha) or !unit(p.shadow_alpha)) return false;
    if (p.color > 0xffffff or p.highlight_color > 0xffffff or p.shadow_color > 0xffffff) return false;
    if (p.reads < 1 or p.reads > 2 or p.moves < 1 or p.moves > 2) return false;
    const two = p.kind == .bevel or p.kind == .gradient_bevel;
    if (p.moves != @as(u32, if (two) 2 else 1)) return false;
    for (p.read[0..p.reads]) |r| {
        if (!sized(r.rw, r.rh)) return false;
    }

    for (p.move[0..p.moves]) |m| {
        if (m.read >= p.reads or !(@abs(m.x) < 2147483648.0) or !(@abs(m.y) < 2147483648.0)) return false;
    }

    return true;
}

/// JS's Math.min and Math.max, NaN where either is, by compares: @min's
/// floats lower to a slow sequence in Wasm.
fn min(a: f64, b: f64) f64 {
    if (a != a or b != b) return std.math.nan(f64);
    return if (a < b) a else b;
}

fn max(a: f64, b: f64) f64 {
    if (a != a or b != b) return std.math.nan(f64);
    return if (a > b) a else b;
}

fn int(x: f64) u32 {
    return @bitCast(toInt32(x));
}

fn float(x: anytype) f64 {
    return @floatFromInt(x);
}

/// A box run's taps: whole within `full` each way, the next weighing `part`.
const Box = struct {
    full: usize,
    part: f64,
    scale: f64,

    fn of(width: f64) ?Box {
        if (!(width > 1)) return null;
        const half = width / 2;
        const full = @floor(half - 0.5);
        return .{
            .full = @intFromFloat(full),
            .part = @min(1, @max(0, half - full - 0.5)),
            .scale = 1 / width,
        };
    }

    /// A hair over, so that a value the sum hits exactly stays; truncated.
    inline fn value(b: Box, sum: f64, ends: f64) u8 {
        return @intFromFloat((sum + b.part * ends) * b.scale + 1e-7);
    }
};

/// One run along x over each row of `plane` (w × h), in place; `line`
/// holds a row between zeros as far as the taps reach past its ends.
fn runX(plane: []u8, w: usize, h: usize, box: Box, line: []i32) void {
    const full = box.full;
    const pad = full + 1;
    @memset(line, 0);
    for (0..h) |y| {
        const row = plane[y * w ..][0..w];
        for (row, line[pad..][0..w]) |v, *l| l.* = v;
        var sum: i32 = 0;
        for (line[pad - full .. pad + full + 1]) |v| sum += v;
        for (0..w) |i| {
            const at = i + pad;
            const near = line[at - full - 1];
            const far = line[at + full + 1];
            row[i] = box.value(float(sum), float(near + far));
            sum += far - line[at - full];
        }
    }
}

const lanes = 4;
const V = @Vector(lanes, i32);
const F = @Vector(lanes, f64);
const B = @Vector(lanes, u8);

fn widen(bytes: [lanes]u8) V {
    const v: B = bytes;
    return @intCast(v);
}

/// One run along y from `from` into `to` (w × h), rows past the ends
/// zeros, the sums running down whole rows `lanes` columns at a time.
fn runY(from: []const u8, to: []u8, w: usize, h: usize, box: Box, sums: []i32) void {
    const full = box.full;
    const zero: [lanes]u8 = @splat(0);
    @memset(sums, 0);
    // A row's value at column x, 0 past the plane's ends.
    const Rows = struct {
        from: []const u8,
        w: usize,
        h: usize,

        inline fn at(r: @This(), y: isize, x: usize) [lanes]u8 {
            if (y < 0 or y >= @as(isize, @intCast(r.h))) return zero;
            return r.from[@as(usize, @intCast(y)) * r.w + x ..][0..lanes].*;
        }

        inline fn one(r: @This(), y: isize, x: usize) i32 {
            if (y < 0 or y >= @as(isize, @intCast(r.h))) return 0;
            return r.from[@as(usize, @intCast(y)) * r.w + x];
        }
    };
    const rows = Rows{ .from = from, .w = w, .h = h };
    const f: isize = @intCast(full);
    var j: isize = -f;
    while (j <= f) : (j += 1) {
        for (0..w) |x| sums[x] += rows.one(j, x);
    }

    const part: F = @splat(box.part);
    const scale: F = @splat(box.scale);
    const hair: F = @splat(1e-7);
    for (0..h) |yu| {
        const y: isize = @intCast(yu);
        const out = to[yu * w ..][0..w];
        var x: usize = 0;
        while (x + lanes <= w) : (x += lanes) {
            const lo = widen(rows.at(y - f - 1, x));
            const hi = widen(rows.at(y + f + 1, x));
            const leaving = widen(rows.at(y - f, x));
            const s: V = sums[x..][0..lanes].*;
            const v = (@as(F, @floatFromInt(s)) + part * @as(F, @floatFromInt(lo + hi))) * scale + hair;
            const o: B = @intFromFloat(v);
            out[x..][0..lanes].* = o;
            sums[x..][0..lanes].* = s + hi - leaving;
        }

        while (x < w) : (x += 1) {
            const lo = rows.one(y - f - 1, x);
            const hi = rows.one(y + f + 1, x);
            out[x] = box.value(float(sums[x]), float(lo + hi));
            sums[x] += hi - rows.one(y - f, x);
        }
    }
}

/// The blur's runs over `plane` (w × h): each quality's along x, then along
/// y, the result in `plane`; `temp` is as big.
pub fn blur(gpa: std.mem.Allocator, plane: []u8, temp: []u8, w: usize, h: usize, blur_x: f64, blur_y: f64, quality: u32) Error!void {
    const bx = Box.of(blur_x);
    const by = Box.of(blur_y);
    if (quality == 0 or w == 0 or h == 0 or (bx == null and by == null)) return;

    const line = try gpa.alloc(i32, if (bx) |b| w + 2 * (b.full + 1) + 1 else 0);
    defer gpa.free(line);
    const sums = try gpa.alloc(i32, if (by != null) w else 0);
    defer gpa.free(sums);
    for (0..quality) |_| {
        if (bx) |b| runX(plane, w, h, b, line);
        if (by) |b| {
            runY(plane, temp, w, h, b, sums);
            @memcpy(plane, temp);
        }
    }
}

/// The blur filter over `pixels` (w × h), in place: each channel blurred apart.
pub fn blurPixels(gpa: std.mem.Allocator, pixels: []u32, p: *const BlurParams) Error!void {
    const n = pixels.len;
    const plane = try gpa.alloc(u8, n);
    defer gpa.free(plane);
    const temp = try gpa.alloc(u8, n);
    defer gpa.free(temp);
    inline for (.{ 24, 16, 8, 0 }) |shift| {
        for (plane, pixels) |*v, px| v.* = @truncate(px >> shift);
        try blur(gpa, plane, temp, p.w, p.h, p.blur_x, p.blur_y, p.quality);
        const mask: u32 = ~(@as(u32, 0xff) << shift);
        for (pixels, plane) |*px, v| px.* = (px.* & mask) | (@as(u32, v) << shift);
    }
}

/// `plane` (w × h) read at each pixel of its first ow × oh moved by (ox,
/// oy), between pixels linearly with weights in 256ths, truncated; `outside`
/// past it. The plane is cut from a block at (cx, cy) in it, which the
/// moves are of: a pixel's place and weights are the block's, so a cut
/// leaves them as they were.
fn shifted(gpa: std.mem.Allocator, plane: []const u8, w: usize, h: usize, cx: i64, cy: i64, ox: f64, oy: f64, outside: u8, out: []u8, ow: usize, oh: usize) Error!void {
    const xs = try gpa.alloc(i64, ow);
    defer gpa.free(xs);
    const fxs = try gpa.alloc(f64, ow);
    defer gpa.free(fxs);
    for (xs, fxs, 0..) |*x0, *fx, x| {
        const at = float(x) + ox;
        // As an Int32Array kept it.
        const whole: f64 = float(toInt32(@floor(at)));
        x0.* = @as(i64, @intFromFloat(whole)) - cx;
        fx.* = @floor((at - whole) * 256) / 256;
    }

    const W: i64 = @intCast(w);
    const H: i64 = @intCast(h);
    // Moved by whole pixels, as a glow reads: rows copied, `outside` past the plane.
    if (oy == @floor(oy) and @abs(oy) < 1e15 and std.mem.allEqual(f64, fxs, 0)) {
        const y0: i64 = @as(i64, @intFromFloat(oy)) - cy;
        for (0..oh) |y| {
            const row = out[y * ow ..][0..ow];
            const sy = @as(i64, @intCast(y)) + y0;
            if (sy < 0 or sy >= H or ow == 0) {
                @memset(row, outside);
                continue;
            }

            const line = plane[@intCast(sy * W)..][0..w];
            const first = xs[0];
            const lo: usize = @intCast(std.math.clamp(-first, 0, @as(i64, @intCast(ow))));
            const hi: usize = @intCast(std.math.clamp(W - first, @as(i64, @intCast(lo)), @as(i64, @intCast(ow))));
            @memset(row[0..lo], outside);
            if (hi > lo) @memcpy(row[lo..hi], line[@intCast(first + @as(i64, @intCast(lo)))..][0 .. hi - lo]);
            @memset(row[hi..], outside);
        }

        return;
    }
    const value = struct {
        inline fn of(p: []const u8, pw: i64, ph: i64, x: i64, yy: i64, o2: u8) f64 {
            return float(if (x >= 0 and x < pw and yy >= 0 and yy < ph) p[@intCast(yy * pw + x)] else o2);
        }
    }.of;
    for (0..oh) |y| {
        const at = float(y) + oy;
        const y0f = @floor(at);
        const fy = @floor((at - y0f) * 256) / 256;
        const y0: i64 = (if (std.math.isFinite(y0f) and @abs(y0f) < 1e15) @as(i64, @intFromFloat(y0f)) else std.math.minInt(i32)) - cy;
        const row = out[y * ow ..][0..ow];
        // Both rows within the plane: a read whose columns are too needs no bounds.
        const inside = y0 >= 0 and y0 + 1 < H;
        const r0 = if (inside) plane[@intCast(y0 * W)..][0..w] else plane[0..0];
        const r1 = if (inside) plane[@intCast((y0 + 1) * W)..][0..w] else plane[0..0];
        for (row, xs, fxs) |*o, x0, fx| {
            if (inside and x0 >= 0 and x0 + 1 < W) {
                const c: usize = @intCast(x0);
                const top = float(r0[c]) * (1 - fx) + float(r0[c + 1]) * fx;
                const bottom = float(r1[c]) * (1 - fx) + float(r1[c + 1]) * fx;
                // As below: with no fraction, top * 1 + bottom * 0 is the pixel, + 1e-7 floored.
                o.* = @intFromFloat(@floor(top * (1 - fy) + bottom * fy + 1e-7));
                continue;
            }

            if (fx == 0 and fy == 0) {
                o.* = @intFromFloat(value(plane, W, H, x0, y0, outside));
                continue;
            }

            const top = value(plane, W, H, x0, y0, outside) * (1 - fx) + value(plane, W, H, x0 + 1, y0, outside) * fx;
            const bottom = value(plane, W, H, x0, y0 + 1, outside) * (1 - fx) + value(plane, W, H, x0 + 1, y0 + 1, outside) * fx;
            o.* = @intFromFloat(@floor(top * (1 - fy) + bottom * fy + 1e-7));
        }
    }
}

/// JS's `(a << 24) | (r << 16) | (g << 8) | b`, each converted as JS converts.
fn pack(a: f64, r: f64, g: f64, b: f64) u32 {
    return (int(a) << 24) | (int(r) << 16) | (int(g) << 8) | int(b);
}

/// A glow or a shadow: the moved blur times strength (to 255) and alpha, in
/// its colour; behind the source, or inside it, or alone.
fn glow(pixels: []u32, moved: []const u8, p: *const LayerParams) void {
    const cr = float((p.color >> 16) & 0xff);
    const cg = float((p.color >> 8) & 0xff);
    const cb = float(p.color & 0xff);
    const inner = p.flags.inner;
    const knockout = p.flags.knockout;
    const hide = p.kind == .shadow and p.flags.hide_object;
    // max(0, min(255, round(v))), NaN once checked.
    const clamp = struct {
        inline fn of(v: f64) f64 {
            if (v != v) return v;
            const r = round(v);
            return if (r < 0) 0 else if (r > 255) 255 else r;
        }
    }.of;
    for (pixels, moved) |*px, blur_a| {
        const s = px.*;
        const sa = float(s >> 24);
        const sr = float((s >> 16) & 0xff);
        const sg = float((s >> 8) & 0xff);
        const sb = float(s & 0xff);
        const raw = @floor(min(255, @floor(float(blur_a) * p.strength)) * p.alpha);
        const ga = if (inner) round((raw * sa) / 255) else raw;
        const gr = (cr * ga) / 255;
        const gg = (cg * ga) / 255;
        const gb = (cb * ga) / 255;
        var oa: f64 = undefined;
        var o_r: f64 = undefined;
        var og: f64 = undefined;
        var ob: f64 = undefined;
        if (knockout and !inner) {
            oa = (ga * (255 - sa)) / 255;
            o_r = (gr * (255 - sa)) / 255;
            og = (gg * (255 - sa)) / 255;
            ob = (gb * (255 - sa)) / 255;
        } else if (inner and !knockout) {
            // Over the source's straight colour by the glow's own alpha, the glow's in 255ths and
            // the source's in 256ths, truncated; the source keeps its alpha.
            const keep = 256 - raw;
            const u = unmultiply(s);
            const mix = struct {
                fn of(c: f64, r: f64, straight: u32, k: f64) f64 {
                    return @floor((c * r) / 255 + (float(straight) * k) / 256);
                }
            }.of;
            px.* = premultiply(pack(sa, mix(cr, raw, (u >> 16) & 0xff, keep), mix(cg, raw, (u >> 8) & 0xff, keep), mix(cb, raw, u & 0xff, keep)));
            continue;
        } else if (knockout or hide) {
            oa = ga;
            o_r = gr;
            og = gg;
            ob = gb;
        } else {
            const behind = (255 - sa) / 255;
            oa = sa + ga * behind;
            o_r = sr + gr * behind;
            og = sg + gg * behind;
            ob = sb + gb * behind;
        }

        const ka = clamp(oa);
        px.* = pack(ka, min(clamp(o_r), ka), min(clamp(og), ka), min(clamp(ob), ka));
    }
}

/// How a bevel or a gradient filter places its layer (premultiplied, alpha
/// la) on the source's pixel `s`, as the JS's placer did.
fn place(p: *const LayerParams, s: u32, la: i64, lr: i64, lg: i64, lb: i64) u32 {
    const sa: i64 = s >> 24;
    const sr: i64 = (s >> 16) & 0xff;
    const sg: i64 = (s >> 8) & 0xff;
    const sb: i64 = s & 0xff;
    const inner = p.flags.type_inner;
    const outer = p.flags.type_outer;
    const knockout = p.flags.knockout;
    const over = struct {
        fn of(top: i64, ta: i64, bottom: i64) i64 {
            return @min(255, top + ((bottom * (256 - ta)) >> 8));
        }
    }.of;
    const m: i64 = if (inner) sa else if (outer and knockout) 255 - sa else 255;
    const ma = @divFloor(la * m + 127, 255);
    const mr = @divFloor(lr * m + 127, 255);
    const mg = @divFloor(lg * m + 127, 255);
    const mb = @divFloor(lb * m + 127, 255);
    var oa: i64 = undefined;
    var o_r: i64 = undefined;
    var og: i64 = undefined;
    var ob: i64 = undefined;
    if (knockout) {
        oa = ma;
        o_r = mr;
        og = mg;
        ob = mb;
    } else if (outer) {
        oa = over(sa, sa, ma);
        o_r = over(sr, sa, mr);
        og = over(sg, sa, mg);
        ob = over(sb, sa, mb);
    } else if (inner) {
        // Atop the source's straight colour by the layer's own alpha, the source keeping its alpha.
        const u = unmultiply(s);
        const mix = struct {
            fn of(c: i64, straight: u32, a: i64) f64 {
                return @min(255, @floor(float(c) + (float(straight) * float(256 - a)) / 256));
            }
        }.of;
        return premultiply(pack(float(sa), mix(lr, (u >> 16) & 0xff, la), mix(lg, (u >> 8) & 0xff, la), mix(lb, u & 0xff, la)));
    } else {
        // What is left shows through, by its masked alpha over.
        oa = over(ma, ma, sa);
        o_r = over(mr, ma, sr);
        og = over(mg, ma, sg);
        ob = over(mb, ma, sb);
    }

    return pack(float(oa), float(@min(o_r, oa)), float(@min(og, oa)), float(@min(ob, oa)));
}

/// A bevel: the difference of the blur read on and back, times strength (to
/// 255) and the colour's alpha, rounded, highlight where on is more.
fn bevel(pixels: []u32, on: []const u8, back: []const u8, p: *const LayerParams) void {
    const hr: i64 = (p.highlight_color >> 16) & 0xff;
    const hg: i64 = (p.highlight_color >> 8) & 0xff;
    const hb: i64 = p.highlight_color & 0xff;
    const sr: i64 = (p.shadow_color >> 16) & 0xff;
    const sg: i64 = (p.shadow_color >> 8) & 0xff;
    const sb: i64 = p.shadow_color & 0xff;
    for (pixels, on, back) |*px, o, b| {
        const d = @as(i32, o) - @as(i32, b);
        const lit = d > 0;
        const la = round(min(255, @floor(float(@abs(d)) * p.strength)) * (if (lit) p.highlight_alpha else p.shadow_alpha));
        const a: i64 = toInt32(la);
        const channel = struct {
            fn of(c: i64, alpha: f64) i64 {
                return toInt32(@floor((float(c) * alpha) / 255));
            }
        }.of;
        px.* = place(p, px.*, a, channel(if (lit) hr else sr, la), channel(if (lit) hg else sg, la), channel(if (lit) hb else sb, la));
    }
}

fn placeColor(p: *const LayerParams, s: u32, c: u32) u32 {
    return place(p, s, c >> 24, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
}

/// A gradient glow: the moved blur times strength to 255 picks its colour.
fn gradientGlow(pixels: []u32, moved: []const u8, table: []const u32, p: *const LayerParams) void {
    for (pixels, moved) |*px, v| {
        const at = min(255, @floor(float(v) * p.strength));
        px.* = placeColor(p, px.*, table[@as(u32, @bitCast(toInt32(at))) & 0xff]);
    }
}

/// A gradient bevel: a bevel's difference picks its colour, the middle where they agree.
fn gradientBevel(pixels: []u32, on: []const u8, back: []const u8, table: []const u32, p: *const LayerParams) void {
    for (pixels, on, back) |*px, o, b| {
        const d = max(-255, min(255, @floor(float(@as(i32, o) - @as(i32, b)) * p.strength)));
        const at = @floor((d + 256) / 2);
        px.* = placeColor(p, px.*, table[@as(u32, @bitCast(toInt32(at))) & 0xff]);
    }
}

/// The layer over `pixels`, in place: each read's alpha (`reads`, blurred
/// in place) blurred, each move read from its block, and the layer placed
/// on the source.
pub fn layer(gpa: std.mem.Allocator, pixels: []u32, reads: []const []u8, p: *const LayerParams, table: []const u32) Error!void {
    const n = pixels.len;
    for (reads, 0..) |plane, k| {
        if (p.flags.invert) {
            for (plane) |*v| v.* = 255 - v.*;
        }

        const temp = try gpa.alloc(u8, plane.len);
        defer gpa.free(temp);
        try blur(gpa, plane, temp, p.read[k].rw, p.read[k].rh, p.blur_x, p.blur_y, p.quality);
    }

    var moved: [2][]u8 = .{ &.{}, &.{} };
    defer for (moved) |m| gpa.free(m);
    for (0..p.moves) |k| {
        const mv = p.move[k];
        const r = p.read[mv.read];
        moved[k] = try gpa.alloc(u8, n);
        try shifted(gpa, reads[mv.read], r.rw, r.rh, r.x, r.y, mv.x, mv.y, if (p.flags.invert) 255 else 0, moved[k], p.w, p.h);
    }

    switch (p.kind) {
        .bevel => bevel(pixels, moved[0], moved[1], p),
        .gradient_bevel => gradientBevel(pixels, moved[0], moved[1], table, p),
        .gradient_glow => gradientGlow(pixels, moved[0], table, p),
        else => glow(pixels, moved[0], p),
    }
}

test "a box run of width 3 averages a pixel with its neighbours, truncated" {
    var plane = [_]u8{ 0, 0, 255, 0, 0, 0 };
    var line: [6 + 2 * 2 + 1]i32 = undefined;
    runX(&plane, 6, 1, Box.of(3).?, &line);
    try std.testing.expectEqualSlices(u8, &.{ 0, 85, 85, 85, 0, 0 }, &plane);
}

test "runs along y give what runs along x give the plane turned" {
    var rows: [5 * 7]u8 = undefined;
    var turned: [7 * 5]u8 = undefined;
    for (0..7) |y| for (0..5) |x| {
        rows[y * 5 + x] = @truncate(x * 37 + y * 91);
        turned[x * 7 + y] = rows[y * 5 + x];
    };
    var out: [5 * 7]u8 = undefined;
    var sums: [5]i32 = undefined;
    runY(&rows, &out, 5, 7, Box.of(3.5).?, &sums);
    var line: [7 + 2 * 2 + 1]i32 = undefined;
    runX(&turned, 7, 5, Box.of(3.5).?, &line);
    for (0..7) |y| for (0..5) |x| try std.testing.expectEqual(out[y * 5 + x], turned[x * 7 + y]);
}

test "a pixel moved by whole pixels is read as it is, past the plane its outside" {
    const plane = [_]u8{ 1, 2, 3, 4 };
    var out: [4]u8 = undefined;
    try shifted(std.testing.allocator, &plane, 2, 2, 0, 0, 1, 0, 9, &out, 2, 2);
    try std.testing.expectEqualSlices(u8, &.{ 2, 9, 4, 9 }, &out);
}

test "toInt32 wraps and takes NaN as 0, as JS converts" {
    try std.testing.expectEqual(@as(i32, 0), toInt32(std.math.nan(f64)));
    try std.testing.expectEqual(@as(i32, -1), toInt32(4294967295));
    try std.testing.expectEqual(@as(i32, -2), toInt32(-2.7));
    try std.testing.expectEqual(@as(f64, 3), round(2.5));
    try std.testing.expectEqual(@as(f64, 0), round(0.49999999999999994));
}

test "params the player never gives are refused" {
    const blur_ok: BlurParams = .{ .w = 4, .h = 4, .quality = 2, .pixels = 0, .blur_x = std.math.nan(f64), .blur_y = 3 };
    try std.testing.expect(validBlur(&blur_ok));
    for ([_]BlurParams{
        .{ .w = 0, .h = 4, .quality = 2, .pixels = 0, .blur_x = 3, .blur_y = 3 },
        .{ .w = 4, .h = 4, .quality = 16, .pixels = 0, .blur_x = 3, .blur_y = 3 },
        .{ .w = 4, .h = 4, .quality = 2, .pixels = 0, .blur_x = -1, .blur_y = 3 },
        .{ .w = 4, .h = 4, .quality = 2, .pixels = 0, .blur_x = 256, .blur_y = 3 },
        .{ .w = 0x100000, .h = 0x100000, .quality = 2, .pixels = 0, .blur_x = 3, .blur_y = 3 },
    }) |p| try std.testing.expect(!validBlur(&p));

    const read: Read = .{ .alpha = 0, .rw = 8, .rh = 8, .x = 0, .y = 0, .unused = 0 };
    const move: Move = .{ .read = 0, .unused = 0, .x = 2, .y = 2 };
    const layer_ok: LayerParams = .{ .kind = .glow, .flags = .{}, .w = 4, .h = 4, .pixels = 0, .quality = 1, .reads = 1, .moves = 1, .read = .{ read, read }, .move = .{ move, move }, .blur_x = 4, .blur_y = 4, .strength = 2, .alpha = 1, .highlight_alpha = 1, .shadow_alpha = 1, .color = 0xff0000, .highlight_color = 0, .shadow_color = 0, .table = 0 };
    try std.testing.expect(validLayer(&layer_ok));
    var bad = layer_ok;
    bad.strength = std.math.nan(f64);
    try std.testing.expect(!validLayer(&bad));
    bad = layer_ok;
    bad.strength = -1;
    try std.testing.expect(!validLayer(&bad));
    bad = layer_ok;
    bad.alpha = std.math.nan(f64);
    try std.testing.expect(!validLayer(&bad));
    bad = layer_ok;
    bad.color = 0x1000000;
    try std.testing.expect(!validLayer(&bad));
    bad = layer_ok;
    bad.flags.unused = 1;
    try std.testing.expect(!validLayer(&bad));
    bad = layer_ok;
    bad.moves = 2;
    try std.testing.expect(!validLayer(&bad));
    bad = layer_ok;
    bad.move[0].x = std.math.inf(f64);
    try std.testing.expect(!validLayer(&bad));
}

test "every failed allocation is reported" {
    var pixels: [16]u32 = @splat(0xff00ff00);
    const p: BlurParams = .{ .w = 4, .h = 4, .quality = 2, .pixels = 0, .blur_x = 3, .blur_y = 3 };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn run(gpa: std.mem.Allocator, px: []u32, params: *const BlurParams) !void {
            try blurPixels(gpa, px, params);
        }
    }.run, .{ &pixels, &p });
}

test "a plane cut from its block reads as the block where the cut holds it" {
    var block: [6 * 6]u8 = undefined;
    for (&block, 0..) |*v, i| v.* = @truncate(i * 37);
    // The block's middle 4 by 4, cut at (1, 1).
    var cut: [4 * 4]u8 = undefined;
    for (0..4) |y| for (0..4) |x| {
        cut[y * 4 + x] = block[(y + 1) * 6 + x + 1];
    };
    var whole: [2 * 2]u8 = undefined;
    var part: [2 * 2]u8 = undefined;
    try shifted(std.testing.allocator, &block, 6, 6, 0, 0, 1.75, 2.3, 0, &whole, 2, 2);
    try shifted(std.testing.allocator, &cut, 4, 4, 1, 1, 1.75, 2.3, 0, &part, 2, 2);
    try std.testing.expectEqualSlices(u8, &whole, &part);
}
