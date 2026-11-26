// One instruction's checks, as Verifier::verifyBlock makes them and in its
// order (assembly/avm2/abc/verify.ts): the operands that index the constant
// pool and the method's tables, the stack and scope depths, and what only
// some opcodes check; then its types (typing.zig), and for an instruction
// that wrote no IR of its own, the generic row the second pass writes.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const TYPE_Any = @import("../link/traits.zig").TYPE_Any;
const code_ = @import("code.zig");
const BodyDecoder = code_.BodyDecoder;
const C = @import("constants.zig");
const ops = @import("opcodes.zig");
const ConstantPool = @import("pool.zig").ConstantPool;
const typing = @import("typing.zig");

/// The IR of an instruction that wrote none of its own: its opcode reading
/// the values it popped, or the register it names, and writing what it
/// pushed; branches name their target blocks.
fn emitGeneric(bd: *BodyDecoder, pc: u32, opcode: u8, a: u32, b: u32, stackBefore: u32, scopeBefore: u32, pops: u32) Error!void {
    const base = bd.stackBase();
    var src: i32 = @bitCast(base +% stackBefore -% pops);
    var count = pops;
    var dst: i32 = if (bd.stack > stackBefore -% pops) @bitCast(base + bd.stack - 1) else -1;
    var ra = a;
    switch (opcode) {
        ops.OP_label, ops.OP_nop, ops.OP_bkpt, ops.OP_bkptline, ops.OP_timestamp => return,
        ops.OP_getlocal => {
            src = @bitCast(a);
            count = 1;
        },
        ops.OP_setlocal => dst = @bitCast(a),
        ops.OP_pushscope, ops.OP_pushwith => dst = @bitCast(bd.localCount + scopeBefore),
        ops.OP_popscope => {
            src = @bitCast(bd.localCount + scopeBefore -% 1);
            count = 1;
        },
        ops.OP_getscopeobject => {
            ra = bd.byteAt(pc + 1);
            src = @bitCast(bd.localCount + ra);
            count = 1;
        },
        // Slots count from 0 in the IR, as early bound ones do.
        ops.OP_getslot, ops.OP_setslot, ops.OP_getglobalslot, ops.OP_setglobalslot => ra = a -% 1,
        ops.OP_jump, ops.OP_iftrue, ops.OP_iffalse, ops.OP_ifeq, ops.OP_ifne, ops.OP_iflt, ops.OP_ifle, ops.OP_ifgt, ops.OP_ifge, ops.OP_ifstricteq, ops.OP_ifstrictne, ops.OP_ifnlt, ops.OP_ifnle, ops.OP_ifngt, ops.OP_ifnge => {
            ra = bd.blockOf[bd.slotNext[pc] +% @as(u32, @bitCast(bd.slotA[pc]))];
        },
        ops.OP_lookupswitch => {
            const ir = &bd.ir;
            const first = bd.slotC[pc];
            const cases = ir.caseCount;
            var i = first;
            while (i <= first + b) : (i += 1) {
                try ir.addCase(bd.blockOf[pc +% @as(u32, @bitCast(bd.code.cases[i]))]);
            }

            try bd.emit(opcode, -1, src, count, bd.blockOf[pc +% @as(u32, @bitCast(bd.slotA[pc]))], cases, @bitCast(b), pc);
            return;
        },
        else => {},
    }

    if (opcode >= ops.OP_getlocal0 and opcode < ops.OP_getlocal0 + 4) {
        src = opcode - ops.OP_getlocal0;
        count = 1;
    } else if (opcode >= ops.OP_setlocal0 and opcode < ops.OP_setlocal0 + 4) {
        dst = opcode - ops.OP_setlocal0;
    }

    try bd.emit(opcode, dst, src, count, ra, b, bd.rowC, pc);
}

