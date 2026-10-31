//! BitmapData.draw of one bitmap into another in the normal blend mode, as
//! the player's ops.ts draws it, to the bit: drawBitmap's rows through a
//! matrix (each pixel the source's under its centre, nearest or bilinear,
//! through the colour transform, scaled by how many of its 4 x 4 samples
//! the source covers, then source over the destination), and composite's,
//! unscaled at a whole pixel. Each takes the whole draw in one call, over
//! what draw-kernel.ts copies into the input (bitmap.zig's resetArena)
//! for it: the rows of the source the draw reads, and the destination's
//! area, which it copies back out. A pixel reads only the source and its
//! own destination pixel, so each is done in one pass, which is what the
//! row passes of ops.ts leave.
const std = @import("std");
const builtin = @import("builtin");
const color = @import("color.zig");

/// The input the params and blocks must lie in; the host's tests, which take none from memory, have none.
const input = if (builtin.target.cpu.arch.isWasm()) @import("bitmap.zig") else struct {
    pub fn holds(_: usize, _: usize, _: usize) bool {
        return true;
    }
};

pub const SMOOTH: u32 = 1;
pub const TRANSFORM: u32 = 2;
/// The destination store is opaque: what normal leaves takes an alpha of 255.
pub const OPAQUE: u32 = 4;
/// A clear pixel through the colour transform stays clear (the offset of alpha is 0 or less).
pub const SKIP_ZERO_ALPHA: u32 = 8;
const FLAGS: u32 = SMOOTH | TRANSFORM | OPAQUE | SKIP_ZERO_ALPHA;

/// A draw, as draw-kernel.ts writes it.
pub const DrawParams = extern struct {
    /// The matrix's inverse, from a destination point to the source's, as ops.ts computes it.
    ia: f64,
    ib: f64,
    ic: f64,
    id: f64,
    itx: f64,
    ity: f64,
    /// The prepared colour transform: multipliers in 256ths and offsets, red, green, blue, alpha.
    muls: [4]f64,
    adds: [4]f64,
    /// The source, `src_w` by `src_h`, of which `src` holds the rows from
    /// `src_top`, `src_rows` of them: every row the draw reads.
    src: u32,
    src_w: u32,
    src_h: u32,
    /// The destination's area, `w` by `h` from (x, y) of its store, as a block of its own.
    dst: u32,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    flags: u32,
    /// composite's move of the source, whole pixels.
    tx: i32,
    ty: i32,
    src_top: u32,
    src_rows: u32,
};

/// What a draw did: refused its params, wrote nothing, or wrote its block.
pub const INVALID: usize = 0;
pub const UNTOUCHED: usize = 1;
pub const WRITTEN: usize = 2;

/// The params at `address`, copied, and checked: null where they or the blocks they name lie past the input.
fn paramsAt(address: usize) ?DrawParams {
    if (!input.holds(address, @sizeOf(DrawParams), @alignOf(DrawParams))) return null;
    const p = @as(*const DrawParams, @ptrFromInt(address)).*;
    if (p.flags & ~FLAGS != 0) return null;
    if (p.w == 0 or p.h == 0 or p.src_w == 0 or p.src_h == 0 or p.src_rows == 0) return null;
    if (p.src_top >= p.src_h or p.src_rows > p.src_h - p.src_top) return null;
    const src_bytes = @as(u64, p.src_w) * p.src_rows * 4;
    const dst_bytes = @as(u64, p.w) * p.h * 4;
    if (src_bytes > std.math.maxInt(u32) or dst_bytes > std.math.maxInt(u32)) return null;
    if (!input.holds(p.src, @intCast(src_bytes), 4) or !input.holds(p.dst, @intCast(dst_bytes), 4)) return null;
    return p;
}

/// A source row's place among the rows copied in: `row` itself, which the
/// copy always holds, and kept within them whatever it is.
fn local(q: *const DrawParams, row: usize) usize {
    const last = q.src_top + q.src_rows - 1;
    return @min(@max(row, q.src_top), last) - q.src_top;
}

