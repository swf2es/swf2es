// A MethodEmitter's (method.zig) copies: a register that stands for another
// or a constant, read as what it copies until it must be written, and the
// literals it reads as. Its methods, written here and named in it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const copies = @import("../copies.zig");
const Fact = copies.Fact;
const refs = @import("../refs.zig");
const method_ = @import("../method.zig");
const MethodEmitter = method_.MethodEmitter;

/// Whether instruction i, reading register `r`, only makes its
/// destination a copy, as flowCopies knows it.
pub fn copies_(self: *MethodEmitter, i: u32, r: i32) bool {
    const ir = self.ir;
    const stack: i32 = @intCast(ir.localCount + ir.maxScope);
    const dst = ir.dst[i];
    if (dst < @as(i32, @intCast(ir.localCount))) {
        return false;
    }

    const copy: Fact = if (r < @as(i32, @intCast(ir.localCount))) .none else self.copyOf[@intCast(r)];
    const from = copy.orRegister(r);
    if (dst < stack and (!from.isRegister() or from.register() >= stack)) {
        return false;
    }

    // Its own value again, as a nip of a dup: as it was.
    self.setCopy(dst, if (from == Fact.of(dst)) .none else from);
    self.kept = true;
    return true;
}

/// Whether instruction i makes an int or uint a Number, as LIR's i2d and ui2d (see wraps).
pub fn promotes(self: *MethodEmitter, i: u32) bool {
    const ir = self.ir;
    const dst = ir.dst[i];
    if (ir.op[i] != .ir_coerce or dst != ir.src[i]) {
        return false;
    }

    const bt = self.builtinOf(dst);
    return self.domain.builtin(ir.cType(i)) == .number and (bt == .int or bt == .uint);
}

/// What a copy reads: a register, or the constant an instruction pushed.
pub fn copied(self: *MethodEmitter, copy: Fact, boxed: bool) Error!void {
    if (copy.isRegister()) {
        const r = copy.register();
        const c: u32 = @intCast(r);
        if (self.held[c] != 0) {
            try self.inline_(r);
            return;
        }

        self.readsAt(r, r);
        const wrap = boxed and (self.unboxedLocal(r) or self.rawFloat[c] != 0);
        if (wrap) {
            try self.out.text("rt.float(");
        }

        try self.regName(r);
        if (wrap) {
            try self.out.text(")");
        }

        return;
    }

    const out = &self.out;
    const pool = &self.abc.pool;
    const i = copy.instruction();
    const a = self.ir.a[i];
    switch (self.ir.op[i]) {
        .pushbyte, .pushshort => try self.literal(@floatFromInt(@as(i32, @bitCast(a))), false),
        .pushint => try self.literal(@floatFromInt(pool.ints[a]), false),
        .pushuint => try out.uint(pool.uints[a]),
        .pushdouble => try self.literal(pool.doubles[a], true),
        .pushfloat => {
            try out.text("rt.float(");
            try self.literal(pool.floats[a], true);
            try out.text(")");
        },
        .pushnan => try out.text("NaN"),
        .pushstring => try refs.poolString(self, a),
        .pushtrue => try out.text("true"),
        .pushfalse => try out.text("false"),
        .pushnull => try out.text("null"),
        else => try out.text("void 0"),
    }
}

/// A number read as an operand, a negative one in parentheses, so that `-` before it is no decrement.
pub fn literal(self: *MethodEmitter, d: f64, double: bool) Error!void {
    const out = &self.out;
    const negative = d < 0 or (d == 0 and std.math.signbit(d));
    if (negative) {
        try out.byte('(');
    }

    if (double) {
        try out.double(d);
    } else {
        try out.int(@intFromFloat(d));
    }

    if (negative) {
        try out.byte(')');
    }
}

/// Forget every copy from register `from` up: none is needed.
pub fn uncopy(self: *MethodEmitter, from: i32) void {
    self.drop(from);
    self.clearRaw(from);
    const top = @min(self.copyTop, @as(i32, @intCast(self.ir.frameSize)));
    var r = from;
    while (r < top) : (r += 1) {
        self.setCopy(r, .none);
    }

    if (from < self.copyTop) {
        self.copyTop = @max(from, 0);
    }
}

/// Register r now a copy of `copy`, or of nothing for none: copyTop and copiedBy kept.
pub fn setCopy(self: *MethodEmitter, r: i32, copy: Fact) void {
    const ru: u32 = @intCast(r);
    const old = self.copyOf[ru];
    if (old.isRegister()) {
        self.copiedBy[@intCast(old.register())] -%= 1;
    }

    self.copyOf[ru] = copy;
    if (copy.isRegister()) {
        self.copiedBy[@intCast(copy.register())] +%= 1;
    }

    if (copy != .none and r >= self.copyTop) {
        self.copyTop = r + 1;
    }
}

/// copyTop and copiedBy made again from copyOf, as a block's entry or a restore sets it whole.
pub fn recount(self: *MethodEmitter) void {
    const frame = self.ir.frameSize;
    var top: i32 = 0;
    @memset(self.copiedBy[0..frame], 0);
    for (0..frame) |r| {
        const copy = self.copyOf[r];
        if (copy.isRegister()) {
            self.copiedBy[@intCast(copy.register())] +%= 1;
        }

        if (copy != .none) {
            top = @intCast(r + 1);
        }
    }

    self.copyTop = top;
}
