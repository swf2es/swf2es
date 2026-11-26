// Where control goes in an AVM1 region: the ranges Withs and Trys hold
// over, branches, gotos and exits, and the units control goes on in
// (assembly/avm1/emit/control.ts).
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../../output.zig");
const Output = output.Output;
const Error = Allocator.Error;
const decode = @import("../actions/decode.zig");
const Action = decode.Action;
const Actions = decode.Actions;
const Op = @import("../actions/opcodes.zig").Op;
const pool_ = @import("../flow/pool.zig");
const Pool = pool_.Pool;
const regions_ = @import("../flow/regions.zig");
const Flow = regions_.Flow;
const Region = regions_.Region;
const block_ = @import("block.zig");
const BlockEmitter = block_.BlockEmitter;
const Range = block_.Range;
const UnitKey = @import("units.zig").UnitKey;

/// The ranges of blocks the region's Withs and Trys hold over. The blocks
/// are in order of their offsets, and a body's bounds start blocks, so
/// each body is the blocks from the first at or after its start to the
/// first at or after its end.
pub fn heldRanges(em: *BlockEmitter, region: *const Region) Error!void {
    const gpa = em.gpa;
    em.handled.clearRetainingCapacity();
    em.scoped.clearRetainingCapacity();
    em.finallies.clearRetainingCapacity();
    em.returns.clearRetainingCapacity();
    em.late.clearRetainingCapacity();
    em.catch_registers.clearRetainingCapacity();
    em.tries = false;
    em.holds = false;
    for (region.actions.items) |index| {
        const action = em.actions.get(index);
        if (!action.ok()) {
            continue;
        }

        switch (action.operands) {
            .with => |body| {
                em.holds = true;
                try em.scoped.append(gpa, .{ .from = region.firstFrom(body.start), .to = region.firstFrom(body.end) });
            },
            .@"try" => |t| {
                em.holds = true;
                em.tries = true;
                const from = region.firstFrom(t.start);
                const catch_from = region.firstFrom(t.catch_start);
                const finally_from = region.firstFrom(t.finally_start);
                const finally_to = if (t.flags.finally_block) region.firstFrom(t.end) else finally_from;
                try em.handled.append(gpa, .{ .from = from, .to = finally_from });
                if (t.flags.catch_block) {
                    // A throw's scopes and the catch's variable hold over the catch body.
                    try em.scoped.append(gpa, .{ .from = catch_from, .to = finally_from });
                    if (t.catch_into == .register and std.mem.indexOfScalar(u8, em.catch_registers.items, t.catch_into.register) == null) {
                        try em.catch_registers.append(gpa, t.catch_into.register);
                    }
                }

                if (finally_from < finally_to) {
                    try em.handled.append(gpa, .{ .from = finally_from, .to = finally_to });
                    try em.finallies.append(gpa, .{ .from = finally_from, .to = finally_to });
                    try em.returns.append(gpa, .{ .from = from, .to = finally_from });
                }
            },
            else => {},
        }
    }

    if (!em.holds) {
        return;
    }

    // The block past each scope's body, whose first action runs in it.
    const n = region.blockCount();
    @memset(try em.late.addManyAsSlice(gpa, n), false);
    for (em.scoped.items) |scope| {
        if (scope.to < n) {
            em.late.items[scope.to] = true;
        }
    }
}

/// The catch handler's part that sets a register a catch took a value into.
pub fn catchInto(em: *BlockEmitter) Error!void {
    const out = em.out;
    if (em.catch_registers.items.len == 0) {
        return;
    }

    try out.text("switch (cx.into) {\n");
    for (em.catch_registers.items) |r| {
        if (r >= em.registers and r >= 4) {
            continue;
        }

        try out.text("case ");
        try out.uint(r);
        try out.text(": ");
        _ = try em.register(r);
        try out.text(" = cx.thrown; break;\n");
    }
    try out.text("}\n");
}

/// The branch of an If or a WaitForFrame to `target`: there, or the region's exit.
pub fn branch(em: *BlockEmitter, region: *const Region, target: i32) Error!void {
    if (region.runs(target) or within(em.finallies.items, em.k) or transfers(em, region, target)) {
        const out = em.out;
        try out.text("{ ");
        try goto(em, region, target);
        try out.text(" }\n");
    } else {
        try end(em);
    }
}

