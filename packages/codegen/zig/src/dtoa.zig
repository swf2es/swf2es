// AS QUIRK, KEPT AS IS: this file copies AssemblyScript's behaviour, not
// Zig's idiom, and must stay byte for byte what AS writes.
//
// AssemblyScript's f64.toString, its Grisu2 dtoa, ported from its standard
// library (std/assembly/util/number.ts, Apache-2.0, Copyright the
// AssemblyScript authors) so that a double reads as the AS build writes it:
// Grisu2 is not always the shortest round-trip form, which Zig's own Ryu
// formatting gives, and an integer-valued double gets a ".0". The u64
// arithmetic wraps and the shifts take their amount mod 64, as wasm's do.
const std = @import("std");

const POWERS10 = [_]u32{ 1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000 };

const EXP_POWERS = [_]i16{
    -1220, -1193, -1166, -1140, -1113, -1087, -1060, -1034, -1007, -980,
    -954,  -927,  -901,  -874,  -847,  -821,  -794,  -768,  -741,  -715,
    -688,  -661,  -635,  -608,  -582,  -555,  -529,  -502,  -475,  -449,
    -422,  -396,  -369,  -343,  -316,  -289,  -263,  -236,  -210,  -183,
    -157,  -130,  -103,  -77,   -50,   -24,   3,     30,    56,    83,
    109,   136,   162,   189,   216,   242,   269,   295,   322,   348,
    375,   402,   428,   455,   481,   508,   534,   561,   588,   614,
    641,   667,   694,   720,   747,   774,   800,   827,   853,   880,
    907,   933,   960,   986,   1013,  1039,  1066,
};

const FRC_POWERS = [_]u64{
    0xFA8FD5A0081C0288, 0xBAAEE17FA23EBF76, 0x8B16FB203055AC76, 0xCF42894A5DCE35EA,
    0x9A6BB0AA55653B2D, 0xE61ACF033D1A45DF, 0xAB70FE17C79AC6CA, 0xFF77B1FCBEBCDC4F,
    0xBE5691EF416BD60C, 0x8DD01FAD907FFC3C, 0xD3515C2831559A83, 0x9D71AC8FADA6C9B5,
    0xEA9C227723EE8BCB, 0xAECC49914078536D, 0x823C12795DB6CE57, 0xC21094364DFB5637,
    0x9096EA6F3848984F, 0xD77485CB25823AC7, 0xA086CFCD97BF97F4, 0xEF340A98172AACE5,
    0xB23867FB2A35B28E, 0x84C8D4DFD2C63F3B, 0xC5DD44271AD3CDBA, 0x936B9FCEBB25C996,
    0xDBAC6C247D62A584, 0xA3AB66580D5FDAF6, 0xF3E2F893DEC3F126, 0xB5B5ADA8AAFF80B8,
    0x87625F056C7C4A8B, 0xC9BCFF6034C13053, 0x964E858C91BA2655, 0xDFF9772470297EBD,
    0xA6DFBD9FB8E5B88F, 0xF8A95FCF88747D94, 0xB94470938FA89BCF, 0x8A08F0F8BF0F156B,
    0xCDB02555653131B6, 0x993FE2C6D07B7FAC, 0xE45C10C42A2B3B06, 0xAA242499697392D3,
    0xFD87B5F28300CA0E, 0xBCE5086492111AEB, 0x8CBCCC096F5088CC, 0xD1B71758E219652C,
    0x9C40000000000000, 0xE8D4A51000000000, 0xAD78EBC5AC620000, 0x813F3978F8940984,
    0xC097CE7BC90715B3, 0x8F7E32CE7BEA5C70, 0xD5D238A4ABE98068, 0x9F4F2726179A2245,
    0xED63A231D4C4FB27, 0xB0DE65388CC8ADA8, 0x83C7088E1AAB65DB, 0xC45D1DF942711D9A,
    0x924D692CA61BE758, 0xDA01EE641A708DEA, 0xA26DA3999AEF774A, 0xF209787BB47D6B85,
    0xB454E4A179DD1877, 0x865B86925B9BC5C2, 0xC83553C5C8965D3D, 0x952AB45CFA97A0B3,
    0xDE469FBD99A05FE3, 0xA59BC234DB398C25, 0xF6C69A72A3989F5C, 0xB7DCBF5354E9BECE,
    0x88FCF317F22241E2, 0xCC20CE9BD35C78A5, 0x98165AF37B2153DF, 0xE2A0B5DC971F303A,
    0xA8D9D1535CE3B396, 0xFB9B7CD9A4A7443C, 0xBB764C4CA7A44410, 0x8BAB8EEFB6409C1A,
    0xD01FEF10A657842C, 0x9B10A4E5E9913129, 0xE7109BFBA19C0C9D, 0xAC2820D9623BF429,
    0x80444B5E7AA7CF85, 0xBF21E44003ACDD2D, 0x8E679C2F5E44FF8F, 0xD433179D9C8CB841,
    0x9E19DB92B4E31BA9, 0xEB96BF6EBADF77D9, 0xAF87023B9BF0EE6B,
};

