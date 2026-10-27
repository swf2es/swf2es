//! BitmapData convolution, as packages/player/src/bitmap/filters.ts's
//! convolve computes it, pixel for pixel. root.zig wraps it for Wasm.
const std = @import("std");

/// The Wasm memory's maximum, which bounds a call's scratch.
pub const memory_limit = 128 * 1024 * 1024;

/// Params.flags, written by bitmap.ts from the same bit positions.
pub const Flags = packed struct(u32) {
    /// Taps past the bitmap read its nearest edge, not the filter's colour.
    clamp: bool = false,
    /// The source has an alpha channel; an opaque one reads as alpha 255.
    source_transparent: bool = false,
    /// The result keeps the source's alpha instead of convolving it.
    preserve_alpha: bool = false,
    /// The destination is transparent: premultiply the colour by the alpha.
    premultiply: bool = false,
    unused: u28 = 0,
};

/// One call's inputs, written by bitmap.ts at the start of the input region.
/// Coordinates are the source bitmap's pixels.
pub const Params = extern struct {
    /// The source bitmap's width and height.
    sw: u32,
    sh: u32,
    /// The rect to convolve, which may reach past the bitmap; the result is
    /// w × h pixels in row order.
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    /// The block of the source copied to `pixels`: the rect grown by the
    /// kernel's reach and clamped to the bitmap, nw × nh pixels from x0, y0.
    x0: u32,
    y0: u32,
    nw: u32,
    nh: u32,
    /// The kernel's columns and rows (ConvolutionFilter's matrixX, matrixY).
    cols: u32,
    rows: u32,
    flags: Flags,
    /// Addresses in the input region: the block's premultiplied ARGB, and
    /// the kernel's cols × rows f64 weights in row order.
    pixels: u32,
    matrix: u32,
    reserved: u32,
    /// Never 0: bitmap.ts passes 0 or NaN as 1, as Flash takes it.
    divisor: f64,
    bias: f64,
    /// The colour taps past an unclamped edge read: alpha as 0–255, and RGB.
    outside_alpha: i32,
    color: u32,
};

