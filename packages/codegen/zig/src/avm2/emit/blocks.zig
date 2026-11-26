// Writes the method's blocks, an instruction at a time, from each one's
// entry state (assembly/avm2/emit/blocks.ts, whose comments tell each part):
// the copies an instruction's write would change written first, a value the
// next instruction only moves to a local assigned to it there, and before a
// branch, the copies its target needs and does not know (see copies.zig).
const std = @import("std");
const Error = std.mem.Allocator.Error;
const traits_ = @import("../link/traits.zig");
const TypeId = traits_.TypeId;
const copies = @import("copies.zig");
const NONE = copies.NONE;
const handlers = @import("handlers.zig");
const instructions = @import("instructions.zig");
const MethodEmitter = @import("method.zig").MethodEmitter;
const structure = @import("structure.zig");
const values = @import("values.zig");
const ir_ = @import("../ir/ir.zig");
const IrOp = ir_.Op;

fn u(r: i32) usize {
    return @intCast(r);
}

/// Write block k: its case label, then its instructions, following register types.
pub fn block(em: *MethodEmitter, k: u32) Error!void {
    try em.out.text("case ");
    try em.out.uint(k);
    try em.out.text(":\n");
    try blockBody(em, k);
}

/// Block k's instructions, following register types from its entry state.
pub fn blockBody(em: *MethodEmitter, k: u32) Error!void {
    const out = &em.out;
    const ir = em.ir;
    const entry = k * ir.frameSize;
    em.clearRaw(0);
    em.resetEnd = -1;
    @memcpy(em.regType[0..ir.frameSize], ir.entryType[entry..][0..ir.frameSize]);

    em.scopeDepth = ir.blockScope[k];
    for (0..em.scopeDepth) |d| {
        em.scopeWith[d] = @intFromBool(ir.entryFlags[entry + ir.localCount + d].with);
    }

    // A block may be entered from any region, so it sets its own first.
    const handled = ir.handlerCount > 0;
    em.region = -1;
    const last = if (k + 1 < ir.blockCount) ir.blockFirst[k + 1] else ir.count;
    const stack: i32 = @intCast(ir.localCount + ir.maxScope);
    // Every way in wrote the copies the block does not know; one written in
    // place keeps what the code before it checked (blocks.ts tells why).
    const base = ir.localCount;
    const slots = ir.frameSize - base;
    @memcpy(em.copyOf[base..ir.frameSize], em.copyIn[k * slots ..][0..slots]);

    em.recount();

    @memset(em.promoted[0..ir.frameSize], 0);
    if (!em.inPlace) {
        @memset(em.checked[0..ir.frameSize], 0);
    }

    em.inPlace = false;
    em.drop(0);
    em.pendingNull = -1;
    em.file = em.blockFile[k];
    em.line = em.blockLine[k];
    try em.mark();
    var i = ir.blockFirst[k];
    while (i < last) : (i += 1) {
        const op = ir.op[i];
        const dst = ir.dst[i];
        // A branch's code written in place is another block's: this one's end, for each instruction.
        em.blockLast = last;
        const promotes = em.promotes(i);
        // What the instruction writes is copied first by the registers
        // copying it, but for those it takes; and what a branch leaves on
        // the stack is written, for the block it goes to.
        const frame: i32 = @intCast(ir.frameSize);
        const pops = stackDiscipline(op) and ir.srcCount[i] > 0 and ir.src[i] >= stack;
        if (dst >= 0 and !try keptAt(em, i, em.regType[u(dst)])) {
            // Above a push nothing is live to copy it.
            const push = dst >= stack and stackDiscipline(op);
            try copyAll(em, dst, if (pops) ir.src[i] else if (push) dst else frame);
        }

        if (op == .hasnext2) {
            try copyAll(em, @bitCast(ir.a[i]), frame);
            try copyAll(em, @bitCast(ir.b[i]), frame);
        } else if (op == .popscope or op == .swap) {
            try copyAll(em, ir.src[i], frame);
        } else if (structure.conditional(op)) {
            try boxRaw(em, ir.src[i]);
            try copyFor(em, ir.a[i], ir.src[i]);
        } else if (op == .lookupswitch) {
            try boxRaw(em, ir.src[i]);
            try copyFor(em, ir.a[i], ir.src[i]);
            var c: u32 = 0;
            while (c <= ir.cLastCase(i)) : (c += 1) {
                try copyFor(em, ir.cases[ir.b[i] + c], ir.src[i]);
            }
        } else if (op == .jump) {
            try boxRaw(em, frame);
            try copyFor(em, ir.a[i], frame);
        }

        // A swap of two values neither of which is written yet, copies or
        // held texts, swaps what the registers stand for and writes nothing.
        // Not with float's raw values, which a branch boxes by register.
        if (op == .swap and !em.abc.hasFloatSupport() and em.pendingNull < 0) {
            // Where one is written, it is written to the other register: a
            // text that reads that register is written first.
            const x = ir.src[i];
            if (virtual(em, x) != virtual(em, x + 1)) {
                try em.clobber(if (virtual(em, x)) x else x + 1, -1, -1);
            }

            if (virtual(em, x) or virtual(em, x + 1)) {
                try swapVirtual(em, x);
                continue;
            }
        }

        // A value the next instruction only moves to a local or scope goes
        // there straight, if the instruction assigns it; one it duplicates to
        // set a local goes to the local, and stays on the stack as its copy.
        // Conversions between that change nothing write nothing either.
        em.target = -1;
        var moves: u32 = 0;
        var duplicated = false;
        const floatType = em.domain.floatType;
        if (dst >= stack and op != .hasnext2) {
            var n = i + 1;
            var ty = ir.type[i];
            while (n < last) {
                if (ty.isBuiltin(floatType) and debugRecord(ir.op[n])) {
                    n += 1;
                } else if (ir.dst[n] == dst and try keptAt(em, n, ty)) {
                    ty = ir.type[n];
                    n += 1;
                } else {
                    break;
                }
            }

            if (n < last and ir.src[n] == dst) {
                const next = ir.op[n];
                if (copies.setsLocal(next) or next == .pushscope) {
                    moves = n - i;
                } else if (next == .dup) {
                    var set = n + 1;
                    while (set < last and ty.isBuiltin(floatType)) {
                        if (debugRecord(ir.op[set])) {
                            set += 1;
                        } else if (ir.dst[set] == dst + 1 and try keptAt(em, set, ty)) {
                            ty = ir.type[set];
                            set += 1;
                        } else {
                            break;
                        }
                    }

                    if (set < last and
                        copies.setsLocal(ir.op[set]) and
                        ir.src[set] == dst + 1 and
                        (set == n + 1 or em.unboxedLocal(ir.dst[set])))
                    {
                        moves = set - i;
                        duplicated = true;
                    }
                }
            }
        }

        if (moves != 0) {
            // After them, the stack is as far as dst: what is there on, the instruction takes.
            em.target = ir.dst[i + moves];
            try copyAll(em, em.target, dst);
        }

        if (handled) {
            const region = handlers.regionOf(em, ir.pc[i]);
            if (region != em.region) {
                try out.text("t = ");
                try out.int(region);
                try out.text(";\n");
                em.region = region;
                if (em.structured and !structure.enclosed(em, region)) {
                    em.unenclosed = true;
                }
            }
        }

        if (em.heldCount != 0) {
            try releaseFor(em, i);
        }

        // A pure value on the stack is held, not written, for what reads it:
        // not a float, which may stay raw (MethodEmitter.rawFloat).
        const holds = dst >= stack and
            em.target < 0 and
            em.pendingNull < 0 and
            ir.type[i] != floatType and
            pureValue(em, i);
        const start = out.len();
        const marks = em.map.count();
        em.readLow = std.math.maxInt(i32);
        em.readHigh = -1;

        // A branch's own target, written in place, sinks its own values: only
        // an instruction given a local here can have assigned it.
        const sinking = em.target;
        em.kept = false;
        em.sunk = false;
        try instructions.instruction(em, i);
        if (!em.kept and dst >= stack) {
            if (holds and
                !em.rawResult and
                !em.unboxResult and
                em.map.count() == marks and
                em.pendingNull < 0 and
                try em.hold(dst, start))
            {
                // Held: written nowhere.
            } else {
                // A value nothing read, overwritten.
                em.forget(dst);
            }
        }

        if (em.pendingNull >= 0 and i >= em.pendingUntil) {
            try em.unpend();
        }

        unchecks(em, i);
        em.target = -1;
        if (structure.conditional(op) or op == .jump or op == .lookupswitch) {
            em.clearRaw(0);
        } else if (op == .swap) {
            em.rawFloat[u(ir.src[i])] = 0;
            em.rawFloat[u(ir.src[i] + 1)] = 0;
        } else if (dst >= stack and !em.kept) {
            em.rawFloat[u(dst)] = if (em.rawResult) 1 else 0;
            if (em.rawResult) {
                em.rawTop = @max(em.rawTop, dst + 1);
            }
        }

        if (op == .swap) {
            // Its one destination is the new top, whose type the IR gives; the
            // register below it now holds what the top did, and its type.
            const x = ir.src[i];
            em.regType[u(x)] = em.regType[u(x + 1)];
        }

        if (dst >= 0) {
            em.regType[u(dst)] = ir.type[i];
            em.promoted[u(dst)] = if (promotes) 1 else 0;
        }

        if (op == .swap) {
            em.promoted[u(ir.src[i])] = 0;
            em.promoted[u(ir.src[i] + 1)] = 0;
        } else if (op == .hasnext2) {
            em.promoted[ir.a[i]] = 0;
            em.promoted[ir.b[i]] = 0;
        }

        if (em.target >= 0) {
            em.promoted[u(em.target)] = 0;
        }

        if (sinking >= 0 and em.sunk) {
            // The setlocal or pushscope is written: its stack register was
            // never set, and the stack is as far as it, or as far as the copy.
            var j = i + 1;
            while (j <= i + moves) : (j += 1) {
                const to = ir.dst[j];
                if (to >= 0) {
                    em.promoted[u(to)] = if (em.promotes(j)) 1 else 0;
                    em.regType[u(to)] = ir.type[j];
                } else if (ir.op[j] == .debugfile) {
                    em.file = @bitCast(ir.a[j]);
                } else if (ir.op[j] == .debugline) {
                    em.line = ir.a[j];
                    try em.mark();
                }
            }

            i += moves;
            em.setCopy(sinking, NONE);
            if (ir.op[i] == .pushscope) {
                em.scopeWith[em.scopeDepth] = 0;
                em.scopeDepth += 1;
            }

            if (duplicated) {
                em.setCopy(dst, sinking);
                em.uncopy(dst + 1);
            } else {
                em.uncopy(dst);
            }

            continue;
        }

        if (structure.conditional(op) or op == .lookupswitch) {
            // What the branch took is gone.
            em.uncopy(ir.src[i]);
        } else if (op == .swap) {
            em.setCopy(ir.src[i], NONE);
            em.setCopy(ir.src[i] + 1, NONE);
        } else if (op == .popscope) {
            em.setCopy(ir.src[i], NONE);
        } else {
            if (dst >= 0 and !em.kept) {
                em.setCopy(dst, NONE);
            }

            // What is above the stack now is gone.
            if (stackDiscipline(op)) {
                if (dst >= stack) {
                    em.uncopy(dst + 1);
                } else if (pops) {
                    em.uncopy(ir.src[i]);
                }
            }
        }
    }

    if (!structure.terminates(em, k) and k + 1 < ir.blockCount) {
        try em.releaseAll(-1, -1);
        try boxRaw(em, @intCast(ir.frameSize));
        try copyFor(em, k + 1, @intCast(ir.frameSize));
    }

    // What is held after a return or throw, nothing reads.
    em.drop(0);
}

