//! Nellymoser Asao, the speech codec of DefineSound's and a stream's
//! formats 4, 5 and 6: translated from FFmpeg's libavcodec/nellymoser.c and
//! nellymoserdec.c, which carry this notice:
//!
//! Copyright (c) 2007 a840bda5870ba11f19698ff6eb9581dfb0f95fa5,
//!                    539459aeb7d425140b62a3ec7dbf6dc8e408a306, and
//!                    520e17cd55896441042b14df2566a6eb610ed444
//! Copyright (c) 2007 Loic Minier <lool at dooz.org>
//!                    Benjamin Larsson
//!
//! Permission is hereby granted, free of charge, to any person obtaining a
//! copy of this software and associated documentation files (the "Software"),
//! to deal in the Software without restriction, including without limitation
//! the rights to use, copy, modify, merge, publish, distribute, sublicense,
//! and/or sell copies of the Software, and to permit persons to whom the
//! Software is furnished to do so, subject to the following conditions:
//!
//! The above copyright notice and this permission notice shall be included in
//! all copies or substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//! IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//! FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
//! THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//! LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//! FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//! DEALINGS IN THE SOFTWARE.
//!
//! (The three alphanumeric notices are the MD5 sums of the original
//! implementers' names, of nelly2pcm.)
//!
//! Each 64-byte block is 256 mono samples: band energies, then two halves
//! of 124 coefficients whose bit widths the energies decide, each through
//! an inverse MDCT and overlapped with the half before it. Bands given no
//! bits are noise of the band's energy, its signs from a generator of this
//! file's own rather than FFmpeg's, as the ear cannot tell. Coefficients
//! and samples are single precision and the transform double, each value
//! rounded where the TypeScript decoder this replaces stored it, so that it
//! gives that decoder's samples.
const std = @import("std");

const bands = 23;
pub const block_len = 64;
const header_bits = 116;
const detail_bits = 198;
const buf_len = 128;
const fill_len = 124;
const bit_cap = 6;
const base_off = 4228;
const base_shift = 19;
/// The samples a block decodes to.
pub const block_samples = 2 * buf_len;

const dequantization = [_]f32{
    0.0,           -0.8472560048, 0.7224709988,  -1.5247479677, -0.4531480074, 0.3753609955,  1.4717899561,
    -1.9822579622, -1.1929379702, -0.5829370022, -0.0693780035, 0.3909569979,  0.9069200158,  1.486274004,
    2.2215409279,  -2.3887870312, -1.806753993,  -1.4105420113, -1.0773609877, -0.7995010018, -0.5558109879,
    -0.3334020078, -0.1324490011, 0.0568020009,  0.254877001,   0.4773550034,  0.7386850119,  1.0443060398,
    1.3954459429,  1.8098750114,  2.3918759823,  -2.3893830776, -1.988468051,  -1.751404047,  -1.5643119812,
    -1.3922129869, -1.2164649963, -1.0469499826, -0.8905100226, -0.7645580173, -0.645457983,  -0.5259280205,
    -0.4059549868, -0.3029719889, -0.2096900046, -0.1239869967, -0.0479229987, 0.025773,      0.1001340002,
    0.1737180054,  0.2585540116,  0.3522900045,  0.4569880068,  0.5767750144,  0.7003160119,  0.8425520062,
    1.00938797,    1.1821349859,  1.3534560204,  1.5320819616,  1.7332619429,  1.9722349644,  2.3978140354,
    -2.5756309032, -2.0573320389, -1.8984919786, -1.7727810144, -1.666260004,  -1.5742180347, -1.4993319511,
    -1.43166399,   -1.3652280569, -1.3000990152, -1.2280930281, -1.1588579416, -1.0921250582, -1.0135740042,
    -0.9202849865, -0.8287050128, -0.7374889851, -0.6447759867, -0.5590940118, -0.4857139885, -0.4110319912,
    -0.3459700048, -0.2851159871, -0.2341620028, -0.1870580018, -0.1442500055, -0.1107169986, -0.0739680007,
    -0.0365610011, -0.0073290002, 0.0203610007,  0.0479039997,  0.0751969963,  0.0980999991,  0.1220389977,
    0.1458999962,  0.1694349945,  0.1970459968,  0.2252430022,  0.2556869984,  0.2870100141,  0.3197099864,
    0.3525829911,  0.3889069855,  0.4334920049,  0.4769459963,  0.5204820037,  0.5644530058,  0.6122040153,
    0.6685929894,  0.7341650128,  0.8032159805,  0.8784040213,  0.9566209912,  1.0397069454,  1.1293770075,
    1.2211159468,  1.3080279827,  1.4024800062,  1.5056819916,  1.6227730513,  1.772495985,   1.9430880547,
    2.2903931141,
};

