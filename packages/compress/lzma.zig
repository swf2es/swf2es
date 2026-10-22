// LZMA decoding, after the LZMA SDK's LzmaSpec.cpp (Igor Pavlov, public
// domain) and the decoder packages/format had in TypeScript, whose semantics
// it keeps: properties past 224 and any read past the input's end fail,
// and a dictionary is at least 4 KB. The output is the arena's top
// allocation, grown in place as it fills, so a header that names more than
// the stream holds costs nothing until the bytes are there.
const std = @import("std");

pub const panic = std.debug.no_panic;

extern fn alloc(n: usize) usize;
extern fn extend(p: usize, n: usize) c_int;
extern fn setResult(p: usize, n: usize, used: usize) void;

// The statuses compress.c returns too.
const DONE = 0;
const CORRUPT = -1;
const TRUNCATED = -2;
const NO_MEMORY = -3;

const STATES = 12;
const POS_BITS_MAX = 4;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + (16 << 3);
const LEN_HIGH = LEN_MID + (16 << 3);
const LEN_SIZE = LEN_HIGH + 256;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);

const Truncated = error{Truncated};

const Range = struct {
    input: []const u8,
    pos: usize,
    range: u32 = 0xffff_ffff,
    code: u32 = 0,

    inline fn byte(r: *Range) Truncated!u8 {
        if (r.pos >= r.input.len) {
            return error.Truncated;
        }

        const b = r.input[r.pos];
        r.pos += 1;
        return b;
    }

    inline fn normalize(r: *Range) Truncated!void {
        if (r.range < (1 << 24)) {
            r.range <<= 8;
            r.code = (r.code << 8) | try r.byte();
        }
    }

    inline fn bit(r: *Range, p: *u16) Truncated!u32 {
        const v = p.*;
        const bound = (r.range >> 11) * v;
        var b: u32 = undefined;
        if (r.code < bound) {
            p.* = v + ((2048 - v) >> 5);
            r.range = bound;
            b = 0;
        } else {
            p.* = v - (v >> 5);
            r.code -%= bound;
            r.range -%= bound;
            b = 1;
        }

        try r.normalize();
        return b;
    }

    fn direct(r: *Range, count: u32) Truncated!u32 {
        var result: u32 = 0;
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            r.range >>= 1;
            var b: u32 = 0;
            if (r.code >= r.range) {
                r.code -%= r.range;
                b = 1;
            }

            result = (result << 1) | b;
            try r.normalize();
        }

        return result;
    }

    inline fn tree(r: *Range, probs: []u16, bits: u5) Truncated!u32 {
        var m: u32 = 1;
        var i: u5 = 0;
        while (i < bits) : (i += 1) {
            m = (m << 1) + try r.bit(&probs[m]);
        }

        return m - (@as(u32, 1) << bits);
    }

    inline fn reverseTree(r: *Range, probs: []u16, bits: u5) Truncated!u32 {
        var m: u32 = 1;
        var symbol: u32 = 0;
        var i: u5 = 0;
        while (i < bits) : (i += 1) {
            const b = try r.bit(&probs[m]);
            m = (m << 1) + b;
            symbol |= b << i;
        }

        return symbol;
    }

    fn len(r: *Range, probs: []u16, pos_state: u32) Truncated!u32 {
        if (try r.bit(&probs[0]) == 0) {
            return r.tree(probs[LEN_LOW + (pos_state << 3) ..][0..8], 3);
        }

        if (try r.bit(&probs[1]) == 0) {
            return 8 + try r.tree(probs[LEN_MID + (pos_state << 3) ..][0..8], 3);
        }

        return 16 + try r.tree(probs[LEN_HIGH..][0..256], 8);
    }
};

fn newProbs(n: usize) ?[]u16 {
    const p = alloc(n * 2);
    if (p == 0) {
        return null;
    }

    const s = @as([*]u16, @ptrFromInt(p))[0..n];
    @memset(s, 1024);
    return s;
}