/// The larger of two numbers by comparison, which Wasm's f64.max, a call
/// for its NaN and signed zeros, is not; ops.ts's Math.max differs only
/// for those, which the numbers here never are but for a zero's sign.
fn maxf(a: f64, b: f64) f64 {
    return if (a > b) a else b;
}

fn minf(a: f64, b: f64) f64 {
    return if (a < b) a else b;
}

/// Source over destination, both premultiplied: s + ((d * (256 - sa)) >> 8) a channel.
fn over(s: u32, d: u32) u32 {
    const sa = s >> 24;
    if (sa == 255) return s;
    if (sa == 0) return d;
    const k = 256 - sa;
    const a: u32 = @min(255, sa + (((d >> 24) * k) >> 8));
    const r: u32 = @min(255, ((s >> 16) & 0xff) + ((((d >> 16) & 0xff) * k) >> 8));
    const g: u32 = @min(255, ((s >> 8) & 0xff) + ((((d >> 8) & 0xff) * k) >> 8));
    const b: u32 = @min(255, (s & 0xff) + (((d & 0xff) * k) >> 8));
    return (a << 24) | (r << 16) | (g << 8) | b;
}

/// Each channel of a premultiplied pixel scaled by a coverage, rounded as JS's Math.round.
fn scaleBy(p: u32, f: f64) u32 {
    var out: u32 = 0;
    inline for (.{ 24, 16, 8, 0 }) |shift| {
        const c: f64 = @floatFromInt((p >> shift) & 0xff);
        out |= @as(u32, @intFromFloat(color.round(c * f))) << shift;
    }

    return out;
}

/// ops.ts's colorChannel: floor(v * mul / 256) + add, within 0 to 255.
fn channel(v: f64, mul: f64, add: f64) u32 {
    return @intFromFloat(maxf(0.0, minf(255.0, @floor((v * mul) / 256.0) + add)));
}

/// A premultiplied pixel through the prepared colour transform, as ops.ts's transformed.
fn transformed(p: u32, q: *const DrawParams) u32 {
    const a0 = p >> 24;
    if (a0 == 0 and q.flags & SKIP_ZERO_ALPHA != 0) return 0;
    const a = channel(@floatFromInt(a0), q.muls[3], q.adds[3]);
    var out = a << 24;
    inline for (.{ 16, 8, 0 }, 0..) |shift, k| {
        const straight: u32 = if (a0 == 0) 0 else @min(255, (((p >> shift) & 0xff) * 255) / a0);
        const v = channel(@floatFromInt(straight), q.muls[k], q.adds[k]);
        out |= (if (a == 255) v else (v * (a + 1)) >> 8) << shift;
    }

    return out;
}

/// A pixel put in normal mode, as ops.ts's blendRow: opaque where the store is, unless already.
fn put(p: u32, d: u32, opaque_bits: u32) u32 {
    return if (p >> 24 == 255) p else over(p, d) | opaque_bits;
}

fn nearest(q: *const DrawParams, from: []const u32, x: f64, y: f64) u32 {
    const px: u32 = @intFromFloat(minf(@as(f64, @floatFromInt(q.src_w - 1)), maxf(0.0, @floor(x))));
    const py: u32 = @intFromFloat(minf(@as(f64, @floatFromInt(q.src_h - 1)), maxf(0.0, @floor(y))));
    return from[local(q, py) * q.src_w + px];
}

