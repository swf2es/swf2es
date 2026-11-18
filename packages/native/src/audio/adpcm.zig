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
    bit: usize,

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

fn codeSize(first: u8) u5 {
    return @as(u5, @intCast(first >> 6)) + 2;
}

/// An upper bound in interleaved samples: each code consumes its declared width,
/// and even a packet header consumes 22 bits for the one sample it contributes per channel.
pub fn capacity(data: []const u8) u64 {
    if (data.len == 0) return 0;
    return (@as(u64, data.len) * 8 - 2) / codeSize(data[0]);
}

/// `data` decoded into `out`, which holds capacity(); how many samples.
pub fn decode(data: []const u8, channels: u32, out: []i16) usize {
    if (data.len == 0 or channels < 1 or channels > 2) {
        return 0;
    }

    var r = Reader{ .data = data, .bit = 2 };
    const bits = codeSize(data[0]);
    const sign: u32 = @as(u32, 1) << (bits - 1);
    const index = indices[bits - 2];
    var n: usize = 0;
    while (true) {
        const remaining = @as(u64, r.data.len) * 8 - r.bit;
        const header = 22 * channels;
        if (remaining < header) break;
        var sample: [2]i32 = undefined;
        var step: [2]i32 = undefined;
        for (0..channels) |c| {
            sample[c] = @as(i16, @bitCast(@as(u16, @intCast(r.read(16)))));
            step[c] = @intCast(r.read(6));
            out[n] = @intCast(sample[c]);
            n += 1;
        }

        const frames: usize = @intCast(@min(4095, (remaining - header) / (bits * channels)));
        for (0..frames) |_| {
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

        if (frames < 4095) break;
        // Keep the bit cursor local to a packet, including a header that starts mid-byte.
        r.data = r.data[r.bit >> 3 ..];
        r.bit &= 7;
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
    try std.testing.expect(n <= capacity(&bytes));
    try std.testing.expectEqualSlices(i16, &.{ 0, 10, -3, 2, -3 }, out[0..n]);
}

test "the ADPCM output reservation follows the code width" {
    var data: [1024]u8 = @splat(0);
    var out: [4096]i16 = undefined;
    for (2..6) |width| {
        data[0] = @intCast((width - 2) << 6);
        const bound = capacity(&data);
        try std.testing.expect(bound <= (data.len * 8 - 2) / width);
        for (1..3) |channels| {
            const samples = decode(&data, @intCast(channels), out[0..@intCast(bound)]);
            const frames = 1 + (data.len * 8 - 2 - 22 * channels) / (width * channels);
            try std.testing.expectEqual(frames * channels, samples);
        }
    }
}

test "a packet header starting mid-byte contributes a sample only when complete" {
    const next = 2 + 22 + 4095 * 3;
    var data: [(next + 22 + 7) / 8]u8 = @splat(0);
    data[0] = 0x40; // Three-bit codes, mono.
    for (next..next + 16) |bit| data[bit >> 3] |= @as(u8, 0x80) >> @intCast(bit & 7);

    var out: [(data.len * 8 - 2) / 3]i16 = undefined;
    try std.testing.expectEqual(@as(usize, 4096), decode(data[0 .. data.len - 1], 1, &out));
    try std.testing.expectEqual(@as(usize, 4098), decode(&data, 1, &out));
    try std.testing.expectEqual(@as(i16, -1), out[4096]);
}