/// The longest text it writes.
pub const max_length = 28;

/// The state AS keeps in globals between Grisu2's steps.
const State = struct {
    K: i32 = 0,
    exp: i32 = 0,
    frc_minus: u64 = 0,
    frc_plus: u64 = 0,
    frc_pow: u64 = 0,
    exp_pow: i32 = 0,
};

fn shl(x: u64, n: i32) u64 {
    return x << @as(u6, @truncate(@as(u32, @bitCast(n))));
}

fn shr(x: u64, n: i32) u64 {
    return x >> @as(u6, @truncate(@as(u32, @bitCast(n))));
}

fn decimalCount32(value: u32) u32 {
    if (value < 100000) {
        if (value < 100) {
            return 1 + @as(u32, @intFromBool(value >= 10));
        }

        return 3 + @as(u32, @intFromBool(value >= 10000)) + @intFromBool(value >= 1000);
    }

    if (value < 10000000) {
        return 6 + @as(u32, @intFromBool(value >= 1000000));
    }

    return 8 + @as(u32, @intFromBool(value >= 1000000000)) + @intFromBool(value >= 100000000);
}

fn umul64f(u: u64, v: u64) u64 {
    const r1 = u & 0xFFFFFFFF;
    const v0 = v & 0xFFFFFFFF;
    const u_1 = u >> 32;
    const v1 = v >> 32;
    const l = r1 *% v0;
    var t = u_1 *% v0 +% (l >> 32);
    var w = r1 *% v1 +% (t & 0xFFFFFFFF);
    w +%= 0x7FFFFFFF;
    t >>= 32;
    w >>= 32;
    return u_1 *% v1 +% t +% w;
}

fn umul64e(e1: i32, e2: i32) i32 {
    return e1 + e2 + 64;
}

fn normalizedBoundaries(s: *State, f: u64, e: i32) void {
    var frc = (f << 1) +% 1;
    var exp = e - 1;
    const off: i32 = @intCast(@clz(frc));
    frc = shl(frc, off);
    exp -= off;
    const m: i32 = 1 + @as(i32, @intFromBool(f == 0x0010000000000000));
    s.frc_plus = frc;
    s.frc_minus = shl(shl(f, m) -% 1, e - m - exp);
    s.exp = exp;
}

fn grisuRound(buffer: []u8, len: i32, delta: u64, rest_in: u64, ten_kappa: u64, wp_w: u64) void {
    const lastp: usize = @intCast(len - 1);
    var digit = buffer[lastp];
    var rest = rest_in;
    while (rest < wp_w and delta -% rest >= ten_kappa and
        (rest +% ten_kappa < wp_w or wp_w -% rest > rest +% ten_kappa -% wp_w))
    {
        digit -%= 1;
        rest +%= ten_kappa;
    }

    buffer[lastp] = digit;
}

