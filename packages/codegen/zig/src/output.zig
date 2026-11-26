// The JavaScript being written, as bytes, all ASCII (every character past
// it escaped), in one growable buffer (assembly/output.ts). The emitters,
// AVM1's and AVM2's, write through its methods, as AssemblyScript's call
// them; a double goes through AS's own dtoa (dtoa.zig). The test build's
// dumps write through `writer()`, a std.Io.Writer, with std.fmt.
const std = @import("std");
const Allocator = std.mem.Allocator;
const dtoa = @import("dtoa.zig");

/// What writing through `writer()` can fail with: a writer that cannot grow, or an allocation.
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

    /// Room for `more` bytes past the end.
    pub fn reserve(self: *Output, more: u32) Allocator.Error!void {
        try self.allocating.ensureUnusedCapacity(more);
    }

    /// Nothing written, the room kept.
    pub fn reset(self: *Output) void {
        self.allocating.writer.end = 0;
    }

    /// The `n` bytes of `from` from offset `at`, appended.
    pub fn append(self: *Output, from: *const Output, at: u32, n: u32) Allocator.Error!void {
        try self.reserve(n);
        const w = &self.allocating.writer;
        @memcpy(w.buffer[w.end..][0..n], from.written()[at..][0..n]);
        w.end += n;
    }

    /// Through the writer's own writeByte, which is shared: written into the
    /// buffer at each call site instead, grown first, the emitters' code
    /// came to twice the size (measured at stage 5).
    pub fn byte(self: *Output, b: u8) Allocator.Error!void {
        self.allocating.writer.writeByte(b) catch return error.OutOfMemory;
    }

    /// Text of the emitter's own, all ASCII. `s` must not point into this
    /// Output: a grow that reallocates the buffer would leave it dangling.
    /// Not inlined, so that the emitters share one append and their Wasm
    /// stays small.
    pub noinline fn text(self: *Output, s: []const u8) Allocator.Error!void {
        const w = &self.allocating.writer;
        if (w.buffer.len - w.end < s.len) {
            try self.allocating.ensureUnusedCapacity(s.len);
        }

        @memcpy(w.buffer[w.end..][0..s.len], s);
        w.end += s.len;
    }

    pub fn int(self: *Output, n: i64) Allocator.Error!void {
        if (n < 0) {
            try self.byte('-');
        }

        try self.uint(@abs(n));
    }

    /// Not inlined, as `text` is not: inlined, its loop came to some 16 KB
    /// over the emitters' 180 calls, and sharing it costs no time (P8).
    pub noinline fn uint(self: *Output, n: u64) Allocator.Error!void {
        var digits: [20]u8 = undefined;
        var at: usize = digits.len;
        var rest = n;
        while (true) {
            at -= 1;
            digits[at] = @intCast('0' + rest % 10);
            rest /= 10;
            if (rest == 0) {
                break;
            }
        }

        try self.text(digits[at..]);
    }

    /// A JavaScript number literal for a double: exact, and valid for NaN, infinities and -0.
    pub fn double(self: *Output, d: f64) Allocator.Error!void {
        if (std.math.isNan(d)) {
            try self.text("NaN");
        } else if (std.math.isInf(d)) {
            try self.text(if (d > 0) "Infinity" else "-Infinity");
        } else if (d == 0 and std.math.signbit(d)) {
            try self.text("-0");
        } else if (d == @floor(d) and @abs(d) < 9007199254740992) {
            try self.int(@intFromFloat(d));
        } else {
            // Every double round-trips through 17 significant digits.
            var buffer: [dtoa.max_length]u8 = undefined;
            try self.text(dtoa.dtoa(&buffer, d));
        }
    }

    /// UTF-8 bytes, such as a string in the ABC, as a JavaScript string
    /// literal of the string avmplus reads from them (output.ts tells how:
    /// ASCII alone, escaped, the rest as \u escapes, read leniently).
    pub fn string(self: *Output, bytes: []const u8) Allocator.Error!void {
        try self.reserve(@intCast(bytes.len + 2));
        try self.byte('"');
        try self.chars(bytes);
        try self.byte('"');
    }

    /// What string() writes between the quotes, for a literal made of several strings.
    pub fn chars(self: *Output, bytes: []const u8) Allocator.Error!void {
        try self.reserve(@intCast(bytes.len));

        // Most names fit in one write. After the first escape, use the
        // ordinary loop so escape-heavy strings only classify each byte once.
        var i: usize = 0;
        while (i < bytes.len) : (i += 1) {
            const b = bytes[i];
            if (b < ' ' or b >= 0x7f or b == '"' or b == '\\') {
                break;
            }
        }

        if (i > 0) {
            try self.text(bytes[0..i]);
        }

        while (i < bytes.len) {
            const b = bytes[i];
            if (b < 0x80) {
                if (b == '"' or b == '\\') {
                    try self.byte('\\');
                    try self.byte(b);
                } else if (b < 0x20 or b == 0x7f) {
                    try self.text("\\x");
                    try self.hex(b);
                } else {
                    try self.byte(b);
                }

                i += 1;
                continue;
            }

            const n = wellFormed(bytes[i..]);
            if (n == 0) {
                i += try self.lenient(bytes[i..]);
            } else {
                try self.point(codePoint(bytes[i..], n));
                i += n;
            }
        }
    }

    /// What avmplus reads at the start of `p`, where the bytes are not
    /// well-formed UTF-8, as \u escapes: a sequence by its shape alone, a
    /// surrogate's or one past U+10FFFF among them, else the byte itself.
    /// How many bytes it took.
    pub fn lenient(self: *Output, p: []const u8) Allocator.Error!u32 {
        const c: u32 = p[0];
        const left = p.len;
        switch (c >> 4) {
            12, 13 => if (left >= 2 and follows(p[1])) {
                const ch = ((c & 0x1f) << 6) | (p[1] & 0x3f);
                if (ch >= 0x80) {
                    try self.unit(ch);
                    return 2;
                }
            },
            14 => if (left >= 3 and follows(p[1]) and follows(p[2])) {
                const ch = ((c & 0x0f) << 12) | (@as(u32, p[1] & 0x3f) << 6) | (p[2] & 0x3f);
                if (ch >= 0x800) {
                    try self.unit(ch);
                    return 3;
                }
            },
            15 => if (left >= 4 and follows(p[1]) and follows(p[2]) and follows(p[3])) {
                const ch = ((c & 0x07) << 18) | (@as(u32, p[1] & 0x3f) << 12) | (@as(u32, p[2] & 0x3f) << 6) | (p[3] & 0x3f);
                if (ch >= 0x10000) {
                    try self.point(ch);
                    return 4;
                }
            },
            else => {},
        }

        try self.unit(c);
        return 1;
    }

    /// A code point as \u escapes, two surrogates' past U+FFFF.
    pub fn point(self: *Output, c: u32) Allocator.Error!void {
        if (c > 0xffff) {
            try self.unit((((c - 0x10000) >> 10) & 0x3ff) + 0xd800);
            try self.unit(((c - 0x10000) & 0x3ff) + 0xdc00);
        } else {
            try self.unit(c);
        }
    }

    /// A UTF-16 code unit as a \u escape: its low 16 bits, as AssemblyScript's two hex bytes.
    pub fn unit(self: *Output, u: u32) Allocator.Error!void {
        try self.text("\\u");
        try self.hex(@truncate(u >> 8));
        try self.hex(@truncate(u));
    }

    pub fn hex(self: *Output, b: u8) Allocator.Error!void {
        const digits = "0123456789abcdef";
        try self.byte(digits[b >> 4]);
        try self.byte(digits[b & 15]);
    }
};

