//! SWF's ADPCM as 16-bit samples, channels interleaved: a code size, then
//! packets of a header per channel (a 16-bit sample and a 6-bit step
//! index) and 4095 codes, the header's sample the packet's first, as adl
//! gives it (Ruffle's decoder leaves it out). It ends where the bits do.
const std = @import("std");

const index_2 = [_]i8{ -1, 2 };
const index_3 = [_]i8{ -1, -1, 2, 4 };
const index_4 = [_]i8{ -1, -1, -1, -1, 2, 4, 6, 8 };
const index_5 = [_]i8{ -1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16 };
const indices = [_][]const i8{ &index_2, &index_3, &index_4, &index_5 };

const steps = [_]i32{
    7,     8,     9,     10,    11,    12,    13,    14,    16,    17,    19,    21,    23,    25,    28,
    31,    34,    37,    41,    45,    50,    55,    60,    66,    73,    80,    88,    97,    107,   118,
    130,   143,   157,   173,   190,   209,   230,   253,   279,   307,   337,   371,   408,   449,   494,
    544,   598,   658,   724,   796,   876,   963,   1060,  1166,  1282,  1411,  1552,  1707,  1878,  2066,
    2272,  2499,  2749,  3024,  3327,  3660,  4026,  4428,  4871,  5358,  5894,  6484,  7132,  7845,  8630,
    9493,  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
};

/// Bits read most significant first.
const Reader = struct {
    data: []const u8,
    bit: usize = 0,

    /// The next `n` bits, at most 16: the three bytes they lie in, those past the end zeros.
    fn read(self: *Reader, n: u5) u32 {
        const at = self.bit >> 3;
        var word: u32 = 0;
        inline for (0..3) |i| {
            word = (word << 8) | (if (at + i < self.data.len) self.data[at + i] else 0);
        }

        const shift: u5 = @intCast(24 - (self.bit & 7) - n);
        self.bit += n;
        return (word >> shift) & ((@as(u32, 1) << n) - 1);
    }
};

/// The most samples `length` bytes of `channels` decode to: what `out` must hold.
pub fn capacity(length: usize, channels: u32) usize {
    // The fewest bits a sample takes, 2, and a header's sample per channel besides.
    return (length * 8 + 1) / 2 + channels;
}

/// `data` decoded into `out`, which holds capacity(); how many samples.
pub fn decode(data: []const u8, channels: u32, out: []i16) usize {
    const total = data.len * 8;
    if (total < 2 or channels < 1 or channels > 2) {
        return 0;
    }

    var r = Reader{ .data = data };
    const bits: u5 = @intCast(r.read(2) + 2);
    const sign: u32 = @as(u32, 1) << (bits - 1);
    const index = indices[bits - 2];
    var sample = [2]i32{ 0, 0 };
    var step = [2]i32{ 0, 0 };
    var n: usize = 0;
    var k: u32 = 0;
    while (true) : (k = (k + 1) % 4096) {
        if (k == 0) {
            if (r.bit + 22 * channels > total) {
                break;
            }

            for (0..channels) |c| {
                sample[c] = @as(i16, @bitCast(@as(u16, @intCast(r.read(16)))));
                step[c] = @intCast(r.read(6));
                out[n] = @intCast(sample[c]);
                n += 1;
            }

            continue;
        }

        if (r.bit + bits * channels > total) {
            break;
        }

        for (0..channels) |c| {
            const value = r.read(bits);
            const magnitude = value & (sign - 1);
            const size = steps[@intCast(step[c])];
            var delta = size >> (bits - 1);
            for (0..bits - 1) |b| {
                if (magnitude & (@as(u32, 1) << @intCast(b)) != 0) {
                    delta += size >> @intCast(bits - 2 - b);
                }
            }

            sample[c] = if (value & sign != 0) @max(-32768, sample[c] - delta) else @min(32767, sample[c] + delta);
            step[c] = std.math.clamp(step[c] + index[magnitude], 0, @as(i32, steps.len - 1));
            out[n] = @intCast(sample[c]);
            n += 1;
        }
    }

    return n;
}

test "a mono packet: its header's sample, then each code's" {
    // 2-bit codes: sample 0, step index 0, then codes 01, 11, 00 and 10, sign first.
    const bits = "00" ++ "0000000000000000" ++ "000000" ++ "01" ++ "11" ++ "00" ++ "10";
    var bytes: [(bits.len + 7) / 8]u8 = @splat(0);
    for (bits, 0..) |b, i| {
        bytes[i >> 3] |= @as(u8, b - '0') << @intCast(7 - (i & 7));
    }

    var out: [16]i16 = undefined;
    const n = decode(&bytes, 1, &out);
    try std.testing.expect(n <= capacity(bytes.len, 1));
    try std.testing.expectEqualSlices(i16, &.{ 0, 10, -3, 2, -3 }, out[0..n]);
}
