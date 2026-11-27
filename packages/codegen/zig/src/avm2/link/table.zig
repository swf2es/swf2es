// Hash tables of ids for the domain's interned names and bindings
// (assembly/avm2/link/table.ts).
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");

/// Maps a 32-bit hash to ids by linear probing; callers compare the keys.
pub const IdTable = struct {
    /// id + 1 per slot; 0 is empty.
    ids: []u32,
    hashes: []u32,
    count: u32 = 0,

    pub fn init(gpa: Allocator) Allocator.Error!IdTable {
        const ids = try memory.allocZeroed(gpa, u32, 64);
        return .{ .ids = ids, .hashes = try memory.allocZeroed(gpa, u32, 64) };
    }

    pub inline fn start(self: *const IdTable, hash: u32) u32 {
        return hash & (@as(u32, @intCast(self.ids.len)) - 1);
    }

    pub inline fn next(self: *const IdTable, slot: u32) u32 {
        return (slot + 1) & (@as(u32, @intCast(self.ids.len)) - 1);
    }

    /// The id in `slot`, or -1 at the end of the probe.
    pub inline fn at(self: *const IdTable, slot: u32) i32 {
        return @as(i32, @bitCast(self.ids[slot])) - 1;
    }

    pub inline fn hashAt(self: *const IdTable, slot: u32) u32 {
        return self.hashes[slot];
    }

    pub fn insert(self: *IdTable, gpa: Allocator, hash: u32, id: u32) Allocator.Error!void {
        // At most half full: a lookup that misses, as most of a binding's
        // lookups do, probes until an empty slot.
        if ((self.count + 1) * 2 > self.ids.len) {
            try self.grow(gpa);
        }

        var slot = self.start(hash);
        while (self.ids[slot] != 0) {
            slot = self.next(slot);
        }

        self.ids[slot] = id + 1;
        self.hashes[slot] = hash;
        self.count += 1;
    }

    fn grow(self: *IdTable, gpa: Allocator) Allocator.Error!void {
        try self.rehash(gpa, @intCast(self.ids.len * 2), std.math.maxInt(u32));
    }

    /// The ids from `limit` on taken out, as a link that fails leaves none
    /// of its rows behind: the others placed again, in tables of their own,
    /// as linear probing cannot empty a slot that an earlier id's probe
    /// passed, and a Change rolled back takes the old tables back as they were.
    pub fn forget(self: *IdTable, gpa: Allocator, limit: u32) Allocator.Error!void {
        for (self.ids) |slot| {
            if (slot > limit) {
                return self.rehash(gpa, @intCast(self.ids.len), limit);
            }
        }
    }

    /// The ids below `limit` placed again in tables of `size` slots.
    fn rehash(self: *IdTable, gpa: Allocator, size: u32, limit: u32) Allocator.Error!void {
        const ids = self.ids;
        const hashes = self.hashes;
        const old: u32 = @intCast(ids.len);
        // Both taken before either replaces the old: running out of memory leaves the table as it was.
        const new_ids = try memory.allocZeroed(gpa, u32, size);
        self.hashes = try memory.allocZeroed(gpa, u32, size);
        self.ids = new_ids;
        self.count = 0;

        // Re-inserting in slot order keeps equal hashes in insertion order.
        var first: u32 = 0;
        while (first < old and ids[first] != 0) {
            first += 1;
        }

        var i: u32 = 1;
        while (i <= old) : (i += 1) {
            const slot = (first + i) & (old - 1);
            if (ids[slot] != 0 and ids[slot] <= limit) {
                self.place(hashes[slot], ids[slot] - 1);
            }
        }
    }

    /// insert, into room there is.
    fn place(self: *IdTable, hash: u32, id: u32) void {
        var slot = self.start(hash);
        while (self.ids[slot] != 0) {
            slot = self.next(slot);
        }

        self.ids[slot] = id + 1;
        self.hashes[slot] = hash;
        self.count += 1;
    }

    /// Empty, the room kept: lookups give what a new table would.
    pub fn clear(self: *IdTable) void {
        @memset(self.ids, 0);
        self.count = 0;
    }

    /// The ids from `limit` on taken out again, as they were inserted after
    /// a state this table (its slices, as saved then) was copied back to.
    /// Linear probing leaves an earlier id's probe on slots that were full
    /// when it was inserted, so emptying later ones changes no lookup of
    /// those left.
    pub fn forgetFrom(self: *IdTable, limit: u32) void {
        var count: u32 = 0;
        for (self.ids, self.hashes) |*slot, *hash| {
            if (slot.* > limit) {
                // Its hash too, so that the slot is as it was before, byte for byte.
                slot.* = 0;
                hash.* = 0;
            } else if (slot.* != 0) {
                count += 1;
            }
        }

        self.count = count;
    }
};

