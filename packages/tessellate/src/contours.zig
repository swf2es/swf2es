// Directed fill edges joined in their original first-unused-edge order.
const std = @import("std");

pub const Edge = extern struct { x0: f64, y0: f64, cx: f64, cy: f64, x1: f64, y1: f64 };
const Point = struct { x: i64, y: i64 };

pub const Result = struct { commands: []f64, offsets: []u32 };

fn integer(x: f64) bool {
    return std.math.isFinite(x) and @trunc(x) == x and @abs(x) <= 9007199254740991;
}

fn point(x: f64, y: f64) Point {
    return .{ .x = @intFromFloat(x), .y = @intFromFloat(y) };
}

pub fn join(edges: []const Edge, allocator: std.mem.Allocator) !Result {
    for (edges) |e| {
        if (!integer(e.x0) or !integer(e.y0) or !integer(e.x1) or !integer(e.y1)) return error.Coordinate;
    }

    var from: std.AutoHashMapUnmanaged(Point, u32) = .empty;
    try from.ensureTotalCapacity(allocator, @intCast(edges.len));
    const next = try allocator.alloc(u32, edges.len);
    const used = try allocator.alloc(u8, edges.len);
    const commands = try allocator.alloc(f64, edges.len * 8);
    const offsets = try allocator.alloc(u32, edges.len + 1);
    @memset(used, 0);

    var reverse = edges.len;
    while (reverse > 0) {
        reverse -= 1;
        const e = edges[reverse];
        const previous = from.fetchPutAssumeCapacity(point(e.x0, e.y0), @intCast(reverse + 1));
        next[reverse] = if (previous) |kv| kv.value else 0;
    }

    var length: usize = 0;
    var paths: usize = 0;
    for (edges, 0..) |start, first| {
        if (used[first] != 0) continue;
        offsets[paths] = @intCast(length);
        paths += 1;
        commands[length..][0..3].* = .{ 1, start.x0 / 20, start.y0 / 20 };
        length += 3;

        var i = first;
        while (true) {
            used[i] = 1;
            const e = edges[i];
            if (std.math.isNan(e.cx)) {
                commands[length] = 2;
                length += 1;
            } else {
                commands[length..][0..3].* = .{ 3, e.cx / 20, e.cy / 20 };
                length += 3;
            }
            commands[length..][0..2].* = .{ e.x1 / 20, e.y1 / 20 };
            length += 2;
            if (e.x1 == start.x0 and e.y1 == start.y0) break;

            const head = from.getPtr(point(e.x1, e.y1)) orelse break;
            var candidate = head.*;
            while (candidate != 0 and used[candidate - 1] != 0) candidate = next[candidate - 1];
            if (candidate == 0) {
                head.* = 0;
                break;
            }

            head.* = next[candidate - 1];
            i = candidate - 1;
        }
    }

    offsets[paths] = @intCast(length);
    return .{ .commands = commands[0..length], .offsets = offsets[0 .. paths + 1] };
}
