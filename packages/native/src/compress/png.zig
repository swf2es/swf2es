// A PNG encoder's rows, one at a time: a bitmap's pixels as PNG's bytes,
// and the row given the filter, of PNG's five, whose output's bytes, taken
// as signed, sum smallest (libpng's heuristic), the first of equals. A
// filtered byte is a function of the row's and the row above's unfiltered
// bytes alone, so sixteen are made at a time.
const std = @import("std");

const lanes = 16;
const B = @Vector(lanes, u8);
const W = @Vector(lanes, i16);

/// A row of pixels, premultiplied ARGB as a BitmapData keeps them, as PNG's bytes in `out`:
/// RGBA for 4 `channels`, RGB for 3. The colours are divided out of alpha as Flash's encoder
/// does it, floor(c * 256 / a) up to 255, and are 0 where alpha is.
pub fn unpremultiply(pixels: []const u32, out: []u8, channels: usize) void {
    var j: usize = 0;
    for (pixels) |p| {
        const a: u32 = p >> 24;
        var r: u32 = (p >> 16) & 0xff;
        var g: u32 = (p >> 8) & 0xff;
        var b: u32 = p & 0xff;
        if (a == 0) {
            r = 0;
            g = 0;
            b = 0;
        } else if (a != 255) {
            r = @min(255, (r << 8) / a);
            g = @min(255, (g << 8) / a);
            b = @min(255, (b << 8) / a);
        }

        out[j] = @intCast(r);
        out[j + 1] = @intCast(g);
        out[j + 2] = @intCast(b);
        if (channels == 4) {
            out[j + 3] = @intCast(a);
        }

        j += channels;
    }
}

/// |v| of a filtered byte taken as signed, 128 for 0x80: what the heuristic sums.
inline fn weight(v: u8) u32 {
    return if (v < 128) v else 256 - @as(u32, v);
}

/// One byte of filter `f` from x and its neighbours: a to the left, b above, c above left.
inline fn filtered(f: usize, x: u8, a: u8, b: u8, c: u8) u8 {
    return switch (f) {
        0 => x,
        1 => x -% a,
        2 => x -% b,
        3 => x -% @as(u8, @intCast((@as(u16, a) + b) >> 1)),
        else => blk: {
            const p = @as(i16, a) + b - c;
            const pa = @abs(p - a);
            const pb = @abs(p - b);
            const pc = @abs(p - c);
            break :blk x -% (if (pa <= pb and pa <= pc) a else if (pb <= pc) b else c);
        },
    };
}

/// Sixteen bytes of filter `f`, as `filtered` makes each.
inline fn filteredLanes(comptime f: usize, x: B, a: B, b: B, c: B) B {
    return switch (f) {
        0 => x,
        1 => x -% a,
        2 => x -% b,
        // The floor of the mean without a ninth bit.
        3 => x -% ((a & b) +% ((a ^ b) >> @as(@Vector(lanes, u3), @splat(1)))),
        else => blk: {
            const wa: W = @intCast(a);
            const wb: W = @intCast(b);
            const wc: W = @intCast(c);
            // p - a is b - c, p - b is a - c, and p - c their sum.
            const pa = @abs(wb - wc);
            const pb = @abs(wa - wc);
            const pc = @abs(wa + wb - wc - wc);
            const b_or_c = @select(u8, pb <= pc, b, c);
            break :blk x -% @select(u8, pa <= pb, @select(u8, pa <= pc, a, b_or_c), b_or_c);
        },
    };
}

/// The sum of sixteen filtered bytes' weights.
inline fn weightLanes(v: B) u32 {
    const signed: @Vector(lanes, i8) = @bitCast(v);
    const wide: @Vector(lanes, u16) = @intCast(@abs(signed));
    return @reduce(.Add, wide);
}

/// Filter `f` of `row` into `out`, `up` the unfiltered row above (zeros for the first), `bpp`
/// bytes a pixel: its weights' sum.
fn filterRow(comptime f: usize, row: []const u8, up: []const u8, out: []u8, bpp: usize) u32 {
    var sum: u32 = 0;
    const head = @min(bpp, row.len);
    for (0..head) |i| {
        const v = filtered(f, row[i], 0, up[i], 0);
        out[i] = v;
        sum += weight(v);
    }

    var i = head;
    while (i + lanes <= row.len) : (i += lanes) {
        const x: B = row[i..][0..lanes].*;
        const a: B = row[i - bpp ..][0..lanes].*;
        const b: B = up[i..][0..lanes].*;
        const c: B = up[i - bpp ..][0..lanes].*;
        const v = filteredLanes(f, x, a, b, c);
        out[i..][0..lanes].* = v;
        sum += weightLanes(v);
    }

    while (i < row.len) : (i += 1) {
        const v = filtered(f, row[i], row[i - bpp], up[i], up[i - bpp]);
        out[i] = v;
        sum += weight(v);
    }

    return sum;
}