test "text appends across growth and accepts an empty write to a full buffer" {
    var out: Output = .{ .allocating = try .initCapacity(std.testing.allocator, 3) };
    defer out.deinit();

    try out.text("abc");
    try out.text("");
    try out.text("defg");
    try std.testing.expectEqualStrings("abcdefg", out.written());
}

test "failed text growth leaves the prefix and remaining space usable" {
    var storage: [4]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    var out: Output = .{ .allocating = try .initCapacity(fixed.allocator(), storage.len) };
    defer out.deinit();

    try out.text("ab");
    try std.testing.expectError(error.OutOfMemory, out.text("cde"));
    try std.testing.expectEqualStrings("ab", out.written());
    try out.text("cd");
    try std.testing.expectEqualStrings("abcd", out.written());
}

test "the AVM2 emitters' methods write as AssemblyScript's Output does" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();

    var out: Output = try .init(arena.allocator());
    try out.text("x=");
    try out.int(-1234567890123);
    try out.byte(' ');
    try out.uint(0);
    try out.byte(' ');
    try out.double(0.1);
    try out.byte(' ');
    try out.double(-0.0);
    try out.byte(' ');
    try out.double(1e21);
    try out.byte(' ');
    try out.string("a\"\\\n\xc3\xa9\xed\xa0\x80\xf0\x9f\x98\x80\xff");
    try std.testing.expectEqualStrings("x=-1234567890123 0 0.1 -0 1e+21 \"a\\\"\\\\\\x0a\\u00e9\\ud800\\ud83d\\ude00\\u00ff\"", out.written());

    out.reset();
    try out.chars("");
    try out.chars(" !#[]~");
    try out.chars("plain\x7fend");
    try out.chars("\"tail");
    // The plain prefix ending at once at a byte past ASCII, and at a control character.
    try out.chars("ab\xc3\xa9");
    try out.chars("cd\x01e");
    try std.testing.expectEqualStrings(" !#[]~plain\\x7fend\\\"tailab\\u00e9cd\\x01e", out.written());
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
    try out.double(-0.0);
    try out.double(-12);
    try out.byte(' ');
    try out.double(0.5);
    try out.byte(' ');
    try out.int(std.math.minInt(i32));
    try out.byte(' ');
    try out.unit(0xe9);
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

