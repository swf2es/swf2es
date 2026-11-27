// The frame a BodyDecoder (code.zig) verifies a block in: its values, their
// types and flags, merged into a block's entry; and the typed helpers the
// verifier's instructions work on the stack with. Its methods, written here
// and named in it.
const std = @import("std");
const errors = @import("../errors.zig");
const Rejected = errors.Rejected;
const Error = errors.Error;
const ir_ = @import("../../ir/ir.zig");
const typeOperand = ir_.typeOperand;
const traits_ = @import("../../link/traits.zig");
const TypeId = traits_.TypeId;
const types = @import("../../link/types.zig");
const Op = @import("../opcodes.zig").Op;
const IrOp = @import("../../ir/ir.zig").Op;
const code = @import("../code.zig");
const BodyDecoder = code.BodyDecoder;
const Flags = code.Flags;
const Origin = code.Origin;

// Frame values: locals from 0, scope entries from localCount, the stack from
// localCount + maxScope.

pub inline fn setValue(self: *BodyDecoder, i: u32, ty: TypeId, flags: Flags) void {
    self.valueType[i] = ty;
    self.valueFlags[i] = flags;
    if (i < self.localCount) {
        self.localsVersion += 1;
        self.localWrites[i] +%= 1;
    } else {
        self.origin[i] = .none;
    }
}

/// What stack value i tells of a local, if its local is unchanged since.
pub fn originOf(self: *BodyDecoder, i: u32) Origin {
    const o = self.origin[i];
    if (!o.isLocal() or self.originWrite[i] != self.localWrites[o.local()]) {
        return .none;
    }

    self.testWrite = self.originWrite[i];
    return o;
}

/// As originOf, a copy as what its truth tells: no local is null or undefined and true.
pub fn truthOf(self: *BodyDecoder, i: u32) Origin {
    const o = self.originOf(i);
    return if (o.isLocal() and o.kind() == .copy) o.asTest(.if_true) else o;
}

/// What `==` of the top two values tells, one of them a null or undefined pushed, the other a local's copy.
pub fn equalsNull(self: *BodyDecoder) Origin {
    const lhs = self.peek(2);
    const rhs = self.peek(1);
    var o: Origin = .none;
    if (self.origin[rhs] == .nullish) {
        o = self.originOf(lhs);
    } else if (self.origin[lhs] == .nullish) {
        o = self.originOf(rhs);
    }

    return if (o.isLocal() and o.kind() == .copy) o.asTest(.if_false) else .none;
}

/// What instruction `opcode` tells of a local's being neither null nor
/// undefined, from its operands: for a test its result's, for a
/// conditional branch its condition's.
pub fn nullTest(self: *BodyDecoder, opcode: Op) Origin {
    // Too few values fail the instruction's verification after this.
    const one = self.stack >= 1;
    const two = self.stack >= 2;
    var o: Origin = .none;
    switch (opcode) {
        .iftrue => return if (one) self.truthOf(self.peek(1)) else .none,
        .iffalse, .not => o = if (one) self.truthOf(self.peek(1)) else .none,
        .equals, .ifeq => return if (two) self.equalsNull() else .none,
        .ifne => o = if (two) self.equalsNull() else .none,
        else => return .none,
    }

    return if (!o.isLocal()) o else o.negated();
}

/// Mark local `local` checked, returning its flags before.
pub fn markChecked(self: *BodyDecoder, local: u32) Flags {
    const flags = self.valueFlags[local];
    var checked = flags;
    checked.checked = true;
    self.valueFlags[local] = checked;
    self.localsVersion += 1;
    return flags;
}

/// Push null or undefined, of `type`, as what equalsNull compares with.
pub fn pushNullish(self: *BodyDecoder, ty: TypeId) void {
    const i = self.stackBase() + self.stack;
    self.setValue(i, ty, .none);
    self.origin[i] = .nullish;
}

/// Push local `a`, as a copy of it.
pub fn pushLocal(self: *BodyDecoder, a: u32) void {
    const i = self.stackBase() + self.stack;
    self.setValue(i, self.typeOf(a), self.valueFlags[a].known());
    self.origin[i] = .of(a, .copy);
    self.originWrite[i] = self.localWrites[a];
}

pub inline fn stackBase(self: *const BodyDecoder) u32 {
    return self.localCount + self.maxScope;
}

/// The index of the value `n` from the top of the stack, 1 being the top.
pub inline fn peek(self: *const BodyDecoder, n: u32) u32 {
    return self.stackBase() + self.stack -% n;
}

pub inline fn typeOf(self: *const BodyDecoder, i: u32) TypeId {
    return self.valueType[i];
}

/// Handler i's exception type and catch scope type, as checkHandlers
/// wrote them for this body: in a typed walk (an untyped decoder has
/// handlers but no types), i below handlerCount, which the callers'
/// loops and verify's newcatch check keep it. The poison build's fill
/// in checkHandlers is what catches an entry this body did not write.
pub inline fn handlerTypeAt(self: *const BodyDecoder, i: u32) TypeId {
    std.debug.assert(self.typed and i < self.handlerCount);
    return self.handlerType[i];
}

