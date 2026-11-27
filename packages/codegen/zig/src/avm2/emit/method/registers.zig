// A MethodEmitter's (method.zig) registers: read, as what they copy or a
// held text, written, and texts held for them until they are read, released
// or clobbered. Its methods, written here and named in it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const structure = @import("../structure.zig");
const method_ = @import("../method.zig");
const MethodEmitter = method_.MethodEmitter;

/// The length of the end of a reset, ` = void 0;\n`.
const RESET_END: u32 = 11;
/// The longest text a register holds, and all of them together, in bytes.
const MAX_HELD: u32 = 1024;
const MAX_HELD_TEXT: u32 = 1 << 20;

/// A space, but at the start of a line, as after a block written in place.
pub fn space(self: *MethodEmitter) Error!void {
    const written = self.out.written();
    if (written.len == 0 or written[written.len - 1] != '\n') {
        try self.out.byte(' ');
    }
}

/// Register r as read: what it copies, if it is a copy; null checked, if the check is pending.
pub fn reg(self: *MethodEmitter, r: i32) Error!void {
    if (r == self.pendingNull) {
        self.pendingNull = -1;
        try self.checkedRead(r);
        return;
    }

    try self.read(r);
}

/// Register r as read before a `.`; a constant in parentheses, as `void 0.x` does not parse.
pub fn member(self: *MethodEmitter, r: i32) Error!void {
    if (r == self.pendingNull or self.copyOf[@intCast(r)].isConstant()) {
        try self.out.byte('(');
        try self.reg(r);
        try self.out.byte(')');
        return;
    }

    try self.read(r);
}

/// Register r read, null checked: `r ?? nn(r)`.
pub fn checkedRead(self: *MethodEmitter, r: i32) Error!void {
    try self.read(r);
    try self.out.text(" ?? nn(");
    try self.read(r);
    try self.out.text(")");
}

/// The null check pending for an instruction that did not read the
/// register, as a statement before it.
pub fn unpend(self: *MethodEmitter) Error!void {
    const name = try self.nameOf(self.pendingRead);
    self.pendingNull = -1;
    const check = try std.fmt.allocPrint(self.gpa, "{s} ?? nn({s});\n", .{ name, name });
    try self.out.insert(self.pendingAt, check);
    self.map.shift(self.pendingMarks, @intCast(check.len));
}

/// Register `at`'s name, as text.
pub fn nameOf(self: *MethodEmitter, at: i32) Error![]const u8 {
    const ir = self.ir;
    const local: i32 = @intCast(ir.localCount);
    if (at < local) {
        return std.fmt.allocPrint(self.gpa, "l{d}", .{at});
    }

    const scopes: i32 = @intCast(ir.maxScope);
    if (at < local + scopes) {
        return std.fmt.allocPrint(self.gpa, "sc{d}", .{at - local});
    }

    return std.fmt.allocPrint(self.gpa, "s{d}", .{at - local - scopes});
}

/// Register r as read: what it copies, if it is a copy.
pub fn read(self: *MethodEmitter, r: i32) Error!void {
    try self.copied(self.copyOf[@intCast(r)].orRegister(r), true);
}

pub fn unboxedLocal(self: *const MethodEmitter, r: i32) bool {
    return r >= 0 and r < @as(i32, @intCast(self.ir.localCount)) and self.unboxed[@intCast(r)] != 0;
}

pub fn unboxedTarget(self: *const MethodEmitter, i: u32) bool {
    const r = if (self.target >= 0) self.target else self.ir.dst[i];
    return self.unboxedLocal(r) or
        (r >= @as(i32, @intCast(self.ir.localCount + self.ir.maxScope)) and
            self.ir.type[i].isBuiltin(self.domain.floatType));
}

pub fn clearRaw(self: *MethodEmitter, from: i32) void {
    var r: i32 = @max(from, 0);
    while (r < self.rawTop) : (r += 1) {
        self.rawFloat[@intCast(r)] = 0;
    }

    self.rawTop = @min(self.rawTop, @max(from, 0));
}

