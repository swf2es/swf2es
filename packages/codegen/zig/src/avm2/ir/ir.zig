// The IR of one method (assembly/avm2/ir/ir.ts, whose comment tells what
// each instruction's registers and operands hold): register-form
// instructions with the verifier's types, in blocks, as flat tables that
// the decoder reuses from body to body within a call.
const std = @import("std");
const Allocator = std.mem.Allocator;
const ops = @import("../abc/opcodes.zig");

// Instructions beyond the ABC's opcodes.
/// dst = src coerced to type `c`.
pub const IR_Coerce: u16 = 0x100;
/// Throw a TypeError if src is null or undefined.
pub const IR_CheckNull: u16 = 0x101;
/// dst = the getter of dispatch id `a` of src's type, called on src; c the getter (domain-wide id).
pub const IR_CallGetter: u16 = 0x102;
/// The setter of dispatch id `a` of src's type, called on src with src + 1; c the setter.
pub const IR_CallSetter: u16 = 0x103;
/// dst = an interface's method, called on src with `b` arguments: `a` its
/// dispatch id in the interface's layout, c the method (domain-wide id).
pub const IR_CallInterface: u16 = 0x104;
/// dst = the global object's property `a`, looked up at run time (findpropglobal).
pub const IR_FindPropGlobal: u16 = 0x105;
pub const IR_FindPropGlobalStrict: u16 = 0x106;
/// dst = the method's global object, from its scope chain or its own first scope.
pub const IR_GetGlobalScope: u16 = 0x107;
/// dst = src + count - 1, dropping the `count - 1` values below it.
pub const IR_Nip: u16 = 0x108;
/// dst = a new instance of what slot `a` of src holds, constructed with the
/// `b` arguments after src; c the slot's type.
pub const IR_ConstructSlot: u16 = 0x109;
/// dst = the base class's method of dispatch id `a`, called on src with
/// the `b` arguments after it; c the method (domain-wide id).
pub const IR_CallSuper: u16 = 0x10a;

pub const Ir = struct {
    gpa: Allocator,
    count: u32 = 0,
    op: []u16 = &.{},
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
    pub fn add(self: *Ir, op: u16, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32, pc: u32) Allocator.Error!u32 {
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
        return self.op[i] == ops.OP_lookupswitch;
    }
};