/// The output so far, at the arena's top, and how far it may grow.
const Output = struct {
    base: usize,
    bytes: []u8,
    length: usize,

    /// Room for `n` more bytes after `at`, doubling as it fills, never past `length`.
    inline fn room(o: *Output, at: usize, n: usize) error{Memory}!void {
        if (at + n <= o.bytes.len) {
            return;
        }

        const size = @min(o.length, @max(o.bytes.len * 2, at + n));
        if (extend(o.base, size) == 0) {
            return error.Memory;
        }

        o.bytes = @as([*]u8, @ptrFromInt(o.base))[0..size];
    }
};

/// Decode the LZMA stream of `in_len` bytes at `in`, whose 5 property bytes
/// are at `properties`, to `length` bytes, or fewer if its end marker comes first.
export fn lzmaDecode(properties: usize, in: usize, in_len: usize, length: usize) i32 {
    const props = @as(*const [5]u8, @ptrFromInt(properties));
    var r: Range = .{ .input = @as([*]const u8, @ptrFromInt(in))[0..in_len], .pos = 0 };
    var out: Output = .{ .base = 0, .bytes = &.{}, .length = length };
    const status: i32 = if (decode(props, &r, &out)) DONE else |e| switch (e) {
        error.Truncated => TRUNCATED,
        error.Corrupt => CORRUPT,
        error.Memory => NO_MEMORY,
    };
    setResult(out.base, out.bytes.len, r.pos);
    return status;
}