/// A double as AssemblyScript's f64.toString writes it, as a template string does.
pub fn writeF64(w: *std.Io.Writer, d: f64) std.Io.Writer.Error!void {
    if (d == 0) {
        return w.writeAll("0.0");
    }

    if (std.math.isNan(d)) {
        return w.writeAll("NaN");
    }

    if (std.math.isInf(d)) {
        return w.writeAll(if (d < 0) "-Infinity" else "Infinity");
    }

    var buffer: [dtoa.max_length]u8 = undefined;
    try w.writeAll(dtoa.dtoa(&buffer, d));
}

/// The UTF-16 units String.UTF8.decodeUnsafe makes of `bytes`, written as
/// WTF-8: valid UTF-8 for valid UTF-8, a lone surrogate as its three bytes,
/// which the wrapper's fromUtf8 reads back to the same units.
pub fn writeDecoded(w: *std.Io.Writer, bytes: []const u8) std.Io.Writer.Error!void {
    var pending: ?u32 = null;
    var at: usize = 0;
    var units: [2]u32 = undefined;
    while (nextUnits(bytes, &at, &units)) |n| {
        for (units[0..n]) |unit| {
            pending = try writePending(w, pending, unit);
        }
    }

    if (pending) |high| {
        try writeCodePoint(w, high);
    }
}

/// `bytes` decoded as AssemblyScript's String.UTF8.decodeUnsafe decodes
/// them, its UTF-16 units: for comparing strings as it does.
pub fn decodeUnits(gpa: Allocator, bytes: []const u8) Allocator.Error![]u16 {
    var out: std.ArrayList(u16) = .empty;
    var at: usize = 0;
    var units: [2]u32 = undefined;
    while (nextUnits(bytes, &at, &units)) |n| {
        for (units[0..n]) |unit| {
            try out.append(gpa, @truncate(unit));
        }
    }

    return out.items;
}

