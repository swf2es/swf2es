//! DXT1 and DXT5 encoding, block for block as context3d/src/dxt.ts. The
//! covariance and power iterations keep the reference's double arithmetic
//! and order; integer colour distances compare the four palette entries
//! together. Edge blocks repeat the level's last row and column.
const std = @import("std");
const builtin = @import("builtin");

const input = if (builtin.target.cpu.arch.isWasm()) @import("bitmap.zig") else struct {
    pub fn holds(_: usize, _: usize, _: usize) bool {
        return true;
    }
};

const Distances = @Vector(4, i32);

fn rgb(c: u32) u32 {
    const r = (c >> 11) & 31;
    const g = (c >> 5) & 63;
    const b = c & 31;
    return (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((b << 3) | (b >> 2));
}

fn mix(a: u32, b: u32, wa: u32, wb: u32) u32 {
    var out: u32 = 0;
    inline for (.{ 0, 8, 16 }) |shift| {
        out |= ((((a >> shift) & 255) * wa + ((b >> shift) & 255) * wb) / 3) << shift;
    }

    return out;
}

fn pack(r: u8, g: u8, b: u8) u32 {
    return (@as(u32, r >> 3) << 11) | (@as(u32, g >> 2) << 5) | (b >> 3);
}

fn byte(out: []u8, at: usize, value: u32) void {
    out[at] = @truncate(value);
}

/// A whole level, whose input and output sizes the caller has checked.
pub fn encode(rgba: []const u8, dxt5: bool, width: usize, height: usize, out: []u8) void {
    const size: usize = if (dxt5) 16 else 8;
    const across = (width + 3) / 4;
    const down = (height + 3) / 4;
    var texels: [16]usize = undefined;
    var alphas: [8]u8 = undefined;

    for (0..down) |by| {
        for (0..across) |bx| {
            const at = (by * across + bx) * size;
            var mr: f64 = 0;
            var mg: f64 = 0;
            var mb: f64 = 0;
            var low_a: u32 = 255;
            var high_a: u32 = 0;
            for (&texels, 0..) |*texel, i| {
                const p = (@min(by * 4 + (i >> 2), height - 1) * width + @min(bx * 4 + (i & 3), width - 1)) * 4;
                texel.* = p;
                mr += @floatFromInt(rgba[p]);
                mg += @floatFromInt(rgba[p + 1]);
                mb += @floatFromInt(rgba[p + 2]);
                low_a = @min(low_a, rgba[p + 3]);
                high_a = @max(high_a, rgba[p + 3]);
            }

            mr /= 16;
            mg /= 16;
            mb /= 16;
            var rr: f64 = 0;
            var rg: f64 = 0;
            var rb: f64 = 0;
            var gg: f64 = 0;
            var gb: f64 = 0;
            var bb: f64 = 0;
            for (texels) |p| {
                const r = @as(f64, @floatFromInt(rgba[p])) - mr;
                const g = @as(f64, @floatFromInt(rgba[p + 1])) - mg;
                const b = @as(f64, @floatFromInt(rgba[p + 2])) - mb;
                rr += r * r;
                rg += r * g;
                rb += r * b;
                gg += g * g;
                gb += g * b;
                bb += b * b;
            }

            var vr: f64 = 0;
            var vg: f64 = 0;
            var vb: f64 = 0;
            var spread: f64 = -1;
            for (texels) |p| {
                const r = @as(f64, @floatFromInt(rgba[p])) - mr;
                const g = @as(f64, @floatFromInt(rgba[p + 1])) - mg;
                const b = @as(f64, @floatFromInt(rgba[p + 2])) - mb;
                const distance = r * r + g * g + b * b;
                if (distance > spread) {
                    spread = distance;
                    vr = r;
                    vg = g;
                    vb = b;
                }
            }

            for (0..4) |_| {
                const nr = rr * vr + rg * vg + rb * vb;
                const ng = rg * vr + gg * vg + gb * vb;
                const nb = rb * vr + gb * vg + bb * vb;
                const m = @max(@abs(nr), @abs(ng), @abs(nb));
                if (m == 0) break;
                vr = nr / m;
                vg = ng / m;
                vb = nb / m;
            }

            var first = texels[0];
            var second = texels[0];
            var least = std.math.inf(f64);
            var most = -std.math.inf(f64);
            for (texels) |p| {
                const d = @as(f64, @floatFromInt(rgba[p])) * vr + @as(f64, @floatFromInt(rgba[p + 1])) * vg + @as(f64, @floatFromInt(rgba[p + 2])) * vb;
                if (d < least) {
                    least = d;
                    second = p;
                }
                if (d > most) {
                    most = d;
                    first = p;
                }
            }

            var c0 = pack(rgba[first], rgba[first + 1], rgba[first + 2]);
            var c1 = pack(rgba[second], rgba[second + 1], rgba[second + 2]);
            if (c0 < c1) std.mem.swap(u32, &c0, &c1);
            const p0 = rgb(c0);
            const p1 = rgb(c1);
            const palette = [4]u32{ p0, p1, mix(p0, p1, 2, 1), mix(p0, p1, 1, 2) };
            var red: Distances = undefined;
            var green: Distances = undefined;
            var blue: Distances = undefined;
            inline for (0..4) |i| {
                red[i] = @intCast((palette[i] >> 16) & 255);
                green[i] = @intCast((palette[i] >> 8) & 255);
                blue[i] = @intCast(palette[i] & 255);
            }

            const colour = if (dxt5) at + 8 else at;
            byte(out, colour, c0);
            byte(out, colour + 1, c0 >> 8);
            byte(out, colour + 2, c1);
            byte(out, colour + 3, c1 >> 8);
            if (dxt5) {
                alphas[0] = @intCast(high_a);
                alphas[1] = @intCast(low_a);
                for (1..7) |i| alphas[i + 1] = @intCast(((7 - @as(u32, @intCast(i))) * high_a + @as(u32, @intCast(i)) * low_a) / 7);
                byte(out, at, high_a);
                byte(out, at + 1, low_a);
            }

            var indices: u32 = 0;
            var low: u32 = 0;
            var high: u32 = 0;
            for (texels, 0..) |p, i| {
                var best: u32 = 0;
                if (c0 != c1) {
                    const dr = @as(Distances, @splat(@intCast(rgba[p]))) - red;
                    const dg = @as(Distances, @splat(@intCast(rgba[p + 1]))) - green;
                    const db = @as(Distances, @splat(@intCast(rgba[p + 2]))) - blue;
                    const distances = dr * dr + dg * dg + db * db;
                    var nearest = distances[0];
                    inline for (1..4) |j| {
                        if (distances[j] < nearest) {
                            nearest = distances[j];
                            best = j;
                        }
                    }
                }

                indices |= best << @as(u5, @intCast(i * 2));
                if (dxt5) {
                    var index: u32 = 0;
                    const alpha: i32 = rgba[p + 3];
                    for (1..8) |j| {
                        if (@abs(alpha - alphas[j]) < @abs(alpha - alphas[index])) index = @intCast(j);
                    }
                    if (i < 8) {
                        low |= index << @as(u5, @intCast(i * 3));
                    } else {
                        high |= index << @as(u5, @intCast((i - 8) * 3));
                    }
                }
            }

            inline for (0..4) |i| byte(out, colour + 4 + i, indices >> (i * 8));
            if (dxt5) {
                inline for (0..3) |i| {
                    byte(out, at + 2 + i, low >> (i * 8));
                    byte(out, at + 5 + i, high >> (i * 8));
                }
            }
        }
    }
}

/// One level, in the live input resetArena reserved: false for invalid sizes or ranges.
export fn encodeDxt(source: usize, destination: usize, width: u32, height: u32, alpha: u32) bool {
    if (width == 0 or height == 0 or width > 4096 or height > 4096 or alpha > 1) return false;
    const source_bytes = @as(usize, width) * height * 4;
    const output_bytes = ((@as(usize, width) + 3) / 4) * ((@as(usize, height) + 3) / 4) * (if (alpha == 1) @as(usize, 16) else 8);
    if (!input.holds(source, source_bytes, 1) or !input.holds(destination, output_bytes, 1)) return false;
    if (source < destination + output_bytes and destination < source + source_bytes) return false;
    const rgba = @as([*]const u8, @ptrFromInt(source))[0..source_bytes];
    const out = @as([*]u8, @ptrFromInt(destination))[0..output_bytes];
    encode(rgba, alpha == 1, width, height, out);
    return true;
}

test "a flat RGB565 colour and equal alpha choose their first palette entry" {
    var rgba: [64]u8 = undefined;
    for (0..16) |i| @memcpy(rgba[i * 4 ..][0..4], &[_]u8{ 0, 255, 0, 255 });
    var dxt1: [8]u8 = undefined;
    encode(&rgba, false, 4, 4, &dxt1);
    try std.testing.expectEqualSlices(u8, &.{ 0xe0, 0x07, 0xe0, 0x07, 0, 0, 0, 0 }, &dxt1);
    var dxt5: [16]u8 = undefined;
    encode(&rgba, true, 4, 4, &dxt5);
    try std.testing.expectEqualSlices(u8, &.{ 255, 255, 0, 0, 0, 0, 0, 0, 0xe0, 0x07, 0xe0, 0x07, 0, 0, 0, 0 }, &dxt5);
}

test "a partial block repeats the last row and column" {
    const small = [_]u8{ 255, 0, 0, 0, 0, 0, 255, 255 };
    var full: [64]u8 = undefined;
    for (0..16) |i| @memcpy(full[i * 4 ..][0..4], small[@as(usize, @min(i & 3, 1)) * 4 ..][0..4]);
    inline for (.{ false, true }) |alpha| {
        var a: [16]u8 = undefined;
        var b: [16]u8 = undefined;
        const bytes: usize = if (alpha) 16 else 8;
        encode(&small, alpha, 2, 1, a[0..bytes]);
        encode(&full, alpha, 4, 4, b[0..bytes]);
        try std.testing.expectEqualSlices(u8, a[0..bytes], b[0..bytes]);
    }
}
