const std = @import("std");
const options = @import("options");

pub const panic = std.debug.no_panic;
extern var __heap_base: u8;
const page = 65536;
const limit = 128 * 1024 * 1024;
var top: usize = 0;
var input_start: usize = 0;
var input_end: usize = 0;

/// Params.flags, written by bitmap.ts from the same bit positions.
const Flags = packed struct(u32) {
    /// Taps past the bitmap read its nearest edge, not the filter's colour.
    clamp: bool,
    /// The source has an alpha channel; an opaque one reads as alpha 255.
    source_transparent: bool,
    /// The result keeps the source's alpha instead of convolving it.
    preserve_alpha: bool,
    /// The destination is transparent: premultiply the colour by the alpha.
    premultiply: bool,
    unused: u28,
};

const Params = extern struct {
    sw: u32,
    sh: u32,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    x0: u32,
    y0: u32,
    nw: u32,
    nh: u32,
    cols: u32,
    rows: u32,
    flags: Flags,
    pixels: u32,
    matrix: u32,
    reserved: u32,
    divisor: f64,
    bias: f64,
    outside_alpha: i32,
    color: u32,
};

fn reserve(end: usize) bool {
    if (end > limit) return false;
    const have = @wasmMemorySize(0) * page;
    return end <= have or @wasmMemoryGrow(0, (end - have + page - 1) / page) >= 0;
}

fn alloc(comptime T: type, n: usize) ?[]T {
    const at = std.mem.alignForward(usize, top, @alignOf(T));
    const bytes = std.math.mul(usize, n, @sizeOf(T)) catch return null;
    const end = std.math.add(usize, at, bytes) catch return null;
    if (!reserve(end)) return null;
    top = end;
    const ptr: [*]T = @ptrFromInt(at);
    return ptr[0..n];
}

export fn input(bytes: usize) usize {
    top = std.mem.alignForward(usize, @intFromPtr(&__heap_base), 16);
    input_start = top;
    input_end = top;
    const storage = alloc(u8, bytes) orelse return 0;
    input_end = top;
    return @intFromPtr(storage.ptr);
}

fn inputRange(at: usize, bytes: usize, alignment: usize) bool {
    return at >= input_start and at <= input_end and at % alignment == 0 and bytes <= input_end - at;
}

export fn capacity() usize {
    return @wasmMemorySize(0) * page;
}

fn clamp(v: i32, n: u32) i32 {
    return @max(0, @min(@as(i32, @intCast(n)) - 1, v));
}

fn index(p: *const Params, x: i32, y: i32) usize {
    if (!p.flags.clamp and (x < 0 or y < 0 or x >= p.sw or y >= p.sh)) return p.nw * p.nh;
    return @as(usize, @intCast(clamp(y, p.sh) - @as(i32, @intCast(p.y0)))) * p.nw + @as(usize, @intCast(clamp(x, p.sw) - @as(i32, @intCast(p.x0))));
}

fn straight(v: f64, bias: f64) i32 {
    @setFloatMode(.strict);
    const c = v + bias;
    return if (c >= 255) 255 else if (c > 0) @intFromFloat(@floor(c + 1e-7)) else 0;
}

fn integerKernel(matrix: []const f64, divisor: f64) ?i32 {
    @setFloatMode(.strict);
    if (matrix.len != 9) return null;
    var positive: f64 = 0;
    var negative: f64 = 0;
    for (matrix) |m| {
        if (!std.math.isFinite(m) or @floor(m) != m) return null;
        positive += @max(0, m);
        negative += @min(0, m);
    }
    const enough = if (negative < 0) divisor > @as(f64, @as(f32, 2.0001)) else divisor >= @as(f64, @as(f32, 1.1));
    if (positive > 127 or negative < -127 or !enough) return null;
    const reciprocal: u16 = @intFromFloat(@floor(65536 / divisor) + 1);
    return @as(i16, @bitCast(reciprocal));
}

fn addRow(sum: []f64, plane: []const i32, start: usize, lo: usize, hi: usize, weight: f64) void {
    @setFloatMode(.strict);
    var x = lo;
    if (options.manual) {
        const Vec = @Vector(2, f64);
        const w: Vec = @splat(weight);
        while (x + 2 <= hi) : (x += 2) {
            const values: *align(1) const @Vector(2, i32) = @ptrCast(&plane[start + x - lo]);
            const into: *align(1) Vec = @ptrCast(&sum[x]);
            into.* = into.* + @as(Vec, @floatFromInt(values.*)) * w;
        }
    }
    while (x < hi) : (x += 1) sum[x] += @as(f64, @floatFromInt(plane[start + x - lo])) * weight;
}