/// Whether register r stands for a value not written to it: a copy, or a held text.
fn virtual(em: *const MethodEmitter, r: i32) bool {
    return em.copyOf[u(r)] != NONE or em.held[u(r)] != 0;
}

fn swap(comptime T: type, table: []T, x: usize, y: usize) void {
    const t = table[x];
    table[x] = table[y];
    table[y] = t;
}

/// Swap registers x and x + 1, one or both virtual: what each stands for,
/// and its type. A value written moves to the other register, which then
/// holds it as written.
fn swapVirtual(em: *MethodEmitter, x: i32) Error!void {
    const y = x + 1;
    const ux = u(x);
    const uy = u(y);
    // A dup's copy below its original: the same value either way round.
    if (em.copyOf[uy] == x) {
        swap(TypeId, em.regType, ux, uy);
        return;
    }

    if (!virtual(em, x) or !virtual(em, y)) {
        const to = if (virtual(em, x)) x else y;
        try em.regName(to);
        try em.out.text(" = ");
        try em.regName(if (to == x) y else x);
        try em.out.text(";\n");
    }

    const cx = em.copyOf[ux];
    em.setCopy(x, em.copyOf[uy]);
    em.setCopy(y, cx);

    swap(u8, em.held, ux, uy);
    swap(u32, em.heldAt, ux, uy);
    swap(u32, em.heldEnd, ux, uy);
    swap(i32, em.heldLow, ux, uy);
    swap(i32, em.heldHigh, ux, uy);
    if (em.held[uy] != 0) {
        em.heldTop = @max(em.heldTop, y + 1);
    }

    swap(TypeId, em.regType, ux, uy);
    em.promoted[ux] = 0;
    em.promoted[uy] = 0;
    em.checked[ux] = 0;
    em.checked[uy] = 0;
}

