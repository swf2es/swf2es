//! lyon's fill tessellator, from swf2es/tessellate's static library (tessellate/), for the fills
//! crossings.zig finds too dense for libtess2. The library allocates through arena.zig's malloc
//! and realloc, so its output lives until the next reset; it fills in twips itself.
const std = @import("std");
const c = @import("c");
const arena = @import("arena.zig");

extern fn lyon_fill(
    coords: [*]const f64,
    count: usize,
    ends: [*]const u32,
    contours: usize,
    nonzero: i32,
    positions: *[*]const f32,
    vertices: *usize,
    indices: *[*]const u32,
    index_count: *usize,
) i32;

/// lyon_fill's status for input it refused, such as coordinates past its range.
pub const refused = -2;

pub const Output = struct {
    positions: []const f64,
    indices: []const c.TESSindex,
};

/// lyon's fill of the contours, its positions widened to f64 in the arena; or its status where
/// it failed, -1 for output unfit to draw (an index past the vertices or past TESSindex) or where
/// the arena has no room for the widened positions.
pub fn fill(coords: []const f64, ends: []const u32, nonzero: bool) union(enum) { output: Output, status: i32 } {
    var positions: [*]const f32 = undefined;
    var vertices: usize = 0;
    var indices: [*]const u32 = undefined;
    var index_count: usize = 0;
    const status = lyon_fill(coords.ptr, coords.len / 2, ends.ptr, ends.len, @intFromBool(nonzero), &positions, &vertices, &indices, &index_count);
    if (status != 0) {
        return .{ .status = status };
    }

    if (vertices > std.math.maxInt(c.TESSindex) or index_count % 3 != 0) {
        return .{ .status = -1 };
    }

    for (indices[0..index_count]) |index| {
        if (index >= vertices) {
            return .{ .status = -1 };
        }
    }

    const wide = arena.allocator.alloc(f64, vertices * 2) catch return .{ .status = -1 };
    for (wide, positions[0 .. vertices * 2]) |*to, from| {
        if (!std.math.isFinite(from)) {
            return .{ .status = -1 };
        }

        to.* = from;
    }

    return .{
        .output = .{
            .positions = wide,
            // In range of TESSindex, checked above.
            .indices = @as([*]const c.TESSindex, @ptrCast(indices))[0..index_count],
        },
    };
}
