// How an AVM1 block writes each action (assembly/avm1/emit/actions.ts).
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
const control = @import("control.zig");
const stack = @import("stack.zig");

/// How an action is written, where a table can say.
const Emit = union(enum) {
    /// By `special`: its operands decide.
    special,
    /// Text of its own.
    fixed: []const u8,
    /// `V.<name>` of the `operands` values on top of the stack, the top
    /// first, its result pushed.
    operation: struct { name: []const u8, operands: u8 },
    /// `prefix`, the value on top of the stack, popped, and `rest`; with
    /// `pushes`, a statement that pushes, whose value the next action may take.
    pops: struct { prefix: []const u8, rest: []const u8, pushes: bool = false },
};

/// Every action Flash knows, by opcode; none for the others, which Flash skips.
const emits: [256]?Emit = blk: {
    @setEvalBranchQuota(10000);
    var table: [256]?Emit = @splat(null);
    const Entry = struct { Op, Emit };
    const entries = [_]Entry{
        .{ .end, .{ .fixed = "" } },
        .{ .pop, .{ .fixed = "st.pop();\n" } },
        .{ .play, .{ .fixed = "V.play(cx);\n" } },
        .{ .stop, .{ .fixed = "V.stop(cx);\n" } },
        .{ .init_object, .{ .fixed = "V.initObject(cx);\n" } },
        .{ .init_array, .{ .fixed = "V.initArray(cx);\n" } },
        .{ .call_function, .{ .fixed = "V.callFunction(cx);\n" } },
        .{ .call_method, .{ .fixed = "V.callMethod(cx);\n" } },
        .{ .new_object, .{ .fixed = "V.newObject(cx);\n" } },
        .{ .new_method, .{ .fixed = "V.newMethod(cx);\n" } },
        .{ .implements_op, .{ .fixed = "V.implementsOp(cx);\n" } },
        .{ .push_duplicate, .{ .fixed = "{ const a = st.pop(); st.push(a, a); }\n" } },
        .{ .stack_swap, .{ .fixed = "{ const a = st.pop(), b = st.pop(); st.push(a, b); }\n" } },
        .{ .next_frame, .{ .fixed = "V.nextFrame(cx);\n" } },
        .{ .previous_frame, .{ .fixed = "V.prevFrame(cx);\n" } },
        .{ .stop_sounds, .{ .fixed = "V.stopSounds(cx);\n" } },
        .{ .start_drag, .{ .fixed = "V.startDrag(cx);\n" } },
        .{ .end_drag, .{ .fixed = "V.stopDrag(cx);\n" } },
        .{ .toggle_quality, .{ .fixed = "V.toggleQuality(cx);\n" } },

        .{ .add, .{ .operation = .{ .name = "add", .operands = 2 } } },
        .{ .add2, .{ .operation = .{ .name = "add2", .operands = 2 } } },
        .{ .subtract, .{ .operation = .{ .name = "subtract", .operands = 2 } } },
        .{ .multiply, .{ .operation = .{ .name = "multiply", .operands = 2 } } },
        .{ .divide, .{ .operation = .{ .name = "divide", .operands = 2 } } },
        .{ .modulo, .{ .operation = .{ .name = "modulo", .operands = 2 } } },
        .{ .equals, .{ .operation = .{ .name = "equals", .operands = 2 } } },
        .{ .equals2, .{ .operation = .{ .name = "equals2", .operands = 2 } } },
        .{ .strict_equals, .{ .operation = .{ .name = "strictEquals", .operands = 2 } } },
        .{ .less, .{ .operation = .{ .name = "less", .operands = 2 } } },
        .{ .less2, .{ .operation = .{ .name = "less2", .operands = 2 } } },
        .{ .greater, .{ .operation = .{ .name = "greater", .operands = 2 } } },
        .{ .@"and", .{ .operation = .{ .name = "and", .operands = 2 } } },
        .{ .@"or", .{ .operation = .{ .name = "or", .operands = 2 } } },
        .{ .not, .{ .operation = .{ .name = "not", .operands = 1 } } },
        .{ .bit_and, .{ .operation = .{ .name = "bitAnd", .operands = 2 } } },
        .{ .bit_or, .{ .operation = .{ .name = "bitOr", .operands = 2 } } },
        .{ .bit_xor, .{ .operation = .{ .name = "bitXor", .operands = 2 } } },
        .{ .bit_l_shift, .{ .operation = .{ .name = "bitLShift", .operands = 2 } } },
        .{ .bit_r_shift, .{ .operation = .{ .name = "bitRShift", .operands = 2 } } },
        .{ .bit_u_r_shift, .{ .operation = .{ .name = "bitURShift", .operands = 2 } } },
        .{ .increment, .{ .operation = .{ .name = "increment", .operands = 1 } } },
        .{ .decrement, .{ .operation = .{ .name = "decrement", .operands = 1 } } },
        .{ .string_add, .{ .operation = .{ .name = "stringAdd", .operands = 2 } } },
        .{ .string_equals, .{ .operation = .{ .name = "stringEquals", .operands = 2 } } },
        .{ .string_less, .{ .operation = .{ .name = "stringLess", .operands = 2 } } },
        .{ .string_greater, .{ .operation = .{ .name = "stringGreater", .operands = 2 } } },
        .{ .string_length, .{ .operation = .{ .name = "stringLength", .operands = 1 } } },
        .{ .mb_string_length, .{ .operation = .{ .name = "mbStringLength", .operands = 1 } } },
        .{ .string_extract, .{ .operation = .{ .name = "stringExtract", .operands = 3 } } },
        .{ .mb_string_extract, .{ .operation = .{ .name = "mbStringExtract", .operands = 3 } } },
        .{ .char_to_ascii, .{ .operation = .{ .name = "charToAscii", .operands = 1 } } },
        .{ .ascii_to_char, .{ .operation = .{ .name = "asciiToChar", .operands = 1 } } },
        .{ .mb_char_to_ascii, .{ .operation = .{ .name = "mbCharToAscii", .operands = 1 } } },
        .{ .mb_ascii_to_char, .{ .operation = .{ .name = "mbAsciiToChar", .operands = 1 } } },
        .{ .to_number, .{ .operation = .{ .name = "toNumber", .operands = 1 } } },
        .{ .to_string, .{ .operation = .{ .name = "toString", .operands = 1 } } },
        .{ .to_integer, .{ .operation = .{ .name = "toInteger", .operands = 1 } } },
        .{ .type_of, .{ .operation = .{ .name = "typeOf", .operands = 1 } } },

        .{ .trace, .{ .pops = .{ .prefix = "V.trace(cx, ", .rest = ");\n" } } },
        .{ .set_variable, .{ .pops = .{ .prefix = "V.setVariable(cx, ", .rest = ", st.pop());\n" } } },
        .{ .define_local, .{ .pops = .{ .prefix = "V.defineLocal(cx, ", .rest = ", st.pop());\n" } } },
        .{ .define_local2, .{ .pops = .{ .prefix = "V.defineLocal2(cx, ", .rest = ");\n" } } },
        .{ .set_member, .{ .pops = .{ .prefix = "V.setMember(cx, ", .rest = ", st.pop(), st.pop());\n" } } },
        .{ .enumerate, .{ .pops = .{ .prefix = "V.enumerate(cx, ", .rest = ");\n" } } },
        .{ .enumerate2, .{ .pops = .{ .prefix = "V.enumerate2(cx, ", .rest = ");\n" } } },
        .{ .extends, .{ .pops = .{ .prefix = "V.extends(cx, ", .rest = ", st.pop());\n" } } },
        .{ .throw, .{ .pops = .{ .prefix = "V.throw(", .rest = ");\n" } } },
        .{ .set_target2, .{ .pops = .{ .prefix = "V.setTarget2(cx, ", .rest = ");\n" } } },
        .{ .set_property, .{ .pops = .{ .prefix = "V.setProperty(cx, ", .rest = ", st.pop(), st.pop());\n" } } },
        .{ .call, .{ .pops = .{ .prefix = "V.callFrame(cx, ", .rest = ");\n" } } },
        .{ .clone_sprite, .{ .pops = .{ .prefix = "V.cloneSprite(cx, ", .rest = ", st.pop(), st.pop());\n" } } },
        .{ .remove_sprite, .{ .pops = .{ .prefix = "V.removeSprite(cx, ", .rest = ");\n" } } },
        .{ .get_variable, .{ .pops = .{ .prefix = "st.push(V.getVariable(cx, ", .rest = "));\n", .pushes = true } } },
        .{ .get_member, .{ .pops = .{ .prefix = "st.push(V.getMember(cx, ", .rest = ", st.pop()));\n", .pushes = true } } },
        .{ .delete, .{ .pops = .{ .prefix = "st.push(V.deleteMember(cx, ", .rest = ", st.pop()));\n", .pushes = true } } },
        .{ .delete2, .{ .pops = .{ .prefix = "st.push(V.deleteVariable(cx, ", .rest = "));\n", .pushes = true } } },
        .{ .instance_of, .{ .pops = .{ .prefix = "st.push(V.instanceOf(cx, ", .rest = ", st.pop()));\n", .pushes = true } } },
        .{ .cast_op, .{ .pops = .{ .prefix = "st.push(V.castOp(cx, ", .rest = ", st.pop()));\n", .pushes = true } } },
        .{ .random_number, .{ .pops = .{ .prefix = "st.push(V.randomNumber(cx, ", .rest = "));\n", .pushes = true } } },
        .{ .get_property, .{ .pops = .{ .prefix = "st.push(V.getProperty(cx, ", .rest = ", st.pop()));\n", .pushes = true } } },
        .{ .target_path, .{ .pops = .{ .prefix = "st.push(V.targetPath(cx, ", .rest = "));\n", .pushes = true } } },
    };
    for (entries) |entry| {
        table[@backingInt(entry[0])] = entry[1];
    }

    const specials = [_]Op{
        .push,           .constant_pool,   .define_function, .define_function2, .store_register,
        .@"return",      .with,            .@"try",          .jump,             .@"if",
        .wait_for_frame, .wait_for_frame2, .goto_frame,      .goto_label,       .goto_frame2,
        .set_target,     .get_url,         .get_url2,        .get_time,
    };
    for (specials) |op| {
        table[@backingInt(op)] = .special;
    }

    // Every action Flash knows is written: none is left to fail at run time.
    for (std.enums.values(Op)) |op| {
        if (table[@backingInt(op)] == null) {
            @compileError("no code for " ++ @tagName(op));
        }
    }

    break :blk table;
};

