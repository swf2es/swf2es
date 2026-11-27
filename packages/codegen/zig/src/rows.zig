// Rows: a table whose rows never move, grown in memory.zig's arenas, which
// a domain's tables are made of; and the tests that hold a domain's
// entries to rolling back wherever memory runs out.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("memory.zig");
const chunk_size = memory.chunk_size;
const Arena = memory.Arena;
const Pages = memory.Pages;
const TestPages = memory.TestPages;
const atEveryMemorySize = memory.atEveryMemorySize;
const testing = std.testing;

/// A table whose rows never move: shelves that double from a few rows up
/// to a chunk's worth of rows, then shelves of that many each (a run of
/// two chunks, with its arena run's header, where a shelf is the only
/// thing in its run). Grown in a bump arena,
/// it leaves no old copy behind but its directory of shelves, a pointer a
/// shelf; a link that fails rolls it back with `restore`, after its arena.
pub fn Rows(comptime T: type) type {
    return struct {
        const Self = @This();

        /// Rows a full shelf holds: a chunk's worth of bytes, rounded down to a power of two.
        const full: u32 = std.math.floorPowerOfTwo(u32, @max(1, chunk_size / @sizeOf(T)));
        const first: u32 = @min(full, 8);
        /// How many shelves double, and the rows they hold together.
        const doubling: u5 = std.math.log2_int(u32, full / first);
        const in_doubling: u32 = full - first;

        directory: [*][*]T = undefined,
        capacity: u32 = 0,
        shelves: u32 = 0,
        len: u32 = 0,

        pub const State = struct {
            directory: [*][*]T,
            capacity: u32,
            shelves: u32,
            len: u32,
        };

        fn shelfSize(shelf: u32) u32 {
            return if (shelf < doubling) first << @intCast(shelf) else full;
        }

        pub inline fn at(self: *const Self, index: u32) *T {
            std.debug.assert(index < self.len);
            if (index < in_doubling) {
                const shelf = std.math.log2_int(u32, index / first + 1);
                return &self.directory[shelf][index + first - (first << shelf)];
            }

            const past = index - in_doubling;
            return &self.directory[doubling + past / full][past % full];
        }

        pub inline fn get(self: *const Self, index: u32) T {
            return self.at(index).*;
        }

        pub inline fn set(self: *const Self, index: u32, row: T) void {
            self.at(index).* = row;
        }

        /// `row` at the end.
        pub fn push(self: *Self, gpa: Allocator, row: T) Allocator.Error!void {
            (try self.addOne(gpa)).* = row;
        }

        /// The rows from `count` on forgotten, their shelves kept: as
        /// AssemblyScript's `length = count`, never a longer table.
        pub fn truncate(self: *Self, count: u32) void {
            std.debug.assert(count <= self.len);
            self.len = count;
        }

        /// A new row at the end, undefined.
        pub fn addOne(self: *Self, gpa: Allocator) Allocator.Error!*T {
            const room = if (self.shelves <= doubling) first * ((@as(u32, 1) << @intCast(self.shelves)) - 1) else in_doubling + (self.shelves - doubling) * full;
            if (self.len == room) {
                if (self.shelves == self.capacity) {
                    // The old directory stays where it is: a state saved before still names it.
                    const capacity = @max(8, self.capacity * 2);
                    const directory = try gpa.alloc([*]T, capacity);
                    @memcpy(directory[0..self.shelves], self.directory[0..self.shelves]);
                    self.directory = directory.ptr;
                    self.capacity = capacity;
                }

                self.directory[self.shelves] = (try gpa.alloc(T, shelfSize(self.shelves))).ptr;
                self.shelves += 1;
            }

            self.len += 1;
            return self.at(self.len - 1);
        }

        pub fn addOneZeroed(self: *Self, gpa: Allocator) Allocator.Error!*T {
            const row = try self.addOne(gpa);
            @memset(std.mem.asBytes(row), 0);
            return row;
        }

        /// `row` at the end: its index.
        pub fn append(self: *Self, gpa: Allocator, row: T) Allocator.Error!u32 {
            (try self.addOne(gpa)).* = row;
            return self.len - 1;
        }

        /// `count` rows at the end that no row's id names, each a copy of
        /// the last (zero where there is none), as a table whose ids skip
        /// would leave: for the probe of what reads ids by their numbers
        /// (testing/measure.zig).
        pub fn skip(self: *Self, gpa: Allocator, count: u32) Allocator.Error!void {
            for (0..count) |_| {
                if (self.len == 0) {
                    _ = try self.addOneZeroed(gpa);
                } else {
                    const last = self.get(self.len - 1);
                    try self.push(gpa, last);
                }
            }
        }

        /// What the table's shelves and its directory take, and what the
        /// directories it outgrew still take in its arena.
        pub fn bytes(self: *const Self) u64 {
            var total: u64 = @as(u64, self.capacity) * @sizeOf([*]T);
            for (0..self.shelves) |shelf| {
                total += @as(u64, shelfSize(@intCast(shelf))) * @sizeOf(T);
            }

            return total;
        }

        pub fn outgrownBytes(self: *const Self) u64 {
            return if (self.capacity > 8) @as(u64, self.capacity - 8) * @sizeOf([*]T) else 0;
        }

        /// No rows, the shelves kept for the rows that come next.
        pub fn clearRetainingCapacity(self: *Self) void {
            self.len = 0;
        }

        /// The shelves and the directory given back, as an arena takes them:
        /// the directories it outgrew stay, for a state saved before.
        pub fn deinit(self: *Self, gpa: Allocator) void {
            for (0..self.shelves) |shelf| {
                gpa.free(self.directory[shelf][0..shelfSize(@intCast(shelf))]);
            }

            if (self.capacity > 0) {
                gpa.free(self.directory[0..self.capacity]);
            }

            self.* = .{};
        }

        pub fn save(self: *const Self) State {
            return .{ .directory = self.directory, .capacity = self.capacity, .shelves = self.shelves, .len = self.len };
        }

        pub fn restore(self: *Self, state: State) void {
            self.directory = state.directory;
            self.capacity = state.capacity;
            self.shelves = state.shelves;
            self.len = state.len;
        }
    };
}