const band_sizes = [bands]u8{ 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 4, 4, 5, 6, 6, 7, 8, 9, 10, 12, 14, 15 };

const init_values = [_]i32{
    3134,  5342,  6870,  7792,  8569,  9185,  9744,  10191, 10631, 11061, 11434, 11770, 12116,
    12513, 12925, 13300, 13674, 14027, 14352, 14716, 15117, 15477, 15824, 16157, 16513, 16804,
    17090, 17401, 17679, 17948, 18238, 18520, 18764, 19078, 19381, 19640, 19921, 20205, 20500,
    20813, 21162, 21465, 21794, 22137, 22453, 22756, 23067, 23350, 23636, 23926, 24227, 24521,
    24819, 25107, 25414, 25730, 26120, 26497, 26895, 27344, 27877, 28463, 29426, 31355,
};

const deltas = [_]i32{
    -11725, -9420, -7910, -6801, -5948, -5233, -4599, -4039, -3507, -3030, -2596,
    -2170,  -1774, -1383, -1016, -660,  -329,  -1,    337,   696,   1085,  1512,
    1962,   2433,  2968,  3569,  4314,  5279,  6622,  8154,  10076, 12975,
};

const n4 = buf_len / 2;

/// The window halves overlap by: FFmpeg's ff_sine_128.
const sine = blk: {
    @setEvalBranchQuota(100_000);
    var t: [buf_len]f32 = undefined;
    for (0..buf_len) |i| t[i] = @floatCast(@sin((@as(f64, @floatFromInt(i)) + 0.5) * (std.math.pi / (2.0 * buf_len))));
    break :blk t;
};

/// The inverse MDCT's twiddles, FFmpeg's ff_mdct_init's for 256 points at a scale of 1.
const tcos = blk: {
    @setEvalBranchQuota(100_000);
    var t: [n4]f64 = undefined;
    for (0..n4) |i| t[i] = -@cos(2.0 * std.math.pi * (@as(f64, @floatFromInt(i)) + 1.0 / 8.0) / 256.0);
    break :blk t;
};
const tsin = blk: {
    @setEvalBranchQuota(100_000);
    var t: [n4]f64 = undefined;
    for (0..n4) |i| t[i] = -@sin(2.0 * std.math.pi * (@as(f64, @floatFromInt(i)) + 1.0 / 8.0) / 256.0);
    break :blk t;
};

/// Where each of the FFT's 64 points goes in its bit-reversed order.
const reversed = blk: {
    var t: [n4]u8 = undefined;
    for (0..n4) |i| t[i] = @bitReverse(@as(u6, @intCast(i)));
    break :blk t;
};

/// The FFT's roots: e^(2 pi i k / 64), an inverse transform's.
const root_re = blk: {
    @setEvalBranchQuota(100_000);
    var t: [n4 / 2]f64 = undefined;
    for (0..n4 / 2) |k| t[k] = @cos(2.0 * std.math.pi * @as(f64, @floatFromInt(k)) / n4);
    break :blk t;
};
const root_im = blk: {
    @setEvalBranchQuota(100_000);
    var t: [n4 / 2]f64 = undefined;
    for (0..n4 / 2) |k| t[k] = @sin(2.0 * std.math.pi * @as(f64, @floatFromInt(k)) / n4);
    break :blk t;
};