/// Before instruction i: write the held texts it cannot read in place, its
/// own operands' but those it reads each once as a value (heldFrom); all
/// others too if it branches, as its target reads registers; else those
/// that read a register it writes.
fn releaseFor(em: *MethodEmitter, i: u32) Error!void {
    const ir = em.ir;
    const op = ir.op[i];
    const dst = ir.dst[i];
    const stack: i32 = @intCast(ir.localCount + ir.maxScope);
    const src = ir.src[i];
    const count: i32 = @intCast(ir.srcCount[i]);
    var from: i32 = -1;
    var to: i32 = -1;
    if (src >= 0 and count > 0) {
        from = heldFrom(em, i);
        to = src + count;
        var r = src;
        while (r < from) : (r += 1) {
            try em.release(r);
        }
    }

    if (structure.conditional(op) or op == .jump or op == .lookupswitch) {
        return em.releaseAll(from, to);
    }

    if (dst >= 0 and !(dst >= stack and copiesOnly(op))) {
        try em.clobber(dst, from, to);
    }

    if (em.target >= 0) {
        try em.clobber(em.target, from, to);
    }

    if (op == .hasnext2) {
        try em.clobber(@bitCast(ir.a[i]), from, to);
        try em.clobber(@bitCast(ir.b[i]), from, to);
    } else if (op == .popscope) {
        try em.clobber(src, from, to);
    }
}

