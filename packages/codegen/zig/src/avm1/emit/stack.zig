// How an AVM1 block writes the operand stack: pushes, and a pushed value
// taken as it is by the action that pops it (assembly/avm1/emit/stack.ts).
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../../output.zig");
const Output = output.Output;
const Error = output.Error;
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

/// `V.<name>` of the `operands` values on top of the stack, the top first, its result pushed.
pub fn operation(em: *BlockEmitter, name: []const u8, operands: u8) Error!void {
    const w = em.out.writer();
    const start = try detach(em);
    try w.print("st.push(V.{s}(", .{name});
    try takeValue(em);
    try w.writeAll(switch (operands) {
        3 => ", st.pop(), st.pop()));\n",
        2 => ", st.pop()));\n",
        else => "));\n",
    });
    pushed(em, start);
}

pub fn push(em: *BlockEmitter, push_: decode.Span, pool: Pool) Error!void {
    const out = em.out;
    const w = out.writer();
    const values = em.actions.pushValues(push_);
    if (values.len == 0) {
        return;
    }

    const start = out.len();
    try w.writeAll("st.push(");
    var last = out.len();
    for (values, 0..) |value, i| {
        if (i > 0) {
            try w.writeAll(", ");
        }

        last = out.len();
        switch (value) {
            .string => |s| try em.string(s),
            .float, .double, .integer => try output.writeDouble(w, value.number().?),
            .null => try w.writeAll("null"),
            .undefined => try w.writeAll("undefined"),
            .boolean => |boolean| try w.writeAll(if (boolean) "true" else "false"),
            .constant8 => |index| try constant(em, pool, index),
            .constant16 => |index| try constant(em, pool, index),
            .register => |r| if (!try em.register(r)) {
                try w.writeAll("undefined");
            },
        }
    }

    try w.writeAll(");\n");
    em.pending = .{ .statement = start, .value = last, .end = out.len(), .more = values.len > 1 };
}

/// Constant `index` of `pool`: its string, undefined past its end, or the activation's.
pub fn constant(em: *BlockEmitter, pool: Pool, index: u16) Error!void {
    switch (pool) {
        .known => |at| {
            const strings = em.actions.poolStrings(em.actions.get(at).operands.pool);
            if (index < strings.len) {
                try em.string(strings[index]);
            } else {
                try em.out.writer().writeAll("undefined");
            }
        },
        .unknown, .unreached => {
            try em.out.writer().print("cx.pool[{d}]", .{index});
        },
    }
}

/// `prefix`, the value on top of the stack, popped, and `rest`: where the
/// action before pushed it, `st.push(value);` and `st.pop()` become the
/// value itself, evaluated where the push was, as nothing comes between.
/// Where the statement it writes starts.
pub fn top(em: *BlockEmitter, prefix: []const u8, rest: []const u8) Error!u32 {
    const start = try detach(em);
    try em.out.writer().writeAll(prefix);
    try takeValue(em);
    try em.out.writer().writeAll(rest);
    return start;
}

/// The value the action before pushed, if any, taken out of its push into
/// `scratch`; where the statement that takes it starts.
pub fn detach(em: *BlockEmitter) Error!u32 {
    const out = em.out;
    em.detached = null;
    const pending = em.pending orelse return out.len();
    if (pending.end != out.len()) {
        return out.len();
    }

    // The value, out of its push, after what stays of that push.
    em.scratch.clearRetainingCapacity();
    try em.scratch.appendSlice(em.gpa, out.written()[pending.value .. out.len() - 3]);
    if (pending.more) {
        out.shrink(pending.value - 2);
        try out.writer().writeAll(");\n");
    } else {
        out.shrink(pending.statement);
    }

    em.detached = em.scratch.items;
    return out.len();
}

/// The value detach took, else `st.pop()`.
pub fn takeValue(em: *BlockEmitter) Error!void {
    try em.out.writer().writeAll(em.detached orelse "st.pop()");
    em.pending = null;
}

/// The statement from `start`, `st.push(value);`, whose value the next action may take.
pub fn pushed(em: *BlockEmitter, start: u32) void {
    em.pending = .{ .statement = start, .value = start + 8, .end = em.out.len(), .more = false };
}
