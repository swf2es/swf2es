// An AVM1 string as a JavaScript string literal of what adl reads from its
// bytes (assembly/avm1/emit/strings.ts): up to SWF 5 a character a byte,
// from SWF 6 UTF-8 read leniently, as Unicode's old ConvertUTF.c reads it;
// every character past ASCII escaped, to keep the module ASCII.
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../../output.zig");
const Output = output.Output;

/// What ConvertUTF.c subtracts from the sum of a sequence of 1 to 6 bytes.
const offsets = [_]u32{ 0, 0x3080, 0xe2080, 0x3c82080, 0xfa082080, 0x82082080 };

/// The string `s`, read as UTF-8 if `utf8`, else a character a byte.
pub fn writeString(out: *Output, s: []const u8, utf8: bool) Allocator.Error!void {
    try out.byte('"');
    var i: usize = 0;
    while (i < s.len) {
        const b = s[i];
        if (b < 0x80) {
            switch (b) {
                '"', '\\' => {
                    try out.byte('\\');
                    try out.byte(b);
                },
                0...0x1f, 0x7f => {
                    try out.text("\\x");
                    try out.hex(b);
                },
                else => try out.byte(b),
            }

            i += 1;
            continue;
        }

        if (!utf8) {
            try out.unit(b);
            i += 1;
            continue;
        }

        // Well-formed UTF-8 reads as adl reads it; escaped, as every character
        // past ASCII is, to keep the module ASCII.
        const n = output.wellFormed(s[i..]);
        if (n != 0) {
            try out.point(output.codePoint(s[i..], n));
            i += n;
            continue;
        }

        const more: usize = switch (b) {
            0...0x7f => unreachable,
            0x80...0xbf => 0,
            0xc0...0xdf => 1,
            0xe0...0xef => 2,
            0xf0...0xf7 => 3,
            0xf8...0xfb => 4,
            0xfc...0xff => 5,
        };
        if (more >= s.len - i) {
            break;
        }

        var c: u32 = 0;
        for (s[i..][0 .. more + 1]) |byte| {
            c = (c << 6) +% byte;
        }

        c -%= offsets[more];
        i += more + 1;
        // Escaped, since what it reads as may be a quote or a line's end.
        switch (c) {
            0 => break,
            0xd800...0xdfff, 0x110000...std.math.maxInt(u32) => try out.unit(0xfffd),
            else => try out.point(c),
        }
    }

    try out.byte('"');
}

fn expectString(bytes: []const u8, utf8: bool, js: []const u8) !void {
    var out: Output = try .init(std.testing.allocator);
    defer out.deinit();
    try writeString(&out, bytes, utf8);
    try std.testing.expectEqualStrings(js, out.written());
}

test "strings read as adl reads them" {
    try expectString("a\"b\\c\n", true, "\"a\\\"b\\\\c\\x0a\"");
    try expectString("\xe9", false, "\"\\u00e9\"");
    try expectString("\xc3\xa9", true, "\"\\u00e9\"");
    try expectString("\xf0\x9f\x98\x80", true, "\"\\ud83d\\ude00\"");
    try expectString("\xe2\x80\xa8", true, "\"\\u2028\"");
    // A lone continuation byte is its own character; a lead the end cuts short ends the string.
    try expectString("\x80x\xe0", true, "\"\\u0080x\"");
    // An overlong NUL ends the string; a surrogate's code point is U+FFFD.
    try expectString("a\xc0\x80b", true, "\"a\"");
    try expectString("\xed\xa0\x80", true, "\"\\ufffd\"");
    try expectString("\xf0\x9f\x98", true, "\"\"");
}