/// Whether op only makes its stack register a copy, which writes it only when a copy is written (writeCopy).
fn copiesOnly(op: IrOp) bool {
    return copies.pushesConstant(op) or
        copies.getsLocal(op) or
        op == .dup or
        op == .getscopeobject or
        op == .ir_nip;
}

/// The first of instruction i's operands from which it reads each once, as
/// a value, before it writes anything, and never by a null check
/// (blocks.ts tells which); past its last operand for none.
fn heldFrom(em: *const MethodEmitter, i: u32) i32 {
    const ir = em.ir;
    const op = ir.op[i];
    const src = ir.src[i];
    const end = src + @as(i32, @intCast(ir.srcCount[i]));
    if (readsHeld(op)) {
        return src;
    }

    return switch (op) {
        .newarray => src,
        .callmethod, .ir_call_interface, .ir_call_setter, .ir_call_super, .callstatic, .construct, .constructsuper => src + 1,
        .call => src + 2,
        // The receiver and the name's run-time parts, then the arguments.
        .callproperty, .callproplex, .callpropvoid, .constructprop => end - @as(i32, @bitCast(ir.b[i])),
        else => end,
    };
}

/// Whether op reads each of its operands once, as a value (see heldFrom).
fn readsHeld(op: IrOp) bool {
    return switch (op) {
        .add,
        .subtract,
        .multiply,
        .divide,
        .modulo,
        .add_i,
        .subtract_i,
        .multiply_i,
        .bitand,
        .bitor,
        .bitxor,
        .lshift,
        .rshift,
        .urshift,
        .bitnot,
        .negate,
        .negate_i,
        .increment,
        .decrement,
        .increment_i,
        .decrement_i,
        .not,
        .typeof,
        .equals,
        .strictequals,
        .lessthan,
        .lessequals,
        .greaterthan,
        .greaterequals,
        .convert_i,
        .coerce_i,
        .convert_u,
        .coerce_u,
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
        .ir_coerce,
        .setlocal,
        .setlocal0,
        .setlocal1,
        .setlocal2,
        .setlocal3,
        .iftrue,
        .iffalse,
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
        .lookupswitch,
        .returnvalue,
        .throw,
        .pop,
        .li8,
        .li16,
        .li32,
        .lf32,
        .lf64,
        .si8,
        .si16,
        .si32,
        .sf32,
        .sf64,
        .sxi1,
        .sxi8,
        .sxi16,
        .setslot,
        .setglobalslot,
        => true,
        else => false,
    };
}