// The bit allocation's integer arithmetic is the TypeScript's, which was
// FFmpeg's in JS: 32-bit shifts by a count taken mod 32, wrapping sums, and
// stores into shorts.

fn shl(v: i32, s: i32) i32 {
    return v << @intCast(s & 31);
}

fn sar(v: i32, s: i32) i32 {
    return v >> @intCast(s & 31);
}

/// A short, as C's stores wrap it.
fn short(v: i32) i32 {
    return @as(i16, @truncate(v));
}

/// C's floor(log2(v)) for a positive v, av_log2.
fn log2(v: u32) i32 {
    return 31 - @as(i32, @clz(v));
}

fn signedShift(v: i32, s: i32) i32 {
    return if (s > 0) shl(v, s) else sar(v, -s);
}

/// headroom(&v): how far `v` may be shifted up, and `v` shifted.
fn headroom(v: i32) struct { i32, i32 } {
    if (v == 0) {
        return .{ 31, 0 };
    }

    const l = 30 - log2(@abs(v));
    return .{ l, v *% shl(1, l) };
}

fn sumBits(sbuf: *const [fill_len]i16, shift: i32, offset: i32) i32 {
    const off = short(offset);
    var sum: i32 = 0;
    for (sbuf) |s| {
        const b = sar(sar(s - off, shift - 1) +% 1, 1);
        sum += std.math.clamp(b, 0, bit_cap);
    }

    return sum;
}

/// The bits each coefficient takes, from the bands' energies: ff_nelly_get_sample_bits.
fn sampleBits(buf: *const [fill_len]f32, bits: *[buf_len]i32) void {
    var sbuf: [fill_len]i16 = undefined;
    var max: i32 = 0;
    for (buf) |v| max = @max(max, @as(i32, @intFromFloat(v)));

    var shift: i32 = -16;
    const top = headroom(max);
    shift = short(shift + top[0]);
    var sum: i32 = 0;
    for (buf, 0..) |v, i| {
        sbuf[i] = @truncate(signedShift(@intFromFloat(v), shift));
        sbuf[i] = @truncate((3 * @as(i32, sbuf[i])) >> 2);
        sum += sbuf[i];
    }

    shift = short(shift + 11);
    const saved = shift;
    sum = sum -% shl(detail_bits, shift);
    const scaled = headroom(sum);
    sum = scaled[1];
    shift = short(shift + scaled[0]);
    var small = (base_off *% (sum >> 16)) >> 15;
    shift = short(saved - (base_shift + shift - 31));
    small = signedShift(small, shift);
    var bitsum = sumBits(&sbuf, saved, small);
    if (bitsum != detail_bits) {
        var wide: i64 = bitsum - detail_bits;
        shift = 0;
        while (@abs(wide) <= 16383) : (shift += 1) {
            wide *= 2;
        }

        var off: i32 = (@as(i32, @intCast(wide)) *% base_off) >> 15;
        shift = short(saved - (base_shift + shift - 15));
        off = signedShift(off, shift);
        var last = small;
        var last_bitsum = bitsum;
        var j: i32 = 1;
        while (j < 20) : (j += 1) {
            last = small;
            small +%= off;
            last_bitsum = bitsum;
            bitsum = sumBits(&sbuf, saved, small);
            if ((bitsum - detail_bits) * (last_bitsum - detail_bits) <= 0) {
                break;
            }
        }

        var big: i32 = undefined;
        var big_bitsum: i32 = undefined;
        var small_bitsum: i32 = undefined;
        if (bitsum > detail_bits) {
            big = small;
            small = last;
            big_bitsum = bitsum;
            small_bitsum = last_bitsum;
        } else {
            big = last;
            big_bitsum = last_bitsum;
            small_bitsum = bitsum;
        }

        while (bitsum != detail_bits and j <= 19) : (j += 1) {
            off = @truncate((@as(i64, big) + small) >> 1);
            bitsum = sumBits(&sbuf, saved, off);
            if (bitsum > detail_bits) {
                big = off;
                big_bitsum = bitsum;
            } else {
                small = off;
                small_bitsum = bitsum;
            }
        }

        if (@abs(big_bitsum - detail_bits) >= @abs(small_bitsum - detail_bits)) {
            bitsum = small_bitsum;
        } else {
            small = big;
            bitsum = big_bitsum;
        }
    }

    for (sbuf, 0..) |s, i| {
        bits[i] = std.math.clamp(sar(sar(@as(i32, s) -% small, saved - 1) +% 1, 1), 0, bit_cap);
    }

    if (bitsum > detail_bits) {
        var total: i32 = 0;
        var i: usize = 0;
        while (total < detail_bits) : (i += 1) {
            total += bits[i];
        }

        bits[i - 1] -= total - detail_bits;
        while (i < fill_len) : (i += 1) {
            bits[i] = 0;
        }
    }
}