/// The checks of the instruction at `pc` in Verifier::verifyBlock, in the
/// verifier's order, and its effect on the stack and scope depths and, when
/// typed, on the values; false after recording the error.
pub fn verifyAt(bd: *BodyDecoder, pc: u32, opcode: u8) Error!bool {
    const pool = &bd.abc.pool;
    const a: u32 = @bitCast(bd.slotA[pc]);
    const b = bd.slotB[pc];
    const stack = ops.opcodeStack[opcode];
    var pops: u64 = ops.opcodePops[opcode];
    const pushes: u64 = ops.opcodePushes[opcode];
    const checkPushes: u64 = if (stack & ops.STACK_CheckPushOne != 0) 1 else pushes;

    // A name looked up in the scope chain needs a scope to look in.
    if (bd.typed and
        (opcode == ops.OP_getlex or opcode == ops.OP_findpropstrict or opcode == ops.OP_findproperty) and
        bd.scope + bd.outer.size == 0)
    {
        return bd.fail(C.kFindVarWithNoScopeError);
    }

    // Operands that index the pool or the method tables, checked before the stack.
    if (stack & ops.STACK_Multiname != 0) {
        if (a == 0 or a >= pool.multinameCount()) {
            return bd.fail(C.kCpoolIndexRangeError);
        }

        pops += runtimeParts(pool, a);
    }

    if (stack & ops.STACK_ArgcA != 0) {
        pops += a;
    } else if (stack & ops.STACK_ArgcB != 0) {
        pops += b;
    }

    switch (opcode) {
        ops.OP_newobject => pops = @as(u64, a) * 2,
        ops.OP_newarray => pops = a,
        ops.OP_callstatic => {
            if (a >= bd.abc.methodCount() or !callable(bd, a)) {
                return bd.fail(C.kCorruptABCError);
            }
        },
        ops.OP_dxns => {
            if (bd.methodFlags & C.METHOD_SetsDxns == 0) {
                return bd.fail(C.kIllegalSetDxns);
            }

            if (bd.emitPass) {
                try bd.emit(opcode, -1, -1, 0, a, 0, 0, pc);
            }

            return bd.checkString(a);
        },
        ops.OP_debugfile => {
            if (bd.emitPass) {
                try bd.emit(opcode, -1, -1, 0, a, 0, 0, pc);
            }

            return bd.checkString(a);
        },
        ops.OP_kill => {
            if (!bd.checkLocal(a)) {
                return false;
            }

            if (bd.typed) {
                bd.setValue(a, TYPE_Any, 0);
            }

            if (bd.emitPass) {
                try bd.emit(opcode, @bitCast(a), -1, 0, a, 0, 0, pc);
            }

            return true;
        },
        ops.OP_inclocal, ops.OP_declocal, ops.OP_inclocal_i, ops.OP_declocal_i => {
            if (!bd.checkLocal(a)) {
                return false;
            }

            if (bd.typed) {
                const integer = opcode == ops.OP_inclocal_i or opcode == ops.OP_declocal_i;
                const numeric = typing.numericType(bd, bd.typeOf(a));
                if (!integer and bd.abc.hasFloatSupport() and numeric != bd.domain.numberType) {
                    bd.retype(a, numeric);
                } else {
                    try bd.coerce(a, if (integer) bd.domain.intType else bd.domain.numberType);
                }
            }

            if (bd.emitPass) {
                try bd.emit(opcode, @bitCast(a), @bitCast(a), 1, a, 0, 0, pc);
            }

            return true;
        },
        ops.OP_popscope => {
            if (bd.scope == 0) {
                return bd.fail(C.kScopeStackUnderflowError);
            }

            bd.scope -= 1;
            if (bd.emitPass) {
                try bd.emit(opcode, -1, @bitCast(bd.localCount + bd.scope), 1, 0, 0, 0, pc);
            }

            return true;
        },
        ops.OP_setglobalslot => {
            if (bd.typed and bd.scope == 0 and bd.outer.size == 0) {
                return bd.fail(C.kNoGlobalScopeError);
            }
        },
        else => {},
    }

    if (bd.stack < pops) {
        return bd.fail(C.kStackUnderflowError);
    }

    if (bd.stack - pops + checkPushes > bd.maxStack) {
        return bd.fail(C.kStackOverflowError);
    }

    const scopeBefore = bd.scope;
    if (!verifySpecial(bd, pc, opcode, a, b)) {
        return false;
    }

    bd.emitted = false;
    bd.rowC = 0;
    bd.pc = pc;
    if (bd.typed and !try typing.typeAt(bd, pc, opcode, a, b, scopeBefore)) {
        return false;
    }

    const stackBefore = bd.stack;
    bd.stack = @intCast(bd.stack - pops + pushes);
    if (bd.emitPass and !bd.emitted) {
        try emitGeneric(bd, pc, opcode, a, b, stackBefore, scopeBefore, @intCast(pops));
    }

    return true;
}