fn getCachedPower(s: *State, min_exp: i32) void {
    const c: f64 = @bitCast(@as(u64, 0x3FD34413509F79FE));
    const dk = @as(f64, @floatFromInt(-61 - min_exp)) * c + 347;
    var k: i32 = @intFromFloat(dk);
    k += @intFromBool(@as(f64, @floatFromInt(k)) != dk);
    const index = (k >> 3) + 1;
    s.K = 348 - (index << 3);
    s.frc_pow = FRC_POWERS[@intCast(index)];
    s.exp_pow = EXP_POWERS[@intCast(index)];
}

fn grisu2(s: *State, value: f64, buffer: []u8, sign: i32) i32 {
    const uv: u64 = @bitCast(value);
    var exp: i32 = @intCast((uv & 0x7FF0000000000000) >> 52);
    const sid = uv & 0x000FFFFFFFFFFFFF;
    var frc = (@as(u64, @intFromBool(exp != 0)) << 52) + sid;
    exp = (if (exp != 0) exp else 1) - (0x3FF + 52);

    normalizedBoundaries(s, frc, exp);
    getCachedPower(s, s.exp);

    const off: i32 = @intCast(@clz(frc));
    frc = shl(frc, off);
    exp -= off;

    const frc_pow = s.frc_pow;
    const exp_pow = s.exp_pow;
    const w_frc = umul64f(frc, frc_pow);
    const w_exp = umul64e(exp, exp_pow);
    _ = w_exp;
    const wp_frc = umul64f(s.frc_plus, frc_pow) -% 1;
    const wp_exp = umul64e(s.exp, exp_pow);
    const wm_frc = umul64f(s.frc_minus, frc_pow) +% 1;
    const delta = wp_frc -% wm_frc;
    return genDigits(s, buffer, w_frc, wp_frc, wp_exp, delta, sign);
}

fn genDigits(s: *State, buffer: []u8, w_frc: u64, mp_frc: u64, mp_exp: i32, delta_in: u64, sign: i32) i32 {
    const one_exp = -mp_exp;
    const one_frc = shl(1, one_exp);
    const mask = one_frc -% 1;
    var wp_w_frc = mp_frc -% w_frc;
    var p1: u32 = @truncate(shr(mp_frc, one_exp));
    var p2 = mp_frc & mask;
    var kappa: i32 = @intCast(decimalCount32(p1));
    var len = sign;
    var delta = delta_in;

    while (kappa > 0) {
        var d: u32 = 0;
        if (kappa <= 10) {
            const p = POWERS10[@intCast(kappa - 1)];
            d = p1 / p;
            p1 %= p;
        }

        if ((d | @as(u32, @bitCast(len))) != 0) {
            buffer[@intCast(len)] = @truncate('0' + d);
            len += 1;
        }

        kappa -= 1;
        const tmp = shl(p1, one_exp) +% p2;
        if (tmp <= delta) {
            s.K += kappa;
            grisuRound(buffer, len, delta, tmp, shl(POWERS10[@intCast(kappa)], one_exp), wp_w_frc);
            return len;
        }
    }

    while (true) {
        p2 *%= 10;
        delta *%= 10;
        const d = shr(p2, one_exp);
        if ((d | @as(u64, @as(u32, @bitCast(len)))) != 0) {
            buffer[@intCast(len)] = @truncate('0' +% d);
            len += 1;
        }

        p2 &= mask;
        kappa -= 1;
        if (p2 < delta) {
            s.K += kappa;
            // As the repository's patch to AssemblyScript reads it
            // (patches/assemblyscript@0.28.20.patch): past the table's ten
            // powers, 0, which leaves the last digit unrounded.
            const index = -kappa;
            wp_w_frc = if (index < 10) wp_w_frc *% POWERS10[@intCast(index)] else 0;
            grisuRound(buffer, len, delta, p2, one_frc, wp_w_frc);
            return len;
        }
    }
}

