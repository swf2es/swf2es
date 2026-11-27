// AS QUIRK, KEPT AS IS: AssemblyScript's i32.parse (strtol<i32> of
// std/assembly/util/string.ts, Apache-2.0, Copyright the AssemblyScript
// authors), which AVM1's block lists and AVM2's body lists and replayed
// logs are read with. It reads the string's UTF-16 units, which the host
// gave as WTF-8 (packages/codegen/src/zig.ts): whitespace is
// AssemblyScript's set (isSpace), then a sign, a radix prefix, and digits
// up to the first that is not one, wrapping as i32 arithmetic does.
// Units.unit() gives 0 past the string's end, where AssemblyScript read
// whatever memory followed; parseI32 asks there only as a string of
// whitespace ends, and 0 is no space, sign or digit.
const std = @import("std");

/// The UTF-16 units of WTF-8 bytes, one at a time.
const Units = struct {
    bytes: []const u8,
    /// Where the current unit's sequence starts, and whether the current
    /// unit is the low surrogate of the pair it encodes.
    at: usize = 0,
    low: bool = false,

    /// The sequence at `at`: its code point and its length.
    fn sequence(self: Units) struct { u32, usize } {
        const s = self.bytes[self.at..];
        const b: u32 = s[0];
        const n: usize = if (b < 0x80) 1 else if (b < 0xe0) 2 else if (b < 0xf0) 3 else 4;
        if (n > s.len) {
            return .{ 0, s.len };
        }

        var c: u32 = if (n == 1) b else b & (@as(u32, 0x7f) >> @intCast(n));
        for (s[1..n]) |more| {
            c = (c << 6) | (more & 0x3f);
        }

        return .{ c, n };
    }

    /// The current unit, 0 past the end.
    fn unit(self: Units) u32 {
        if (self.at >= self.bytes.len) {
            return 0;
        }

        const c, _ = self.sequence();
        if (c < 0x10000) {
            return c;
        }

        return if (self.low) ((c - 0x10000) & 0x3ff) | 0xdc00 else ((c - 0x10000) >> 10) | 0xd800;
    }

    fn advance(self: *Units) void {
        if (self.at >= self.bytes.len) {
            return;
        }

        const c, const n = self.sequence();
        if (c >= 0x10000 and !self.low) {
            self.low = true;
            return;
        }

        self.low = false;
        self.at += n;
    }

    fn count(bytes: []const u8) i64 {
        var units: Units = .{ .bytes = bytes };
        var n: i64 = 0;
        while (units.at < bytes.len) : (units.advance()) {
            n += 1;
        }

        return n;
    }
};

/// AssemblyScript's isSpace: the whitespace JavaScript's trim takes.
fn isSpace(c: u32) bool {
    if (c < 0x1680) {
        return (c | 0x80) == 0xa0 or c -% 0x09 <= 0x0d - 0x09;
    }

    if (c -% 0x2000 <= 0x200a - 0x2000) {
        return true;
    }

    return switch (c) {
        0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        else => false,
    };
}

pub fn parseI32(s: []const u8) i32 {
    var len = Units.count(s);
    if (len == 0) {
        return 0;
    }

    var units: Units = .{ .bytes = s };
    var code = units.unit();
    while (isSpace(code)) {
        units.advance();
        code = units.unit();
        len -= 1;
    }

    var sign: i32 = 1;
    if (code == '-' or code == '+') {
        len -= 1;
        if (len == 0) {
            return 0;
        }

        if (code == '-') {
            sign = -1;
        }

        units.advance();
        code = units.unit();
    }

    var radix: u32 = 10;
    if (code == '0' and len > 2) {
        var next = units;
        next.advance();
        const prefix: ?u32 = switch (next.unit() | 32) {
            'b' => 2,
            'o' => 8,
            'x' => 16,
            else => null,
        };
        if (prefix) |r| {
            radix = r;
            units.advance();
            units.advance();
            len -= 2;
        }
    }

    var num: i32 = 0;
    const initial = len - 1;
    while (len != 0) {
        len -= 1;
        code = units.unit();
        if (code -% '0' < 10) {
            code -= '0';
        } else if (code -% 'A' <= 'Z' - 'A') {
            code -= 'A' - 10;
        } else if (code -% 'a' <= 'z' - 'a') {
            code -= 'a' - 10;
        }

        if (code >= radix) {
            if (initial == len) {
                return 0;
            }

            break;
        }

        num = num *% @as(i32, @intCast(radix)) +% @as(i32, @intCast(code));
        units.advance();
    }

    return sign *% num;
}

test "integers parse as AssemblyScript's i32.parse reads them" {
    try std.testing.expectEqual(12, parseI32("12"));
    try std.testing.expectEqual(-3, parseI32("-3"));
    try std.testing.expectEqual(0, parseI32("x"));
    try std.testing.expectEqual(7, parseI32("7x"));
    try std.testing.expectEqual(255, parseI32("0xff"));
    try std.testing.expectEqual(5, parseI32("0b101"));
    try std.testing.expectEqual(0, parseI32("4294967296"));
    try std.testing.expectEqual(0, parseI32("-"));
    try std.testing.expectEqual(0, parseI32("0x"));
    // AssemblyScript's whitespace: a no-break space, an ideographic space, a BOM, a line separator.
    try std.testing.expectEqual(1, parseI32("\xc2\xa01"));
    try std.testing.expectEqual(1, parseI32("\xe3\x80\x801"));
    try std.testing.expectEqual(1, parseI32("\xef\xbb\xbf1"));
    try std.testing.expectEqual(1, parseI32("\xe2\x80\xa81"));
    // Not whitespace: U+0085, and a surrogate pair's units.
    try std.testing.expectEqual(0, parseI32("\xc2\x851"));
    try std.testing.expectEqual(0, parseI32("\xf0\x9f\x98\x801"));
    // Trailing whitespace reads 0 past the end.
    try std.testing.expectEqual(0, parseI32(" "));
}