export fn convolve(address: usize) usize {
    @setFloatMode(.strict);
    if (!inputRange(address, @sizeOf(Params), @alignOf(Params))) return 0;
    const p: *const Params = @ptrFromInt(address);
    if (p.sw == 0 or p.sh == 0 or p.sw > 0x3fffffff or p.sh > 0x3fffffff or p.cols == 0 or p.rows == 0 or p.cols > 15 or p.rows > 15 or p.w == 0 or p.h == 0 or p.w > 0x100000 or p.h > 0x100000) return 0;
    if (p.x < -0x3fffffff or p.x > 0x3fffffff or p.y < -0x3fffffff or p.y > 0x3fffffff or p.flags.unused != 0) return 0;
    const cx0 = clamp(p.x - @as(i32, @intCast(p.cols / 2)), p.sw);
    const cy0 = clamp(p.y - @as(i32, @intCast(p.rows / 2)), p.sh);
    const cx1 = clamp(p.x + @as(i32, @intCast(p.w + p.cols - p.cols / 2)) - 2, p.sw);
    const cy1 = clamp(p.y + @as(i32, @intCast(p.h + p.rows - p.rows / 2)) - 2, p.sh);
    if (p.x0 != cx0 or p.y0 != cy0 or p.nw != cx1 - cx0 + 1 or p.nh != cy1 - cy0 + 1) return 0;
    const count = std.math.mul(usize, p.nw, p.nh) catch return 0;
    const length = std.math.mul(usize, p.w, p.h) catch return 0;
    if (count > limit / 16 or length > limit / 4) return 0;
    if (!inputRange(p.pixels, count * 4, 4) or !inputRange(p.matrix, p.cols * p.rows * 8, 8)) return 0;
    const source: [*]const u32 = @ptrFromInt(p.pixels);
    const mptr: [*]const f64 = @ptrFromInt(p.matrix);
    const matrix = mptr[0 .. p.cols * p.rows];
    const fixed_scale = integerKernel(matrix, p.divisor);
    const hx: i32 = @intCast(p.cols / 2);
    const hy: i32 = @intCast(p.rows / 2);
    const cols: i32 = @intCast(p.cols);
    const rows: i32 = @intCast(p.rows);
    var planes: [4][]i32 = undefined;
    var sums: [4][]f64 = undefined;
    for (&planes) |*plane| plane.* = alloc(i32, count + 1) orelse return 0;
    for (&sums) |*sum| sum.* = alloc(f64, p.w) orelse return 0;
    const out = alloc(u32, length) orelse return 0;
    for (0..count) |i| {
        const pixel = source[i];
        const alpha = pixel >> 24;
        inline for (0..3) |ch| {
            const value = (pixel >> @as(u5, @intCast(16 - ch * 8))) & 255;
            planes[ch][i] = @intCast(if (alpha == 255) value else if (alpha == 0) 0 else @min(255, (value * (65280 / alpha) + 127) >> 8));
        }
        planes[3][i] = if (p.flags.source_transparent) @intCast(alpha) else 255;
    }
    inline for (0..3) |ch| planes[ch][count] = @intCast((p.color >> @as(u5, @intCast(16 - ch * 8))) & 255);
    planes[3][count] = p.outside_alpha;

    const scale = @as(f64, @floatFromInt(fixed_scale orelse 0)) / 65536;
    for (0..p.h) |y| {
        const sy = p.y + @as(i32, @intCast(y));
        for (sums) |sum| @memset(sum, 0);
        const row_inside = sy >= hy and sy <= @as(i32, @intCast(p.sh)) - rows + hy;
        const x1: usize = if (row_inside) @intCast(@min(@as(i32, @intCast(p.w)), @max(0, hx - p.x))) else 0;
        const x2: usize = if (row_inside) @intCast(@max(@as(i32, @intCast(x1)), @min(@as(i32, @intCast(p.w)), @as(i32, @intCast(p.sw)) - cols + hx + 1 - p.x))) else 0;
        const fixed_row = fixed_scale != null and sy >= 1 and sy < @as(i32, @intCast(p.sh)) - 1;
        if (x2 > x1) {
            for (matrix, 0..) |m, k| {
                const weight = if (fixed_row) m else m / p.divisor;
                if (weight == 0) continue;
                const last = fixed_row and k == matrix.len - 1;
                const dx: i32 = if (last) 0 else @as(i32, @intCast(k % p.cols)) - hx;
                const dy: i32 = if (last) 0 else @as(i32, @intCast(k / p.cols)) - hy;
                const start = index(p, p.x + @as(i32, @intCast(x1)) + dx, sy + dy);
                inline for (0..4) |ch| addRow(sums[ch], planes[ch], start, x1, x2, weight);
            }
        }
        for (0..p.w) |x| {
            const sx = p.x + @as(i32, @intCast(x));
            const fixed = fixed_row and sx >= 1 and sx < @as(i32, @intCast(p.sw)) - 1;
            if (x < x1 or x >= x2) {
                for (matrix, 0..) |m, k| {
                    const weight = if (fixed) m else m / p.divisor;
                    if (weight == 0) continue;
                    const last = fixed and k == matrix.len - 1;
                    const dx: i32 = if (last) 0 else @as(i32, @intCast(k % p.cols)) - hx;
                    const dy: i32 = if (last) 0 else @as(i32, @intCast(k / p.cols)) - hy;
                    const at = index(p, sx + dx, sy + dy);
                    inline for (0..4) |ch| sums[ch][x] += @as(f64, @floatFromInt(planes[ch][at])) * weight;
                }
            }
            var values: [4]f64 = undefined;
            inline for (0..4) |ch| values[ch] = if (fixed) @floor(sums[ch][x] * scale) else sums[ch][x];
            const alpha = if (p.flags.preserve_alpha) planes[3][index(p, sx, sy)] else straight(values[3], p.bias);
            const by: f64 = if (p.flags.premultiply) @floatFromInt(alpha) else 255;
            var pixel = @as(u32, @bitCast(alpha)) << 24;
            inline for (0..3) |ch| {
                const value = @as(f64, @floatFromInt(straight(values[ch], p.bias))) * by;
                const channel: i32 = @intFromFloat(if (fixed) @floor(value / 255) else @trunc((value + 127) / 255));
                pixel |= @as(u32, @bitCast(channel)) << @as(u5, @intCast(16 - ch * 8));
            }
            out[y * p.w + x] = pixel;
        }
    }
    return @intFromPtr(out.ptr);
}