/// The units of the sequence at `at`, as decodeUnsafe reads it, and how
/// many; null at the end, or where the last sequence is cut short.
fn nextUnits(bytes: []const u8, at: *usize, units: *[2]u32) ?usize {
    if (at.* >= bytes.len) {
        return null;
    }

    var lead: u32 = bytes[at.*];
    at.* += 1;
    if (lead & 128 == 0) {
        units[0] = lead;
        return 1;
    }

    if (at.* == bytes.len) {
        return null;
    }

    const second: u32 = bytes[at.*] & 63;
    at.* += 1;
    if (lead & 224 == 192) {
        units[0] = ((lead & 31) << 6) | second;
        return 1;
    }

    if (at.* == bytes.len) {
        return null;
    }

    const third: u32 = bytes[at.*] & 63;
    at.* += 1;
    if (lead & 240 == 224) {
        lead = ((lead & 15) << 12) | (second << 6) | third;
    } else {
        if (at.* == bytes.len) {
            return null;
        }

        lead = ((lead & 7) << 18) | (second << 12) | (third << 6) | (bytes[at.*] & 63);
        at.* += 1;
    }

    if (lead < 0x10000) {
        units[0] = lead;
        return 1;
    }

    units.* = .{ ((lead - 0x10000) >> 10) | 0xd800, ((lead - 0x10000) & 0x3ff) | 0xdc00 };
    return 2;
}

/// Unit `unit` after a high surrogate `pending`, if one waits for its low
/// one: a pair as one code point, anything else alone. The high surrogate
/// that now waits, if one does.
fn writePending(w: *std.Io.Writer, pending: ?u32, unit: u32) std.Io.Writer.Error!?u32 {
    if (pending) |high| {
        if (unit >= 0xdc00 and unit <= 0xdfff) {
            try writeCodePoint(w, 0x10000 + ((high - 0xd800) << 10) + (unit - 0xdc00));
            return null;
        }

        try writeCodePoint(w, high);
    }

    if (unit >= 0xd800 and unit <= 0xdbff) {
        return unit;
    }

    try writeCodePoint(w, unit);
    return null;
}

fn writeCodePoint(w: *std.Io.Writer, c: u32) std.Io.Writer.Error!void {
    var buffer: [4]u8 = undefined;
    const n: usize = switch (c) {
        0...0x7f => blk: {
            buffer[0] = @intCast(c);
            break :blk 1;
        },
        0x80...0x7ff => blk: {
            buffer[0] = @intCast(0xc0 | (c >> 6));
            buffer[1] = @intCast(0x80 | (c & 63));
            break :blk 2;
        },
        0x800...0xffff => blk: {
            buffer[0] = @intCast(0xe0 | (c >> 12));
            buffer[1] = @intCast(0x80 | ((c >> 6) & 63));
            buffer[2] = @intCast(0x80 | (c & 63));
            break :blk 3;
        },
        else => blk: {
            buffer[0] = @intCast(0xf0 | (c >> 18));
            buffer[1] = @intCast(0x80 | ((c >> 12) & 63));
            buffer[2] = @intCast(0x80 | ((c >> 6) & 63));
            buffer[3] = @intCast(0x80 | (c & 63));
            break :blk 4;
        },
    };
    try w.writeAll(buffer[0..n]);
}

fn expectDecoded(bytes: []const u8, wtf8: []const u8) !void {
    var buffer: [64]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buffer);
    try writeDecoded(&w, bytes);
    try std.testing.expectEqualSlices(u8, wtf8, w.buffered());
}

test "strings are AssemblyScript's decoding of their bytes, as WTF-8" {
    try expectDecoded("a\xc3\xa9", "a\xc3\xa9");
    // Cut short at the end: dropped.
    try expectDecoded("a\xc3", "a");
    try expectDecoded("a\xe2\x82", "a");
    // Overlong: read for its bits.
    try expectDecoded("\xc0\xaf", "/");
    // Surrogates' three bytes, alone or as a pair.
    try expectDecoded("\xed\xa0\x80", "\xed\xa0\x80");
    try expectDecoded("\xed\xa0\x80\xed\xb0\x80", "\xf0\x90\x80\x80");
    // A stray continuation byte begins a sequence of four.
    try expectDecoded("\x80\x41\x41\x41b", "\xe1\x81\x81b");
}