/// The checks after the stack check that only some opcodes have.
fn verifySpecial(bd: *BodyDecoder, pc: u32, opcode: u8, a: u32, b: u32) bool {
    const abc = bd.abc;
    const pool = &abc.pool;
    if (opcode >= ops.OP_getlocal0 and opcode < ops.OP_getlocal0 + 4) {
        return bd.checkLocal(opcode - ops.OP_getlocal0);
    }

    if (opcode >= ops.OP_setlocal0 and opcode < ops.OP_setlocal0 + 4) {
        return bd.checkLocal(opcode - ops.OP_setlocal0);
    }

    return switch (opcode) {
        ops.OP_getlocal, ops.OP_setlocal => bd.checkLocal(a),
        ops.OP_hasnext2 => {
            if (!bd.checkLocal(a) or !bd.checkLocal(b)) {
                return false;
            }

            return if (a == b) bd.fail(C.kInvalidHasNextError) else true;
        },
        ops.OP_pushstring => bd.checkString(a),
        ops.OP_pushint => if (a == 0 or a >= pool.ints.len) bd.fail(C.kCpoolIndexRangeError) else true,
        ops.OP_pushuint => if (a == 0 or a >= pool.uints.len) bd.fail(C.kCpoolIndexRangeError) else true,
        ops.OP_pushfloat => if (a == 0 or a >= pool.floats.len) bd.fail(C.kCpoolIndexRangeError) else true,
        ops.OP_pushdouble => if (a == 0 or a >= pool.doubles.len) bd.fail(C.kCpoolIndexRangeError) else true,
        ops.OP_pushnamespace => if (a == 0 or a >= pool.nsCount()) bd.fail(C.kCpoolIndexRangeError) else true,
        ops.OP_dxnslate => if (bd.methodFlags & C.METHOD_SetsDxns != 0) true else bd.fail(C.kIllegalSetDxns),
        ops.OP_getlex => if (runtimeParts(pool, a) != 0) bd.fail(C.kIllegalOpMultinameError) else true,
        ops.OP_finddef => if (code_.isBinding(pool, a)) true else bd.fail(C.kIllegalOpMultinameError),
        ops.OP_callproperty, ops.OP_callproplex, ops.OP_callpropvoid, ops.OP_constructprop, ops.OP_callsuper, ops.OP_callsupervoid, ops.OP_getsuper, ops.OP_setsuper => {
            return if (isAttribute(pool, a)) bd.fail(C.kIllegalOpMultinameError) else true;
        },
        ops.OP_newfunction => if (a >= abc.methodCount()) bd.fail(C.kMethodInfoExceedsCountError) else true,
        ops.OP_newclass => if (a >= abc.classCount()) bd.fail(C.kClassInfoExceedsCountError) else true,
        ops.OP_newactivation => if (bd.methodFlags & C.METHOD_NeedActivation != 0) true else bd.fail(C.kInvalidNewActivationError),
        ops.OP_newcatch => if (a >= bd.handlerCount) bd.fail(C.kInvalidNewActivationError) else true,
        ops.OP_pushscope, ops.OP_pushwith => {
            if (bd.scope + 1 > bd.maxScope) {
                return bd.fail(C.kScopeStackOverflowError);
            }

            bd.scope += 1;
            return true;
        },
        // The verifier reads the index as the operand's first byte.
        ops.OP_getscopeobject => if (bd.byteAt(pc + 1) >= bd.scope) bd.failWith(C.kGetScopeObjectBoundsError, bd.byteAt(pc + 1)) else true,
        else => true,
    };
}

/// Whether method `m` of the ABC may be called statically: without types
/// any may; with them, as avmplus' AbcEnv (verify.ts tells which).
fn callable(bd: *BodyDecoder, m: u32) bool {
    if (!bd.typed) {
        return true;
    }

    const domain = bd.domain;
    return domain.staticallyCallable(domain.methodStart.get(bd.index) + m);
}

/// Values a multiname takes from the stack: a runtime namespace, a runtime name, or both.
fn runtimeParts(pool: *const ConstantPool, index: u32) u32 {
    const kind = pool.mnKind[index];
    if (kind == C.CONSTANT_RTQname or kind == C.CONSTANT_RTQnameA or kind == C.CONSTANT_MultinameL or kind == C.CONSTANT_MultinameLA) {
        return 1;
    }

    return if (kind == C.CONSTANT_RTQnameL or kind == C.CONSTANT_RTQnameLA) 2 else 0;
}

fn isAttribute(pool: *const ConstantPool, index: u32) bool {
    const kind = pool.mnKind[index];
    return kind == C.CONSTANT_QnameA or kind == C.CONSTANT_RTQnameA or kind == C.CONSTANT_RTQnameLA or kind == C.CONSTANT_MultinameA or kind == C.CONSTANT_MultinameLA;
}