pub fn hashBytes(bytes: []const u8) u32 {
    var h: u32 = 0x811c9dc5;
    for (bytes) |b| {
        h = (h ^ b) *% 0x01000193;
    }

    return h;
}

/// A pair of ids' hash, every bit of each mixed into the low bits that pick
/// a slot: murmur3's 64-bit finalizer over the pair, a bijection, so that no
/// two pairs share a hash before its low half is taken. Ids are dense, and a
/// hash that left consecutive names of one namespace in consecutive slots
/// made one cluster of them, which every lookup that missed walked to its end.
pub fn hashPair(a: u32, b: u32) u32 {
    var h: u64 = (@as(u64, a) << 32) | b;
    h ^= h >> 33;
    h *%= 0xff51afd7ed558ccd;
    h ^= h >> 33;
    h *%= 0xc4ceb9fe1a85ec53;
    h ^= h >> 33;
    return @truncate(h);
}

const testing = std.testing;

test "ids are found by their hashes in insertion order, across growth" {
    var arena: memory.Arena = .init(testing.allocator);
    defer arena.deinit();
    const gpa = arena.allocator();
    var table: IdTable = try .init(gpa);
    for (0..200) |i| {
        try table.insert(gpa, @intCast(i % 7), @intCast(i));
    }

    try testing.expectEqual(512, table.ids.len);
    var slot = table.start(3);
    var seen: u32 = 0;
    while (table.at(slot) >= 0) : (slot = table.next(slot)) {
        const id: u32 = @intCast(table.at(slot));
        if (table.hashAt(slot) == 3) {
            try testing.expectEqual(3 + 7 * seen, id);
            seen += 1;
        }
    }

    try testing.expectEqual(29, seen);
}

test "ids inserted after a state are forgotten, those before kept" {
    var arena: memory.Arena = .init(testing.allocator);
    defer arena.deinit();
    const gpa = arena.allocator();
    var table: IdTable = try .init(gpa);
    for (0..20) |i| {
        try table.insert(gpa, @intCast(i % 3), @intCast(i));
    }

    const saved = table;
    for (20..100) |i| {
        try table.insert(gpa, @intCast(i % 3), @intCast(i));
    }

    table = saved;
    table.forgetFrom(20);
    try testing.expectEqual(20, table.count);
    for (0..20) |i| {
        var slot = table.start(@intCast(i % 3));
        while (table.at(slot) != i) : (slot = table.next(slot)) {
            try testing.expect(table.at(slot) >= 0);
        }
    }
}

test "the hashes are AssemblyScript's, wrapping" {
    try testing.expectEqual(0x811c9dc5, hashBytes(""));
    try testing.expectEqual(0xe40c292c, hashBytes("a"));
    try testing.expectEqual(hashPair(1, 2), hashPair(1, 2));
    try testing.expect(hashPair(1, 2) != hashPair(2, 1));
}

test "consecutive names of one namespace spread over the table, and a miss probes a few slots" {
    var arena: memory.Arena = .init(testing.allocator);
    defer arena.deinit();
    const gpa = arena.allocator();
    // As a large ABC's names are interned: thousands, consecutive ids, in a
    // few namespaces, which the old hash put in consecutive slots.
    var table: IdTable = try .init(gpa);
    var id: u32 = 0;
    for ([_]u32{ 3, 4, 9 }) |ns| {
        for (1000..9000) |name| {
            try table.insert(gpa, hashPair(ns, @intCast(name)), id);
            id += 1;
        }
    }

    // A lookup that misses walks its cluster to an empty slot: in a table at
    // most half full of well-spread hashes, a few slots on average, and no
    // run long; the old hash made one run of over 10,000 slots here.
    var longest: u32 = 0;
    var run: u32 = 0;
    for (0..2 * table.ids.len) |i| {
        if (table.ids[i & (table.ids.len - 1)] != 0) {
            run += 1;
            longest = @max(longest, run);
        } else {
            run = 0;
        }
    }

    // Names of the same namespace not in the table, as most lookups of a
    // binding miss: the old hash took some 500 probes for each of these.
    var probes: u64 = 0;
    const misses = 10_000;
    for (0..misses) |name| {
        var slot = table.start(hashPair(3, @intCast(20_000 + name)));
        while (table.at(slot) >= 0) : (slot = table.next(slot)) {
            probes += 1;
        }
    }

    try testing.expect(longest < 100);
    try testing.expect(probes < 4 * misses);
}
