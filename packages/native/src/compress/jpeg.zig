// A JPEG encoder for BitmapData.encode, making the choices Flash's makes,
// which are libjpeg's defaults since its version 7. Measured under adl
// (AIR's Flash) from the files it writes for known bitmaps at qualities 0
// to 100, and from what it draws of them:
//
// - SOI, a JFIF 1.01 APP0 of density 1:1 without a unit or a thumbnail,
//   two DQT segments, the frame, four DHT segments (DC and AC for luma,
//   then for chroma), one interleaved scan of everything, EOI. No restart
//   intervals, no other segments.
// - Three components, Y at 2x2 and Cb and Cr at 1x1 (4:2:0), whatever the
//   quality.
// - The quantization tables are Annex K's, scaled as the IJG's quality
//   scale does: by 5000 / quality percent under 50 and 200 - 2 * quality
//   from there, rounded, from 1 up. Quality 0 is quality 1. Nothing holds
//   them to a byte: a table with a value past 255, the luma table under
//   quality 24 and the chroma table under 20, is written in 16 bits, and
//   the frame is then SOF1, extended sequential, not baseline's SOF0.
//   Qualities past 100 Flash refuses (RangeError 2006) before it encodes.
// - Annex K's Huffman tables, never ones made for the image.
// - A transparent bitmap's alpha is ignored: what is encoded are the
//   premultiplied colours a BitmapData keeps, so alpha fades to black.
// - Colours are JFIF's YCbCr in 16-bit fixed point, each rounded.
// - Chroma is not averaged down: a chroma block is the 8 by 8 lowest
//   frequencies of the 16 by 16 DCT of the MCU's full chroma, halved, as
//   libjpeg has scaled by DCT since its version 7. Averaging the samples
//   in fours instead gives coefficients tens of units from Flash's
//   wherever chroma changes from pixel to pixel. (Flash decodes the same
//   way round, a chroma block by a 16 by 16 inverse DCT.)
// - The picture's last column and row are repeated to fill an MCU; a luma
//   block wholly past them is coded as the DC of the one before it and
//   nothing else.
//
// All of that is done here as measured. What is not Flash's is the DCTs'
// arithmetic: Flash's are libjpeg's integer ones, these are in floats,
// eight or sixteen columns at a time, the luma's the scaled DCT of Arai,
// Agui and Nakajima (1988), its factors folded into the quantization.
// Both are within a fraction of a unit of the true transform, so a
// quantized coefficient differs from Flash's, by one, only where the true
// one lies next to a rounding boundary. Of a 96 by 64 picture of
// gradients and edges, 1 coefficient in 1000 differs at quality 80, 4 in
// 1000 at 90 and 4 in 100 at 100, where every step is 1; a flat picture's
// file, and that picture's at qualities 1 and 10, are Flash's byte for
// byte.
const std = @import("std");

const lanes = 8;
const F = @Vector(lanes, f32);
/// A row of an MCU's chroma.
const W = @Vector(16, f32);
const I = @Vector(lanes, i32);
const U = @Vector(lanes, u32);

/// Where the k-th coefficient of the zigzag order is in a block's rows.
const zigzag = [64]u8{
    0,  1,  8,  16, 9,  2,  3,  10, 17, 24, 32, 25, 18, 11, 4,  5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6,  7,  14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
};

// Annex K's tables for luminance and chrominance, in a block's rows.
const base = [2][64]u8{
    .{
        16, 11, 10, 16, 24,  40,  51,  61,
        12, 12, 14, 19, 26,  58,  60,  55,
        14, 13, 16, 24, 40,  57,  69,  56,
        14, 17, 22, 29, 51,  87,  80,  62,
        18, 22, 37, 56, 68,  109, 103, 77,
        24, 35, 55, 64, 81,  104, 113, 92,
        49, 64, 78, 87, 103, 121, 120, 101,
        72, 92, 95, 98, 112, 100, 103, 99,
    },
    .{
        17, 18, 24, 47, 99, 99, 99, 99,
        18, 21, 26, 66, 99, 99, 99, 99,
        24, 26, 56, 99, 99, 99, 99, 99,
        47, 66, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
    },
};

/// A Huffman table as a DHT segment holds it: how many codes of each length, and their values.
const Huffman = struct { counts: [16]u8, values: []const u8 };

// Annex K's tables: DC then AC, for luminance then chrominance.
const huffman = [2][2]Huffman{
    .{
        .{ .counts = .{ 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0 }, .values = &.{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } },
        .{ .counts = .{ 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125 }, .values = &.{
            0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
            0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
            0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
            0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
            0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
            0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
            0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
            0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
            0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
            0xf9, 0xfa,
        } },
    },
    .{
        .{ .counts = .{ 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0 }, .values = &.{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } },
        .{ .counts = .{ 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119 }, .values = &.{
            0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
            0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
            0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
            0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
            0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
            0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
            0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
            0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
            0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
            0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
            0xf9, 0xfa,
        } },
    },
};

