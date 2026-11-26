// The IR of one method (assembly/avm2/ir/ir.ts, whose comment tells what
// each instruction's registers and operands hold): register-form
// instructions with the verifier's types, in blocks, as flat tables that
// the decoder reuses from body to body within a call.
const std = @import("std");
const Allocator = std.mem.Allocator;
const ops = @import("../abc/opcodes.zig");
const TypeId = @import("../link/traits.zig").TypeId;

/// The IR's own instructions, beyond the ABC's opcodes: their names in Op
/// and their numbers, from 0x100. The `.ir_*` tags used across emit/ are
/// declared here, nowhere else.
const ir_only = [_]struct { []const u8, u16 }{
    // dst = src coerced to type `c`.
    .{ "ir_coerce", 0x100 },
    // Throw a TypeError if src is null or undefined.
    .{ "ir_check_null", 0x101 },
    // dst = the getter of dispatch id `a` of src's type, called on src; c
    // the getter (domain-wide id).
    .{ "ir_call_getter", 0x102 },
    // The setter of dispatch id `a` of src's type, called on src with
    // src + 1; c the setter.
    .{ "ir_call_setter", 0x103 },
    // dst = an interface's method, called on src with `b` arguments: `a`
    // its dispatch id in the interface's layout, c the method (domain-wide
    // id).
    .{ "ir_call_interface", 0x104 },
    // dst = the global object's property `a`, looked up at run time
    // (findpropglobal).
    .{ "ir_find_prop_global", 0x105 },
    .{ "ir_find_prop_global_strict", 0x106 },
    // dst = the method's global object, from its scope chain or its own
    // first scope.
    .{ "ir_get_global_scope", 0x107 },
    // dst = src + count - 1, dropping the `count - 1` values below it.
    .{ "ir_nip", 0x108 },
    // dst = a new instance of what slot `a` of src holds, constructed with
    // the `b` arguments after src; c the slot's type.
    .{ "ir_construct_slot", 0x109 },
    // dst = the base class's method of dispatch id `a`, called on src with
    // the `b` arguments after it; c the method (domain-wide id).
    .{ "ir_call_super", 0x10a },
};

/// An IR instruction's op. Generated: every field of abc/opcodes.zig's Op,
/// with the same name and value (so `.add` is the opcode add), then the
/// IR's own instructions from `ir_only` above (`.ir_coerce` and the rest),
/// from 0x100. Non-exhaustive, like Op; the comptime block below checks
/// that the two agree and do not collide.
pub const Op = blk: {
    const abc_names = @typeInfo(ops.Op).@"enum".field_names;
    const abc_values = @typeInfo(ops.Op).@"enum".field_values;
    var names: [abc_names.len + ir_only.len][]const u8 = undefined;
    var values: [names.len]u16 = undefined;
    for (abc_names, abc_values, 0..) |name, value, i| {
        names[i] = name;
        values[i] = value;
    }

    for (ir_only, abc_names.len..) |op, i| {
        names[i] = op[0];
        values[i] = op[1];
    }

    const final_names = names;
    const final_values = values;
    break :blk @Enum(u16, .nonexhaustive, &final_names, &final_values);
};

comptime {
    for (std.enums.values(ops.Op)) |op| {
        if (@backingInt(@field(Op, @tagName(op))) != @backingInt(op)) {
            @compileError("ir.Op." ++ @tagName(op) ++ " is not the opcode's value");
        }
    }

    for (ir_only) |op| {
        if (op[1] < 0x100) {
            @compileError(op[0] ++ " collides with the opcodes");
        }
    }
}

/// The IR op of opcode `op`.
pub fn of(op: ops.Op) Op {
    return @fromBackingInt(@backingInt(op));
}

/// The opcode `op` is, or null for one of the IR's own.
pub fn opcode(op: Op) ?ops.Op {
    const b = @backingInt(op);
    return if (b < 0x100) @fromBackingInt(@intCast(b)) else null;
}

/// The opcode's name as opcodes.tbl spells it, or "ir" for one of the IR's own.
pub fn opcodeName(op: Op) []const u8 {
    return if (opcode(op)) |o| o.name() else "ir";
}

/// Whether `op` is an opcode that `is` holds of; never one of the IR's own.
pub fn opcodeIs(op: Op, comptime is: fn (ops.Op) bool) bool {
    const b = @backingInt(op);
    return b < 0x100 and is(@fromBackingInt(@as(u8, @truncate(b))));
}

/// A type as an i32, as the IR's columns (type, c, entryType,
/// handlerType), the verifier's frames and the emitters' registers hold
/// it, and back: the one place the two meet, until those hold TypeId too.
pub fn typeColumn(t: TypeId) i32 {
    return @backingInt(t);
}

pub fn columnType(c: i32) TypeId {
    return @fromBackingInt(c);
}