/// Bilinear between the four premultiplied pixels round (x, y), clamped to the edges, as ops.ts's.
fn bilinear(q: *const DrawParams, from: []const u32, x: f64, y: f64) u32 {
    const w = q.src_w;
    const x0 = @floor(x);
    const y0 = @floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const last_x: f64 = @floatFromInt(w - 1);
    const last_y: f64 = @floatFromInt(q.src_h - 1);
    const left: usize = @intFromFloat(minf(last_x, maxf(0.0, x0)));
    const right: usize = @intFromFloat(minf(last_x, maxf(0.0, x0 + 1)));
    const top = local(q, @intFromFloat(minf(last_y, maxf(0.0, y0)))) * w;
    const bottom = local(q, @intFromFloat(minf(last_y, maxf(0.0, y0 + 1)))) * w;
    const p00 = from[top + left];
    const p10 = from[top + right];
    const p01 = from[bottom + left];
    const p11 = from[bottom + right];
    const gx = 1 - fx;
    const gy = 1 - fy;
    var out: u32 = 0;
    inline for (.{ 24, 16, 8, 0 }) |shift| {
        const c00: f64 = @floatFromInt((p00 >> shift) & 0xff);
        const c10: f64 = @floatFromInt((p10 >> shift) & 0xff);
        const c01: f64 = @floatFromInt((p01 >> shift) & 0xff);
        const c11: f64 = @floatFromInt((p11 >> shift) & 0xff);
        const upper = c00 * gx + c10 * fx;
        const lower = c01 * gx + c11 * fx;
        out |= @as(u32, @intFromFloat(color.round(upper * gy + lower * fy))) << shift;
    }

    return out;
}

/// ops.ts's coveredSpan: narrows [from, to) to the pixels of row y whose
/// 16 samples all have u = a x + c y' + t within [0, size); false where u
/// barely moves along x without being still, which leaves every pixel to be tested.
fn coveredSpan(a: f64, c: f64, t: f64, size: f64, y: f64, from: *f64, to: *f64) bool {
    if (a == 0) {
        for (0..4) |k| {
            const u = c * (y + (@as(f64, @floatFromInt(k)) + 0.5) / 4) + t;
            if (!(u >= 0 and u < size)) from.* = std.math.inf(f64);
        }

        return true;
    }

    if (@abs(a) < 1e-6) return false;
    for (0..4) |k| {
        const offset = c * (y + (@as(f64, @floatFromInt(k)) + 0.5) / 4) + t;
        const at0 = -offset / a;
        const at_size = (size - offset) / a;
        const margin = 0.001 + (1e-12 * (@abs(offset) + size + @abs(a) * (@abs(at0) + @abs(at_size)))) / @abs(a);
        const low = minf(at0, at_size) + margin;
        const high = maxf(at0, at_size) - margin;
        if (!std.math.isFinite(low) or !std.math.isFinite(high)) return false;
        from.* = maxf(from.*, @ceil(low - 0.125));
        to.* = minf(to.*, @floor(high - 0.875) + 1);
    }

    return true;
}

/// How many of the pixel's 4 x 4 samples fall inside the source.
fn coverage(q: *const DrawParams, x: f64, y: f64, w: f64, h: f64) u32 {
    var hits: u32 = 0;
    for (0..16) |k| {
        const px = x + (@as(f64, @floatFromInt(k & 3)) + 0.5) / 4;
        const py = y + (@as(f64, @floatFromInt(k >> 2)) + 0.5) / 4;
        const sx = q.ia * px + q.ic * py + q.itx;
        const sy = q.ib * px + q.id * py + q.ity;
        if (sx >= 0 and sy >= 0 and sx < w and sy < h) hits += 1;
    }

    return hits;
}

/// The colour transform of each pixel a draw takes, which is the same for
/// the same pixel: the last few hundred kept, by a hash of the pixel.
const Transformer = struct {
    q: *const DrawParams,
    keys: [256]u32 = undefined,
    values: [256]u32 = undefined,
    held: [256]bool = @splat(false),
    /// The last pixel asked for, which a run of one pixel asks for again.
    last: u32 = 0,
    last_out: u32 = 0,
    have_last: bool = false,

    inline fn of(t: *Transformer, p: u32) u32 {
        if (t.have_last and p == t.last) return t.last_out;
        t.have_last = true;
        t.last = p;
        t.last_out = t.lookup(p);
        return t.last_out;
    }

    fn lookup(t: *Transformer, p: u32) u32 {
        const slot = (p *% 0x9e3779b1) >> 24;
        if (t.held[slot] and t.keys[slot] == p) return t.values[slot];
        const out = transformed(p, t.q);
        t.keys[slot] = p;
        t.values[slot] = out;
        t.held[slot] = true;
        return out;
    }
};

/// The widest or tallest area an unturned draw takes its columns' and rows' numbers once for.
const max_side = 4096;

