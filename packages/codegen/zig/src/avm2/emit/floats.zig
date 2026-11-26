// Floats a method may keep unboxed, and float arithmetic written as
// JavaScript's own (assembly/avm2/emit/floats.ts).
const std = @import("std");
const Error = std.mem.Allocator.Error;
const ops = @import("../abc/opcodes.zig");
const MethodEmitter = @import("method.zig").MethodEmitter;

/// Keep a local unboxed only when every read and write knows its float identity.
pub fn floatLocals(em: *MethodEmitter) Error!void {
    const ir = em.ir;
    if (em.unboxed.len < ir.localCount) {
        em.unboxed = try em.gpa.alloc(u8, ir.localCount);
    }

    @memset(em.unboxed[0..ir.localCount], 0);
    const ty = em.domain.floatType;
    if (!em.abc.hasFloatSupport() or ty < 0) {
        return;
    }

    // Bit 2 stays set until a non-float use; bit 1 records a float value.
    for (0..ir.localCount) |r| {
        em.unboxed[r] = if (ir.entryType[r] == ty) 3 else 2;
    }

    for (0..ir.blockCount) |k| {
        const entry = k * ir.frameSize;
        for (0..ir.localCount) |r| {
            em.regType[r] = ir.entryType[entry + r];
        }

        const last = if (k + 1 < ir.blockCount) ir.blockFirst[k + 1] else ir.count;
        var i = ir.blockFirst[k];
        while (i < last) : (i += 1) {
            const s = ir.src[i];
            for (0..ir.srcCount[i]) |n| {
                const r = s + @as(i32, @intCast(n));
                if (r >= 0 and r < @as(i32, @intCast(ir.localCount))) {
                    const ru: u32 = @intCast(r);
                    if (em.regType[ru] != ty) {
                        em.unboxed[ru] = 0;
                    } else if (em.unboxed[ru] != 0) {
                        em.unboxed[ru] |= 1;
                    }
                }
            }

            if (ir.op[i] == .hasnext2) {
                em.unboxed[ir.a[i]] = 0;
                em.unboxed[ir.b[i]] = 0;
            }

            const dst = ir.dst[i];
            if (dst >= 0 and dst < @as(i32, @intCast(ir.localCount))) {
                const du: u32 = @intCast(dst);
                em.regType[du] = ir.type[i];
                if (ir.type[i] != ty) {
                    em.unboxed[du] = 0;
                } else if (em.unboxed[du] != 0) {
                    em.unboxed[du] |= 1;
                }
            }
        }
    }

    for (em.unboxed[0..ir.localCount]) |*u| {
        u.* = if (u.* == 3) 1 else 0;
    }
}

/// Arithmetic whose operands and result are statically floats needs no runtime dispatch.
pub fn floatOperation(em: *MethodEmitter, i: u32) Error!bool {
    if (em.domain.floatType < 0 or em.ir.type[i] != em.domain.floatType) {
        return false;
    }

    const op = em.ir.op[i];
    const operator: []const u8 = switch (op) {
        .add => " + ",
        .subtract => " - ",
        .multiply => " * ",
        .divide => " / ",
        .modulo => " % ",
        .negate, .increment, .decrement, .inclocal, .declocal, .unplus => "",
        else => return false,
    };

    const out = &em.out;
    try em.assign(i, true);
    const boxed = !em.unboxedTarget(i);
    if (boxed) {
        try out.text("rt.float(");
    }

    try out.text("Math.fround(");
    if (op == .negate) {
        try out.text("-");
    }

    try em.numberReg(em.ir.src[i]);
    if (operator.len > 0) {
        try out.text(operator);
        try em.numberReg(em.ir.src[i] + 1);
    } else {
        switch (op) {
            .increment, .inclocal => try out.text(" + 1"),
            .decrement, .declocal => try out.text(" - 1"),
            else => {},
        }
    }

    try out.text(if (boxed) "))" else ")");
    return true;
}
