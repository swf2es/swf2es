// The JavaScript being written, as bytes, all ASCII (every character past
// it escaped), in one growable buffer (assembly/output.ts): the AVM1
// emitter's part of it. The emitter writes
// through `writer()`, a std.Io.Writer, with std.fmt where it prints as AS
// does (integers, hex); a double goes through AS's own dtoa (dtoa.zig).
const std = @import("std");
const Allocator = std.mem.Allocator;
const dtoa = @import("dtoa.zig");

/// What writing can fail with: a writer that cannot grow, or an allocation.
pub const Error = std.Io.Writer.Error || Allocator.Error;

pub const Output = struct {
    allocating: std.Io.Writer.Allocating,

    pub fn init(gpa: Allocator) Allocator.Error!Output {
        return .{ .allocating = try .initCapacity(gpa, 1 << 16) };
    }

    pub fn deinit(self: *Output) void {
        self.allocating.deinit();
    }

    pub fn writer(self: *Output) *std.Io.Writer {
        return &self.allocating.writer;
    }

    pub fn written(self: *const Output) []u8 {
        return self.allocating.writer.buffer[0..self.allocating.writer.end];
    }

    pub fn len(self: *const Output) u32 {
        return @intCast(self.allocating.writer.end);
    }

    /// What was written from `n` on taken back.
    pub fn shrink(self: *Output, n: u32) void {
        self.allocating.shrinkRetainingCapacity(n);
    }

    /// Text of the emitter's own, all ASCII, put in at offset `at`, what follows moved after it.
    pub fn insert(self: *Output, at: u32, s: []const u8) Allocator.Error!void {
        try self.allocating.ensureUnusedCapacity(s.len);
        const w = &self.allocating.writer;
        std.mem.copyBackwards(u8, w.buffer[at + s.len .. w.end + s.len], w.buffer[at..w.end]);
        @memcpy(w.buffer[at..][0..s.len], s);
        w.end += s.len;
    }

    /// The `n` bytes from offset `at` taken out, what follows moved back.
    pub fn remove(self: *Output, at: u32, n: u32) void {
        const w = &self.allocating.writer;
        std.mem.copyForwards(u8, w.buffer[at .. w.end - n], w.buffer[at + n .. w.end]);
        w.end -= n;
    }
};

/// A JavaScript number literal for a double: exact, and valid for NaN,
/// infinities and -0; an integer as std.fmt writes it, any other as AS's
/// dtoa does, which std.fmt's shortest form would not match.
pub fn writeDouble(w: *std.Io.Writer, d: f64) std.Io.Writer.Error!void {
    if (std.math.isNan(d)) {
        try w.writeAll("NaN");
    } else if (std.math.isInf(d)) {
        try w.writeAll(if (d > 0) "Infinity" else "-Infinity");
    } else if (d == 0 and std.math.signbit(d)) {
        try w.writeAll("-0");
    } else if (d == @floor(d) and @abs(d) < 9007199254740992) {
        try w.print("{d}", .{@as(i64, @intFromFloat(d))});
    } else {
        var buffer: [dtoa.max_length]u8 = undefined;
        try w.writeAll(dtoa.dtoa(&buffer, d));
    }
}

/// A UTF-16 code unit as a \u escape: its low 16 bits, as Output.unit writes two bytes' hex.
pub fn writeUnit(w: *std.Io.Writer, u: u32) std.Io.Writer.Error!void {
    try w.print("\\u{x:0>4}", .{@as(u16, @truncate(u))});
}

/// A code point as \u escapes, two surrogates' past U+FFFF (Output.point).
pub fn writePoint(w: *std.Io.Writer, c: u32) std.Io.Writer.Error!void {
    if (c > 0xffff) {
        try writeUnit(w, (((c - 0x10000) >> 10) & 0x3ff) + 0xd800);
        try writeUnit(w, ((c - 0x10000) & 0x3ff) + 0xdc00);
    } else {
        try writeUnit(w, c);
    }
}

/// The code point of the well-formed sequence of `n` bytes that starts `p` (wellFormed).
pub fn codePoint(p: []const u8, n: u32) u32 {
    const c: u32 = p[0];
    return switch (n) {
        2 => ((c & 0x1f) << 6) | (p[1] & 0x3f),
        3 => ((c & 0x0f) << 12) | (@as(u32, p[1] & 0x3f) << 6) | (p[2] & 0x3f),
        else => ((c & 0x07) << 18) | (@as(u32, p[1] & 0x3f) << 12) | (@as(u32, p[2] & 0x3f) << 6) | (p[3] & 0x3f),
    };
}

/// How many bytes the well-formed UTF-8 sequence at the start of `p` takes,
/// which JavaScript reads as avmplus does; 0 if there is none.
pub fn wellFormed(p: []const u8) u32 {
    const c = p[0];
    const left = p.len;
    return switch (c) {
        0xc2...0xdf => if (left >= 2 and follows(p[1])) 2 else 0,
        0xe0...0xef => blk: {
            const lo: u8 = if (c == 0xe0) 0xa0 else 0x80;
            const hi: u8 = if (c == 0xed) 0x9f else 0xbf;
            break :blk if (left >= 3 and p[1] >= lo and p[1] <= hi and follows(p[2])) 3 else 0;
        },
        0xf0...0xf4 => blk: {
            const lo: u8 = if (c == 0xf0) 0x90 else 0x80;
            const hi: u8 = if (c == 0xf4) 0x8f else 0xbf;
            break :blk if (left >= 4 and p[1] >= lo and p[1] <= hi and follows(p[2]) and follows(p[3])) 4 else 0;
        },
        else => 0,
    };
}

/// Whether `b` continues a sequence: 10xxxxxx.
fn follows(b: u8) bool {
    return b & 0xc0 == 0x80;
}

test "numbers as AssemblyScript writes them" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();

    var out: Output = try .init(arena.allocator());
    const w = out.writer();
    try writeDouble(w, -0.0);
    try writeDouble(w, -12);
    try w.writeByte(' ');
    try writeDouble(w, 0.5);
    try w.print(" {d} ", .{std.math.minInt(i32)});
    try writeUnit(w, 0xe9);
    try out.insert(0, "[");
    out.remove(1, 2);
    try std.testing.expectEqualStrings("[-12 0.5 -2147483648 \\u00e9", out.written());
}

test "well-formed UTF-8, as JavaScript and avmplus both read it" {
    try std.testing.expectEqual(2, wellFormed("\xc3\xa9"));
    try std.testing.expectEqual(0, wellFormed("\xc0\x80"));
    try std.testing.expectEqual(0, wellFormed("\xed\xa0\x80"));
    try std.testing.expectEqual(4, wellFormed("\xf0\x9f\x98\x80"));
    try std.testing.expectEqual(0, wellFormed("\xe2\x80"));
}