/// A row as a PNG stores it, its filter byte first: `row` under the best of the five filters,
/// `up` the unfiltered row above it, zeros for the first. `lines` holds five such rows, each
/// `row.len + 1` bytes, of which the one returned is the best.
pub fn filterBest(row: []const u8, up: []const u8, lines: []u8, bpp: usize) []const u8 {
    const stride = row.len + 1;
    var best: usize = 0;
    var best_sum: u32 = std.math.maxInt(u32);
    inline for (0..5) |f| {
        const line = lines[f * stride ..][0..stride];
        line[0] = f;
        const sum = filterRow(f, row, up, line[1..], bpp);
        if (sum < best_sum) {
            best_sum = sum;
            best = f;
        }
    }

    return lines[best * stride ..][0..stride];
}

/// `filterBest` a byte at a time, as the encoder's JavaScript did it: what the lanes must equal.
fn filterBestScalar(row: []const u8, up: []const u8, lines: []u8, bpp: usize) []const u8 {
    const stride = row.len + 1;
    var best: usize = 0;
    var best_sum: u32 = std.math.maxInt(u32);
    for (0..5) |f| {
        const line = lines[f * stride ..][0..stride];
        line[0] = @intCast(f);
        var sum: u32 = 0;
        for (0..row.len) |i| {
            const a: u8 = if (i >= bpp) row[i - bpp] else 0;
            const c: u8 = if (i >= bpp) up[i - bpp] else 0;
            line[1 + i] = filtered(f, row[i], a, up[i], c);
            sum += weight(line[1 + i]);
        }

        if (sum < best_sum) {
            best_sum = sum;
            best = f;
        }
    }

    return lines[best * stride ..][0..stride];
}

test "the lanes filter a row as a byte at a time does, for every width's tail and both pixel sizes" {
    var prng = std.Random.DefaultPrng.init(7);
    const random = prng.random();
    const allocator = std.testing.allocator;
    var won: [5]usize = @splat(0);
    for ([_]usize{ 3, 4 }) |bpp| {
        for ([_]usize{ 1, 2, 3, 4, 5, 15, 16, 17, 31, 33, 64, 100 }) |width| {
            const length = width * bpp;
            const row = try allocator.alloc(u8, length);
            defer allocator.free(row);
            const up = try allocator.alloc(u8, length);
            defer allocator.free(up);
            const a = try allocator.alloc(u8, 5 * (length + 1));
            defer allocator.free(a);
            const b = try allocator.alloc(u8, 5 * (length + 1));
            defer allocator.free(b);
            // Noise, flat runs, ramps and rows like the one above, so that every filter wins some.
            for (0..12) |round| {
                for (0..length) |i| {
                    up[i] = if (round == 0) 0 else random.int(u8);
                    row[i] = switch (round % 4) {
                        0 => random.int(u8),
                        1 => 200,
                        2 => @truncate(i * 3 + round * 5),
                        else => up[i] +% random.uintLessThan(u8, 3),
                    };
                }

                const got = filterBest(row, up, a, bpp);
                const expected = filterBestScalar(row, up, b, bpp);
                try std.testing.expectEqualSlices(u8, expected, got);
                won[got[0]] += 1;
            }
        }
    }

    for (won) |n| {
        try std.testing.expect(n > 0);
    }
}

test "a flat row takes Sub after its first pixel, and Up under a row like it" {
    const row = [_]u8{ 9, 9, 9, 9, 9, 9 };
    const zeros: [6]u8 = @splat(0);
    var lines: [35]u8 = undefined;
    try std.testing.expectEqualSlices(u8, &[_]u8{ 1, 9, 9, 9, 0, 0, 0 }, filterBest(&row, &zeros, &lines, 3));
    try std.testing.expectEqualSlices(u8, &[_]u8{ 2, 0, 0, 0, 0, 0, 0 }, filterBest(&row, &row, &lines, 3));
}

test "colours are divided out of alpha as Flash's encoder does, and dropped where it is 0" {
    const pixels = [_]u32{ 0xff102030, 0x80402010, 0x00ffffff, 0x01010101, 0x40404040 };
    var rgba: [20]u8 = undefined;
    unpremultiply(&pixels, &rgba, 4);
    try std.testing.expectEqualSlices(u8, &[_]u8{
        0x10, 0x20, 0x30, 0xff,
        // 0x40 * 256 / 0x80, and so on.
        0x80, 0x40, 0x20, 0x80,
        0,    0,    0,    0,
        // 1 * 256 / 1 is past a byte.
        255,  255,  255,  1,
        255,  255,  255,  0x40,
    }, &rgba);
    var rgb: [15]u8 = undefined;
    unpremultiply(&pixels, &rgb, 3);
    try std.testing.expectEqualSlices(u8, &[_]u8{ 0x10, 0x20, 0x30, 0x80, 0x40, 0x20, 0, 0, 0, 255, 255, 255, 255, 255, 255 }, &rgb);
}