/// What carries from one block to the next: the last half's transform,
/// which the next half overlaps, and the noise's generator.
pub const State = extern struct {
    prev: [buf_len]f32,
    random: u32,

    pub const initial = State{ .prev = @splat(0), .random = 1 };
};

/// FFmpeg's little-endian bit reader: the first bit read is the value's lowest.
const Reader = struct {
    block: *const [block_len]u8,
    bit: usize,

    /// The next `n` bits, at most 6: the two bytes they lie in, one past the block a zero.
    fn read(self: *Reader, n: u32) u32 {
        const at = self.bit >> 3;
        const next: u32 = if (at + 1 < block_len) self.block[at + 1] else 0;
        const word = self.block[at] | (next << 8);
        const v = (word >> @intCast(self.bit & 7)) & ((@as(u32, 1) << @intCast(n)) - 1);
        self.bit += n;
        return v;
    }
};

/// The middle half of the 256-point inverse MDCT of `a`'s 128 coefficients
/// into `out`, as FFmpeg's imdct_half: rotated into 64 complex points, an
/// inverse FFT, rotated back.
fn imdct(a: *const [buf_len]f32, out: *[buf_len]f32) void {
    var re: [n4]f64 = undefined;
    var im: [n4]f64 = undefined;
    for (0..n4) |k| {
        const x: f64 = a[buf_len - 1 - 2 * k];
        const y: f64 = a[2 * k];
        const j = reversed[k];
        re[j] = x * tcos[k] - y * tsin[k];
        im[j] = x * tsin[k] + y * tcos[k];
    }

    var size: usize = 2;
    while (size <= n4) : (size *= 2) {
        const half = size / 2;
        const step = n4 / size;
        var start: usize = 0;
        while (start < n4) : (start += size) {
            for (0..half) |k| {
                const wr = root_re[k * step];
                const wi = root_im[k * step];
                const p = start + k;
                const q = p + half;
                const tr = re[q] * wr - im[q] * wi;
                const ti = re[q] * wi + im[q] * wr;
                re[q] = re[p] - tr;
                im[q] = im[p] - ti;
                re[p] += tr;
                im[p] += ti;
            }
        }
    }

    const n8 = n4 / 2;
    for (0..n8) |k| {
        const lo = n8 - k - 1;
        const hi = n8 + k;
        out[2 * lo] = @floatCast(im[lo] * tsin[lo] - re[lo] * tcos[lo]);
        out[2 * lo + 1] = @floatCast(im[hi] * tcos[hi] + re[hi] * tsin[hi]);
        out[2 * hi] = @floatCast(im[hi] * tsin[hi] - re[hi] * tcos[hi]);
        out[2 * hi + 1] = @floatCast(im[lo] * tcos[lo] + re[lo] * tsin[lo]);
    }
}