/// An unturned draw's numbers along one axis, a column's or a row's: where its
/// centre falls in the source, nearest or bilinear, and how many of its four
/// sample lines fall inside it.
const Axis = struct {
    near: [max_side]u32 = undefined,
    low: [max_side]u32 = undefined,
    high: [max_side]u32 = undefined,
    f: [max_side]f64 = undefined,
    g: [max_side]f64 = undefined,
    inside: [max_side]u32 = undefined,
};

const F4 = @Vector(4, f64);
const offsets: F4 = .{ 0.125, 0.375, 0.625, 0.875 };

var columns: Axis = .{};
var rows: Axis = .{};

/// One axis's numbers for `count` pixels from `start`: u = a v + other + t
/// at each, `other` the other axis' term, which is a zero where the matrix
/// neither turns nor skews, as ops.ts's sums leave it.
fn fillAxis(axis: *Axis, count: usize, start: f64, a: f64, other: f64, t: f64, size: u32, smooth: bool) void {
    const extent: f64 = @floatFromInt(size);
    const last: f64 = @floatFromInt(size - 1);
    for (0..count) |k| {
        const v = start + @as(f64, @floatFromInt(k));
        const u = a * (v + 0.5) + other + t;
        if (smooth) {
            // bilinear's, at u less half a pixel.
            const b = u - 0.5;
            const b0 = @floor(b);
            axis.f[k] = b - b0;
            axis.g[k] = 1 - (b - b0);
            axis.low[k] = @intFromFloat(minf(last, maxf(0.0, b0)));
            axis.high[k] = @intFromFloat(minf(last, maxf(0.0, b0 + 1)));
        } else {
            axis.near[k] = @intFromFloat(minf(last, maxf(0.0, @floor(u))));
        }

        // The four sample lines at once: (j + 0.5) / 4 along the pixel.
        const samples = @as(F4, @splat(a)) * (@as(F4, @splat(v)) + offsets) + @as(F4, @splat(other)) + @as(F4, @splat(t));
        const below: @Vector(4, bool) = samples < @as(F4, @splat(extent));
        const in = @select(bool, samples >= @as(F4, @splat(0.0)), below, @as(@Vector(4, bool), @splat(false)));
        axis.inside[k] = @reduce(.Add, @select(u32, in, @as(@Vector(4, u32), @splat(1)), @as(@Vector(4, u32), @splat(0))));
    }
}

/// bilinear's channels, from an unturned draw's axes.
fn blend4(q: *const DrawParams, from: []const u32, cx: usize, ry: usize) u32 {
    const w = q.src_w;
    const top = local(q, rows.low[ry]) * w;
    const bottom = local(q, rows.high[ry]) * w;
    const left = columns.low[cx];
    const right = columns.high[cx];
    const p00 = from[top + left];
    const p10 = from[top + right];
    const p01 = from[bottom + left];
    const p11 = from[bottom + right];
    const fx = columns.f[cx];
    const gx = columns.g[cx];
    const fy = rows.f[ry];
    const gy = rows.g[ry];
    var out: u32 = 0;
    inline for (.{ 24, 16, 8, 0 }) |shift| {
        const c00: f64 = @floatFromInt((p00 >> shift) & 0xff);
        const c10: f64 = @floatFromInt((p10 >> shift) & 0xff);
        const c01: f64 = @floatFromInt((p01 >> shift) & 0xff);
        const c11: f64 = @floatFromInt((p11 >> shift) & 0xff);
        const upper = c00 * gx + c10 * fx;
        const lower = c01 * gx + c11 * fx;
        out |= @as(u32, @intFromFloat(color.round(upper * gy + lower * fy))) << shift;
    }

    return out;
}

