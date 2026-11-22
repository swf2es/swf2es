// Reads the primitive types of the ABC format (AVM2 overview, chapter 4.1),
// as assembly/avm2/abc/reader.ts does.
//
// The input must be followed by PADDING readable bytes, as avmplus pads its
// buffer, so a variable-length read checks the bounds once before and once
// after instead of at every byte. Errors are sticky: a read past the end
// sets `failed`, parks at the end and returns 0. Parsers check `failed` at
// section ends.
const std = @import("std");

pub const PADDING: u32 = 16;

pub const Reader = struct {
    /// The ABC and PADDING bytes after it; positions are offsets into it.
    data: []const u8,
    pos: usize,
    end: usize,
    failed: bool = false,

    /// A reader of `data` from `pos` to `end`; `data` must hold PADDING
    /// bytes past `end`, which its callers guarantee by copying the ABC so
    /// (a bug otherwise, which panics here).
    pub fn init(data: []const u8, pos: usize, end: usize) Reader {
        std.debug.assert(end + PADDING <= data.len);
        return .{ .data = data, .pos = pos, .end = end };
    }

    pub inline fn u8_(self: *Reader) u32 {
        const p = self.pos;
        if (p >= self.end) {
            return self.fail();
        }

        self.pos = p + 1;
        return self.data[p];
    }

    pub inline fn u16_(self: *Reader) u32 {
        const p = self.pos;
        if (p + 2 > self.end) {
            return self.fail();
        }

        self.pos = p + 2;
        return std.mem.readInt(u16, self.data[p..][0..2], .little);
    }

    pub inline fn s24(self: *Reader) i32 {
        const p = self.pos;
        if (p + 3 > self.end) {
            return @bitCast(self.fail());
        }

        self.pos = p + 3;
        const low: i32 = std.mem.readInt(u16, self.data[p..][0..2], .little);
        const high: i32 = @as(i8, @bitCast(self.data[p + 2]));
        return low | (high << 16);
    }

    /// 1 to 5 bytes, 7 bits each, low bits first; as avmplus, bits past 32 drop off.
    pub fn u32_(self: *Reader) u32 {
        const p = self.pos;
        if (p >= self.end) {
            return self.fail();
        }

        const d = self.data;
        var result: u32 = d[p];
        var length: usize = 1;
        if (result & 0x80 != 0) {
            result = (result & 0x7f) | (@as(u32, d[p + 1]) << 7);
            length = 2;
            if (result & 0x4000 != 0) {
                result = (result & 0x3fff) | (@as(u32, d[p + 2]) << 14);
                length = 3;
                if (result & 0x200000 != 0) {
                    result = (result & 0x1fffff) | (@as(u32, d[p + 3]) << 21);
                    length = 4;
                    if (result & 0x10000000 != 0) {
                        // A byte shifted left by 28 keeps its low 4 bits, as in C.
                        result = (result & 0xfffffff) | (@as(u32, d[p + 4]) << 28);
                        length = 5;
                    }
                }
            }
        }

        if (p + length > self.end) {
            return self.fail();
        }

        self.pos = p + length;
        return result;
    }

    /// A u32 whose top two bits must be clear; avmplus rejects the ABC otherwise.
    pub inline fn u30_(self: *Reader) u32 {
        const value = self.u32_();
        if (value & 0xc0000000 != 0) {
            return self.fail();
        }

        return value;
    }

    /// The u32 bit pattern, not sign-extended: negative values take 5 bytes.
    pub inline fn s32(self: *Reader) i32 {
        return @bitCast(self.u32_());
    }

    pub inline fn f32_(self: *Reader) f32 {
        const p = self.pos;
        if (p + 4 > self.end) {
            _ = self.fail();
            return 0;
        }

        self.pos = p + 4;
        return @bitCast(std.mem.readInt(u32, self.data[p..][0..4], .little));
    }

    pub inline fn d64(self: *Reader) f64 {
        const p = self.pos;
        if (p + 8 > self.end) {
            _ = self.fail();
            return 0;
        }

        self.pos = p + 8;
        return @bitCast(std.mem.readInt(u64, self.data[p..][0..8], .little));
    }

    /// Byte length of a string_info; its UTF-8 bytes follow at `pos`.
    pub inline fn utf8Length(self: *Reader) u32 {
        const length = self.u30_();
        if (@as(u64, self.pos) + length > self.end) {
            return self.fail();
        }

        return length;
    }

    pub inline fn skip(self: *Reader, length: u32) void {
        if (@as(u64, self.pos) + length > self.end) {
            _ = self.fail();
        } else {
            self.pos += length;
        }
    }

    fn fail(self: *Reader) u32 {
        @branchHint(.cold);
        self.failed = true;
        self.pos = self.end;
        return 0;
    }
};

fn padded(comptime bytes: []const u8) [bytes.len + PADDING]u8 {
    var out: [bytes.len + PADDING]u8 = @splat(0);
    @memcpy(out[0..bytes.len], bytes);
    return out;
}

test "variable-length integers read as avmplus reads them" {
    const data = padded(&.{ 0x7f, 0x80, 0x01, 0xff, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0xff, 0xff });
    var r: Reader = .init(&data, 0, data.len - PADDING);
    try std.testing.expectEqual(0x7f, r.u32_());
    try std.testing.expectEqual(0x80, r.u32_());
    try std.testing.expectEqual(0xffffffff, r.u32_());
    // Bits past 32 drop off.
    try std.testing.expectEqual(0xffffffff, r.u32_());
    try std.testing.expect(!r.failed);
}

test "a read past the end fails, parks at the end and returns 0" {
    const data = padded(&.{ 1, 2, 0x80 });
    var r: Reader = .init(&data, 0, 3);
    try std.testing.expectEqual(0x0201, r.u16_());
    try std.testing.expectEqual(0, r.u32_());
    try std.testing.expect(r.failed);
    try std.testing.expectEqual(3, r.pos);
    try std.testing.expectEqual(0, r.u8_());
}

test "s24 sign-extends its high byte, u30 rejects the top two bits" {
    const data = padded(&.{ 0xfe, 0xff, 0xff, 0x80, 0x80, 0x80, 0x80, 0x04 });
    var r: Reader = .init(&data, 0, 8);
    try std.testing.expectEqual(-2, r.s24());
    try std.testing.expectEqual(0, r.u30_());
    try std.testing.expect(r.failed);
}