comptime {
    // The offsets bitmap.ts writes the fields at.
    std.debug.assert(@offsetOf(Params, "divisor") == 64);
    std.debug.assert(@offsetOf(Params, "outside_alpha") == 80);
    std.debug.assert(@sizeOf(Params) <= 96);
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
    x0: i32,
    y0: i32,
    nw: i32,
    cols: i32,
    rows: i32,
    hx: i32,
    hy: i32,
    clamp: bool,
    /// The block rows the planes hold at once, a power of two less one: a
    /// ring that row r of the block fills at line r & line_mask.
    line_mask: usize,
    /// The planes' entry after the lines, which holds the filter's colour.
    outside: usize,

    fn init(p: *const Params, lines: usize) Geometry {
        return .{
            .sw = @intCast(p.sw),
            .sh = @intCast(p.sh),
            .x = p.x,
            .y = p.y,
            .w = @intCast(p.w),
            .x0 = @intCast(p.x0),
            .y0 = @intCast(p.y0),
            .nw = @intCast(p.nw),
            .cols = @intCast(p.cols),
            .rows = @intCast(p.rows),
            .hx = @intCast(p.cols / 2),
            .hy = @intCast(p.rows / 2),
            .clamp = p.flags.clamp,
            .line_mask = lines - 1,
            .outside = lines * p.nw,
        };
    }

    /// The block row source row y reads: past the bitmap, its nearest edge's.
    fn row(g: Geometry, y: i32) usize {
        return @intCast(clamp(y, g.sh) - g.y0);
    }

    /// Where the planes hold source pixel (x, y): past the bitmap, its
    /// nearest edge's when clamping, else the filter's colour after the rest.
    fn index(g: Geometry, x: i32, y: i32) usize {
        if (!g.clamp and (x < 0 or y < 0 or x >= g.sw or y >= g.sh)) return g.outside;
        const column: usize = @intCast(clamp(x, g.sw) - g.x0);
        return (g.row(y) & g.line_mask) * @as(usize, @intCast(g.nw)) + column;
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

/// Adds plane values from `start` on times weight to sums lo to before hi.
fn addRow(sum: []f64, plane: []const i32, start: usize, lo: usize, hi: usize, weight: f64) void {
    @setFloatMode(.strict);
    var x = lo;
    const Vec = @Vector(2, f64);
    const w: Vec = @splat(weight);
    while (x + 2 <= hi) : (x += 2) {
        const values: @Vector(2, i32) = plane[start + x - lo ..][0..2].*;
        const into: Vec = sum[x..][0..2].*;
        sum[x..][0..2].* = into + @as(Vec, @floatFromInt(values)) * w;
    }
    while (x < hi) : (x += 1) sum[x] += @as(f64, @floatFromInt(plane[start + x - lo])) * weight;
}

/// Whether p describes a convolution the kernel can run. The limits are
/// bitmap.ts's own, so the two reject the same calls.
pub fn validate(p: *const Params) bool {
    // Under 2^30, so that a coordinate plus a size or a kernel stays an i32.
    if (p.sw == 0 or p.sw > 0x3fffffff) return false;
    if (p.sh == 0 or p.sh > 0x3fffffff) return false;
    if (p.x < -0x3fffffff or p.x > 0x3fffffff) return false;
    if (p.y < -0x3fffffff or p.y > 0x3fffffff) return false;
    // ConvolutionFilter's matrix is at most 15 × 15.
    if (p.cols == 0 or p.cols > 15) return false;
    if (p.rows == 0 or p.rows > 15) return false;
    if (p.w == 0 or p.w > 0x100000) return false;
    if (p.h == 0 or p.h > 0x100000) return false;
    if (p.flags.unused != 0) return false;

    // The copied block must be the rect grown by the kernel's reach and
    // clamped to the bitmap, as bitmap.ts computes it; the taps index it so.
    const sw: i32 = @intCast(p.sw);
    const sh: i32 = @intCast(p.sh);
    const hx: i32 = @intCast(p.cols / 2);
    const hy: i32 = @intCast(p.rows / 2);
    const x0 = clamp(p.x - hx, sw);
    const y0 = clamp(p.y - hy, sh);
    const x1 = clamp(p.x + @as(i32, @intCast(p.w + p.cols)) - hx - 2, sw);
    const y1 = clamp(p.y + @as(i32, @intCast(p.h + p.rows)) - hy - 2, sh);
    if (p.x0 != x0 or p.nw != x1 - x0 + 1) return false;
    if (p.y0 != y0 or p.nh != y1 - y0 + 1) return false;

    // The block and the output must each fit the 128 MiB memory with room
    // to spare; the planes hold at most 16 of the block's rows.
    const count = std.math.mul(u32, p.nw, p.nh) catch return false;
    const length = std.math.mul(u32, p.w, p.h) catch return false;
    return count <= memory_limit / 16 and length <= memory_limit / 4;
}

/// Converts row `r` of the block, `source`, into its line of the planes:
/// straight colour from premultiplied, and alpha 255 for an opaque source.
fn fill(planes: [4][]i32, g: Geometry, source: []const u32, r: usize, transparent: bool) void {
    const nw: usize = @intCast(g.nw);
    const start = (r & g.line_mask) * nw;
    for (source, start..) |pixel, i| {
        const alpha = pixel >> 24;
        inline for (planes[0..3], 0..) |plane, ch| {
            const value = (pixel >> (16 - 8 * ch)) & 255;
            plane[i] = @intCast(if (alpha == 255) value else if (alpha == 0) 0 else @min(255, (value * (65280 / alpha) + 127) >> 8));
        }
        planes[3][i] = if (transparent) @intCast(alpha) else 255;
    }
}

pub const Error = error{ InvalidParams, OutOfMemory };

/// Convolves `pixels`, the nw × nh block p describes, by the cols × rows
/// `matrix`: w × h premultiplied ARGB pixels the caller owns.
pub fn convolve(gpa: std.mem.Allocator, p: *const Params, pixels: []const u32, matrix: []const f64) Error![]u32 {
    // An output row reads at most `rows` consecutive block rows, and the
    // next reads the same or later ones, so that many lines of planes
    // suffice however tall the block is; a power of two masks rather than
    // divides when a tap finds its line. Validated first: no rows to round up
    // is invalid params, not a failed assertion.
    if (!validate(p)) return error.InvalidParams;
    return convolveLines(gpa, p, pixels, matrix, std.math.ceilPowerOfTwoAssert(usize, @min(p.rows, p.nh)));
}

/// convolve with planes of `lines` block rows, a power of two at least the
/// kernel's rows or the block's.
fn convolveLines(gpa: std.mem.Allocator, p: *const Params, pixels: []const u32, matrix: []const f64, lines: usize) Error![]u32 {
    @setFloatMode(.strict);
    if (!validate(p)) return error.InvalidParams;
    if (pixels.len != p.nw * p.nh or matrix.len != p.cols * p.rows) return error.InvalidParams;
    std.debug.assert(std.math.isPowerOfTwo(lines) and lines >= @min(p.rows, p.nh));
    const g: Geometry = .init(p, lines);
    const nw: usize = p.nw;
    const width: usize = p.w;
    const count = g.outside;

    // A plane a channel, each a ring of the block's rows in straight colour
    // and after it the filter's colour; and a row of sums a channel.
    const plane_memory = try gpa.alloc(i32, 4 * (count + 1));
    defer gpa.free(plane_memory);
    const sum_memory = try gpa.alloc(f64, 4 * width);
    defer gpa.free(sum_memory);
    const out = try gpa.alloc(u32, width * p.h);
    errdefer gpa.free(out);
    var planes: [4][]i32 = undefined;
    var sums: [4][]f64 = undefined;
    for (&planes, &sums, 0..) |*plane, *sum, ch| {
        plane.* = plane_memory[ch * (count + 1) ..][0 .. count + 1];
        sum.* = sum_memory[ch * width ..][0..width];
    }

    inline for (planes[0..3], 0..) |plane, ch| plane[count] = @intCast((p.color >> (16 - 8 * ch)) & 255);
    planes[3][count] = p.outside_alpha;

    const fixed_scale = integerKernel(matrix, p.divisor);
    const scale = @as(f64, @floatFromInt(fixed_scale orelse 0)) / 65536;
    var filled: usize = 0;
    for (0..p.h) |y| {
        const sy = g.y + @as(i32, @intCast(y));
        // Up to the block row of the row's lowest tap; the lines this
        // overwrites belong to rows above its highest.
        const last = g.row(sy + g.rows - 1 - g.hy);
        while (filled <= last) : (filled += 1) {
            fill(planes, g, pixels[filled * nw ..][0..nw], filled, p.flags.source_transparent);
        }
        for (sums) |sum| @memset(sum, 0);
        // The pixels whose taps all lie in the bitmap, x from x1 to before x2,
        // sum a tap at a time along the row; the rest a pixel at a time.
        const row_inside = sy >= g.hy and sy <= g.sh - g.rows + g.hy;
        const x1: usize, const x2: usize = span: {
            if (!row_inside) break :span .{ 0, 0 };
            const lo = @min(g.w, @max(0, g.hx - g.x));
            const hi = @max(lo, @min(g.w, g.sw - g.cols + g.hx + 1 - g.x));
            break :span .{ @intCast(lo), @intCast(hi) };
        };
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

    return out;
}

/// Params for the rect at x, y, w × h of a sw × sh bitmap, its block
/// computed as bitmap.ts does.
fn rectParams(sw: u32, sh: u32, x: i32, y: i32, w: u32, h: u32, cols: u32, rows: u32, flags: Flags) Params {
    const hx: i32 = @intCast(cols / 2);
    const hy: i32 = @intCast(rows / 2);
    const x0 = clamp(x - hx, @intCast(sw));
    const y0 = clamp(y - hy, @intCast(sh));
    const x1 = clamp(x + @as(i32, @intCast(w + cols)) - hx - 2, @intCast(sw));
    const y1 = clamp(y + @as(i32, @intCast(h + rows)) - hy - 2, @intCast(sh));
    return .{
        .sw = sw,
        .sh = sh,
        .x = x,
        .y = y,
        .w = w,
        .h = h,
        .x0 = @intCast(x0),
        .y0 = @intCast(y0),
        .nw = @intCast(x1 - x0 + 1),
        .nh = @intCast(y1 - y0 + 1),
        .cols = cols,
        .rows = rows,
        .flags = flags,
        .pixels = 0,
        .matrix = 0,
        .reserved = 0,
        .divisor = 1,
        .bias = 0,
        .outside_alpha = 0,
        .color = 0,
    };
}

/// Params for the whole of a sw × sh bitmap.
fn testParams(sw: u32, sh: u32, cols: u32, rows: u32, flags: Flags) Params {
    return rectParams(sw, sh, 0, 0, sw, sh, cols, rows, flags);
}

/// The block of `bitmap` that p describes, which the caller frees.
fn copyBlock(gpa: std.mem.Allocator, bitmap: []const u32, p: *const Params) ![]u32 {
    const block = try gpa.alloc(u32, p.nw * p.nh);
    for (0..p.nh) |r| @memcpy(block[r * p.nw ..][0..p.nw], bitmap[(p.y0 + r) * p.sw + p.x0 ..][0..p.nw]);
    return block;
}

/// Premultiplied ARGB with alpha 0, 255 and in between, as bitmaps hold.
fn randomBitmap(random: std.Random, pixels: []u32) void {
    for (pixels) |*pixel| {
        const alpha = random.uintLessThan(u32, 4) * 85;
        var argb = alpha << 24;
        for (0..3) |ch| argb |= random.uintAtMost(u32, alpha) << @intCast(8 * ch);
        pixel.* = argb;
    }
}

const opaque_flags: Flags = .{ .clamp = true, .source_transparent = true, .premultiply = true };

test "an identity kernel returns its source" {
    const pixels = [_]u32{ 0xff102030, 0xff405060, 0xff708090, 0xffa0b0c0, 0xffd0e0f0, 0xff000000 };
    const p = testParams(3, 2, 3, 3, opaque_flags);
    const out = try convolve(std.testing.allocator, &p, &pixels, &.{ 0, 0, 0, 0, 1, 0, 0, 0, 0 });
    defer std.testing.allocator.free(out);
    try std.testing.expectEqualSlices(u32, &pixels, out);
}

test "a tap past the edge reads the edge when clamping, else the filter's colour" {
    const red = 0xffff0000;
    const pixels = [_]u32{ red, 0xff00ff00 };
    // Each pixel takes its left neighbour's colour.
    const matrix = [_]f64{ 1, 0, 0 };
    var p = testParams(2, 1, 3, 1, opaque_flags);
    p.color = 0x0000ff;
    p.outside_alpha = 128;
    const cases = [_]struct { clamp: bool, expected: [2]u32 }{
        .{ .clamp = true, .expected = .{ red, red } },
        // Half-transparent blue, premultiplied: (255 × 128 + 127) / 255 truncated.
        .{ .clamp = false, .expected = .{ 0x80000080, red } },
    };
    for (cases) |case| {
        p.flags.clamp = case.clamp;
        const out = try convolve(std.testing.allocator, &p, &pixels, &matrix);
        defer std.testing.allocator.free(out);
        try std.testing.expectEqualSlices(u32, &case.expected, out);
    }
}

test "inconsistent params are rejected" {
    const pixels = [_]u32{0xff000000};
    var p = testParams(1, 1, 1, 1, opaque_flags);
    p.nw = 2;
    try std.testing.expectError(error.InvalidParams, convolve(std.testing.allocator, &p, &pixels, &.{1}));
    p = testParams(1, 1, 1, 1, opaque_flags);
    p.flags.unused = 1;
    try std.testing.expectError(error.InvalidParams, convolve(std.testing.allocator, &p, &pixels, &.{1}));
    p = testParams(1, 1, 1, 1, opaque_flags);
    try std.testing.expectError(error.InvalidParams, convolve(std.testing.allocator, &p, &pixels, &.{ 1, 2 }));
    p = testParams(1, 1, 1, 1, opaque_flags);
    p.rows = 0;
    try std.testing.expectError(error.InvalidParams, convolve(std.testing.allocator, &p, &pixels, &.{}));
    p = testParams(1, 1, 1, 1, opaque_flags);
    p.nh = 0;
    try std.testing.expectError(error.InvalidParams, convolve(std.testing.allocator, &p, &.{}, &.{1}));
}

fn convolveAndFree(gpa: std.mem.Allocator, p: *const Params, pixels: []const u32, matrix: []const f64) !void {
    gpa.free(try convolve(gpa, p, pixels, matrix));
}

test "every failed allocation is reported and frees what came before" {
    var pixels: [5 * 4]u32 = undefined;
    for (&pixels, 0..) |*pixel, i| pixel.* = 0x80000000 | @as(u32, @intCast(i * 0x030507));
    const p = testParams(5, 4, 3, 3, .{ .source_transparent = true, .preserve_alpha = true, .premultiply = true });
    const matrix = [_]f64{ 1, 2, 1, 2, 4, 2, 1, 2, 1 };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, convolveAndFree, .{ &p, &pixels, &matrix });
}

/// Kernels whose rows reach past a tall bitmap's top and bottom in turn,
/// fixed-point and not, each with and without clamping or preserved alpha.
const band_kernels = [_]struct { cols: u32, rows: u32, matrix: []const f64, divisor: f64 }{
    .{ .cols = 3, .rows = 3, .matrix = &.{ 1, 2, 1, 2, 4, 2, 1, 2, 1 }, .divisor = 16 },
    .{ .cols = 3, .rows = 3, .matrix = &.{ 0.5, -1, 0.25, 1, 0.125, -0.5, 2, 1, 0.75 }, .divisor = 3 },
    .{ .cols = 1, .rows = 5, .matrix = &.{ 1, 0, -2, 0.5, 3 }, .divisor = 2.5 },
    .{ .cols = 2, .rows = 4, .matrix = &.{ 1, 1, 1, 1, 1, 1, 1, 1 }, .divisor = 8 },
    .{ .cols = 3, .rows = 15, .matrix = &@as([45]f64, @splat(0.1)), .divisor = 1 },
};

test "a ring of the kernel's rows gives the pixels planes of the whole block do" {
    const gpa = std.testing.allocator;
    var prng: std.Random.DefaultPrng = .init(5);
    var bitmap: [7 * 40]u32 = undefined;
    randomBitmap(prng.random(), &bitmap);
    for (band_kernels) |kernel| {
        for (0..8) |bits| {
            var p = testParams(7, 40, kernel.cols, kernel.rows, .{
                .clamp = bits & 1 != 0,
                .source_transparent = true,
                .preserve_alpha = bits & 2 != 0,
                .premultiply = bits & 4 != 0,
            });
            p.divisor = kernel.divisor;
            p.color = 0x405060;
            p.outside_alpha = 200;
            const whole = try convolveLines(gpa, &p, &bitmap, kernel.matrix, std.math.ceilPowerOfTwoAssert(usize, p.nh));
            defer gpa.free(whole);
            const ring = try convolve(gpa, &p, &bitmap, kernel.matrix);
            defer gpa.free(ring);
            try std.testing.expectEqualSlices(u32, whole, ring);
        }
    }
}

test "a rect convolved in bands of rows gives the pixels it does whole" {
    const gpa = std.testing.allocator;
    var prng: std.Random.DefaultPrng = .init(9);
    const sw = 6;
    const sh = 24;
    var bitmap: [sw * sh]u32 = undefined;
    randomBitmap(prng.random(), &bitmap);
    for (band_kernels) |kernel| {
        for ([_]bool{ false, true }) |clamping| {
            // From above the bitmap to below it, so that bands begin and end
            // on each row near its edges.
            var whole_params = rectParams(sw, sh, -2, -9, sw + 3, sh + 18, kernel.cols, kernel.rows, .{ .clamp = clamping, .source_transparent = true });
            whole_params.divisor = kernel.divisor;
            whole_params.outside_alpha = 255;
            const whole_block = try copyBlock(gpa, &bitmap, &whole_params);
            defer gpa.free(whole_block);
            const whole = try convolve(gpa, &whole_params, whole_block, kernel.matrix);
            defer gpa.free(whole);

            for (1..8) |band| {
                var top: u32 = 0;
                while (top < whole_params.h) : (top += @intCast(band)) {
                    const h = @min(band, whole_params.h - top);
                    var p = rectParams(sw, sh, whole_params.x, whole_params.y + @as(i32, @intCast(top)), whole_params.w, @intCast(h), kernel.cols, kernel.rows, whole_params.flags);
                    p.divisor = kernel.divisor;
                    p.outside_alpha = 255;
                    const block = try copyBlock(gpa, &bitmap, &p);
                    defer gpa.free(block);
                    const out = try convolve(gpa, &p, block, kernel.matrix);
                    defer gpa.free(out);
                    try std.testing.expectEqualSlices(u32, whole[top * p.w ..][0..out.len], out);
                }
            }
        }
    }
}