/// drawBitmap's path where the matrix neither turns nor skews: a column's
/// numbers are the same in every row and a row's in every column, so each
/// is worked out once, and a pixel's samples inside the source are its
/// column's times its row's. ops.ts's sums with the other axis' term, a
/// zero, give the same numbers, but for the sign of a zero, which no
/// comparison, floor or clamp tells apart.
fn drawAligned(q: *const DrawParams) usize {
    const from = @as([*]const u32, @ptrFromInt(q.src))[0 .. @as(usize, q.src_w) * q.src_rows];
    const into = @as([*]u32, @ptrFromInt(q.dst))[0 .. @as(usize, q.w) * q.h];
    const sw: f64 = @floatFromInt(q.src_w);
    const sh: f64 = @floatFromInt(q.src_h);
    const x0: f64 = @floatFromInt(q.x);
    const y0: f64 = @floatFromInt(q.y);
    const n: f64 = @floatFromInt(q.w);
    const smooth = q.flags & SMOOTH != 0;
    fillAxis(&columns, q.w, x0, q.ia, q.ic * (y0 + 0.5), q.itx, q.src_w, smooth);
    fillAxis(&rows, q.h, y0, q.id, q.ib * (x0 + 0.5), q.ity, q.src_h, smooth);
    const opaque_bits: u32 = if (q.flags & OPAQUE != 0) 0xff000000 else 0;
    var transformer: Transformer = .{ .q = q };
    const transform = q.flags & TRANSFORM != 0;
    var wrote = false;
    for (0..q.h) |r| {
        const y = y0 + @as(f64, @floatFromInt(r));
        var span_from = -std.math.inf(f64);
        var span_to = std.math.inf(f64);
        const spans = coveredSpan(q.ia, q.ic, q.itx, sw, y, &span_from, &span_to) and
            coveredSpan(q.ib, q.id, q.ity, sh, y, &span_from, &span_to);
        // Whole within, [k_from, k_to) of the row's pixels.
        const full_from = if (spans) maxf(x0, span_from) else 0;
        const full_to = if (spans) minf(x0 + n, span_to) else 0;
        const k_from: usize = if (full_to > full_from) @intFromFloat(maxf(0.0, full_from - x0)) else 0;
        const k_to: usize = if (full_to > full_from) @intFromFloat(minf(n, full_to - x0)) else 0;
        const inside_y = rows.inside[r];
        if (inside_y == 0 and k_to == 0) continue;

        const row = into[r * q.w ..][0..q.w];
        const base = if (smooth) 0 else local(q, rows.near[r]) * q.src_w;
        var buffer: [chunk]u32 = undefined;
        var skip: [chunk]u32 = undefined;
        var at: usize = 0;
        while (at < q.w) : (at += chunk) {
            const count = @min(chunk, q.w - at);
            var any: bool = false;
            for (buffer[0..count], skip[0..count], at..) |*b, *kept, k| {
                const hit: u32 = if (k >= k_from and k < k_to) 16 else columns.inside[k] * inside_y;
                kept.* = @intFromBool(hit == 0);
                if (hit == 0) continue;

                var p = if (smooth) blend4(q, from, k, r) else from[base + columns.near[k]];
                if (transform) p = transformer.of(p);
                if (hit < 16) p = scaleBy(p, @as(f64, @floatFromInt(hit)) / 16);
                b.* = p;
                any = true;
            }

            if (!any) continue;
            putRow(row[at..][0..count], buffer[0..count], skip[0..count], opaque_bits);
            wrote = true;
        }
    }

    return if (wrote) WRITTEN else UNTOUCHED;
}

