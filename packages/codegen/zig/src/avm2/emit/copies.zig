// Which scope and stack registers hold, where each block starts, a copy of
// another register or a constant on every way in: a forward dataflow over
// the IR, so that a block reads the original and the copy is never written
// (assembly/avm2/emit/copies.ts, whose comment tells the facts and why a
// fact enters a block only if its original is live there too).
const std = @import("std");
const Error = std.mem.Allocator.Error;
const ops = @import("../abc/opcodes.zig");
const ir_ = @import("../ir/ir.zig");
const MethodEmitter = @import("method.zig").MethodEmitter;
const structure = @import("structure.zig");
const IrOp = @import("../ir/ir.zig").Op;

/// A fact's constant: CONSTANT - the instruction that pushed it.
pub const CONSTANT: i32 = -2;
/// No fact.
pub const NONE: i32 = -1;
/// A block no way in has reached yet: what a join takes the other side of.
const UNSEEN: i32 = std.math.minInt(i32);

/// Whether op pushes a constant, which a stack register can be a copy of.
pub fn pushesConstant(op: IrOp) bool {
    return switch (op) {
        .pushbyte, .pushshort, .pushint, .pushuint, .pushdouble, .pushfloat, .pushnan, .pushstring, .pushtrue, .pushfalse, .pushnull, .pushundefined => true,
        else => false,
    };
}

/// Whether op is a getlocal, which makes its stack register a copy.
pub fn getsLocal(op: IrOp) bool {
    return op == .getlocal or (if (ir_.opcode(op)) |o| o.getLocalN() != null else false);
}

/// Whether op is a setlocal, which takes its stack register.
pub fn setsLocal(op: IrOp) bool {
    return op == .setlocal or (if (ir_.opcode(op)) |o| o.setLocalN() != null else false);
}

fn grow(em: *MethodEmitter, comptime T: type, table: *[]T, n: usize) Error!void {
    if (table.len < n) {
        table.* = try em.gpa.alloc(T, @max(n, table.len * 2));
    }
}

/// Each block's facts on entry into em.copyIn, a row of frameSize -
/// localCount from the first scope register: the copy each register is,
/// or NONE.
pub fn flowCopies(em: *MethodEmitter) Error!void {
    const ir = em.ir;
    const n = ir.blockCount;
    const slots = ir.frameSize - ir.localCount;
    if (slots == 0 or n == 0) {
        return;
    }

    const size = n * slots;
    try grow(em, i32, &em.copyIn, size);
    const copyIn = em.copyIn;
    // One block is entered only at the start, with no copies, or from itself.
    if (n == 1) {
        @memset(copyIn[0..slots], NONE);
        return;
    }

    try grow(em, u8, &em.dirty, n);
    try grow(em, i32, &em.flow, slots);
    @memset(copyIn[0..size], UNSEEN);
    @memset(em.dirty[0..n], 0);

    // The entry and the handlers start with no copies, whatever else leads there.
    @memset(copyIn[0..slots], NONE);
    em.dirty[0] = 1;
    for (0..ir.handlerCount) |h| {
        const at = ir.handlerBlock[h] * slots;
        @memset(copyIn[at..][0..slots], NONE);
        em.dirty[ir.handlerBlock[h]] = 1;
    }

    // In code order until nothing changes (copies.ts tells why it ends).
    var unseen = true;
    while (unseen) {
        var again = true;
        while (again) {
            again = false;
            for (0..n) |k| {
                if (em.dirty[k] != 0) {
                    em.dirty[k] = 0;
                    if (try walk(em, @intCast(k))) {
                        again = true;
                    }
                }
            }
        }

        unseen = false;
        for (0..n) |k| {
            const at = k * slots;
            if (copyIn[at] == UNSEEN) {
                @memset(copyIn[at..][0..slots], NONE);
                em.dirty[k] = 1;
                unseen = true;
            }
        }
    }
}