pub inline fn handlerScopeAt(self: *const BodyDecoder, i: u32) TypeId {
    std.debug.assert(self.typed and i < self.handlerCount);
    return self.handlerScope[i];
}

pub inline fn isNotNull(self: *const BodyDecoder, i: u32) bool {
    return self.valueFlags[i].not_null;
}

/// As Verifier::mergeState: merge the current values into known target t's
/// entry state, whose depths are the same: types to their common base, not
/// null only if both are. Whether the entry changed; rejected with 1068
/// for a with scope meeting another scope.
pub fn mergeEntry(self: *BodyDecoder, t: u32) Rejected!bool {
    const at = self.entryAt[t];
    const base = self.stackBase();
    // The locals and scopes, then the stack, not what lies between.
    const low = try self.mergeRange(at, 0, self.localCount + self.scope);
    const high = try self.mergeRange(at, base, base + self.stack);
    return low or high;
}

/// mergeEntry for values [from, to) of the entry state at `at`.
pub inline fn mergeRange(self: *BodyDecoder, at: u32, from: u32, to: u32) Rejected!bool {
    var changed = false;
    var i = from;
    while (i < to) : (i += 1) {
        const flags = self.valueFlags[i];
        const entryFlags = self.entryFlags[at + i];
        if (flags.with != entryFlags.with) {
            return self.fail(.kCannotMergeTypesError);
        }

        const entryType = self.entryType[at + i];
        const valueType = self.valueType[i];
        const mergedFlags = entryFlags.merge(flags);
        // Most merges meet the same type, which stays.
        if (valueType == entryType and mergedFlags == entryFlags) {
            continue;
        }

        const merged = types.commonBase(self.domain, entryType, valueType);
        if (merged != entryType or mergedFlags != entryFlags) {
            self.entryType[at + i] = merged;
            self.entryFlags[at + i] = mergedFlags;
            changed = true;
        }
    }

    return changed;
}

// Typed helpers, working on the stack before the instruction's depth change.

/// Push a value; the instruction's stack effect sets the depth afterwards.
pub fn push(self: *BodyDecoder, ty: TypeId, flags: Flags) void {
    self.setValue(self.stackBase() + self.stack, ty, flags);
}

/// Replace the top `n` values with one.
pub fn popPush(self: *BodyDecoder, n: u32, ty: TypeId, flags: Flags) void {
    self.setValue(self.stackBase() + self.stack -% n, ty, flags);
}

/// As Verifier::emitCoerce: value i becomes `type`, still null or not.
pub fn coerce(self: *BodyDecoder, i: u32, ty: TypeId) Error!void {
    const changes = self.typeOf(i) != ty;
    // A coercion of a value neither null nor undefined is not either.
    self.setValue(i, ty, self.valueFlags[i].known());
    if (self.emitPass and changes and ty != .any) {
        try self.emit(.ir_coerce, @intCast(i), @intCast(i), 1, 0, 0, typeOperand(ty), self.pc);
    }
}

/// As FrameState::setType from a conversion instruction: value i becomes `type`, without IR of its own.
pub fn retype(self: *BodyDecoder, i: u32, ty: TypeId) void {
    self.setValue(i, ty, self.valueFlags[i].known());
}

/// As Verifier::emitCheckNull: value i is known not null from here on. The
/// local it copies, unchanged since, is checked too.
pub fn checkNull(self: *BodyDecoder, i: u32) Error!void {
    if (self.emitPass and !self.valueFlags[i].isKnown()) {
        try self.emit(.ir_check_null, ir_.no_register, @intCast(i), 1, 0, 0, 0, self.pc);
    }

    self.valueFlags[i].not_null = true;
    if (i < self.localCount) {
        self.localsVersion += 1;
        return;
    }

    const o = self.originOf(i);
    if (o.isLocal() and o.kind() == .copy) {
        _ = self.markChecked(o.local());
    }
}

/// As Verifier::peekType: the value `n` from the top must be exactly `type`.
pub fn peekType(self: *BodyDecoder, n: u32, ty: TypeId) Rejected!void {
    if (self.typeOf(self.peek(n)) != ty) {
        return self.fail(.kIllegalOperandTypeError);
    }
}

/// Write the instruction's own IR row, instead of the generic one.
pub fn emitOn(self: *BodyDecoder, op: IrOp, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32) Error!void {
    if (self.emitPass) {
        try self.emit(op, dst, src, count, a, b, c, self.pc);
        self.emitted = true;
    }
}

pub fn checkString(self: *BodyDecoder, index: u32) Rejected!void {
    if (index == 0 or index >= self.abc.pool.stringCount()) {
        return self.fail(.kCpoolIndexRangeError);
    }
}