fn decode(input: *const [5]u8, r: *Range, out: *Output) (Truncated || error{ Corrupt, Memory })!void {
    var props = input[0];
    if (props >= 9 * 5 * 5) {
        return error.Corrupt;
    }

    const lc: u5 = @intCast(props % 9);
    props /= 9;
    const lp: u5 = @intCast(props % 5);
    const pb: u5 = @intCast(props / 5);
    const dict = std.mem.readInt(u32, input[1..5], .little);
    const dict_size: u32 = @max(dict, 4096);

    if (try r.byte() != 0) {
        return error.Corrupt;
    }

    for (0..4) |_| {
        r.code = (r.code << 8) | try r.byte();
    }

    if (r.code == r.range) {
        return error.Corrupt;
    }

    const literals = newProbs(@as(usize, 0x300) << (lc + lp)) orelse return error.Memory;
    const pos_slots = newProbs(4 << 6) orelse return error.Memory;
    const pos_decoders = newProbs(1 + FULL_DISTANCES - END_POS_MODEL_INDEX) orelse return error.Memory;
    const align_probs = newProbs(16) orelse return error.Memory;
    const is_match = newProbs(STATES << POS_BITS_MAX) orelse return error.Memory;
    const is_rep = newProbs(STATES) orelse return error.Memory;
    const is_rep_g0 = newProbs(STATES) orelse return error.Memory;
    const is_rep_g1 = newProbs(STATES) orelse return error.Memory;
    const is_rep_g2 = newProbs(STATES) orelse return error.Memory;
    const is_rep0_long = newProbs(STATES << POS_BITS_MAX) orelse return error.Memory;
    const lens = newProbs(LEN_SIZE) orelse return error.Memory;
    const rep_lens = newProbs(LEN_SIZE) orelse return error.Memory;

    // The output last, so that it can grow where it is.
    const first = @min(out.length, 1 << 16);
    out.base = alloc(first);
    if (out.base == 0) {
        return error.Memory;
    }

    out.bytes = @as([*]u8, @ptrFromInt(out.base))[0..first];
    var written: usize = 0;
    defer out.bytes = out.bytes[0..written];

    const pb_mask = (@as(usize, 1) << pb) - 1;
    const lp_mask = (@as(usize, 1) << lp) - 1;
    const length = out.length;
    var state: u32 = 0;
    var rep0: u32 = 0;
    var rep1: u32 = 0;
    var rep2: u32 = 0;
    var rep3: u32 = 0;

    while (written < length) {
        const pos_state: u32 = @intCast(written & pb_mask);
        if (try r.bit(&is_match[(state << POS_BITS_MAX) + pos_state]) == 0) {
            const output = out.bytes;
            const prev: usize = if (written > 0) output[written - 1] else 0;
            const lit = literals[0x300 * (((written & lp_mask) << lc) + (prev >> @intCast(8 - @as(u32, lc)))) ..][0..0x300];
            var symbol: u32 = 1;
            if (state >= 7) {
                // rep0 < written is held by the checks where it is set.
                var match_byte: u32 = output[written - rep0 - 1];
                while (true) {
                    const match_bit = (match_byte >> 7) & 1;
                    match_byte <<= 1;
                    const b = try r.bit(&lit[((1 + match_bit) << 8) + symbol]);
                    symbol = (symbol << 1) | b;
                    if (match_bit != b or symbol >= 0x100) {
                        break;
                    }
                }
            }

            while (symbol < 0x100) {
                symbol = (symbol << 1) | try r.bit(&lit[symbol]);
            }

            try out.room(written, 1);
            out.bytes[written] = @truncate(symbol);
            written += 1;
            state = if (state < 4) 0 else if (state < 10) state - 3 else state - 6;
            continue;
        }

        var len: u32 = undefined;
        if (try r.bit(&is_rep[state]) != 0) {
            if (written == 0) {
                return error.Corrupt;
            }

            if (try r.bit(&is_rep_g0[state]) == 0) {
                if (try r.bit(&is_rep0_long[(state << POS_BITS_MAX) + pos_state]) == 0) {
                    state = if (state < 7) 9 else 11;
                    try out.room(written, 1);
                    out.bytes[written] = out.bytes[written - rep0 - 1];
                    written += 1;
                    continue;
                }
            } else {
                var distance: u32 = undefined;
                if (try r.bit(&is_rep_g1[state]) == 0) {
                    distance = rep1;
                } else {
                    if (try r.bit(&is_rep_g2[state]) == 0) {
                        distance = rep2;
                    } else {
                        distance = rep3;
                        rep3 = rep2;
                    }

                    rep2 = rep1;
                }

                rep1 = rep0;
                rep0 = distance;
            }

            len = try r.len(rep_lens, pos_state);
            state = if (state < 7) 8 else 11;
        } else {
            rep3 = rep2;
            rep2 = rep1;
            rep1 = rep0;
            len = try r.len(lens, pos_state);
            state = if (state < 7) 7 else 10;

            const len_state: u32 = @min(len, 3);
            const pos_slot = try r.tree(pos_slots[len_state << 6 ..][0..64], 6);
            if (pos_slot < 4) {
                rep0 = pos_slot;
            } else {
                const bits: u5 = @intCast((pos_slot >> 1) - 1);
                var distance: u32 = (2 | (pos_slot & 1)) << bits;
                if (pos_slot < END_POS_MODEL_INDEX) {
                    distance += try r.reverseTree(pos_decoders[distance - pos_slot ..], bits);
                } else {
                    distance +%= (try r.direct(bits - 4)) << 4;
                    distance +%= try r.reverseTree(align_probs, 4);
                }

                rep0 = distance;
            }

            // The end marker.
            if (rep0 == 0xffff_ffff) {
                break;
            }

            if (rep0 >= dict_size or rep0 >= written) {
                return error.Corrupt;
            }
        }

        // rep1..rep3 were each checked when they were rep0, and `written` only grows.
        // A match past the length ends the output there, as a prefix asks.
        const n = @min(len + 2, length - written);
        try out.room(written, n);
        const output = out.bytes;
        const from = written - rep0 - 1;
        if (rep0 + 1 >= n) {
            @memcpy(output[written..][0..n], output[from..][0..n]);
        } else {
            for (0..n) |i| {
                output[written + i] = output[from + i];
            }
        }

        written += n;
    }
}