test "rows never move as the table grows, and each lands where at() finds it" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    var arena: Arena = .init(t.pages.allocator());
    defer arena.deinit();

    inline for (.{ u8, u32, [3]u32, [5000]u8, [20000]u8 }) |T| {
        var rows: Rows(T) = .{};
        const first = try rows.addOne(arena.allocator());
        const count: u32 = if (@sizeOf(T) > 1000) 40 else 70_000;
        for (1..count) |_| {
            _ = try rows.addOne(arena.allocator());
        }

        try testing.expectEqual(first, rows.at(0));
        // Every row its own bytes: no two indices share one.
        if (@sizeOf(T) <= 12) {
            for (0..count) |i| {
                @memset(std.mem.asBytes(rows.at(@intCast(i))), @truncate(i));
            }

            for (0..count) |i| {
                try testing.expectEqual(@as(u8, @truncate(i)), std.mem.asBytes(rows.at(@intCast(i)))[0]);
            }
        }
    }
}

test "a skip adds copies of the last row, and bytes counts every shelf and the directory" {
    const t = try TestPages.init(4 << 20);
    defer t.deinit();
    var arena: Arena = .init(t.pages.allocator());
    defer arena.deinit();
    const gpa = arena.allocator();

    var rows: Rows(u32) = .{};
    try rows.skip(gpa, 2);
    try testing.expectEqual(@as(u32, 2), rows.len);
    try testing.expectEqual(@as(u32, 0), rows.get(1));
    try rows.push(gpa, 7);
    try rows.skip(gpa, 3);
    try testing.expectEqual(@as(u32, 6), rows.len);
    try testing.expectEqual(@as(u32, 7), rows.get(5));

    // Shelves of 8 and 16 rows, and a directory of 8.
    for (0..10) |_| {
        try rows.push(gpa, 1);
    }

    try testing.expectEqual(@as(u64, (8 + 16) * 4 + 8 * @sizeOf([*]u32)), rows.bytes());
    try testing.expectEqual(@as(u64, 0), rows.outgrownBytes());
}

/// Tables as a domain's will be: rows added to several by one entry, all
/// or none, and a scratch buffer grown in place meanwhile.
const TestDomain = struct {
    names: Rows(u32) = .{},
    pairs: Rows([2]u64) = .{},

    fn add(self: *TestDomain, arena: *Arena, count: u32, seed: u32) Allocator.Error!void {
        const saved = arena.mark();
        const names = self.names.save();
        const pairs = self.pairs.save();
        errdefer {
            arena.restore(saved);
            self.names.restore(names);
            self.pairs.restore(pairs);
        }

        const gpa = arena.allocator();
        var scratch: std.ArrayList(u8) = .empty;
        for (0..count) |i| {
            _ = try self.names.append(gpa, seed +% @as(u32, @intCast(i)));
            (try self.pairs.addOne(gpa)).* = .{ i, seed };
            try scratch.appendNTimes(gpa, @truncate(i), 1000);
        }
    }

    fn check(self: *const TestDomain, entries: []const [2]u32) !void {
        var row: u32 = 0;
        for (entries) |entry| {
            for (0..entry[0]) |i| {
                try testing.expectEqual(entry[1] +% @as(u32, @intCast(i)), self.names.at(row).*);
                try testing.expectEqual([2]u64{ i, entry[1] }, self.pairs.at(row).*);
                row += 1;
            }
        }

        try testing.expectEqual(row, self.names.len);
        try testing.expectEqual(row, self.pairs.len);
    }
};

const test_entries = [_][2]u32{ .{ 3, 10 }, .{ 900, 20 }, .{ 1, 30 }, .{ 5000, 40 }, .{ 40, 50 } };

/// Entries added one after another, as domainAdd adds ABCs: one that runs
/// out of memory leaves the domain, and its memory, as they were before it.
fn addEntries(source: Allocator, p: *Pages) !void {
    var arena: Arena = .init(source);
    defer arena.deinit();
    var domain: TestDomain = .{};
    for (test_entries, 0..) |entry, done| {
        const used = p.used;
        domain.add(&arena, entry[0], entry[1]) catch |err| {
            // Fewer where a run before the entry gave back what it did not use.
            try testing.expect(p.used <= used);
            try domain.check(test_entries[0..done]);
            return err;
        };
    }

    try domain.check(&test_entries);
}

test "every run an entry takes may fail, and leaves the domain as it was, its memory no larger" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    try testing.checkAllAllocationFailures(t.pages.allocator(), addEntries, .{&t.pages});
    try testing.expectEqual(0, t.pages.used);
}

test "entries that run out of memory anywhere, a run neither grown nor taken, roll back" {
    try atEveryMemorySize(addEntries);
}

test "a run that cannot grow in place is replaced by a new one, with the same rows" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    var count = std.testing.FailingAllocator.init(t.pages.allocator(), .{});
    try addEntries(count.allocator(), &t.pages);
    for (0..count.resize_index + 1) |index| {
        var failing = std.testing.FailingAllocator.init(t.pages.allocator(), .{ .resize_fail_index = index });
        try addEntries(failing.allocator(), &t.pages);
        try testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    }

    try testing.expectEqual(0, t.pages.used);
}
