// Units, and where a unit's home may reach (assembly/avm1/emit/units.ts):
// to the next bound of the action blocks past its offset, so that a
// block's own code, or the bytes between blocks, are compiled apart; within
// a window, as bitmaps' bytes between blocks may be long; and not past the
// end of its region.
const std = @import("std");

/// A block of actions: `length` bytes from `offset` in the SWF's bytes.
pub const BlockRange = struct {
    offset: i32,
    length: i32,
};

/// Where control goes on in a unit, as V.far is called: an offset in the
/// SWF, where its region ends, where its actions' bytes end, and whether
/// it runs as a SWF 5's function.
pub const UnitKey = struct {
    at: i32,
    end: i32,
    bound: i32,
    five: bool,
};

/// How far after its offset a unit's home reaches at most.
pub const unit_window: i32 = 1 << 15;

/// The first bound of a block past `at` in a SWF of `size` bytes, a block's
/// start or its end, else the SWF's end: where V.far's first choice of unit
/// for control at `at` ends its region and its bytes (module.zig).
pub fn segmentEnd(blocks: []const BlockRange, size: i32, at: i32) i32 {
    var high = size;
    for (blocks) |block| {
        if (block.offset < 0 or block.length < 0 or @as(i64, block.offset) + block.length > size) {
            continue;
        }

        if (block.offset > at) {
            high = @min(high, block.offset);
        }

        const stop = block.offset + block.length;
        if (stop > at) {
            high = @min(high, stop);
        }
    }

    return high;
}

/// How far the home of the unit at `at`, of a region that ends at `end`, may reach.
pub fn unitHigh(blocks: []const BlockRange, size: i32, at: i32, end: i32) i32 {
    return @min(segmentEnd(blocks, size, at), end, at +% unit_window);
}

test "a unit's home ends at the next bound of a block" {
    const blocks = [_]BlockRange{ .{ .offset = 10, .length = 50 }, .{ .offset = 100, .length = 20 } };
    try std.testing.expectEqual(60, segmentEnd(&blocks, 1000, 20));
    try std.testing.expectEqual(100, segmentEnd(&blocks, 1000, 60));
    try std.testing.expectEqual(1000, segmentEnd(&blocks, 1000, 120));
    try std.testing.expectEqual(80, unitHigh(&blocks, 1000, 60, 80));
}
