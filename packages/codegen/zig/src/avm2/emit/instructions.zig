// The method emitter's instructions (assembly/avm2/emit/instructions.ts):
// constants, locals and the stack, arithmetic, comparisons and conversions,
// branches, returns and throws, each as a JavaScript statement; those of
// the object model are in objects.zig. A null check is made where the
// instruction after it first reads the register, if it reads it first.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const ops = @import("../abc/opcodes.zig");
const ir_ = @import("../ir/ir.zig");
const copies = @import("copies.zig");
const CONSTANT = copies.CONSTANT;
const NONE = copies.NONE;
const floats = @import("floats.zig");
const MethodEmitter = @import("method.zig").MethodEmitter;
const objects = @import("objects.zig");
const refs = @import("refs.zig");
const structure = @import("structure.zig");
const values = @import("values.zig");
const IrOp = @import("../ir/ir.zig").Op;

fn floatArithmetic(em: *const MethodEmitter, i: u32) bool {
    const ty = ir_.columnType(em.ir.type[i]);
    return em.abc.hasFloatSupport() and (ty == .any or ty == em.domain.floatType);
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
        .pushbyte, .pushshort => {
            try em.assign(i, false);
            try out.int(@as(i32, @bitCast(a)));
        },
        .pushint => {
            try em.assign(i, false);
            try out.int(em.abc.pool.ints[a]);
        },
        .pushuint => {
            try em.assign(i, false);
            try out.uint(em.abc.pool.uints[a]);
        },
        .pushfloat => {
            try em.assign(i, false);
            try out.text("rt.float(");
            try out.double(em.abc.pool.floats[a]);
            try out.text(")");
        },
        .pushdouble => {
            try em.assign(i, false);
            try out.double(em.abc.pool.doubles[a]);
        },
        .pushnan => {
            try em.assign(i, false);
            try out.text("NaN");
        },
        .pushstring => {
            try em.assign(i, false);
            try refs.poolString(em, a);
        },
        .pushtrue => {
            try em.assign(i, false);
            try out.text("true");
        },
        .pushfalse => {
            try em.assign(i, false);
            try out.text("false");
        },
        .pushnull => {
            try em.assign(i, false);
            try out.text("null");
        },
        .pushnamespace => {
            try em.assign(i, false);
            try out.text("rt.namespace(N[");
            try out.uint(a);
            try out.text("])");
        },
        .pushundefined => {
            try em.assign(i, false);
            try out.text("void 0");
        },
        .getlocal, .setlocal, .dup => {
            if (em.copies_(i, ir.src[i])) {
                return;
            }

            try move(em, i, ir.src[i]);
        },
        .kill => try em.reset(ir.dst[i]),
        .swap => {
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
        .debugfile => {
            em.file = @bitCast(a);
            return;
        },
        .debugline => {
            em.line = a;
            try em.mark();
            return;
        },
        .pop, .debug => return,
        .ir_coerce => {
            const s = ir.src[i];
            if (ir.dst[i] == s and try values.keeps(em, ir.c[i], em.regType[@intCast(s)])) {
                em.kept = true;
                return;
            }

            try em.assign(i, true);
            try values.convert(em, "", s, ir.c[i], em.regType[@intCast(s)], em.unboxedTarget(i));
        },
        .ir_check_null => {
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
                ir.op[next] == .ir_coerce and
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
        .add => {
            try em.assign(i, false);
            if ((values.isNumeric(em, em.src(i, 0)) and values.isNumeric(em, em.src(i, 1))) or values.concatenates(em, i)) {
                try values.binary(em, i, " + ");
            } else {
                try values.call2(em, "rt.add(", i);
            }
        },
        .subtract => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try values.call2(em, "rt.subtract(", i);
            } else {
                try values.binary(em, i, " - ");
            }
        },
        .multiply => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try values.call2(em, "rt.multiply(", i);
            } else if (values.wraps(em, i)) {
                try values.call2(em, "Math.imul(", i);
            } else {
                try values.binary(em, i, " * ");
            }
        },
        .divide => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try values.call2(em, "rt.divide(", i);
            } else {
                try values.binary(em, i, " / ");
            }
        },
        .modulo => {
            try em.assign(i, false);
            if (floatArithmetic(em, i)) {
                try values.call2(em, "rt.modulo(", i);
            } else {
                try values.binary(em, i, " % ");
            }
        },
        .add_i => {
            try em.assign(i, false);
            try values.binaryInt(em, i, " + ");
        },
        .subtract_i => {
            try em.assign(i, false);
            try values.binaryInt(em, i, " - ");
        },
        .multiply_i => {
            // int multiplication wraps as Math.imul does, not as a double product.
            try em.assign(i, false);
            try values.call2(em, "Math.imul(", i);
        },
        .bitand, .bitor, .bitxor, .lshift, .rshift, .urshift => {
            try em.assign(i, false);
            try values.binary(em, i, switch (op) {
                .bitand => " & ",
                .bitor => " | ",
                .bitxor => " ^ ",
                .lshift => " << ",
                .rshift => " >> ",
                else => " >>> ",
            });
        },
        .bitnot => {
            try em.assign(i, false);
            try out.text("~");
            try em.reg(ir.src[i]);
        },
        .unplus => {
            try em.assign(i, false);
            try out.text("rt.toNumeric(");
            try em.reg(ir.src[i]);
            try out.text(")");
        },
        .negate => {
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
        .negate_i => {
            try em.assign(i, false);
            try out.text("-");
            try em.reg(ir.src[i]);
            try out.text(" | 0");
        },
        .increment, .decrement, .inclocal, .declocal => {
            const up = op == .increment or op == .inclocal;
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
        .increment_i, .decrement_i, .inclocal_i, .declocal_i => {
            try em.assign(i, false);
            try em.reg(ir.src[i]);
            try out.text(if (op == .increment_i or op == .inclocal_i) " + 1 | 0" else " - 1 | 0");
        },
        .not => {
            try em.assign(i, false);
            try out.text("!");
            try em.reg(ir.src[i]);
        },
        .typeof => {
            try em.assign(i, false);
            try out.text("rt.typeOf(");
            try em.reg(ir.src[i]);
            try out.text(")");
        },
        .equals, .strictequals, .lessthan, .lessequals, .greaterthan, .greaterequals => {
            try em.assign(i, false);
            try values.compare(em, i, op, false);
        },
        .convert_i,
        .coerce_i,
        .convert_u,
        .coerce_u,
        .convert_f,
        .convert_d,
        .coerce_d,
        .convert_b,
        .coerce_b,
        .convert_s,
        .coerce_s,
        .coerce_a,
        .coerce_o,
        .coerce,
        .convert_o,
        => {
            // A conversion that changes nothing, in place, is no code.
            const s = ir.src[i];
            if (ir.dst[i] == s and try values.keeps(em, values.conversionType(em, op, i), em.regType[@intCast(s)])) {
                em.kept = true;
                return;
            }

            try em.assign(i, true);
            try values.conversion(em, i, op, em.unboxedTarget(i));
        },
        .jump => try em.goto(a),
        .iftrue, .iffalse => {
            try out.text(if (op == .iftrue) "if (" else "if (!");
            try em.reg(ir.src[i]);
            try out.text(") { ");
            try em.goto(a);
            try em.space();
            try out.text("}");
        },
        .ifeq,
        .ifne,
        .ifstricteq,
        .ifstrictne,
        .iflt,
        .ifle,
        .ifgt,
        .ifge,
        .ifnlt,
        .ifnle,
        .ifngt,
        .ifnge,
        => try values.branch(em, i, op),
        .lookupswitch => {
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
        .returnvoid => try out.text("return"),
        .returnvalue => {
            try out.text("return ");
            try em.reg(ir.src[i]);
        },
        .throw => {
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
            } else if (ir_.opcodeIs(op, isSetLocalN)) {
                try move(em, i, ir.src[i]);
            } else {
                // An instruction not lowered yet fails where it runs.
                try out.text("throw rt.unsupported(\"");
                try out.text(ir_.opcodeName(op));
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
    if (!(structure.conditional(op) or op == .jump or op == .lookupswitch or op == .swap)) {
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
fn readsFirst(op: IrOp) bool {
    return switch (op) {
        .getslot,
        .setslot,
        .ir_call_getter,
        .ir_call_setter,
        .callmethod,
        .ir_call_interface,
        .getproperty,
        .setproperty,
        .initproperty,
        .deleteproperty,
        .callproperty,
        .callproplex,
        .callpropvoid,
        .constructprop,
        .ir_construct_slot,
        .callsuper,
        .callsupervoid,
        .ir_call_super,
        .getsuper,
        .setsuper,
        .callstatic,
        .constructsuper,
        .getdescendants,
        .in,
        .checkfilter,
        => true,
        else => false,
    };
}

fn isSetLocalN(op: ops.Op) bool {
    return op.setLocalN() != null;
}