/// A known float's payload, avoiding a wrapper when it is a local or its copy.
pub fn numberReg(self: *MethodEmitter, r: i32) Error!void {
    const copy = self.copyOf[@intCast(r)];
    const which = copy.orRegister(r);
    if (copy.isConstant() and self.ir.op[copy.instruction()] == .pushfloat) {
        try self.literal(self.abc.pool.floats[self.ir.a[copy.instruction()]], true);
    } else if (which.isRegister() and
        (self.unboxedLocal(which.register()) or self.rawFloat[@intCast(which.register())] != 0))
    {
        try self.copied(which, false);
    } else if (self.builtinOf(r) == .float) {
        try self.out.text("rt.toNumber(");
        try self.reg(r);
        try self.out.text(")");
    } else {
        try self.reg(r);
    }
}

/// Register r itself, as written.
pub fn regName(self: *MethodEmitter, r: i32) Error!void {
    const ir = self.ir;
    const out = &self.out;
    const local: i32 = @intCast(ir.localCount);
    const scopes: i32 = @intCast(ir.maxScope);
    if (r < local) {
        try out.byte('l');
        try out.uint(@intCast(r));
    } else if (r < local + scopes) {
        try out.text("sc");
        try out.uint(@intCast(r - local));
    } else {
        try out.byte('s');
        try out.uint(@intCast(r - local - scopes));
    }
}

/// `dst = ` for instruction i.
pub fn assign(self: *MethodEmitter, i: u32, number: bool) Error!void {
    if (self.target >= 0) {
        try self.regName(self.target);
        self.sunk = true;
    } else {
        try self.regName(self.ir.dst[i]);
    }

    try self.out.text(" = ");
    self.unboxResult = !number and self.unboxedTarget(i);
    self.rawResult = self.target < 0 and
        self.ir.dst[i] >= @as(i32, @intCast(self.ir.localCount + self.ir.maxScope)) and
        self.ir.type[i].isBuiltin(self.domain.floatType);
    if (self.unboxResult) {
        try self.out.text("rt.toNumber(");
    }
}

pub fn src(self: *const MethodEmitter, i: u32, k: u32) i32 {
    return self.ir.src[i] + @as(i32, @intCast(k));
}

/// `b = n; continue;` to block n.
pub fn goto(self: *MethodEmitter, to: u32) Error!void {
    if (self.structured) {
        try structure.branchTo(self, to);
        return;
    }

    try self.out.text("b = ");
    try self.out.uint(to);
    try self.out.text("; continue;");
}

/// Note that what is being written reads registers low .. high.
pub fn readsAt(self: *MethodEmitter, low: i32, high: i32) void {
    if (low > high) {
        return;
    }

    self.readLow = @min(self.readLow, low);
    self.readHigh = @max(self.readHigh, high);
}

/// Register r's held text, read where it is written, in parentheses; r holds it no more.
pub fn inline_(self: *MethodEmitter, r: i32) Error!void {
    const ru: u32 = @intCast(r);
    const out = &self.out;
    self.held[ru] = 0;
    self.heldCount -%= 1;
    self.readsAt(self.heldLow[ru], self.heldHigh[ru]);
    try out.byte('(');
    try out.append(&self.heldText, self.heldAt[ru], self.heldEnd[ru] - self.heldAt[ru]);
    try out.byte(')');
}