/// Whether instruction i gives a value whose text can neither throw nor do
/// anything seen, and reads only registers (blocks.ts tells which): such a
/// text may be read anywhere until a register it reads is written.
fn pureValue(em: *MethodEmitter, i: u32) bool {
    const ir = em.ir;
    const op = ir.op[i];
    const src = ir.src[i];
    return switch (op) {
        .add,
        .subtract,
        .multiply,
        .divide,
        .modulo,
        .add_i,
        .subtract_i,
        .multiply_i,
        .bitand,
        .bitor,
        .bitxor,
        .lshift,
        .rshift,
        .urshift,
        .equals,
        .strictequals,
        .lessthan,
        .lessequals,
        .greaterthan,
        .greaterequals,
        => ir.srcCount[i] == 2 and values.isNumeric(em, src) and values.isNumeric(em, src + 1),
        .bitnot,
        .negate,
        .negate_i,
        .increment,
        .decrement,
        .increment_i,
        .decrement_i,
        .sxi1,
        .sxi8,
        .sxi16,
        => ir.srcCount[i] == 1 and values.isNumeric(em, src),
        .not => ir.srcCount[i] == 1,
        .convert_i,
        .coerce_i,
        .convert_u,
        .coerce_u,
        .convert_d,
        .coerce_d,
        .convert_b,
        .coerce_b,
        => ir.srcCount[i] == 1 and converts(em, values.conversionType(em, op, i), src),
        .ir_coerce => ir.srcCount[i] == 1 and converts(em, ir.cType(i), src),
        else => false,
    };
}

/// Whether converting register r to `ty` is plain JavaScript on a number or Boolean: to int, uint, Number or Boolean.
fn converts(em: *MethodEmitter, ty: TypeId, r: i32) bool {
    const from = em.builtinOf(r);
    return switch (em.domain.builtin(ty)) {
        .int, .uint, .boolean => values.isNumeric(em, r),
        .number => from == .int or from == .uint or from == .number,
        else => false,
    };
}

fn debugRecord(op: IrOp) bool {
    return op == .debugfile or op == .debugline or op == .debug;
}