pub fn writeAction(em: *BlockEmitter, region: *const Region, action: *const Action, pool: Pool) Error!void {
    if (!action.ok()) {
        // adl stops the whole SWF at an action it cannot read; the block's end returns.
        return em.out.text("V.halt(cx);\n");
    }

    const out = em.out;
    const emit = emits[@backingInt(action.op)] orelse return;
    switch (emit) {
        .fixed => |text| try out.text(text),
        .operation => |operation| try stack.operation(em, operation.name, operation.operands),
        .pops => |pops| {
            const start = try stack.top(em, pops.prefix, pops.rest);
            if (pops.pushes) {
                stack.pushed(em, start);
            }
        },
        .special => try special(em, region, action, pool),
    }
}

/// The actions whose operands decide what they become.
pub fn special(em: *BlockEmitter, region: *const Region, action: *const Action, pool: Pool) Error!void {
    const out = em.out;
    switch (action.operands) {
        .push => |values| try stack.push(em, values, pool),
        .pool => |strings| {
            try out.text("V.constantPool(cx, [");
            for (em.actions.poolStrings(strings), 0..) |s, i| {
                if (i > 0) {
                    try out.text(", ");
                }

                try em.string(s);
            }
            try out.text("]);\n");
        },
        .function => |function| try defineFunction(em, action.op == .define_function2, function),
        .register => |r| {
            // StoreRegister: the value stays, popped and pushed again, undefined on an empty stack.
            try out.text("st.push(");
            if (try em.register(r)) {
                try out.text(" = ");
            }
            try out.text("st.pop());\n");
        },
        .with => |body| {
            try out.text("if (!V.with(cx, st.pop(), ");
            try out.uint(region.firstFrom(body.start));
            try out.text(", ");
            try out.uint(region.firstFrom(body.end));
            try out.text(")) { ");
            try control.goto(em, region, action.next);
            try out.text(" }\n");
        },
        .@"try" => |t| try em.@"try"(region, t),
        .branch => |to| switch (action.op) {
            .jump => {
                try control.goto(em, region, to);
                try out.byte('\n');
            },
            else => {
                _ = try stack.top(em, "if (V.toBoolean(", ")) ");
                try control.branch(em, region, to);
            },
        },
        .wait => |wait| {
            // A frame not loaded skips the actions after.
            if (action.op == .wait_for_frame) {
                try out.text("if (!V.frameLoaded(cx, ");
                try out.uint(wait.frame);
                try out.text(")) ");
            } else {
                _ = try stack.top(em, "if (!V.frameLoaded2(cx, ", ")) ");
            }
            try control.branch(em, region, wait.target.?);
        },
        .frame => |frame| {
            try out.text("V.gotoFrame(cx, ");
            try out.uint(frame);
            try out.text(");\n");
        },
        .name => |name| {
            try out.text(if (action.op == .goto_label) "V.gotoLabel(cx, " else "V.setTarget(cx, ");
            try em.string(name);
            try out.text(");\n");
        },
        .goto_frame2 => |frame2| {
            _ = try stack.top(em, "V.gotoFrame2(cx, ", if (frame2.play) ", true, " else ", false, ");
            try out.uint(frame2.bias);
            try out.text(");\n");
        },
        .url => |url| {
            try out.text("V.getUrl(cx, ");
            try em.string(url.url);
            try out.text(", ");
            try em.string(url.target);
            try out.text(");\n");
        },
        .get_url2 => |flags| {
            _ = try stack.top(em, "V.getUrl2(cx, ", ", st.pop(), ");
            try out.uint(flags);
            try out.text(");\n");
        },
        .none => switch (action.op) {
            .@"return" => {
                // A Try's finally runs first, where one holds.
                if (control.within(em.returns.items, em.k)) {
                    try out.text("b = V.ret(cx); continue;\n");
                } else if (em.in_unit) {
                    _ = try stack.top(em, "cx.ret = ", "; return -2;\n");
                } else {
                    _ = try stack.top(em, "return ", ";\n");
                }
            },
            .get_time => {
                const start = em.out.len();
                try out.text("st.push(V.getTime(cx));\n");
                stack.pushed(em, start);
            },
            else => unreachable,
        },
    }
}

/// DefineFunction and DefineFunction2: the function made of its region,
/// with its name, and its parameters that are variables, null for those
/// in a register; a DefineFunction2's flags.
pub fn defineFunction(em: *BlockEmitter, two: bool, function: decode.Function) Error!void {
    const out = em.out;
    try out.text(if (two) "V.defineFunction2(cx, " else "V.defineFunction(cx, ");
    try out.uint(function.region.?);
    try out.text(", ");
    try em.string(function.name);
    try out.text(", [");
    for (em.actions.functionParams(function), 0..) |param, i| {
        if (i > 0) {
            try out.text(", ");
        }

        if (two and param.register != 0) {
            try out.text("null");
        } else {
            try em.string(param.name);
        }
    }
    try out.byte(']');
    if (two) {
        try out.text(", ");
        try out.uint(@as(u16, @bitCast(function.flags)));
    }
    try out.text(");\n");
}
