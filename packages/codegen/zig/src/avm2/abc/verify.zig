// One instruction's checks, as Verifier::verifyBlock makes them and in its
// order: the operands that index the constant
// pool and the method's tables, the stack and scope depths, and what only
// some opcodes check; then its types (typing.zig), and for an instruction
// that wrote no IR of its own, the generic row the second pass writes.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const TYPE_Any = @import("../link/traits.zig").TYPE_Any;
const code_ = @import("code.zig");
const BodyDecoder = code_.BodyDecoder;
const C = @import("constants.zig");
const ConstantPool = @import("pool.zig").ConstantPool;
const typing = @import("typing.zig");
const Op = @import("opcodes.zig").Op;
const ir_ = @import("../ir/ir.zig");

/// The IR of an instruction that wrote none of its own: its opcode reading
/// the values it popped, or the register it names, and writing what it
/// pushed; branches name their target blocks.
fn emitGeneric(bd: *BodyDecoder, pc: u32, opcode: Op, a: u32, b: u32, stackBefore: u32, scopeBefore: u32, pops: u32) Error!void {
    const base = bd.stackBase();
    var src: i32 = @bitCast(base +% stackBefore -% pops);
    var count = pops;
    var dst: i32 = if (bd.stack > stackBefore -% pops) @bitCast(base + bd.stack - 1) else -1;
    var ra = a;
    switch (opcode) {
        .label, .nop, .bkpt, .bkptline, .timestamp => return,
        .getlocal => {
            src = @bitCast(a);
            count = 1;
        },
        .setlocal => dst = @bitCast(a),
        .pushscope, .pushwith => dst = @bitCast(bd.localCount + scopeBefore),
        .popscope => {
            src = @bitCast(bd.localCount + scopeBefore -% 1);
            count = 1;
        },
        .getscopeobject => {
            ra = bd.byteAt(pc + 1);
            src = @bitCast(bd.localCount + ra);
            count = 1;
        },
        // Slots count from 0 in the IR, as early bound ones do.
        .getslot, .setslot, .getglobalslot, .setglobalslot => ra = a -% 1,
        .jump, .iftrue, .iffalse, .ifeq, .ifne, .iflt, .ifle, .ifgt, .ifge, .ifstricteq, .ifstrictne, .ifnlt, .ifnle, .ifngt, .ifnge => {
            ra = bd.blockOf[bd.slotNext[pc] +% @as(u32, @bitCast(bd.slotA[pc]))];
        },
        .lookupswitch => {
            const ir = &bd.ir;
            const first = bd.slotC[pc];
            const cases = ir.caseCount;
            var i = first;
            while (i <= first + b) : (i += 1) {
                try ir.addCase(bd.blockOf[pc +% @as(u32, @bitCast(bd.code.cases[i]))]);
            }

            try bd.emit(ir_.of(opcode), -1, src, count, bd.blockOf[pc +% @as(u32, @bitCast(bd.slotA[pc]))], cases, @bitCast(b), pc);
            return;
        },
        else => {},
    }

    if (opcode.getLocalN()) |local| {
        src = @intCast(local);
        count = 1;
    } else if (opcode.setLocalN()) |local| {
        dst = @intCast(local);
    }

    try bd.emit(ir_.of(opcode), dst, src, count, ra, b, bd.rowC, pc);
}