/// drawBitmap's general path over the area, in normal mode.
pub fn draw(q: *const DrawParams) usize {
    if (q.ib == 0 and q.ic == 0 and q.w <= max_side and q.h <= max_side) return drawAligned(q);
    const from = @as([*]const u32, @ptrFromInt(q.src))[0 .. @as(usize, q.src_w) * q.src_rows];
    const into = @as([*]u32, @ptrFromInt(q.dst))[0 .. @as(usize, q.w) * q.h];
    const sw: f64 = @floatFromInt(q.src_w);
    const sh: f64 = @floatFromInt(q.src_h);
    const smooth = q.flags & SMOOTH != 0;
    const transform = q.flags & TRANSFORM != 0;
    const opaque_bits: u32 = if (q.flags & OPAQUE != 0) 0xff000000 else 0;
    const x0: f64 = @floatFromInt(q.x);
    const n: f64 = @floatFromInt(q.w);
    var transformer: Transformer = .{ .q = q };
    var wrote = false;
    for (0..q.h) |r| {
        const y: f64 = @floatFromInt(@as(i64, q.y) + @as(i64, @intCast(r)));
        var span_from = -std.math.inf(f64);
        var span_to = std.math.inf(f64);
        const spans = coveredSpan(q.ia, q.ic, q.itx, sw, y, &span_from, &span_to) and
            coveredSpan(q.ib, q.id, q.ity, sh, y, &span_from, &span_to);
        const full_from = if (spans) maxf(x0, span_from) else 0;
        const full_to = if (spans) minf(x0 + n, span_to) else 0;
        const row = into[r * q.w ..][0..q.w];
        const cy = y + 0.5;
        for (row, 0..) |*d, k| {
            const x = x0 + @as(f64, @floatFromInt(k));
            const cx = x + 0.5;
            const sx = q.ia * cx + q.ic * cy + q.itx;
            const sy = q.ib * cx + q.id * cy + q.ity;
            const hit: u32 = if (x < full_from or x >= full_to) coverage(q, x, y, sw, sh) else 16;
            if (hit == 0) continue;

            var p = if (smooth) bilinear(q, from, sx - 0.5, sy - 0.5) else nearest(q, from, sx, sy);
            if (transform) p = transformer.of(p);

            if (hit < 16) p = scaleBy(p, @as(f64, @floatFromInt(hit)) / 16);
            d.* = put(p, d.*, opaque_bits);
            wrote = true;
        }
    }

    return if (wrote) WRITTEN else UNTOUCHED;
}

/// composite: the source at (tx, ty), unscaled, over the area, in normal mode.
pub fn composite(q: *const DrawParams) usize {
    // The area within the source moved, as drawBitmap makes it.
    const left = @as(i64, q.x) - q.tx;
    const top = @as(i64, q.y) - q.ty;
    if (left < 0 or top < q.src_top or left + q.w > q.src_w or top + q.h > q.src_top + q.src_rows) return INVALID;
    const opaque_bits: u32 = if (q.flags & OPAQUE != 0) 0xff000000 else 0;
    const transform = q.flags & TRANSFORM != 0;
    const from: [*]const u32 = @ptrFromInt(q.src);
    const into: [*]u32 = @ptrFromInt(q.dst);
    var wrote = false;
    var transformer: Transformer = .{ .q = q };
    for (0..q.h) |r| {
        const src = from[(@as(usize, @intCast(top)) - q.src_top + r) * q.src_w + @as(usize, @intCast(left)) ..][0..q.w];
        const dst = into[r * q.w ..][0..q.w];
        if (!transform) {
            wrote = overRow(dst, src, opaque_bits) or wrote;
            continue;
        }

        // Every pixel put, a clear one too, as ops.ts's row passes put them, a chunk at a time.
        var buffer: [chunk]u32 = undefined;
        var at: usize = 0;
        while (at < q.w) : (at += chunk) {
            const n = @min(chunk, q.w - at);
            for (buffer[0..n], src[at..][0..n]) |*b, p| b.* = transformer.of(p);
            putRow(dst[at..][0..n], buffer[0..n], null, opaque_bits);
        }

        wrote = true;
    }

    return if (wrote) WRITTEN else UNTOUCHED;
}

const lanes = 4;
const P = @Vector(lanes, u32);

/// put of four pixels at once, a channel a vector: the source where it is
/// opaque, else source over destination, opaque where the store is.
fn put4(s: P, d: P, opaque_bits: u32) P {
    const mask: P = @splat(0xff);
    const limit: P = @splat(255);
    const sa = s >> @splat(24);
    const k = @as(P, @splat(256)) - sa;
    const a: P = @min(limit, sa + (((d >> @splat(24)) * k) >> @splat(8)));
    const r: P = @min(limit, ((s >> @splat(16)) & mask) + ((((d >> @splat(16)) & mask) * k) >> @splat(8)));
    const g: P = @min(limit, ((s >> @splat(8)) & mask) + ((((d >> @splat(8)) & mask) * k) >> @splat(8)));
    const b: P = @min(limit, (s & mask) + (((d & mask) * k) >> @splat(8)));
    const op: P = @splat(opaque_bits);
    const blended = (a << @splat(24)) | (r << @splat(16)) | (g << @splat(8)) | b | op;
    // over leaves the destination for a clear source, which put then makes opaque.
    const under = @select(u32, sa == @as(P, @splat(0)), d | op, blended);
    return @select(u32, sa == @as(P, @splat(255)), s, under);
}