/// Register r to hold the text instruction i wrote to the output from
/// `start`, `r = text;\n`, which is taken out; false if what it wrote is
/// not that one assignment, as written.
pub fn hold(self: *MethodEmitter, r: i32, start: u32) Error!bool {
    const out = &self.out;
    const bytes = out.written();
    const end = out.len();
    // `s`, its number, ` = `, at least a byte, `;\n`.
    var at = start;
    if (end < at + 7 or bytes[at] != 's') {
        return false;
    }

    at += 1;
    var n: u32 = 0;
    while (at < end and bytes[at] >= '0' and bytes[at] <= '9') {
        n = n *% 10 +% (bytes[at] - '0');
        at += 1;
        if (n > self.ir.frameSize) {
            return false;
        }
    }

    if (@as(i32, @intCast(n + self.ir.localCount + self.ir.maxScope)) != r or
        at + 6 > end or
        bytes[at] != ' ' or
        bytes[at + 1] != '=' or
        bytes[at + 2] != ' ' or
        bytes[end - 2] != ';' or
        bytes[end - 1] != '\n')
    {
        return false;
    }

    at += 3;
    // One statement on one line, of no more than a few lines' text.
    const length = end - 2 - at;
    if (length > MAX_HELD or self.heldText.len() + length > MAX_HELD_TEXT) {
        return false;
    }

    var k = at;
    while (k < end - 1) : (k += 1) {
        if (bytes[k] == '\n') {
            return false;
        }
    }

    if (self.heldCount == 0) {
        self.heldText.reset();
    }

    const ru: u32 = @intCast(r);
    self.heldAt[ru] = self.heldText.len();
    try self.heldText.append(out, at, length);
    self.heldEnd[ru] = self.heldText.len();
    self.heldLow[ru] = self.readLow;
    self.heldHigh[ru] = self.readHigh;
    self.held[ru] = 1;
    self.heldCount += 1;
    self.heldTop = @max(self.heldTop, r + 1);
    out.shrink(start);
    return true;
}

/// Write register r's held text to it, `r = text;`, first writing what holds a text that reads r.
pub fn release(self: *MethodEmitter, r: i32) Error!void {
    const ru: u32 = @intCast(r);
    if (self.held[ru] == 0) {
        return;
    }

    self.held[ru] = 0;
    self.heldCount -%= 1;
    try self.clobber(r, -1, -1);
    const out = &self.out;
    try self.regName(r);
    try out.text(" = ");
    try out.append(&self.heldText, self.heldAt[ru], self.heldEnd[ru] - self.heldAt[ru]);
    try out.text(";\n");
    self.checked[ru] = 0;
}

/// Before register w is written: write each held text that reads it, but those of registers from .. to - 1.
pub fn clobber(self: *MethodEmitter, w: i32, from: i32, to: i32) Error!void {
    if (self.heldCount == 0) {
        return;
    }

    var r: i32 = @intCast(self.ir.localCount);
    while (r < self.heldTop) : (r += 1) {
        const ru: u32 = @intCast(r);
        if (self.held[ru] != 0 and (r < from or r >= to) and self.heldLow[ru] <= w and w <= self.heldHigh[ru]) {
            try self.release(r);
        }
    }
}

/// Write every held text, but those of registers from .. to - 1.
pub fn releaseAll(self: *MethodEmitter, from: i32, to: i32) Error!void {
    var r: i32 = @intCast(self.ir.localCount);
    while (r < self.heldTop) : (r += 1) {
        if (r < from or r >= to) {
            try self.release(r);
        }
    }
}

/// Forget register r's held text, a value no instruction reads.
pub fn forget(self: *MethodEmitter, r: i32) void {
    const ru: u32 = @intCast(r);
    if (self.held[ru] != 0) {
        self.held[ru] = 0;
        self.heldCount -%= 1;
    }
}

/// Forget the texts held from register `from` up, values no instruction reads.
pub fn drop(self: *MethodEmitter, from: i32) void {
    var r: i32 = @max(from, 0);
    while (r < self.heldTop) : (r += 1) {
        self.forget(r);
    }

    if (from < self.heldTop) {
        self.heldTop = @max(from, 0);
    }
}

/// `r = void 0`, as a kill or popscope leaves a register; one right after
/// another such, with nothing written or marked between, joins it as
/// `a = r = void 0`, one statement.
pub fn reset(self: *MethodEmitter, r: i32) Error!void {
    const out = &self.out;
    if (@as(i32, @intCast(out.len())) == self.resetEnd and self.map.count() == self.resetMarks) {
        out.shrink(out.len() - RESET_END);
        try out.text(" = ");
    }

    try self.regName(r);
    try out.text(" = void 0");
    self.resets = true;
}
