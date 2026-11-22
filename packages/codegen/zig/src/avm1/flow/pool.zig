// The constant pool along a region's flow: which ConstantPool a Push of a
// constant reads, where one is known (assembly/avm1/flow/pool.ts, which
// says how adl carries the pool).
const std = @import("std");
const Allocator = std.mem.Allocator;
const Actions = @import("../actions/decode.zig").Actions;
const regions = @import("regions.zig");
const Region = regions.Region;

/// The pool where a block starts.
pub const Pool = union(enum) {
    /// Not reached yet.
    unreached,
    /// The activation's, read at run time: none or several may reach here.
    unknown,
    /// The one the ConstantPool action of this index set.
    known: u32,

    /// What two pools that reach one block make there.
    fn join(a: Pool, b: Pool) Pool {
        if (a == .unreached or std.meta.eql(a, b)) {
            return b;
        }

        return .unknown;
    }
};

/// The pool after action `index`, given the one before it.
pub fn poolAfter(actions: *const Actions, index: u32, pool: Pool) Pool {
    const action = actions.get(index);
    return if (action.ok() and action.op == .constant_pool) .{ .known = index } else pool;
}

/// The pool at the start of each of the region's blocks, in `pools`, grown if need be.
pub fn poolsOf(
    gpa: Allocator,
    actions: *const Actions,
    region: *const Region,
    pools: *std.ArrayList(Pool),
    work: *std.ArrayList(u32),
) Allocator.Error!void {
    const n = region.blockCount();
    pools.clearRetainingCapacity();
    @memset(try pools.addManyAsSlice(gpa, n), .unreached);
    work.clearRetainingCapacity();
    if (n == 0) {
        return;
    }

    // Each block's pool changes at most twice, from unreached to one pool to
    // unknown, so the work list ends.
    const entry = region.blockAt(region.start);
    pools.items[entry] = .unknown;
    try work.append(gpa, entry);
    while (work.pop()) |k| {
        var pool = pools.items[k];
        const block = region.blockActions(k);
        for (block) |index| {
            pool = poolAfter(actions, index, pool);
        }

        var edges = regions.successors(actions.get(block[block.len - 1]));
        while (edges.next()) |edge| {
            // A throw reaches a handler from anywhere in the try body.
            try merge(gpa, region, pools.items, work, edge.offset, if (edge.handler) .unknown else pool);
        }
    }
}

/// `pool` into the block at `offset`, if the region runs it.
fn merge(gpa: Allocator, region: *const Region, pools: []Pool, work: *std.ArrayList(u32), offset: i32, pool: Pool) Allocator.Error!void {
    if (!region.runs(offset)) {
        return;
    }

    const k = region.blockAt(offset);
    const joined = pools[k].join(pool);
    if (!std.meta.eql(joined, pools[k])) {
        pools[k] = joined;
        try work.append(gpa, k);
    }
}

test "pools join to unknown where two meet" {
    const a: Pool = .{ .known = 3 };
    try std.testing.expectEqual(a, Pool.join(.unreached, a));
    try std.testing.expectEqual(a, Pool.join(a, a));
    try std.testing.expectEqual(Pool.unknown, Pool.join(a, .{ .known = 4 }));
    try std.testing.expectEqual(Pool.unknown, Pool.join(.unknown, a));
}