/// Source over the row, a clear source pixel leaving its destination be: whether one was put.
fn overRow(dst: []u32, src: []const u32, opaque_bits: u32) bool {
    var any: u32 = 0;
    var i: usize = 0;
    while (i + lanes <= dst.len) : (i += lanes) {
        const s: P = src[i..][0..lanes].*;
        const d: P = dst[i..][0..lanes].*;
        const clear = (s >> @splat(24)) == @as(P, @splat(0));
        dst[i..][0..lanes].* = @select(u32, clear, d, put4(s, d, opaque_bits));
        any |= @reduce(.Or, s >> @splat(24));
    }

    while (i < dst.len) : (i += 1) {
        const s = src[i];
        if (s >> 24 == 0) continue;
        dst[i] = put(s, dst[i], opaque_bits);
        any = 1;
    }

    return any != 0;
}

/// Every pixel of `src` put into the row, a clear one too, and none where `skip` is set.
fn putRow(dst: []u32, src: []const u32, skip: ?[]const u32, opaque_bits: u32) void {
    var i: usize = 0;
    while (i + lanes <= dst.len) : (i += lanes) {
        const s: P = src[i..][0..lanes].*;
        const d: P = dst[i..][0..lanes].*;
        const out = put4(s, d, opaque_bits);
        if (skip) |kept| {
            const keep: P = kept[i..][0..lanes].*;
            dst[i..][0..lanes].* = @select(u32, keep != @as(P, @splat(0)), d, out);
        } else {
            dst[i..][0..lanes].* = out;
        }
    }

    while (i < dst.len) : (i += 1) {
        if (skip) |kept| {
            if (kept[i] != 0) continue;
        }

        dst[i] = put(src[i], dst[i], opaque_bits);
    }
}

/// How many pixels a row's pass takes at a time, through a buffer on the stack.
const chunk = 256;

/// drawBitmap's path through the matrix, per the DrawParams at `address`: WRITTEN, UNTOUCHED, or INVALID.
export fn drawPixels(address: usize) usize {
    const p = paramsAt(address) orelse return INVALID;
    return draw(&p);
}

/// composite, per the DrawParams at `address`: WRITTEN, UNTOUCHED, or INVALID.
export fn compositePixels(address: usize) usize {
    const p = paramsAt(address) orelse return INVALID;
    return composite(&p);
}

test "over and its rows composite as the store does" {
    try std.testing.expectEqual(@as(u32, 0xff112233), over(0xff112233, 0x80402010));
    try std.testing.expectEqual(@as(u32, 0x80402010), over(0x00000000, 0x80402010));
    // 0x40 + ((0x80 * 0xc0) >> 8) = 0xa0, and so on a channel.
    try std.testing.expectEqual(@as(u32, 0xa0502814), over(0x40201008, 0x80402010));
    var dst = [_]u32{ 0x80402010, 0x80402010, 0x80402010, 0x80402010, 0x80402010 };
    const src = [_]u32{ 0x40201008, 0, 0xff010203, 0x40201008, 0x40201008 };
    try std.testing.expect(overRow(&dst, &src, 0));
    try std.testing.expectEqualSlices(u32, &.{ 0xa0502814, 0x80402010, 0xff010203, 0xa0502814, 0xa0502814 }, &dst);
}

test "a coverage scales each channel, a half up" {
    try std.testing.expectEqual(@as(u32, 0x80402010), scaleBy(0xff804020, 0.5));
    try std.testing.expectEqual(@as(u32, 0x01010101), scaleBy(0x01010101, 15.0 / 16.0));
}