/// Whether instruction i is a conversion in place that writes nothing, its value of type `from` being one already.
fn keptAt(em: *MethodEmitter, i: u32, from: TypeId) Error!bool {
    const ir = em.ir;
    const op = ir.op[i];
    if (ir.dst[i] != ir.src[i] or ir.srcCount[i] != 1) {
        return false;
    }

    if (op == .ir_coerce) {
        return values.keeps(em, ir.cType(i), from);
    }

    return values.isTypedConversion(op) and try values.keeps(em, values.conversionType(em, op, i), from);
}

/// Before a branch to block t: write the copies below `limit` that t
/// needs and does not know, as flowCopies found its entry.
fn copyFor(em: *MethodEmitter, t: u32, limit: i32) Error!void {
    const ir = em.ir;
    const base: i32 = @intCast(ir.localCount);
    const stack = base + @as(i32, @intCast(ir.maxScope));
    const end = @min(@min(limit, @as(i32, @intCast(ir.frameSize))), em.copyTop);
    const row = @as(i32, @intCast(t * (ir.frameSize - ir.localCount))) - base;
    const scopes = base + @as(i32, @intCast(ir.blockScope[t]));
    const depth = stack + @as(i32, @intCast(ir.blockStack[t]));
    var r = base;
    while (r < end) : (r += 1) {
        const copy = em.copyOf[u(r)];
        if (copy == NONE or em.copyIn[u(row + r)] == copy) {
            continue;
        }

        if (if (r < stack) r < scopes else r < depth) {
            try writeCopy(em, r);
        }
    }
}

/// Whether op takes its stack operands from the top and pushes what it
/// gives there, as an instruction of a stack machine: all but a coercion
/// or null check in place, and swap.
fn stackDiscipline(op: IrOp) bool {
    return op != .ir_coerce and op != .ir_check_null and op != .swap;
}

/// Write the scope and stack registers below `limit` that copy register w, before w changes.
fn copyAll(em: *MethodEmitter, w: i32, limit: i32) Error!void {
    if (em.copiedBy[u(w)] == 0) {
        return;
    }

    const ir = em.ir;
    const end = @min(@min(limit, @as(i32, @intCast(ir.frameSize))), em.copyTop);
    var r: i32 = @intCast(ir.localCount);
    while (r < end) : (r += 1) {
        if (em.copyOf[u(r)] == w) {
            try writeCopy(em, r);
        }
    }
}

/// A copy written may be the register of a pending null check: the
/// instruction then reads the copy, as unpend would read what pendingRead
/// names, both the value when it was checked.
fn writeCopy(em: *MethodEmitter, r: i32) Error!void {
    try em.clobber(r, -1, -1);
    const from = em.copyOf[u(r)];
    em.setCopy(r, NONE);
    em.checked[u(r)] = 0;
    try em.regName(r);
    try em.out.text(" = ");
    try em.copied(from, true);
    try em.out.text(";\n");
    em.rawFloat[u(r)] = 0;
}

/// Forget the null checks of what instruction i wrote.
fn unchecks(em: *MethodEmitter, i: u32) void {
    const ir = em.ir;
    const op = ir.op[i];
    if (ir.dst[i] >= 0) {
        em.checked[u(ir.dst[i])] = 0;
    }

    if (em.target >= 0) {
        em.checked[u(em.target)] = 0;
    }

    if (op == .hasnext2) {
        em.checked[ir.a[i]] = 0;
        em.checked[ir.b[i]] = 0;
    } else if (op == .swap) {
        em.checked[u(ir.src[i])] = 0;
        em.checked[u(ir.src[i] + 1)] = 0;
    }
}

fn boxRaw(em: *MethodEmitter, limit: i32) Error!void {
    var r: i32 = @intCast(em.ir.localCount + em.ir.maxScope);
    while (r < @min(limit, em.rawTop)) : (r += 1) {
        if (em.rawFloat[u(r)] != 0) {
            if (em.copyOf[u(r)] == NONE) {
                try em.regName(r);
                try em.out.text(" = rt.float(");
                try em.regName(r);
                try em.out.text(");\n");
            }

            em.rawFloat[u(r)] = 0;
        }
    }
}
