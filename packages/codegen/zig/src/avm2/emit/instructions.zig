// The method emitter's instructions (assembly/avm2/emit/instructions.ts):
// constants, locals and the stack, arithmetic, comparisons and conversions,
// branches, returns and throws, each as a JavaScript statement; those of
// the object model are in objects.zig. A null check is made where the
// instruction after it first reads the register, if it reads it first.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const ops = @import("../abc/opcodes.zig");
const ir_ = @import("../ir/ir.zig");
const TYPE_Any = @import("../link/traits.zig").TYPE_Any;
const copies = @import("copies.zig");
const CONSTANT = copies.CONSTANT;
const NONE = copies.NONE;
const floats = @import("floats.zig");
const MethodEmitter = @import("method.zig").MethodEmitter;
const objects = @import("objects.zig");
const refs = @import("refs.zig");
const structure = @import("structure.zig");
const values = @import("values.zig");

fn floatArithmetic(em: *const MethodEmitter, i: u32) bool {
    const ty = em.ir.type[i];
    return em.abc.hasFloatSupport() and (ty == TYPE_Any or ty == em.domain.floatType);
}

fn move(em: *MethodEmitter, i: u32, src: i32) Error!void {
    try em.assign(i, true);
    if (em.unboxedTarget(i)) {
        try em.numberReg(src);
    } else {
        try em.reg(src);
    }
}