pub const Ir = struct {
    gpa: Allocator,
    count: u32 = 0,
    op: []Op = &.{},
    dst: []i32 = &.{},
    src: []i32 = &.{},
    /// How many consecutive registers from src the instruction reads.
    srcCount: []u32 = &.{},
    a: []u32 = &.{},
    b: []u32 = &.{},
    c: []i32 = &.{},
    /// The type of dst after the instruction, and whether it is known not null.
    type: []i32 = &.{},
    notNull: []u8 = &.{},
    /// The ABC offset of the instruction it comes from.
    pc: []u32 = &.{},

    /// Blocks: the first instruction and the ABC offset of each; blockCount are valid.
    blockCount: u32 = 0,
    blockFirst: []u32 = &.{},
    blockPc: []u32 = &.{},
    /// The operand and scope stack depths each block is entered with.
    blockStack: []u32 = &.{},
    blockScope: []u32 = &.{},

    /// Each block's entry state: frameSize types and flags from block *
    /// frameSize, flag 1 for known not null and 2 for a with scope.
    entryType: []i32 = &.{},
    entryFlags: []u8 = &.{},

    /// Exception handlers: the ABC range they cover, their block, exception type and catch scope type.
    handlerCount: u32 = 0,
    handlerFrom: []u32 = &.{},
    handlerTo: []u32 = &.{},
    handlerBlock: []u32 = &.{},
    handlerType: []i32 = &.{},
    handlerScope: []i32 = &.{},

    /// lookupswitch targets as block numbers; an instruction's are cases[b .. b + c].
    cases: []u32 = &.{},
    caseCount: u32 = 0,

    // The method's frame, to name registers, and its outer scope chain's size.
    localCount: u32 = 0,
    maxScope: u32 = 0,
    frameSize: u32 = 0,
    outerSize: u32 = 0,

    pub fn reset(self: *Ir, localCount: u32, maxScope: u32, frameSize: u32) void {
        self.count = 0;
        self.blockCount = 0;
        self.caseCount = 0;
        self.handlerCount = 0;
        self.localCount = localCount;
        self.maxScope = maxScope;
        self.frameSize = frameSize;
    }

    /// Room for `count` instructions before the next add grows the arrays,
    /// after a reset: none of the old are kept. A body's instructions are
    /// known before its IR is written.
    pub fn reserve(self: *Ir, count: u32) Allocator.Error!void {
        if (count <= self.op.len) {
            return;
        }

        try self.resize(count, 0);
    }

    fn resize(self: *Ir, capacity: usize, used: usize) Allocator.Error!void {
        const gpa = self.gpa;
        inline for (.{ "op", "dst", "src", "srcCount", "a", "b", "c", "type", "notNull", "pc" }) |name| {
            const old = @field(self, name);
            const to = try gpa.alloc(@typeInfo(@TypeOf(old)).pointer.child, capacity);
            @memcpy(to[0..used], old[0..used]);
            @field(self, name) = to;
        }
    }

    /// Append an instruction; its type is filled in once the verifier knows it.
    pub fn add(self: *Ir, op: Op, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32, pc: u32) Allocator.Error!u32 {
        if (self.count == self.op.len) {
            try self.resize(@max(64, self.op.len * 2), self.count);
        }

        const i = self.count;
        self.count += 1;
        self.op[i] = op;
        self.dst[i] = dst;
        self.src[i] = src;
        self.srcCount[i] = count;
        self.a[i] = a;
        self.b[i] = b;
        self.c[i] = c;
        self.type[i] = -1;
        self.notNull[i] = 0;
        self.pc[i] = pc;
        return i;
    }

    /// Start a block at ABC offset `pc` with the next instruction, entered with
    /// stack and scope depths `stack` and `scope` and the frame values `types`
    /// and `flags` (1: not null, 2: with scope).
    pub fn addBlock(self: *Ir, pc: u32, stack: u32, scope: u32, types: []const i32, flags: []const u8) Allocator.Error!void {
        const gpa = self.gpa;
        const k = self.blockCount;
        if (k == self.blockFirst.len) {
            const capacity = @max(16, self.blockFirst.len * 2);
            inline for (.{ "blockFirst", "blockPc", "blockStack", "blockScope" }) |name| {
                const to = try gpa.alloc(u32, capacity);
                @memcpy(to[0..k], @field(self, name)[0..k]);
                @field(self, name) = to;
            }
        }

        const size = self.frameSize;
        const used = k * size;
        if (used + size > self.entryType.len) {
            const capacity = @max(used + size, self.entryType.len * 2);
            const types_to = try gpa.alloc(i32, capacity);
            const flags_to = try gpa.alloc(u8, capacity);
            @memcpy(types_to[0..used], self.entryType[0..used]);
            @memcpy(flags_to[0..used], self.entryFlags[0..used]);
            self.entryType = types_to;
            self.entryFlags = flags_to;
        }

        for (0..size) |i| {
            self.entryType[used + i] = types[i];
            self.entryFlags[used + i] = flags[i] & 3;
        }

        self.blockFirst[k] = self.count;
        self.blockPc[k] = pc;
        self.blockStack[k] = stack;
        self.blockScope[k] = scope;
        self.blockCount += 1;
    }

    pub fn addHandler(self: *Ir, from: u32, to: u32, block: u32, type_: i32, scope: i32) Allocator.Error!void {
        const h = self.handlerCount;
        if (h == self.handlerFrom.len) {
            const capacity = @max(4, self.handlerFrom.len * 2);
            inline for (.{ "handlerFrom", "handlerTo", "handlerBlock", "handlerType", "handlerScope" }) |name| {
                const old = @field(self, name);
                const grown = try self.gpa.alloc(@typeInfo(@TypeOf(old)).pointer.child, capacity);
                @memcpy(grown[0..h], old[0..h]);
                @field(self, name) = grown;
            }
        }

        self.handlerFrom[h] = from;
        self.handlerTo[h] = to;
        self.handlerBlock[h] = block;
        self.handlerType[h] = type_;
        self.handlerScope[h] = scope;
        self.handlerCount += 1;
    }

    pub fn addCase(self: *Ir, block: u32) Allocator.Error!void {
        if (self.caseCount == self.cases.len) {
            const grown = try self.gpa.alloc(u32, @max(16, self.cases.len * 2));
            @memcpy(grown[0..self.caseCount], self.cases[0..self.caseCount]);
            self.cases = grown;
        }

        self.cases[self.caseCount] = block;
        self.caseCount += 1;
    }

    /// Whether instruction i is a lookupswitch, whose targets are in `cases`.
    pub fn isSwitch(self: *const Ir, i: u32) bool {
        return self.op[i] == .lookupswitch;
    }
};