/// One block into 256 samples from -1 to 1 at `audio`, carrying `state`.
fn block(state: *State, data: *const [block_len]u8, audio: *[block_samples]f32) void {
    var r = Reader{ .block = data, .bit = 0 };
    var buf: [fill_len]f32 = undefined;
    var pows: [fill_len]f32 = undefined;
    var val: i32 = init_values[r.read(6)];
    var p: usize = 0;
    for (0..bands) |i| {
        if (i > 0) {
            val += deltas[r.read(5)];
        }

        const pval: f32 = @floatCast(-std.math.pow(f64, 2, @as(f64, @floatFromInt(val)) / 2048) / (32768 * 8));
        for (0..band_sizes[i]) |_| {
            buf[p] = @floatFromInt(val);
            pows[p] = pval;
            p += 1;
        }
    }

    var bits: [buf_len]i32 = undefined;
    sampleBits(&buf, &bits);
    var a: [buf_len]f32 = undefined;
    var out: [buf_len]f32 = undefined;
    for (0..2) |half| {
        r.bit = header_bits + half * detail_bits;
        for (0..fill_len) |j| {
            if (bits[j] <= 0) {
                a[j] = @floatCast(std.math.sqrt1_2 * @as(f64, pows[j]));
                // A xorshift's low bit for the noise's sign.
                state.random ^= state.random << 13;
                state.random ^= state.random >> 17;
                state.random ^= state.random << 5;
                if (state.random & 1 != 0) {
                    a[j] = -a[j];
                }
            } else {
                const b: u5 = @intCast(bits[j]);
                const v = r.read(b);
                a[j] = dequantization[(@as(usize, 1) << b) - 1 + v] * pows[j];
            }
        }

        @memset(a[fill_len..], 0);
        imdct(&a, &out);
        // FFmpeg's vector_fmul_window over the last half's second half and this one's first.
        const into = audio[half * buf_len ..][0..buf_len];
        const len = buf_len / 2;
        for (0..len) |i| {
            const j = len - 1 - i;
            const s0: f64 = state.prev[len + i];
            const s1: f64 = out[j];
            const wi: f64 = sine[i];
            const wj: f64 = sine[len + j];
            into[i] = @floatCast(s0 * wj - s1 * wi);
            into[len + j] = @floatCast(s0 * wi + s1 * wj);
        }

        state.prev = out;
    }
}

/// `data`'s whole blocks decoded into `audio`, which holds block_samples a
/// block, `state` carried from the call before; how many samples.
pub fn decode(state: *State, data: []const u8, audio: []f32) usize {
    const blocks = data.len / block_len;
    for (0..blocks) |b| {
        block(state, data[b * block_len ..][0..block_len], audio[b * block_samples ..][0..block_samples]);
    }

    return blocks * block_samples;
}

test "blocks decode one call after another as they do at once" {
    var data: [block_len * 6]u8 = undefined;
    var seed: u32 = 12345;
    for (&data) |*d| {
        seed = seed *% 1103515245 +% 12345;
        d.* = @truncate(seed >> 16);
    }

    var whole: [block_samples * 6]f32 = undefined;
    var state = State.initial;
    try std.testing.expectEqual(whole.len, decode(&state, &data, &whole));

    var parts: [block_samples * 6]f32 = undefined;
    var again = State.initial;
    _ = decode(&again, data[0 .. block_len * 2], parts[0 .. block_samples * 2]);
    // A part short of a whole block decodes none of it.
    try std.testing.expectEqual(block_samples, decode(&again, data[block_len * 2 .. block_len * 3 + 10], parts[block_samples * 2 ..]));
    _ = decode(&again, data[block_len * 3 ..], parts[block_samples * 3 ..]);
    try std.testing.expectEqualSlices(f32, &whole, &parts);
    for (whole) |s| try std.testing.expect(std.math.isFinite(s));
}