/// The checks of the instruction at `pc` in Verifier::verifyBlock, in the
/// verifier's order, and its effect on the stack and scope depths and, when
/// typed, on the values; false after recording the error.
pub fn verifyAt(bd: *BodyDecoder, pc: u32, opcode: Op) Error!bool {
    const pool = &bd.abc.pool;
    const a: u32 = @bitCast(bd.slotA[pc]);
    const b = bd.slotB[pc];
    const info = opcode.info();
    const stack = info.stack;
    var pops: u64 = info.pops;
    const pushes: u64 = info.pushes;
    const checkPushes: u64 = if (stack.check_push_one) 1 else pushes;

    // A name looked up in the scope chain needs a scope to look in.
    if (bd.typed and
        (opcode == .getlex or opcode == .findpropstrict or opcode == .findproperty) and
        bd.scope + bd.outer.size == 0)
    {
        return bd.fail(C.kFindVarWithNoScopeError);
    }

    // Operands that index the pool or the method tables, checked before the stack.
    if (stack.multiname) {
        if (a == 0 or a >= pool.multinameCount()) {
            return bd.fail(C.kCpoolIndexRangeError);
        }

        pops += runtimeParts(pool, a);
    }

    if (stack.argc_a) {
        pops += a;
    } else if (stack.argc_b) {
        pops += b;
    }

    switch (opcode) {
        .newobject => pops = @as(u64, a) * 2,
        .newarray => pops = a,
        .callstatic => {
            if (a >= bd.abc.methodCount() or !callable(bd, a)) {
                return bd.fail(C.kCorruptABCError);
            }
        },
        .dxns => {
            if (!bd.methodFlags.sets_dxns) {
                return bd.fail(C.kIllegalSetDxns);
            }

            if (bd.emitPass) {
                try bd.emit(ir_.of(opcode), -1, -1, 0, a, 0, 0, pc);
            }

            return bd.checkString(a);
        },
        .debugfile => {
            if (bd.emitPass) {
                try bd.emit(ir_.of(opcode), -1, -1, 0, a, 0, 0, pc);
            }

            return bd.checkString(a);
        },
        .kill => {
            if (!bd.checkLocal(a)) {
                return false;
            }

            if (bd.typed) {
                bd.setValue(a, TYPE_Any, 0);
            }

            if (bd.emitPass) {
                try bd.emit(ir_.of(opcode), @bitCast(a), -1, 0, a, 0, 0, pc);
            }

            return true;
        },
        .inclocal, .declocal, .inclocal_i, .declocal_i => {
            if (!bd.checkLocal(a)) {
                return false;
            }

            if (bd.typed) {
                const integer = opcode == .inclocal_i or opcode == .declocal_i;
                const numeric = typing.numericType(bd, bd.typeOf(a));
                if (!integer and bd.abc.hasFloatSupport() and numeric != bd.domain.numberType) {
                    bd.retype(a, numeric);
                } else {
                    try bd.coerce(a, if (integer) bd.domain.intType else bd.domain.numberType);
                }
            }

            if (bd.emitPass) {
                try bd.emit(ir_.of(opcode), @bitCast(a), @bitCast(a), 1, a, 0, 0, pc);
            }

            return true;
        },
        .popscope => {
            if (bd.scope == 0) {
                return bd.fail(C.kScopeStackUnderflowError);
            }

            bd.scope -= 1;
            if (bd.emitPass) {
                try bd.emit(ir_.of(opcode), -1, @bitCast(bd.localCount + bd.scope), 1, 0, 0, 0, pc);
            }

            return true;
        },
        .setglobalslot => {
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
fn verifySpecial(bd: *BodyDecoder, pc: u32, opcode: Op, a: u32, b: u32) bool {
    const abc = bd.abc;
    const pool = &abc.pool;
    if (opcode.getLocalN() orelse opcode.setLocalN()) |local| {
        return bd.checkLocal(local);
    }

    return switch (opcode) {
        .getlocal, .setlocal => bd.checkLocal(a),
        .hasnext2 => {
            if (!bd.checkLocal(a) or !bd.checkLocal(b)) {
                return false;
            }

            return if (a == b) bd.fail(C.kInvalidHasNextError) else true;
        },
        .pushstring => bd.checkString(a),
        .pushint => if (a == 0 or a >= pool.ints.len) bd.fail(C.kCpoolIndexRangeError) else true,
        .pushuint => if (a == 0 or a >= pool.uints.len) bd.fail(C.kCpoolIndexRangeError) else true,
        .pushfloat => if (a == 0 or a >= pool.floats.len) bd.fail(C.kCpoolIndexRangeError) else true,
        .pushdouble => if (a == 0 or a >= pool.doubles.len) bd.fail(C.kCpoolIndexRangeError) else true,
        .pushnamespace => if (a == 0 or a >= pool.nsCount()) bd.fail(C.kCpoolIndexRangeError) else true,
        .dxnslate => if (bd.methodFlags.sets_dxns) true else bd.fail(C.kIllegalSetDxns),
        .getlex => if (runtimeParts(pool, a) != 0) bd.fail(C.kIllegalOpMultinameError) else true,
        .finddef => if (code_.isBinding(pool, a)) true else bd.fail(C.kIllegalOpMultinameError),
        .callproperty, .callproplex, .callpropvoid, .constructprop, .callsuper, .callsupervoid, .getsuper, .setsuper => {
            return if (isAttribute(pool, a)) bd.fail(C.kIllegalOpMultinameError) else true;
        },
        .newfunction => if (a >= abc.methodCount()) bd.fail(C.kMethodInfoExceedsCountError) else true,
        .newclass => if (a >= abc.classCount()) bd.fail(C.kClassInfoExceedsCountError) else true,
        .newactivation => if (bd.methodFlags.need_activation) true else bd.fail(C.kInvalidNewActivationError),
        .newcatch => if (a >= bd.handlerCount) bd.fail(C.kInvalidNewActivationError) else true,
        .pushscope, .pushwith => {
            if (bd.scope + 1 > bd.maxScope) {
                return bd.fail(C.kScopeStackOverflowError);
            }

            bd.scope += 1;
            return true;
        },
        // The verifier reads the index as the operand's first byte.
        .getscopeobject => if (bd.byteAt(pc + 1) >= bd.scope) bd.failWith(C.kGetScopeObjectBoundsError, bd.byteAt(pc + 1)) else true,
        else => true,
    };
}

/// Whether method `m` of the ABC may be called statically: without types
/// any may, as the structural checks cannot tell; with them, as avmplus'
/// AbcEnv, one bound to a traits by a method, getter or setter, or a
/// class's or its instances' initializer.
fn callable(bd: *BodyDecoder, m: u32) bool {
    if (!bd.typed) {
        return true;
    }

    const domain = bd.domain;
    return domain.staticallyCallable(domain.methodStart.get(bd.index) + m);
}

/// Values a multiname takes from the stack: a runtime namespace, a runtime name, or both.
fn runtimeParts(pool: *const ConstantPool, index: u32) u32 {
    return switch (pool.multiname(index)) {
        .rtqname, .multiname_late => 1,
        .rtqname_late => 2,
        .none, .qname, .multiname, .type_name => 0,
    };
}

fn isAttribute(pool: *const ConstantPool, index: u32) bool {
    return pool.multiname(index).isAttribute();
}
