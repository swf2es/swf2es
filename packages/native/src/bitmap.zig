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

fn clamp(v: i32, n: i32) i32 {
    return @max(0, @min(n - 1, v));
}

/// Params' dimensions, which validation keeps within i32, as i32.
const Geometry = struct {
    sw: i32,
    sh: i32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    x0: i32,
    y0: i32,
    nw: i32,
    nh: i32,
    cols: i32,
    rows: i32,
    hx: i32,
    hy: i32,
    clamp: bool,

    fn init(p: *const Params) Geometry {
        return .{
            .sw = @intCast(p.sw),
            .sh = @intCast(p.sh),
            .x = p.x,
            .y = p.y,
            .w = @intCast(p.w),
            .h = @intCast(p.h),
            .x0 = @intCast(p.x0),
            .y0 = @intCast(p.y0),
            .nw = @intCast(p.nw),
            .nh = @intCast(p.nh),
            .cols = @intCast(p.cols),
            .rows = @intCast(p.rows),
            .hx = @intCast(p.cols / 2),
            .hy = @intCast(p.rows / 2),
            .clamp = p.flags.clamp,
        };
    }

    /// Where the planes hold source pixel (x, y): past the bitmap, its
    /// nearest edge's when clamping, else the filter's colour after the rest.
    fn index(g: Geometry, x: i32, y: i32) usize {
        if (!g.clamp and (x < 0 or y < 0 or x >= g.sw or y >= g.sh)) return @intCast(g.nw * g.nh);
        return @intCast((clamp(y, g.sh) - g.y0) * g.nw + clamp(x, g.sw) - g.x0);
    }

    /// Kernel entry k as a tap: its weight and where it reads from the pixel,
    /// or null where it weighs nothing. The fixed-point way divides only after
    /// summing, and reads its last tap at the centre (integerKernel's quirk).
    inline fn tap(g: Geometry, matrix: []const f64, divisor: f64, k: usize, fixed: bool) ?Tap {
        @setFloatMode(.strict);
        const weight = if (fixed) matrix[k] else matrix[k] / divisor;
        if (weight == 0) return null;
        if (fixed and k == matrix.len - 1) return .{ .weight = weight, .dx = 0, .dy = 0 };
        const i: i32 = @intCast(k);
        return .{ .weight = weight, .dx = @rem(i, g.cols) - g.hx, .dy = @divTrunc(i, g.cols) - g.hy };
    }
};

const Tap = struct { weight: f64, dx: i32, dy: i32 };

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
    const sw: i32 = @intCast(p.sw);
    const sh: i32 = @intCast(p.sh);
    const cx0 = clamp(p.x - @as(i32, @intCast(p.cols / 2)), sw);
    const cy0 = clamp(p.y - @as(i32, @intCast(p.rows / 2)), sh);
    const cx1 = clamp(p.x + @as(i32, @intCast(p.w + p.cols - p.cols / 2)) - 2, sw);
    const cy1 = clamp(p.y + @as(i32, @intCast(p.h + p.rows - p.rows / 2)) - 2, sh);
    if (p.x0 != cx0 or p.y0 != cy0 or p.nw != cx1 - cx0 + 1 or p.nh != cy1 - cy0 + 1) return 0;
    const g: Geometry = .init(p);
    const count = std.math.mul(usize, p.nw, p.nh) catch return 0;
    const length = std.math.mul(usize, p.w, p.h) catch return 0;
    if (count > limit / 16 or length > limit / 4) return 0;
    if (!inputRange(p.pixels, count * 4, 4) or !inputRange(p.matrix, p.cols * p.rows * 8, 8)) return 0;
    const width: usize = p.w;
    const source = @as([*]const u32, @ptrFromInt(p.pixels))[0..count];
    const matrix = @as([*]const f64, @ptrFromInt(p.matrix))[0 .. p.cols * p.rows];
    const fixed_scale = integerKernel(matrix, p.divisor);
    var planes: [4][]i32 = undefined;
    var sums: [4][]f64 = undefined;
    for (&planes) |*plane| plane.* = alloc(i32, count + 1) orelse return 0;
    for (&sums) |*sum| sum.* = alloc(f64, width) orelse return 0;
    const out = alloc(u32, length) orelse return 0;
    for (source, 0..) |pixel, i| {
        const alpha = pixel >> 24;
        inline for (planes[0..3], 0..) |plane, ch| {
            const value = (pixel >> (16 - 8 * ch)) & 255;
            plane[i] = @intCast(if (alpha == 255) value else if (alpha == 0) 0 else @min(255, (value * (65280 / alpha) + 127) >> 8));
        }
        planes[3][i] = if (p.flags.source_transparent) @intCast(alpha) else 255;
    }
    inline for (planes[0..3], 0..) |plane, ch| plane[count] = @intCast((p.color >> (16 - 8 * ch)) & 255);
    planes[3][count] = p.outside_alpha;

    const scale = @as(f64, @floatFromInt(fixed_scale orelse 0)) / 65536;
    for (0..p.h) |y| {
        const sy = g.y + @as(i32, @intCast(y));
        for (sums) |sum| @memset(sum, 0);
        // The pixels whose taps all lie in the bitmap, x from x1 to before x2,
        // sum a tap at a time along the row; the rest a pixel at a time.
        const row_inside = sy >= g.hy and sy <= g.sh - g.rows + g.hy;
        const x1: usize = if (row_inside) @intCast(@min(g.w, @max(0, g.hx - g.x))) else 0;
        const x2: usize = if (row_inside) @intCast(@max(@as(i32, @intCast(x1)), @min(g.w, g.sw - g.cols + g.hx + 1 - g.x))) else 0;
        const fixed_row = fixed_scale != null and sy >= 1 and sy < g.sh - 1;
        if (x2 > x1) {
            for (0..matrix.len) |k| {
                const t = g.tap(matrix, p.divisor, k, fixed_row) orelse continue;
                const start = g.index(g.x + @as(i32, @intCast(x1)) + t.dx, sy + t.dy);
                inline for (sums, planes) |sum, plane| addRow(sum, plane, start, x1, x2, t.weight);
            }
        }
        for (out[y * width ..][0..width], 0..) |*pixel, x| {
            const sx = g.x + @as(i32, @intCast(x));
            const fixed = fixed_row and sx >= 1 and sx < g.sw - 1;
            if (x < x1 or x >= x2) {
                for (0..matrix.len) |k| {
                    const t = g.tap(matrix, p.divisor, k, fixed) orelse continue;
                    const at = g.index(sx + t.dx, sy + t.dy);
                    inline for (sums, planes) |sum, plane| sum[x] += @as(f64, @floatFromInt(plane[at])) * t.weight;
                }
            }
            var values: [4]f64 = undefined;
            inline for (&values, sums) |*value, sum| value.* = if (fixed) @floor(sum[x] * scale) else sum[x];
            const alpha = if (p.flags.preserve_alpha) planes[3][g.index(sx, sy)] else straight(values[3], p.bias);
            const by: f64 = if (p.flags.premultiply) @floatFromInt(alpha) else 255;
            var argb = @as(u32, @bitCast(alpha)) << 24;
            inline for (values[0..3], 0..) |value, ch| {
                const product = @as(f64, @floatFromInt(straight(value, p.bias))) * by;
                const channel: i32 = @intFromFloat(if (fixed) @floor(product / 255) else @trunc((product + 127) / 255));
                argb |= @as(u32, @bitCast(channel)) << (16 - 8 * ch);
            }
            pixel.* = argb;
        }
    }
    return @intFromPtr(out.ptr);
}