/// Block k's instructions from its facts, joined into its targets'; whether one before it changed.
fn walk(em: *MethodEmitter, k: u32) Error!bool {
    const ir = em.ir;
    const base: i32 = @intCast(ir.localCount);
    const slots = ir.frameSize - ir.localCount;
    const flow = em.flow;
    const at = k * slots;
    @memcpy(flow[0..slots], em.copyIn[at..][0..slots]);

    const last = if (k + 1 < ir.blockCount) ir.blockFirst[k + 1] else ir.count;
    var back = false;
    var i = ir.blockFirst[k];
    while (i < last) : (i += 1) {
        const op = ir.op[i];
        if (structure.conditional(op) or op == .jump) {
            back = join(em, ir.a[i], k) or back;
        } else if (op == .lookupswitch) {
            back = join(em, ir.a[i], k) or back;
            var c: u32 = 0;
            while (c <= @as(u32, @bitCast(ir.c[i]))) : (c += 1) {
                back = join(em, ir.cases[ir.b[i] + c], k) or back;
            }
        }

        const dst = ir.dst[i];
        const s = ir.src[i];
        switch (op) {
            .swap => {
                kill(em, s);
                kill(em, s + 1);
                continue;
            },
            .hasnext2 => {
                kill(em, @bitCast(ir.a[i]));
                kill(em, @bitCast(ir.b[i]));
                kill(em, dst);
                continue;
            },
            .popscope => {
                kill(em, s);
                continue;
            },
            else => {},
        }

        if (dst < 0) {
            continue;
        }

        const from = sourceOf(em, i);
        if (from == dst) {
            // Its own value again, as a nip of a dup: nothing changes.
            continue;
        }

        // A value set to a local is that local's, as the register it came from
        // is, when that one is not a copy itself: `dup; setlocal`.
        const moved = if (setsLocal(op)) root(em, s) else NONE;
        kill(em, dst);
        if (dst >= base) {
            flow[@intCast(dst - base)] = from;
        } else if (moved >= base + @as(i32, @intCast(ir.maxScope))) {
            flow[@intCast(moved - base)] = dst;
            for (flow[0..slots]) |*f| {
                if (f.* == moved) {
                    f.* = dst;
                }
            }
        }
    }

    if (!structure.terminates(em, k) and k + 1 < ir.blockCount) {
        back = join(em, k + 1, k) or back;
    }

    return back;
}

/// What instruction i's destination is a copy of, from what the facts are before it; NONE if a value of its own.
fn sourceOf(em: *MethodEmitter, i: u32) i32 {
    const ir = em.ir;
    const op = ir.op[i];
    const dst = ir.dst[i];
    const s = ir.src[i];
    const stack: i32 = @intCast(ir.localCount + ir.maxScope);
    if (dst >= stack and pushesConstant(op)) {
        return CONSTANT - @as(i32, @intCast(i));
    }

    if (dst >= stack and (getsLocal(op) or op == .dup or op == .getscopeobject)) {
        return root(em, s);
    }

    if (op == .ir_nip) {
        return root(em, s + @as(i32, @intCast(ir.srcCount[i])) - 1);
    }

    // The global object, from no scope chain: the method's own first scope.
    if ((op == .getglobalscope or op == .ir_get_global_scope) and ir.outerSize == 0) {
        return root(em, @intCast(ir.localCount));
    }

    // A scope stays as long as its block does: of a local or scope only.
    if (op == .pushscope or op == .pushwith) {
        const from = root(em, s);
        return if (from >= 0 and from < stack) from else NONE;
    }

    return NONE;
}

/// What register r's value is now: what it copies, or itself.
fn root(em: *MethodEmitter, r: i32) i32 {
    const base: i32 = @intCast(em.ir.localCount);
    if (r < base) {
        return r;
    }

    const copy = em.flow[@intCast(r - base)];
    return if (copy == NONE) r else copy;
}

/// Register x is written: no longer a copy, nor the original of one.
fn kill(em: *MethodEmitter, x: i32) void {
    const ir = em.ir;
    const base: i32 = @intCast(ir.localCount);
    const slots = ir.frameSize - ir.localCount;
    const flow = em.flow;
    if (x >= base) {
        flow[@intCast(x - base)] = NONE;
    }

    for (flow[0..slots]) |*f| {
        if (f.* == x) {
            f.* = NONE;
        }
    }
}

/// The facts now joined into block t's; whether t changed and comes no later than k, to be walked again.
fn join(em: *MethodEmitter, t: u32, k: u32) bool {
    const ir = em.ir;
    const slots = ir.frameSize - ir.localCount;
    const scopes = ir.blockScope[t];
    const stack = ir.maxScope + ir.blockStack[t];
    const flow = em.flow;
    const copyIn = em.copyIn;
    const at = t * slots;
    var changed = false;
    for (0..slots) |s_| {
        const s: u32 = @intCast(s_);
        // What is not on the stacks there is no one's copy.
        const live = if (s < ir.maxScope) s < scopes else s < stack;
        var fact = if (live) flow[s] else NONE;
        // Nor a copy of what is not, which the emitter may not have written.
        if (fact >= @as(i32, @intCast(ir.localCount))) {
            const f = @as(u32, @intCast(fact)) - ir.localCount;
            if (!(if (f < ir.maxScope) f < scopes else f < stack)) {
                fact = NONE;
            }
        }

        const was = copyIn[at + s];
        const now = if (was == UNSEEN or was == fact) fact else NONE;
        if (now != was) {
            copyIn[at + s] = now;
            changed = true;
        }
    }

    if (!changed) {
        return false;
    }

    em.dirty[t] = 1;
    return t <= k;
}