/// The exponent `k` with its sign at `buffer[0]`: how many characters.
fn genExponent(buffer: []u8, k_in: i32) i32 {
    const negative = k_in < 0;
    const k: u32 = @intCast(if (negative) -k_in else k_in);
    const decimals = decimalCount32(k) + 1;
    var n = k;
    var i = decimals;
    while (i > 1) {
        i -= 1;
        buffer[i] = @truncate('0' + n % 10);
        n /= 10;
    }

    buffer[0] = if (negative) '-' else '+';
    return @intCast(decimals);
}

fn prettify(buffer: []u8, length: i32, k: i32) i32 {
    if (k == 0) {
        buffer[@intCast(length)] = '.';
        buffer[@intCast(length + 1)] = '0';
        return length + 2;
    }

    const kk = length + k;
    if (length <= kk and kk <= 21) {
        // 1234e7 -> 12340000000.0
        var i = length;
        while (i < kk) : (i += 1) {
            buffer[@intCast(i)] = '0';
        }

        buffer[@intCast(kk)] = '.';
        buffer[@intCast(kk + 1)] = '0';
        return kk + 2;
    }

    if (kk > 0 and kk <= 21) {
        // 1234e-2 -> 12.34
        const at: usize = @intCast(kk);
        const n: usize = @intCast(-k);
        std.mem.copyBackwards(u8, buffer[at + 1 .. at + 1 + n], buffer[at .. at + n]);
        buffer[at] = '.';
        return length + 1;
    }

    if (-6 < kk and kk <= 0) {
        // 1234e-6 -> 0.001234
        const offset: usize = @intCast(2 - kk);
        const n: usize = @intCast(length);
        std.mem.copyBackwards(u8, buffer[offset .. offset + n], buffer[0..n]);
        buffer[0] = '0';
        buffer[1] = '.';
        var i: usize = 2;
        while (i < offset) : (i += 1) {
            buffer[i] = '0';
        }

        return length + @as(i32, @intCast(offset));
    }

    if (length == 1) {
        // 1e30
        buffer[1] = 'e';
        return genExponent(buffer[2..], kk - 1) + 2;
    }

    const n: usize = @intCast(length);
    std.mem.copyBackwards(u8, buffer[2 .. n + 1], buffer[1..n]);
    buffer[1] = '.';
    buffer[n + 1] = 'e';
    return length + genExponent(buffer[n + 2 ..], kk - 1) + 2;
}

/// A finite, nonzero double as AS writes it into `buffer`: how many bytes.
pub fn dtoa(buffer: *[max_length]u8, value_in: f64) []const u8 {
    var value = value_in;
    const sign: i32 = @intFromBool(value < 0);
    if (sign != 0) {
        value = -value;
        buffer[0] = '-';
    }

    var s: State = .{};
    var len = grisu2(&s, value, buffer, sign);
    len = prettify(buffer[@intCast(sign)..], len - sign, s.K);
    return buffer[0..@intCast(len + sign)];
}

fn expectText(value: f64, text: []const u8) !void {
    var buffer: [max_length]u8 = undefined;
    const written = dtoa(&buffer, value);
    try std.testing.expectEqualStrings(text, written);
}

test "doubles read as AssemblyScript writes them" {
    try expectText(0.1, "0.1");
    try expectText(-1.5, "-1.5");
    try expectText(1e21, "1e+21");
    try expectText(1.5e300, "1.5e+300");
    try expectText(1e-7, "1e-7");
    try expectText(1.234e-7, "1.234e-7");
    try expectText(0.000001234, "0.000001234");
    try expectText(9007199254740994.0, "9007199254740994.0");
    try expectText(123.456, "123.456");
    try expectText(5e-324, "5e-324");
    try expectText(1.7976931348623157e308, "1.7976931348623157e+308");
    try expectText(3.14159, "3.14159");
    // Digits ten places past the integer part, the last unrounded (tests/unit/codegen/double.test.ts).
    try expectText(6.1300000000000005e-22, "6.1300000000000009e-22");
    try expectText(3.8712999999999997e-22, "3.8712999999999999e-22");
    try expectText(3.3493069370161103e-14, "3.3493069370161106e-14");
    try expectText(2396245078700000000.0, "2396245078700000500.0");
}