pub fn instruction(em: *MethodEmitter, i: u32) Error!void {
    const out = &em.out;
    const ir = em.ir;
    const op = ir.op[i];
    const a = ir.a[i];
    em.unboxResult = false;
    em.rawResult = false;
    if (copies.pushesConstant(op) and ir.dst[i] >= @as(i32, @intCast(ir.localCount + ir.maxScope))) {
        // Read as the literal until the register changes or a branch needs
        // it: V8 then gives the operation the constant in its own bytecode.
        em.setCopy(ir.dst[i], CONSTANT - @as(i32, @intCast(i)));
        em.kept = true;
        return;
    }

    if (try floats.floatOperation(em, i)) {
        try out.text(";\n");
        return;
    }

    switch (op) {
        ops.OP_pushbyte, ops.OP_pushshort => {
            try em.assign(i, false);
            try out.int(@as(i32, @bitCast(a)));
        },
        ops.OP_pushint => {
            try em.assign(i, false);
            try out.int(em.abc.pool.ints[a]);
        },
        ops.OP_pushuint => {
            try em.assign(i, false);
            try out.uint(em.abc.pool.uints[a]);
        },
        ops.OP_pushfloat => {
            try em.assign(i, false);
            try out.text("rt.float(");
            try out.double(em.abc.pool.floats[a]);
            try out.text(")");
        },
        ops.OP_pushdouble => {
            try em.assign(i, false);
            try out.double(em.abc.pool.doubles[a]);
        },
        ops.OP_pushnan => {
            try em.assign(i, false);
            try out.text("NaN");
        },
        ops.OP_pushstring => {
            try em.assign(i, false);
            try refs.poolString(em, a);
        },
        ops.OP_pushtrue => {
            try em.assign(i, false);
            try out.text("true");
        },
        ops.OP_pushfalse => {
            try em.assign(i, false);
            try out.text("false");
        },
        ops.OP_pushnull => {
            try em.assign(i, false);
            try out.text("null");
        },
        ops.OP_pushnamespace => {
            try em.assign(i, false);
            try out.text("rt.namespace(N[");
            try out.uint(a);
            try out.text("])");
        },
        ops.OP_pushundefined => {
            try em.assign(i, false);
            try out.text("void 0");
        },
        ops.OP_getlocal, ops.OP_setlocal, ops.OP_dup => {
            if (em.copies_(i, ir.src[i])) {
                return;
            }

            try move(em, i, ir.src[i]);
        },
        ops.OP_kill => try em.reset(ir.dst[i]),
        ops.OP_swap => {
            // Through a temporary, not [a, b] = [b, a]: destructuring is an
            // array and the iterator protocol, which V8 counts against inlining.
            const x = ir.src[i];
            try out.text("{ const w = ");
            try em.reg(x + 1);
            try out.text("; ");
            try em.regName(x + 1);
            try out.text(" = ");
            try em.reg(x);
            try out.text("; ");
            try em.regName(x);
            try out.text(" = w; }");
        },
        ops.OP_debugfile => {
            em.file = @bitCast(a);
            return;
        },
        ops.OP_debugline => {
            em.line = a;
            try em.mark();
            return;
        },
        ops.OP_pop, ops.OP_debug => return,
        ir_.IR_Coerce => {
            const s = ir.src[i];
            if (ir.dst[i] == s and try values.keeps(em, ir.c[i], em.regType[@intCast(s)])) {
                em.kept = true;
                return;
            }

            try em.assign(i, true);
            try values.convert(em, "", s, ir.c[i], em.regType[@intCast(s)], em.unboxedTarget(i));
        },
        ir_.IR_CheckNull => {
            // A register checked since it was last written is not null.
            const src = ir.src[i];
            const copy = em.copyOf[@intCast(src)];
            const r = if (copy == NONE) src else copy;
            if (r >= 0) {
                if (em.checked[@intCast(r)] != 0) {
                    return;
                }

                em.checked[@intCast(r)] = 1;
            }

            // The instruction checked for reads it before it does anything,
            // and the check is there, as it reads it: `(r ?? nn(r)).$1`; its
            // operands' conversions that change nothing may come between
            // (instructions.ts tells why their types are the registers' now).
            var next = i + 1;
            while (next < em.blockLast and
                ir.pc[next] == ir.pc[i] and
                ir.op[next] == ir_.IR_Coerce and
                ir.dst[next] == ir.src[next] and
                try values.keeps(em, ir.c[next], em.regType[@intCast(ir.src[next])]))
            {
                next += 1;
            }

            // Not a copy of a constant (copyOf below NONE), which has no name for unpend.
            if (copy >= NONE and
                next < em.blockLast and
                ir.pc[next] == ir.pc[i] and
                readsFirst(ir.op[next]))
            {
                em.pendingNull = src;
                em.pendingRead = if (copy == NONE) src else copy;
                em.pendingUntil = next;
                em.pendingAt = out.len();
                em.pendingMarks = em.map.count();
                return;
            }

            try em.checkedRead(src);
        },
        ops.OP_add => {
            try em.assign(i, false);
            if ((values.isNumeric(em, em.src(i, 0)) and values.isNumeric(em, em.src(i, 1))) or values.concatenates(em, i)) {
                try values.binary(em, i, " + ");
            } else {
                try values.call2(em, "rt.add(", i);
            }
        },
        ops.OP_subtract => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try values.call2(em, "rt.subtract(", i);
            } else {
                try values.binary(em, i, " - ");
            }
        },
        ops.OP_multiply => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try values.call2(em, "rt.multiply(", i);
            } else if (values.wraps(em, i)) {
                try values.call2(em, "Math.imul(", i);
            } else {
                try values.binary(em, i, " * ");
            }
        },
        ops.OP_divide => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try values.call2(em, "rt.divide(", i);
            } else {
                try values.binary(em, i, " / ");
            }
        },
        ops.OP_modulo => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try values.call2(em, "rt.modulo(", i);
            } else {
                try values.binary(em, i, " % ");
            }
        },
        ops.OP_add_i => {
            try em.assign(i, false);
            try values.binaryInt(em, i, " + ");
        },
        ops.OP_subtract_i => {
            try em.assign(i, false);
            try values.binaryInt(em, i, " - ");
        },
        ops.OP_multiply_i => {
            // int multiplication wraps as Math.imul does, not as a double product.
            try em.assign(i, false);
            try values.call2(em, "Math.imul(", i);
        },
        ops.OP_bitand, ops.OP_bitor, ops.OP_bitxor, ops.OP_lshift, ops.OP_rshift, ops.OP_urshift => {
            try em.assign(i, false);
            try values.binary(em, i, switch (op) {
                ops.OP_bitand => " & ",
                ops.OP_bitor => " | ",
                ops.OP_bitxor => " ^ ",
                ops.OP_lshift => " << ",
                ops.OP_rshift => " >> ",
                else => " >>> ",
            });
        },
        ops.OP_bitnot => {
            try em.assign(i, false);
            try out.text("~");
            try em.reg(ir.src[i]);
        },
        ops.OP_unplus => {
            try em.assign(i, false);
            try out.text("rt.toNumeric(");
            try em.reg(ir.src[i]);
            try out.text(")");
        },
        ops.OP_negate => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try out.text("rt.negate(");
                try em.reg(ir.src[i]);
                try out.text(")");
            } else {
                try out.text("-");
                try em.reg(ir.src[i]);
            }
        },
        ops.OP_negate_i => {
            try em.assign(i, false);
            try out.text("-");
            try em.reg(ir.src[i]);
            try out.text(" | 0");
        },
        ops.OP_increment, ops.OP_decrement, ops.OP_inclocal, ops.OP_declocal => {
            const up = op == ops.OP_increment or op == ops.OP_inclocal;
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try out.text(if (up) "rt.increment(" else "rt.decrement(");
                try em.reg(ir.src[i]);
                try out.text(")");
            } else {
                try em.reg(ir.src[i]);
                try out.text(if (up) " + 1" else " - 1");
            }
        },
        ops.OP_increment_i, ops.OP_decrement_i, ops.OP_inclocal_i, ops.OP_declocal_i => {
            try em.assign(i, false);
            try em.reg(ir.src[i]);
            try out.text(if (op == ops.OP_increment_i or op == ops.OP_inclocal_i) " + 1 | 0" else " - 1 | 0");
        },
        ops.OP_not => {
            try em.assign(i, false);
            try out.text("!");
            try em.reg(ir.src[i]);
        },
        ops.OP_typeof => {
            try em.assign(i, false);
            try out.text("rt.typeOf(");
            try em.reg(ir.src[i]);
            try out.text(")");
        },
        ops.OP_equals, ops.OP_strictequals, ops.OP_lessthan, ops.OP_lessequals, ops.OP_greaterthan, ops.OP_greaterequals => {
            try em.assign(i, false);
            try values.compare(em, i, op, false);
        },
        ops.OP_convert_i,
        ops.OP_coerce_i,
        ops.OP_convert_u,
        ops.OP_coerce_u,
        ops.OP_convert_f,
        ops.OP_convert_d,
        ops.OP_coerce_d,
        ops.OP_convert_b,
        ops.OP_coerce_b,
        ops.OP_convert_s,
        ops.OP_coerce_s,
        ops.OP_coerce_a,
        ops.OP_coerce_o,
        ops.OP_coerce,
        ops.OP_convert_o,
        => {
            // A conversion that changes nothing, in place, is no code.
            const s = ir.src[i];
            if (ir.dst[i] == s and try values.keeps(em, values.conversionType(em, @truncate(op), i), em.regType[@intCast(s)])) {
                em.kept = true;
                return;
            }

            try em.assign(i, true);
            try values.conversion(em, i, @truncate(op), em.unboxedTarget(i));
        },
        ops.OP_jump => try em.goto(a),
        ops.OP_iftrue, ops.OP_iffalse => {
            try out.text(if (op == ops.OP_iftrue) "if (" else "if (!");
            try em.reg(ir.src[i]);
            try out.text(") { ");
            try em.goto(a);
            try em.space();
            try out.text("}");
        },
        ops.OP_ifeq,
        ops.OP_ifne,
        ops.OP_ifstricteq,
        ops.OP_ifstrictne,
        ops.OP_iflt,
        ops.OP_ifle,
        ops.OP_ifgt,
        ops.OP_ifge,
        ops.OP_ifnlt,
        ops.OP_ifnle,
        ops.OP_ifngt,
        ops.OP_ifnge,
        => try values.branch(em, i, @truncate(op)),
        ops.OP_lookupswitch => {
            // An index out of range, or not an int, takes the default.
            try out.text("switch (");
            try em.reg(ir.src[i]);
            try out.text(") {");
            const first = ir.b[i];
            var c: u32 = 0;
            while (c <= @as(u32, @bitCast(ir.c[i]))) : (c += 1) {
                try em.space();
                try out.text("case ");
                try out.uint(c);
                try out.text(": ");
                try em.goto(ir.cases[first + c]);
            }

            try em.space();
            try out.text("default: ");
            try em.goto(a);
            try em.space();
            try out.text("}");
        },
        ops.OP_returnvoid => try out.text("return"),
        ops.OP_returnvalue => {
            try out.text("return ");
            try em.reg(ir.src[i]);
        },
        ops.OP_throw => {
            try out.text("throw ");
            try em.reg(ir.src[i]);
        },
        else => {
            if (try objects.object(em, i, op)) {
                // One that only made a copy wrote nothing.
                if (em.kept) {
                    return;
                }
            } else if (copies.getsLocal(op)) {
                if (em.copies_(i, ir.src[i])) {
                    return;
                }

                try move(em, i, ir.src[i]);
            } else if (op >= ops.OP_setlocal0 and op < ops.OP_setlocal0 + 4) {
                try move(em, i, ir.src[i]);
            } else {
                // An instruction not lowered yet fails where it runs.
                try out.text("throw rt.unsupported(\"");
                try out.text(if (op < 256) ops.opcodeNames[op] else "ir");
                try out.text("\")");
            }
        },
    }

    if (em.unboxResult) {
        try out.text(")");
    }

    // A branch, switch or swap ends in its own `}` or `;`, or in the code
    // of a block written in place: no empty statement after it.
    const written = out.written();
    const last = if (written.len == 0) 0 else written[written.len - 1];
    if (!(structure.conditional(op) or op == ops.OP_jump or op == ops.OP_lookupswitch or op == ops.OP_swap)) {
        try out.text(";\n");
    } else if (last != '\n') {
        try out.text(if (last == '}' or last == ';') "\n" else ";\n");
    }

    if (em.resets) {
        em.resets = false;
        em.resetEnd = @intCast(out.len());
        em.resetMarks = em.map.count();
    }
}

/// Whether instruction op reads the register it null checks before anything
/// it does that can throw or be seen: before it, only the runtime's
/// methods, the module's tables and other registers. The check can then be
/// made where it reads it.
fn readsFirst(op: u16) bool {
    return switch (op) {
        ops.OP_getslot,
        ops.OP_setslot,
        ir_.IR_CallGetter,
        ir_.IR_CallSetter,
        ops.OP_callmethod,
        ir_.IR_CallInterface,
        ops.OP_getproperty,
        ops.OP_setproperty,
        ops.OP_initproperty,
        ops.OP_deleteproperty,
        ops.OP_callproperty,
        ops.OP_callproplex,
        ops.OP_callpropvoid,
        ops.OP_constructprop,
        ir_.IR_ConstructSlot,
        ops.OP_callsuper,
        ops.OP_callsupervoid,
        ir_.IR_CallSuper,
        ops.OP_getsuper,
        ops.OP_setsuper,
        ops.OP_callstatic,
        ops.OP_constructsuper,
        ops.OP_getdescendants,
        ops.OP_in,
        ops.OP_checkfilter,
        => true,
        else => false,
    };
}