/// Each value's code and its length in bits; a length of 0 where the table has no such value.
const Codes = struct { code: [256]u16, length: [256]u8 };

fn codesOf(comptime table: Huffman) Codes {
    @setEvalBranchQuota(10000);
    var made: Codes = .{ .code = @splat(0), .length = @splat(0) };
    var code: u16 = 0;
    var at: usize = 0;
    for (table.counts, 1..) |count, length| {
        for (0..count) |_| {
            made.code[table.values[at]] = code;
            made.length[table.values[at]] = @intCast(length);
            code += 1;
            at += 1;
        }

        code <<= 1;
    }

    return made;
}

// By table (luma, chroma), then DC and AC.
const codes = [2][2]Codes{
    .{ codesOf(huffman[0][0]), codesOf(huffman[0][1]) },
    .{ codesOf(huffman[1][0]), codesOf(huffman[1][1]) },
};

/// A base table's value at a quality from 0 to 100, as the IJG's quality scale makes it.
fn scaled(value: u8, quality: u32) u16 {
    const q = std.math.clamp(quality, 1, 100);
    const percent: u32 = if (q < 50) 5000 / q else 200 - 2 * q;
    return @intCast(std.math.clamp((@as(u32, value) * percent + 50) / 100, 1, 32767));
}

/// A pixel, its alpha left out, as JFIF's Y, Cb and Cr in 16-bit fixed point.
inline fn ycc(p: u32) [3]u8 {
    const r: i32 = @intCast((p >> 16) & 0xff);
    const g: i32 = @intCast((p >> 8) & 0xff);
    const b: i32 = @intCast(p & 0xff);
    // 0.299, 0.587 and 0.114 of 65536, and a half to round.
    const y = (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
    // -0.168736, -0.331264 and 0.5 about 128, rounded so that 128 itself is exact.
    const cb = (-11059 * r - 21709 * g + 32768 * b + 8421375) >> 16;
    const cr = (32768 * r - 27439 * g - 5329 * b + 8421375) >> 16;
    return .{ @intCast(y), @intCast(cb), @intCast(cr) };
}

inline fn bytes(v: I) @Vector(lanes, u8) {
    return @truncate(@as(U, @bitCast(v)));
}

/// A row of pixels as rows of Y, Cb and Cr, each as long as the row padded to whole MCUs: the
/// last pixel's fill what is past the row.
fn convertRow(pixels: []const u32, y: []u8, cb: []u8, cr: []u8) void {
    const byte: U = @splat(0xff);
    const shift: @Vector(lanes, u5) = @splat(16);
    var i: usize = 0;
    while (i + lanes <= pixels.len) : (i += lanes) {
        const p: U = pixels[i..][0..lanes].*;
        const r: I = @bitCast((p >> shift) & byte);
        const g: I = @bitCast((p >> @as(@Vector(lanes, u5), @splat(8))) & byte);
        const b: I = @bitCast(p & byte);
        const half: I = @splat(32768);
        const mid: I = @splat(8421375);
        y[i..][0..lanes].* = bytes((r * @as(I, @splat(19595)) + g * @as(I, @splat(38470)) + b * @as(I, @splat(7471)) + half) >> shift);
        cb[i..][0..lanes].* = bytes((r * @as(I, @splat(-11059)) + g * @as(I, @splat(-21709)) + b * @as(I, @splat(32768)) + mid) >> shift);
        cr[i..][0..lanes].* = bytes((r * @as(I, @splat(32768)) + g * @as(I, @splat(-27439)) + b * @as(I, @splat(-5329)) + mid) >> shift);
    }

    while (i < pixels.len) : (i += 1) {
        const c = ycc(pixels[i]);
        y[i] = c[0];
        cb[i] = c[1];
        cr[i] = c[2];
    }

    @memset(y[i..], y[i - 1]);
    @memset(cb[i..], cb[i - 1]);
    @memset(cr[i..], cr[i - 1]);
}

// The scaled DCT's factors: 1, then cos(k * pi / 16) * sqrt(2).
const factors = [8]f32{ 1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379 };

/// One dimension of the scaled DCT of Arai, Agui and Nakajima, across the eight vectors: every
/// lane's eight values, one in each vector, become their transform's, each times its factor.
inline fn pass(d: *[8]F) void {
    const s0 = d[0] + d[7];
    const d7 = d[0] - d[7];
    const s1 = d[1] + d[6];
    const d6 = d[1] - d[6];
    const s2 = d[2] + d[5];
    const d5 = d[2] - d[5];
    const s3 = d[3] + d[4];
    const d4 = d[3] - d[4];

    const e0 = s0 + s3;
    const e3 = s0 - s3;
    const e1 = s1 + s2;
    const e2 = s1 - s2;
    d[0] = e0 + e1;
    d[4] = e0 - e1;
    const z1 = (e2 + e3) * @as(F, @splat(0.707106781));
    d[2] = e3 + z1;
    d[6] = e3 - z1;

    const o0 = d4 + d5;
    const o1 = d5 + d6;
    const o2 = d6 + d7;
    const z5 = (o0 - o2) * @as(F, @splat(0.382683433));
    const z2 = o0 * @as(F, @splat(0.541196100)) + z5;
    const z4 = o2 * @as(F, @splat(1.306562965)) + z5;
    const z3 = o1 * @as(F, @splat(0.707106781));
    const z11 = d7 + z3;
    const z13 = d7 - z3;
    d[5] = z13 + z2;
    d[3] = z13 - z2;
    d[1] = z11 + z4;
    d[7] = z11 - z4;
}

/// The 8 by 8 block whose rows are `d` as its DCT's coefficients, transposed, vector u's lane v
/// that of frequency u across and v down, times 8 and both their factors.
fn fdct(d: *[8]F) void {
    pass(d);
    var rows: [8][8]f32 = undefined;
    for (0..8) |i| {
        rows[i] = d[i];
    }

    for (0..8) |i| {
        var column: [8]f32 = undefined;
        for (0..8) |j| {
            column[j] = rows[j][i];
        }

        d[i] = column;
    }

    pass(d);
}

/// cos(m * pi / 32).
inline fn cosine(comptime m: comptime_int) f32 {
    return comptime @floatCast(@cos(@as(f64, @floatFromInt(m)) * std.math.pi / 32.0));
}

/// The eight lowest frequencies of the 16-point DCT across the sixteen vectors: every lane's
/// sixteen values, one in each vector, become sum(x[n] * cos((2n + 1) * k * pi / 32)) for k
/// from 0 to 7. The even ones are an 8-point DCT's of the values added end to end, the odd
/// ones take the values subtracted end to end, each times its cosine.
inline fn lowest(comptime V: type, x: *const [16]V, out: *[8]V) void {
    var e: [8]V = undefined;
    var o: [8]V = undefined;
    inline for (0..8) |n| {
        e[n] = x[n] + x[15 - n];
        o[n] = x[n] - x[15 - n];
    }

    inline for (.{ 1, 3, 5, 7 }) |k| {
        var sum = o[0] * @as(V, @splat(cosine(k)));
        inline for (1..8) |n| {
            sum += o[n] * @as(V, @splat(cosine((2 * n + 1) * k)));
        }

        out[k] = sum;
    }

    const s0 = e[0] + e[7];
    const s1 = e[1] + e[6];
    const s2 = e[2] + e[5];
    const s3 = e[3] + e[4];
    const d0 = e[0] - e[7];
    const d1 = e[1] - e[6];
    const d2 = e[2] - e[5];
    const d3 = e[3] - e[4];
    out[0] = (s0 + s3) + (s1 + s2);
    out[4] = (s0 - s3) * @as(V, @splat(cosine(4))) + (s1 - s2) * @as(V, @splat(cosine(12)));
    out[2] = d0 * @as(V, @splat(cosine(2))) + d1 * @as(V, @splat(cosine(6))) + d2 * @as(V, @splat(cosine(10))) + d3 * @as(V, @splat(cosine(14)));
    out[6] = d0 * @as(V, @splat(cosine(6))) - d1 * @as(V, @splat(cosine(14))) - d2 * @as(V, @splat(cosine(2))) - d3 * @as(V, @splat(cosine(10)));
}

/// The 16 by 16 block whose rows are `x` as the 8 by 8 lowest frequencies of its DCT, laid out
/// as `fdct` lays a block's: vector u's lane v is that of frequency u across and v down, times
/// 16, and the square root of 2 for each of u and v that is 0. The coefficient is the 16 by 16
/// DCT's halved, which makes a flat block's DC what an 8 by 8 block's is.
fn fdct16(x: *const [16]W, d: *[8]F) void {
    var down: [8]W = undefined;
    lowest(W, x, &down);
    var rows: [8][16]f32 = undefined;
    for (0..8) |v| {
        rows[v] = down[v];
    }

    var columns: [16]F = undefined;
    for (0..16) |i| {
        var column: [8]f32 = undefined;
        for (0..8) |v| {
            column[v] = rows[v][i];
        }

        columns[i] = column;
    }

    lowest(F, &columns, d);
}

/// Where the k-th coefficient of the zigzag order is in what `fdct` and `fdct16` leave.
const transposed = blk: {
    var order: [64]u8 = undefined;
    for (zigzag, 0..) |n, k| {
        order[k] = (n % 8) * 8 + n / 8;
    }

    break :blk order;
};

/// The most bytes the segments before the scan's data take.
pub const header_bound = 1024;
/// The most bytes `finish` writes.
pub const finish_bound = 16;
// A block's most: a DC code of 11 bits and its 11 more, and 63 AC codes of 16 bits and their
// 10 more, every byte of them stuffed.
const mcu_bound = 6 * 2 * ((22 + 63 * 26 + 7) / 8);

/// How many bytes of scratch an encoder of pictures `width` wide needs.
pub fn scratchSize(width: usize) usize {
    return 48 * mcuColumns(width) * 16;
}

fn mcuColumns(width: usize) usize {
    return (width + 15) / 16;
}

/// The scan's bits, written whole bytes at a time; a byte of 0xff is followed by one of 0.
const Bits = struct {
    out: [*]u8,
    at: usize,
    acc: u64,
    count: u32,

    /// `length` bits, at most 27, the low ones of `value`.
    inline fn put(self: *Bits, value: u32, length: u32) void {
        self.acc = (self.acc << @intCast(length)) | value;
        self.count += length;
        if (self.count >= 32) {
            self.count -= 32;
            const word: u32 = @truncate(self.acc >> @intCast(self.count));
            // No byte of it 0xff: none of its complement 0.
            if ((~word -% 0x01010101) & word & 0x80808080 == 0) {
                std.mem.writeInt(u32, self.out[self.at..][0..4], word, .big);
                self.at += 4;
            } else {
                inline for (.{ 24, 16, 8, 0 }) |shift| {
                    self.byte(@truncate(word >> shift));
                }
            }
        }
    }

    inline fn byte(self: *Bits, b: u8) void {
        self.out[self.at] = b;
        self.at += 1;
        if (b == 0xff) {
            self.out[self.at] = 0;
            self.at += 1;
        }
    }
};

/// How many bits |v| takes.
inline fn magnitude(v: i32) u32 {
    return 32 - @clz(@as(u32, @abs(v)));
}

/// A value of `size` bits as JPEG appends it to its code: itself, or one less if negative.
inline fn appended(v: i32, size: u32) u32 {
    const low: u32 = @bitCast(if (v < 0) v - 1 else v);
    return low & ((@as(u32, 1) << @intCast(size)) - 1);
}

pub const Encoder = struct {
    width: usize,
    height: usize,
    /// MCUs across and down, each 16 by 16 pixels.
    columns: usize,
    rows: usize,
    /// The luma and chroma tables, in a block's rows.
    tables: [2][64]u16,
    /// What a coefficient `fdct` leaves of luma, and `fdct16` of chroma, is multiplied by to
    /// quantize it.
    reciprocals: [2][8]F,
    /// An MCU row's sixteen rows of Y, of Cb and of Cr.
    planes: [3][]u8,
    /// Each component's last DC.
    last: [3]i32,
    acc: u64,
    count: u32,

    /// An encoder of a `width` by `height` picture at `quality`, 0 to 100, its `scratch` at
    /// least `scratchSize(width)` bytes: null for what a JPEG cannot hold or Flash refuses.
    pub fn init(width: usize, height: usize, quality: u32, scratch: []u8) ?Encoder {
        if (width == 0 or height == 0 or width > 65535 or height > 65535 or quality > 100 or scratch.len < scratchSize(width)) {
            return null;
        }

        const padded = mcuColumns(width) * 16;
        var self: Encoder = .{
            .width = width,
            .height = height,
            .columns = padded / 16,
            .rows = (height + 15) / 16,
            .tables = undefined,
            .reciprocals = undefined,
            .planes = .{ scratch[0 .. 16 * padded], scratch[16 * padded ..][0 .. 16 * padded], scratch[32 * padded ..][0 .. 16 * padded] },
            .last = @splat(0),
            .acc = 0,
            .count = 0,
        };
        for (0..2) |t| {
            for (0..64) |n| {
                self.tables[t][n] = scaled(base[t][n], quality);
            }

            for (0..8) |u| {
                var column: [8]f32 = undefined;
                for (0..8) |v| {
                    const step: f32 = @floatFromInt(self.tables[t][v * 8 + u]);
                    const flat: f32 = std.math.sqrt2;
                    column[v] = 1.0 / (step * if (t == 0)
                        factors[u] * factors[v] * 8.0
                    else
                        16.0 * (if (u == 0) flat else 1.0) * (if (v == 0) flat else 1.0));
                }

                self.reciprocals[t][u] = column;
            }
        }

        return self;
    }

    /// The most bytes `row` writes.
    pub fn rowBound(self: *const Encoder) usize {
        return self.columns * mcu_bound + 8;
    }

    /// The segments before the scan's data, into `out` of at least `header_bound` bytes: how
    /// many bytes they are.
    pub fn header(self: *const Encoder, out: []u8) usize {
        var at: usize = 0;
        const jfif = [_]u8{ 0xff, 0xd8, 0xff, 0xe0, 0, 16, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0 };
        @memcpy(out[0..jfif.len], &jfif);
        at += jfif.len;

        // A table with a value past a byte is written in 16 bits, and then the frame is not
        // baseline's.
        var extended = false;
        for (self.tables, 0..) |table, t| {
            var wide = false;
            for (table) |v| {
                wide = wide or v > 255;
            }

            extended = extended or wide;
            const size: usize = if (wide) 2 else 1;
            out[at..][0..5].* = .{ 0xff, 0xdb, 0, @intCast(3 + 64 * size), @intCast((size - 1) << 4 | t) };
            at += 5;
            for (zigzag) |n| {
                if (wide) {
                    out[at] = @intCast(table[n] >> 8);
                    at += 1;
                }

                out[at] = @truncate(table[n]);
                at += 1;
            }
        }

        out[at..][0..19].* = .{
            0xff,                       if (extended) 0xc1 else 0xc0, 0,                         17,                    8,
            @intCast(self.height >> 8), @truncate(self.height),       @intCast(self.width >> 8), @truncate(self.width), 3,
            1,                          0x22,                         0,                         2,                     0x11,
            1,                          3,                            0x11,                      1,
        };
        at += 19;

        for (huffman, 0..) |pair, t| {
            for (pair, 0..) |table, kind| {
                out[at..][0..5].* = .{ 0xff, 0xc4, 0, @intCast(19 + table.values.len), @intCast(kind << 4 | t) };
                at += 5;
                @memcpy(out[at..][0..16], &table.counts);
                at += 16;
                @memcpy(out[at..][0..table.values.len], table.values);
                at += table.values.len;
            }
        }

        const scan = [_]u8{ 0xff, 0xda, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0 };
        @memcpy(out[at..][0..scan.len], &scan);
        return at + scan.len;
    }

    /// MCU row `my` of the picture whose pixels, ARGB, are `pixels`, into `out` of at least
    /// `rowBound()` bytes: how many bytes were written. The rows are encoded in order, once
    /// each.
    pub fn row(self: *Encoder, pixels: []const u32, my: usize, out: []u8) usize {
        const padded = self.columns * 16;
        for (0..16) |i| {
            const y = @min(my * 16 + i, self.height - 1);
            convertRow(pixels[y * self.width ..][0..self.width], self.planes[0][i * padded ..][0..padded], self.planes[1][i * padded ..][0..padded], self.planes[2][i * padded ..][0..padded]);
        }

        var bits: Bits = .{ .out = out.ptr, .at = 0, .acc = self.acc, .count = self.count };
        for (0..self.columns) |mx| {
            for (0..4) |b| {
                const x = mx * 16 + (b & 1) * 8;
                const y = (b >> 1) * 8;
                if (x >= self.width or my * 16 + y >= self.height) {
                    // A block wholly past the picture: the DC before it again, and the end of block.
                    bits.put(codes[0][0].code[0], codes[0][0].length[0]);
                    bits.put(codes[0][1].code[0], codes[0][1].length[0]);
                } else {
                    var d: [8]F = undefined;
                    for (0..8) |i| {
                        const line: @Vector(lanes, u8) = self.planes[0][(y + i) * padded + x ..][0..lanes].*;
                        d[i] = @floatFromInt(@as(I, @intCast(line)) - @as(I, @splat(128)));
                    }

                    fdct(&d);
                    self.block(&bits, 0, 0, &d);
                }
            }

            for (1..3) |c| {
                var x: [16]W = undefined;
                for (0..16) |i| {
                    const line: @Vector(16, u8) = self.planes[c][i * padded + mx * 16 ..][0..16].*;
                    x[i] = @floatFromInt(@as(@Vector(16, i32), @intCast(line)) - @as(@Vector(16, i32), @splat(128)));
                }

                var d: [8]F = undefined;
                fdct16(&x, &d);
                self.block(&bits, c, 1, &d);
            }
        }

        self.acc = bits.acc;
        self.count = bits.count;
        return bits.at;
    }

    /// One block of `component`, `d` what its DCT left, quantized and coded with tables `t`.
    inline fn block(self: *Encoder, bits: *Bits, component: usize, t: usize, d: *const [8]F) void {
        // Rounded to the nearest, a half away from 0.
        var quantized: [64]i32 = undefined;
        for (0..8) |i| {
            const q = d[i] * self.reciprocals[t][i];
            const rounded: I = @intFromFloat(q + @select(f32, q < @as(F, @splat(0)), @as(F, @splat(-0.5)), @as(F, @splat(0.5))));
            // No samples make a coefficient past these, -1024 a black block's DC: a code exists
            // for whatever is coded.
            quantized[i * 8 ..][0..8].* = @min(@max(rounded, @as(I, @splat(-1024))), @as(I, @splat(1023)));
        }

        const dc_codes = &codes[t][0];
        const ac_codes = &codes[t][1];
        const difference = quantized[0] - self.last[component];
        self.last[component] = quantized[0];
        const size = magnitude(difference);
        bits.put(@as(u32, dc_codes.code[size]) << @intCast(size) | appended(difference, size), dc_codes.length[size] + size);

        var end: usize = 63;
        while (end > 0 and quantized[transposed[end]] == 0) {
            end -= 1;
        }

        var run: u32 = 0;
        for (1..end + 1) |k| {
            const v = quantized[transposed[k]];
            if (v == 0) {
                run += 1;
                continue;
            }

            while (run >= 16) : (run -= 16) {
                bits.put(ac_codes.code[0xf0], ac_codes.length[0xf0]);
            }

            // Ten bits at most, which -1024 alone is past.
            const n = magnitude(@max(v, -1023));
            const symbol = run << 4 | n;
            bits.put(@as(u32, ac_codes.code[symbol]) << @intCast(n) | appended(@max(v, -1023), n), ac_codes.length[symbol] + n);
            run = 0;
        }

        if (end < 63) {
            bits.put(ac_codes.code[0], ac_codes.length[0]);
        }
    }

    /// The scan's last bits, the byte they end in filled with ones, and the end of the image,
    /// into `out` of at least `finish_bound` bytes: how many bytes were written.
    pub fn finish(self: *Encoder, out: []u8) usize {
        var bits: Bits = .{ .out = out.ptr, .at = 0, .acc = self.acc, .count = self.count };
        while (bits.count >= 8) {
            bits.count -= 8;
            bits.byte(@truncate(bits.acc >> @intCast(bits.count)));
        }

        if (bits.count > 0) {
            const fill: u8 = @intCast(8 - bits.count);
            bits.byte(@truncate((bits.acc << @intCast(fill)) | ((@as(u64, 1) << @intCast(fill)) - 1)));
        }

        self.acc = 0;
        self.count = 0;
        out[bits.at..][0..2].* = .{ 0xff, 0xd9 };
        return bits.at + 2;
    }
};

/// A whole file, for the tests: null as `init` is.
fn encode(allocator: std.mem.Allocator, pixels: []const u32, width: usize, height: usize, quality: u32) !?[]u8 {
    const scratch = try allocator.alloc(u8, scratchSize(width));
    defer allocator.free(scratch);
    var encoder = Encoder.init(width, height, quality, scratch) orelse return null;
    const out = try allocator.alloc(u8, header_bound + encoder.rows * encoder.rowBound() + finish_bound);
    defer allocator.free(out);
    var at = encoder.header(out);
    for (0..encoder.rows) |my| {
        at += encoder.row(pixels, my, out[at..]);
    }

    at += encoder.finish(out[at..]);
    return try allocator.dupe(u8, out[0..at]);
}

/// The DCT by its definition, in doubles: what `fdct` must equal once its factors are divided out.
fn reference(samples: *const [64]f64, out: *[64]f64) void {
    for (0..8) |v| {
        for (0..8) |u| {
            var sum: f64 = 0;
            for (0..8) |y| {
                for (0..8) |x| {
                    const cx = @cos(@as(f64, @floatFromInt((2 * x + 1) * u)) * std.math.pi / 16.0);
                    const cy = @cos(@as(f64, @floatFromInt((2 * y + 1) * v)) * std.math.pi / 16.0);
                    sum += samples[y * 8 + x] * cx * cy;
                }
            }

            const cu: f64 = if (u == 0) std.math.sqrt1_2 else 1.0;
            const cv: f64 = if (v == 0) std.math.sqrt1_2 else 1.0;
            out[v * 8 + u] = sum * cu * cv / 4.0;
        }
    }
}

test "the scaled DCT is the DCT by its definition, for noise, flat blocks and the extremes" {
    var prng = std.Random.DefaultPrng.init(11);
    const random = prng.random();
    for (0..200) |round| {
        var samples: [64]f64 = undefined;
        var d: [8]F = undefined;
        for (0..8) |y| {
            var line: [8]f32 = undefined;
            for (0..8) |x| {
                const s: i32 = switch (round % 5) {
                    0 => random.intRangeAtMost(i32, -128, 127),
                    1 => if (round % 2 == 0) -128 else 127,
                    // A checkerboard and stripes: the largest coefficients there are.
                    2 => if ((x + y) % 2 == 0) -128 else 127,
                    3 => if ((x * (round % 7 + 1) / 4) % 2 == 0) -128 else 127,
                    else => @as(i32, @intCast(x * 20 + y * 10)) - 128 + random.intRangeAtMost(i32, 0, 3),
                };
                samples[y * 8 + x] = @floatFromInt(s);
                line[x] = @floatFromInt(s);
            }

            d[y] = line;
        }

        var expected: [64]f64 = undefined;
        reference(&samples, &expected);
        fdct(&d);
        for (0..8) |u| {
            const column: [8]f32 = d[u];
            for (0..8) |v| {
                const got = @as(f64, column[v]) / (@as(f64, factors[u]) * factors[v] * 8.0);
                try std.testing.expectApproxEqAbs(expected[v * 8 + u], got, 0.01);
            }
        }
    }
}

test "the 16 by 16 DCT's lowest frequencies are those of the DCT by its definition" {
    var prng = std.Random.DefaultPrng.init(13);
    const random = prng.random();
    for (0..60) |round| {
        var samples: [256]f64 = undefined;
        var x: [16]W = undefined;
        for (0..16) |row| {
            var line: [16]f32 = undefined;
            for (0..16) |column| {
                const s: i32 = switch (round % 4) {
                    0 => random.intRangeAtMost(i32, -128, 127),
                    1 => if (round % 8 == 1) -128 else 127,
                    2 => if ((column + row) % 2 == 0) -128 else 127,
                    else => @as(i32, @intCast(column * 9 + row * 6)) - 128 + random.intRangeAtMost(i32, 0, 3),
                };
                samples[row * 16 + column] = @floatFromInt(s);
                line[column] = @floatFromInt(s);
            }

            x[row] = line;
        }

        var d: [8]F = undefined;
        fdct16(&x, &d);
        for (0..8) |u| {
            const column: [8]f32 = d[u];
            for (0..8) |v| {
                var sum: f64 = 0;
                for (0..16) |row| {
                    for (0..16) |i| {
                        const cx = @cos(@as(f64, @floatFromInt((2 * i + 1) * u)) * std.math.pi / 32.0);
                        const cy = @cos(@as(f64, @floatFromInt((2 * row + 1) * v)) * std.math.pi / 32.0);
                        sum += samples[row * 16 + i] * cx * cy;
                    }
                }

                // The 16 by 16 DCT's coefficient, halved: a flat block's DC is 8 times its sample.
                const cu: f64 = if (u == 0) std.math.sqrt1_2 else 1.0;
                const cv: f64 = if (v == 0) std.math.sqrt1_2 else 1.0;
                const scale: f64 = 16.0 * (if (u == 0) @as(f64, std.math.sqrt2) else 1.0) * (if (v == 0) @as(f64, std.math.sqrt2) else 1.0);
                try std.testing.expectApproxEqAbs(sum * cu * cv / 16.0, @as(f64, column[v]) / scale, 0.01);
            }
        }
    }
}

test "the tables at a quality are the ones Flash writes: in bytes from 25 up, in 16 bits and an extended frame under it" {
    // The tables of Flash's files, as their DQT segments hold them, in zigzag order.
    const luma80 = [64]u16{ 6, 4, 5, 6, 5, 4, 6, 6, 5, 6, 7, 7, 6, 8, 10, 16, 10, 10, 9, 9, 10, 20, 14, 15, 12, 16, 23, 20, 24, 24, 23, 20, 22, 22, 26, 29, 37, 31, 26, 27, 35, 28, 22, 22, 32, 44, 32, 35, 38, 39, 41, 42, 41, 25, 31, 45, 48, 45, 40, 48, 37, 40, 41, 40 };
    const chroma80 = [64]u16{ 7, 7, 7, 10, 8, 10, 19, 10, 10, 19, 40, 26, 22, 26, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40 };
    const luma10 = [64]u16{ 80, 55, 60, 70, 60, 50, 80, 70, 65, 70, 90, 85, 80, 95, 120, 200, 130, 120, 110, 110, 120, 245, 175, 185, 145, 200, 290, 255, 305, 300, 285, 255, 280, 275, 320, 360, 460, 390, 320, 340, 435, 345, 275, 280, 400, 545, 405, 435, 475, 490, 515, 520, 515, 310, 385, 565, 605, 560, 500, 600, 460, 505, 515, 495 };
    const chroma1 = [64]u16{ 850, 900, 900, 1200, 1050, 1200, 2350, 1300, 1300, 2350, 4950, 3300, 2800, 3300, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950, 4950 };
    for (zigzag, 0..) |n, k| {
        try std.testing.expectEqual(luma80[k], scaled(base[0][n], 80));
        try std.testing.expectEqual(chroma80[k], scaled(base[1][n], 80));
        try std.testing.expectEqual(luma10[k], scaled(base[0][n], 10));
        try std.testing.expectEqual(chroma1[k], scaled(base[1][n], 1));
        // 0 is 1, 50 the tables themselves, 100 all ones.
        try std.testing.expectEqual(chroma1[k], scaled(base[1][n], 0));
        try std.testing.expectEqual(@as(u16, base[0][n]), scaled(base[0][n], 50));
        try std.testing.expectEqual(@as(u16, 1), scaled(base[0][n], 100));
    }

    var scratch: [scratchSize(1)]u8 = undefined;
    var out: [header_bound]u8 = undefined;
    // The header's bytes: Flash's 623, and 64 more for each table in 16 bits, which the luma
    // table is under 24 and the chroma table under 20.
    for ([_]u32{ 0, 1, 10, 19, 20, 23, 24, 25, 80, 100 }) |quality| {
        const encoder = Encoder.init(1, 1, quality, &scratch).?;
        const length = encoder.header(&out);
        const luma: usize = if (quality < 24) 1 else 0;
        const chroma: usize = if (quality < 20) 1 else 0;
        try std.testing.expectEqual(623 + 64 * (luma + chroma), length);
        try std.testing.expectEqual(@as(u8, @intCast(luma << 4)), out[24]);
        try std.testing.expectEqual(@as(u8, @intCast(chroma << 4 | 1)), out[24 + 69 + 64 * luma]);
        const frame = 20 + 2 * 69 + 64 * (luma + chroma);
        try std.testing.expectEqualSlices(u8, &[_]u8{ 0xff, if (luma == 1) 0xc1 else 0xc0, 0, 17, 8, 0, 1, 0, 1, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1 }, out[frame..][0..19]);
        try std.testing.expectEqualSlices(u8, &[_]u8{ 0xff, 0xda, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0 }, out[length - 14 .. length]);
    }
}

test "a flat picture's scan is the one Flash writes, a block past the picture the DC before it" {
    const allocator = std.testing.allocator;
    // What follows the 623 bytes of segments in Flash's files.
    const cases = [_]struct { width: usize, color: u32, quality: u32, scan: []const u8 }{
        // new BitmapData(1, 1, false, 0x336699): one block of each, and three luma blocks past it.
        .{ .width = 1, .color = 0xff336699, .quality = 80, .scan = &.{ 0xe4, 0x28, 0xa2, 0x8a, 0xfa, 0x73, 0xe7, 0x4f, 0xff, 0xd9 } },
        .{ .width = 8, .color = 0xff808080, .quality = 80, .scan = &.{ 0x28, 0xa2, 0x8a, 0x00, 0xff, 0xd9 } },
        .{ .width = 8, .color = 0xffffffff, .quality = 80, .scan = &.{ 0xfa, 0xa6, 0x8a, 0x28, 0xa0, 0x0f, 0xff, 0xd9 } },
        .{ .width = 8, .color = 0xffff0000, .quality = 100, .scan = &.{ 0xfc, 0x5f, 0xa2, 0x8a, 0x2b, 0xfc, 0xa7, 0x3f, 0xef, 0xe0, 0xff, 0xd9 } },
        // A byte of 0xff in the scan, and the 0 after it.
        .{ .width = 8, .color = 0xff0000ff, .quality = 100, .scan = &.{ 0xfe, 0x39, 0xe8, 0xa2, 0x8a, 0xff, 0x00, 0xbf, 0x83, 0xf9, 0x5c, 0xff, 0xd9 } },
        // A transparent bitmap's clear pixels: black.
        .{ .width = 16, .color = 0x00000000, .quality = 90, .scan = &.{ 0xfc, 0xaa, 0xa2, 0x8a, 0x28, 0x03, 0xff, 0xd9 } },
    };
    for (cases) |case| {
        const pixels = try allocator.alloc(u32, case.width * case.width);
        defer allocator.free(pixels);
        @memset(pixels, case.color);
        const file = (try encode(allocator, pixels, case.width, case.width, case.quality)).?;
        defer allocator.free(file);
        try std.testing.expectEqual(623 + case.scan.len, file.len);
        try std.testing.expectEqualSlices(u8, case.scan, file[623..]);
    }
}

test "the lanes convert a row as a pixel at a time does, for every width's tail, and alpha changes nothing" {
    var prng = std.Random.DefaultPrng.init(3);
    const random = prng.random();
    var pixels: [40]u32 = undefined;
    var rows: [3][48]u8 = undefined;
    for (1..41) |width| {
        for (pixels[0..width]) |*p| {
            p.* = random.int(u32);
        }

        convertRow(pixels[0..width], &rows[0], &rows[1], &rows[2]);
        for (0..48) |i| {
            const expected = ycc(pixels[@min(i, width - 1)] | 0xff000000);
            for (0..3) |c| {
                try std.testing.expectEqual(expected[c], rows[c][i]);
            }
        }
    }

    // The primaries, as Flash's files hold them.
    try std.testing.expectEqual([3]u8{ 76, 85, 255 }, ycc(0xff0000));
    try std.testing.expectEqual([3]u8{ 150, 44, 21 }, ycc(0x00ff00));
    try std.testing.expectEqual([3]u8{ 29, 255, 107 }, ycc(0x0000ff));
    try std.testing.expectEqual([3]u8{ 255, 128, 128 }, ycc(0xffffff));
}

test "what a JPEG cannot hold or Flash refuses is no encoder, and noise at every quality fits its bound" {
    const allocator = std.testing.allocator;
    var scratch: [scratchSize(40)]u8 = undefined;
    try std.testing.expect(Encoder.init(0, 1, 80, &scratch) == null);
    try std.testing.expect(Encoder.init(1, 0, 80, &scratch) == null);
    try std.testing.expect(Encoder.init(1, 1, 101, &scratch) == null);
    try std.testing.expect(Encoder.init(65536, 1, 80, &scratch) == null);
    try std.testing.expect(Encoder.init(41, 1, 80, scratch[0 .. scratch.len - 1]) == null);

    var prng = std.Random.DefaultPrng.init(5);
    const random = prng.random();
    var pixels: [37 * 19]u32 = undefined;
    for (&pixels, 0..) |*p, i| {
        // Noise, then black and white by turns: the most bits there are.
        p.* = if (i < 300) random.int(u32) else if (random.boolean()) 0xffffffff else 0xff000000;
    }

    for ([_]u32{ 0, 1, 50, 100 }) |quality| {
        const file = (try encode(allocator, &pixels, 37, 19, quality)).?;
        defer allocator.free(file);
        try std.testing.expectEqualSlices(u8, &[_]u8{ 0xff, 0xd9 }, file[file.len - 2 ..]);
        // No marker inside the scan: every 0xff of it is stuffed.
        const start: usize = if (quality < 20) 751 else 623;
        for (start..file.len - 2) |i| {
            try std.testing.expect(file[i] != 0xff or file[i + 1] == 0);
        }
    }
}