/// Control from the block being written to `offset`, its block or out of
/// the region, without a line's end: through V.leave where it leaves
/// what a With or a Try holds.
pub fn goto(em: *BlockEmitter, region: *const Region, offset: i32) Error!void {
    const out = em.out;
    if (!region.runs(offset)) {
        return if (transfers(em, region, offset)) transfer(em, region, offset) else exit(em);
    }

    const to = region.blockAt(offset);
    // A jump back may loop: it counts down to the script timeout's check (docs/avm1.md, "The frame").
    if (to <= em.k) {
        try out.text("if (--V.budget < 0) V.timeout(cx); ");
    }

    if (leaves(em.handled.items, em.k, to) or crosses(em.scoped.items, em.k, to)) {
        try out.text("b = V.leave(cx, ");
        try out.uint(to);
        try out.text("); continue;");
    } else {
        try out.text("b = ");
        try out.uint(to);
        try out.text("; continue;");
    }
}

/// Control out of the region: through V.leave where a finally may hold a throw or a Return.
pub fn exit(em: *BlockEmitter) Error!void {
    if (within(em.finallies.items, em.k)) {
        try em.out.text("b = V.leave(cx, -1); continue;");
    } else {
        try em.out.text(if (em.in_unit) "return -1;" else "return;");
    }
}

/// The region's exit as a line of its own.
pub fn end(em: *BlockEmitter) Error!void {
    try em.out.text(if (em.in_unit) "return -1;\n" else "return;\n");
}

/// Whether control at `offset`, outside the region's home, goes on in a
/// unit. A unit's own code hands every offset in the SWF to V.far, which
/// knows where the region ends; another region's only those it runs.
pub fn transfers(em: *const BlockEmitter, region: *const Region, offset: i32) bool {
    if (region.runs(offset)) {
        return false;
    }

    // One that keeps all it reaches goes on nowhere else, and is its own region's alone.
    return if (em.in_unit and !region.kept) offset >= region.minimum else region.continues(offset);
}

/// Control to `offset` in the unit there, without a line's end.
pub fn transfer(em: *BlockEmitter, region: *const Region, offset: i32) Error!void {
    const out = em.out;
    const base = em.actions.start;
    const key: UnitKey = .{
        .at = base + offset,
        .end = base + region.end,
        .bound = base + em.actions.len,
        .five = em.five,
    };
    if (em.in_unit) {
        try em.exits.append(em.gpa, key.at);
        try out.text("return ");
        try out.int(key.at);
        return out.byte(';');
    }

    try em.units.append(em.gpa, key);
    try out.text("return V.far(cx, ");
    try out.int(key.at);
    try out.text(", ");
    try out.int(key.end);
    try out.text(", ");
    try out.int(key.bound);
    try out.text(if (key.five) ", true);" else ", false);");
}

/// V.scopes after the first action of the late block `k`.
pub fn scopes(em: *BlockEmitter, k: u32) Error!void {
    try em.out.text("V.scopes(cx, ");
    try em.out.uint(k);
    try em.out.text(");\n");
}

/// Whether control from block `from` to block `to` leaves one of `ranges`.
pub fn leaves(ranges: []const Range, from: u32, to: u32) bool {
    for (ranges) |range| {
        if (range.has(from) and !range.has(to)) {
            return true;
        }
    }

    return false;
}

/// Whether control from block `from` to block `to` leaves one of the scopes'
/// `ranges`, which hold over the first block past them too, as it starts.
fn crosses(ranges: []const Range, from: u32, to: u32) bool {
    for (ranges) |range| {
        if (range.holds(from) and !range.holds(to)) {
            return true;
        }
    }

    return false;
}

/// Whether block `k` is in one of `ranges`.
pub fn within(ranges: []const Range, k: u32) bool {
    for (ranges) |range| {
        if (range.has(k)) {
            return true;
        }
    }

    return false;
}

/// Whether a branch of the region goes to one of its blocks, as a loop to its only one.
pub fn jumpsWithin(actions: *const Actions, region: *const Region) bool {
    for (region.order.items) |index| {
        const action = actions.get(index);
        if (action.target()) |to| {
            if (region.runs(to)) {
                return true;
            }
        }

        if (action.ok() and (action.op == .with or action.op == .@"try")) {
            return true;
        }
    }

    return false;
}
