// A value per offset (assembly/avm1/actions/offsets.ts): dense over the
// code a compile mostly reaches, the block's own bytes; other SWF bytes,
// before or past them, cost space only when reached.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Offsets = struct {
    local: []i32 = &.{},
    dense: i32 = 0,
    outside: std.AutoHashMapUnmanaged(i32, i32) = .empty,

    pub fn deinit(self: *Offsets, gpa: Allocator) void {
        gpa.free(self.local);
        self.outside.deinit(gpa);
    }

    /// Every offset 0 again, those from 0 to `length` dense.
    pub fn reset(self: *Offsets, gpa: Allocator, length: i32) Allocator.Error!void {
        const n: usize = @intCast(length);
        if (n > self.local.len) {
            const local = try gpa.alloc(i32, @max(n, self.local.len * 2));
            gpa.free(self.local);
            self.local = local;
            @memset(self.local, 0);
        } else {
            @memset(self.local[0..n], 0);
        }

        self.dense = length;
        // Missing reads as 0, as the AS version's entries set back to 0 do.
        self.outside.clearRetainingCapacity();
    }

    pub inline fn get(self: *const Offsets, offset: i32) i32 {
        if (@as(u32, @bitCast(offset)) < @as(u32, @bitCast(self.dense))) {
            return self.local[@as(u32, @bitCast(offset))];
        }

        return self.outside.get(offset) orelse 0;
    }

    pub inline fn set(self: *Offsets, gpa: Allocator, offset: i32, value: i32) Allocator.Error!void {
        if (@as(u32, @bitCast(offset)) < @as(u32, @bitCast(self.dense))) {
            self.local[@as(u32, @bitCast(offset))] = value;
            return;
        }

        try self.outside.put(gpa, offset, value);
    }
};

test "offsets outside the dense range" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const gpa = arena.allocator();

    var offsets: Offsets = .{};
    try offsets.reset(gpa, 4);
    try offsets.set(gpa, 2, 7);
    try offsets.set(gpa, -3, 9);
    try offsets.set(gpa, 100, 1);
    try std.testing.expectEqual(7, offsets.get(2));
    try std.testing.expectEqual(9, offsets.get(-3));
    try std.testing.expectEqual(0, offsets.get(99));
    try offsets.reset(gpa, 8);
    try std.testing.expectEqual(0, offsets.get(2));
    try std.testing.expectEqual(0, offsets.get(-3));
}
