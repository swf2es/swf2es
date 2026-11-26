// Decodes and verifies a method body the way avmplus' Verifier walks it:
// from the entry along fall-through, branches
// and the exception handlers that a reachable instruction can trigger.
// Unreachable bytes are never read, as in Flash.
//
// Every walk checks the method's structure as the verifier does, with its
// VerifyError numbers; with a domain the walk is typed, merging the states
// where paths join until none changes (avmplus' first phase), then walking
// the blocks once more in code order writing the IR (its second).
//
// The decoder lives in the call's arena: its scratch grows to the longest
// body of the call, and its IR is valid until the next decode.
const std = @import("std");
const Allocator = std.mem.Allocator;
const errors = @import("errors.zig");
const Diagnostics = errors.Diagnostics;
const Rejected = errors.Rejected;
/// A body's verification stops early: rejected, its VerifyError in the
/// Code, or out of memory.
const Error = errors.Error;
const memory = @import("../../memory.zig");
const ir_ = @import("../ir/ir.zig");
const Ir = ir_.Ir;
const typeColumn = ir_.typeColumn;
const domain_ = @import("../link/domain.zig");
const Domain = domain_.Domain;
const traits_ = @import("../link/traits.zig");
const Scope = traits_.Scope;
const TypeId = traits_.TypeId;
const TypeRef = traits_.TypeRef;
const types = @import("../link/types.zig");
const Abc = @import("abc.zig").Abc;
const C = @import("constants.zig");
const ops = @import("opcodes.zig");
const ConstantPool = @import("pool.zig").ConstantPool;
const properties = @import("properties.zig");
const Reader = @import("reader.zig").Reader;
const targets = @import("targets.zig");
const verify = @import("verify.zig");
const Op = @import("opcodes.zig").Op;
const IrOp = @import("../ir/ir.zig").Op;

/// The reachable instructions of one body, ordered by offset; entries past
/// `count` are stale. Operands: a is the first u30, the signed branch offset,
/// or pushbyte/pushshort's value; b the second u30 (debug: string index;
/// lookupswitch: case count - 1); c debug's register, or where lookupswitch's
/// case offsets start in `cases`.
pub const Code = struct {
    gpa: Allocator,
    /// none, or the VerifyError avmplus would throw; then the lists are incomplete.
    @"error": C.VerifyError = .none,
    /// The numbers avmplus' message for `error` names, where `numbered`.
    errorA: u32 = 0,
    errorB: u32 = 0,
    numbered: bool = false,
    count: u32 = 0,
    offset: []u32 = &.{},
    /// Offset of the next instruction in the code.
    next: []u32 = &.{},
    opcode: []Op = &.{},
    a: []i32 = &.{},
    b: []u32 = &.{},
    c: []u32 = &.{},
    /// lookupswitch case offsets, relative to the instruction; `caseCount` are valid.
    cases: []i32 = &.{},
    caseCount: u32 = 0,

    pub fn fail(self: *Code, err: C.VerifyError) void {
        if (self.@"error" == .none) {
            self.@"error" = err;
            self.numbered = false;
        }
    }

    /// fail, with the two numbers its message names.
    pub fn failWith(self: *Code, err: C.VerifyError, a: u32, b: u32) void {
        if (self.@"error" == .none) {
            self.@"error" = err;
            self.errorA = a;
            self.errorB = b;
            self.numbered = true;
        }
    }

    /// Room for `count` instructions; old contents are not kept.
    fn reserve(self: *Code, count: u32) Allocator.Error!void {
        if (self.offset.len >= count) {
            return;
        }

        const capacity = @max(count, self.offset.len * 2);
        self.offset = try self.gpa.alloc(u32, capacity);
        self.next = try self.gpa.alloc(u32, capacity);
        self.opcode = try self.gpa.alloc(Op, capacity);
        self.a = try self.gpa.alloc(i32, capacity);
        self.b = try self.gpa.alloc(u32, capacity);
        self.c = try self.gpa.alloc(u32, capacity);
    }

    fn pushCase(self: *Code, offset: i32) Allocator.Error!void {
        if (self.caseCount == self.cases.len) {
            const grown = try self.gpa.alloc(i32, @max(16, self.cases.len * 2));
            @memcpy(grown[0..self.caseCount], self.cases[0..self.caseCount]);
            self.cases = grown;
        }

        self.cases[self.caseCount] = offset;
        self.caseCount += 1;
    }
};

/// What each byte of a body is: the start of an instruction, inside one,
/// or not decoded yet (BodyDecoder.cover starts zeroed).
pub const Cover = enum(u8) { unseen = 0, start = 1, inside = 2 };

/// A frame value's flags. Their first two bits are the IR's entry flags.
pub const Flags = packed struct(u8) {
    not_null: bool = false,
    /// A with scope's.
    with: bool = false,
    /// Neither null nor undefined, as a null check of the same local found
    /// it since it was last set, on every path here: the verifier still does
    /// not know it not null, as avmplus' marks only the stack value it
    /// checked, but no check of it needs code.
    checked: bool = false,
    _: u5 = 0,

    pub const none: Flags = .{};

    const known_bits: u8 = @bitCast(Flags{ .not_null = true, .checked = true });
    const with_bit: u8 = @bitCast(Flags{ .with = true });

    /// What a copy, a coercion or a conversion keeps: not null, checked.
    pub inline fn known(f: Flags) Flags {
        return @bitCast(@as(u8, @bitCast(f)) & known_bits);
    }

    /// Whether no null check of it needs code.
    pub inline fn isKnown(f: Flags) bool {
        return f.not_null or f.checked;
    }

    /// An entry state's flags merged with a path's: not null and checked
    /// only if both are; with as the entry has it (mergeRange rejects a
    /// path that differs).
    pub inline fn merge(entry: Flags, value: Flags) Flags {
        return @bitCast(@as(u8, @bitCast(entry)) & (@as(u8, @bitCast(value)) | with_bit));
    }
};

comptime {
    // The IR's entry flags are the first two bits (Ir.addBlock's `& 3`,
    // the emitters' scopeWith), and the constants were 1, 2 and 4.
    std.debug.assert(@as(u8, @bitCast(Flags{ .not_null = true })) == 1);
    std.debug.assert(@as(u8, @bitCast(Flags{ .with = true })) == 2);
    std.debug.assert(@as(u8, @bitCast(Flags{ .checked = true })) == 4);
    std.debug.assert(@as(u8, @bitCast(NameParts{ .attr = true, .rtns = true, .rtname = true, .qname = true })) == 15);
    std.debug.assert(@as(u8, @bitCast(NameParts{ .rtname = true })) == 4);
}

/// What a stack value tells of a local: that it is a copy of the local, or
/// that the local is neither null nor undefined when the value is true, or
/// when it is false. Non-exhaustive: `local << 2 | kind`, as the decoder
/// computes them.
pub const Origin = enum(i32) {
    /// Nothing.
    none = -1,
    /// A stack value pushnull or pushundefined pushed.
    nullish = -2,
    _,

    /// Non-exhaustive: negated flips the two tests' bits, which a copy never is.
    pub const Kind = enum(u2) { copy = 0, if_true = 1, if_false = 2, _ };

    pub inline fn of(local_: u32, kind_: Kind) Origin {
        return @fromBackingInt(@bitCast((local_ << 2) | @backingInt(kind_)));
    }

    /// Whether it tells of a local: neither none nor nullish.
    pub inline fn isLocal(o: Origin) bool {
        return @backingInt(o) >= 0;
    }

    pub inline fn local(o: Origin) u32 {
        return @intCast(@backingInt(o) >> 2);
    }

    pub inline fn kind(o: Origin) Kind {
        return @fromBackingInt(@as(u2, @truncate(@as(u32, @bitCast(@backingInt(o))))));
    }

    /// A copy's origin as the test `k`: what its truth tells.
    pub inline fn asTest(o: Origin, k: Kind) Origin {
        return @fromBackingInt(@backingInt(o) | @backingInt(k));
    }

    /// The other test: what the value's falsehood tells.
    pub inline fn negated(o: Origin) Origin {
        return @fromBackingInt(@backingInt(o) ^ 3);
    }
};

/// The parts of a multiname given at run time, and whether it is an
/// attribute's or a qualified name's, as avmplus' Multiname flags.
pub const NameParts = packed struct(u8) {
    attr: bool = false,
    rtns: bool = false,
    rtname: bool = false,
    qname: bool = false,
    _: u4 = 0,
};

const empty_scope: Scope = .{};

pub const BodyDecoder = struct {
    gpa: Allocator,
    /// The last decode's result, overwritten by the next one.
    code: Code,
    r: Reader,
    abc: *Abc,
    /// The ABC's bytes and PADDING.
    data: []const u8,

    // Scratch for the body being decoded, sized to the longest body so far.
    capacity: u32 = 0,
    /// Whether each byte starts an instruction, lies inside one, or is .unseen.
    cover: []Cover = &.{},
    /// Offsets with a known frame state: branch and handler targets.
    known: []u8 = &.{},
    /// Targets of backward branches.
    loopHeader: []u8 = &.{},
    /// Each decoded instruction's operands and end, by its offset.
    slotNext: []u32 = &.{},
    slotA: []i32 = &.{},
    slotB: []u32 = &.{},
    slotC: []u32 = &.{},
    /// Operand and scope stack depth where each decoded instruction starts.
    stackAt: []u32 = &.{},
    scopeAt: []u32 = &.{},
    /// The frame state a known target is entered with; every path in must match.
    entryStack: []u32 = &.{},
    entryScope: []u32 = &.{},
    /// Where a known target's entry values start in entryType and entryFlags.
    entryAt: []u32 = &.{},
    /// Whether a known target is on the work list.
    pending: []u8 = &.{},
    /// The block whose walk last went through each instruction.
    walkOf: []u32 = &.{},
    /// Block starts still to walk, each at most once at a time.
    work: []u32 = &.{},
    workCount: u32 = 0,

    /// Where the body's code starts in `data`.
    start: u32 = 0,
    length: u32 = 0,
    instructions: u32 = 0,
    handlerFirst: u32 = 0,
    handlerCount: u32 = 0,
    tryFrom: u32 = 0,
    tryTo: u32 = 0,
    /// A branch into the middle of an instruction, reported after other errors.
    overlap: bool = false,

    // The method being verified and the frame state of the block being decoded.
    method: u32 = 0,
    methodFlags: C.MethodFlags = .{},
    maxStack: u32 = 0,
    localCount: u32 = 0,
    maxScope: u32 = 0,
    stack: u32 = 0,
    scope: u32 = 0,

    // Typed verification, with a domain; without one, an empty stand-in.
    domain: *Domain,
    typed: bool,
    index: u32 = 0,
    /// The method's domain-wide id, and the traits it belongs to, if any.
    global: u32 = 0,
    declarer: TypeRef = .none,
    outer: *const Scope = &empty_scope,
    frameSize: u32 = 0,
    /// The current values: locals, then maxScope scope entries, then the stack.
    valueType: []TypeId = &.{},
    valueFlags: []Flags = &.{},
    entryType: []TypeId = &.{},
    entryFlags: []Flags = &.{},
    entryUsed: u32 = 0,
    /// By stack value, what it tells of a local in the block being walked,
    /// with that local's count of writes then.
    origin: []Origin = &.{},
    originWrite: []u32 = &.{},
    /// The count of writes of the local nullTest's result tells of.
    testWrite: u32 = 0,
    /// By local: how many times it was set.
    localWrites: []u32 = &.{},
    /// Each handler's exception type and catch scope type, the first
    /// handlerCount of them once a typed walk's checkHandlers succeeds.
    handlerType: []TypeId = &.{},
    /// Bumped whenever a local may have changed: a local set, or the frame
    /// loaded whole. A handler edge whose locals are the same as at the last
    /// merge into it, at the version of handlerMerged, changes nothing there.
    localsVersion: u64 = 1,
    handlerMerged: []u64 = &.{},
    handlerScope: []TypeId = &.{},
    /// avmplus' second verifier phase, writing the IR.
    emitPass: bool = false,
    /// Methods (domain-wide ids) whose scope chain the last decode captured.
    captured: std.ArrayList(u32) = .empty,
    /// The functions the last decode created, each with the index of its
    /// scope chain among those it was created in, in pairs.
    claims: std.ArrayList(u32) = .empty,
    /// The IR the second pass writes, valid until the next decode.
    ir: Ir,
    /// The block number of each block start.
    blockOf: []u32 = &.{},
    /// Whether the instruction being verified wrote its own IR, and the extra operand of a generic one.
    emitted: bool = false,
    rowC: i32 = 0,
    /// The instruction being verified.
    pc: u32 = 0,

    // The values of the block being walked, while a loop header's handler
    // edges are followed from its entry state instead.
    savedType: []TypeId = &.{},
    savedFlags: []Flags = &.{},

    /// A decoder of ABC `index` of `domain`, or untyped, with no domain, its
    /// scratch in `gpa`. Operands may read past the code up to the end of
    /// the ABC, as avmplus' do into its padding.
    pub fn init(gpa: Allocator, abc: *Abc, data: []const u8, domain: ?*Domain, index: u32) Allocator.Error!BodyDecoder {
        const dom = domain orelse stand: {
            const d = try gpa.create(Domain);
            d.* = try .init(gpa, gpa);
            break :stand d;
        };
        return .{
            .gpa = gpa,
            .code = .{ .gpa = gpa },
            .r = .init(data, 0, abc.length),
            .abc = abc,
            .data = data,
            .domain = dom,
            .typed = domain != null,
            .index = index,
            .ir = .{ .gpa = gpa },
        };
    }

    /// The decoder made to decode ABC `index` of `domain` instead, its scratch kept.
    pub fn retarget(self: *BodyDecoder, abc: *Abc, data: []const u8, domain: *Domain, index: u32) void {
        self.abc = abc;
        self.data = data;
        self.r = .init(data, 0, abc.length);
        self.domain = domain;
        self.typed = true;
        self.index = index;
    }

    pub inline fn byteAt(self: *const BodyDecoder, pc: u32) u8 {
        return self.data[self.start + pc];
    }

    /// The byte at `pc` as an opcode.
    pub inline fn opAt(self: *const BodyDecoder, pc: u32) Op {
        return @fromBackingInt(self.byteAt(pc));
    }

    /// Decode body `body`, created in scope chain `outer` (empty by default, as
    /// for a script's initializer); the result is valid until the next call.
    pub fn decode(self: *BodyDecoder, body: u32, outer: ?*const Scope) Allocator.Error!*Code {
        const abc = self.abc;
        const code = &self.code;
        code.@"error" = .none;
        code.errorA = 0;
        code.errorB = 0;
        code.numbered = false;
        code.count = 0;
        code.caseCount = 0;
        // Not the last body's: a body that fails before its second pass captures nothing.
        self.captured.clearRetainingCapacity();
        self.claims.clearRetainingCapacity();

        self.start = abc.bodyCode[body].start;
        self.length = abc.bodyCode[body].len;
        self.handlerFirst = abc.bodyExceptionStart[body];
        self.handlerCount = abc.bodyExceptionStart[body + 1] - self.handlerFirst;
        if (self.handlerMerged.len < self.handlerCount) {
            self.handlerMerged = try self.gpa.alloc(u64, self.handlerCount);
        }

        // No merge yet into this body's handlers: every version before now.
        @memset(self.handlerMerged[0..self.handlerCount], 0);
        self.localsVersion += 1;
        self.instructions = 0;
        self.workCount = 0;
        self.entryUsed = 0;
        self.overlap = false;
        self.r.failed = false;
        self.method = abc.bodyMethod[body];
        self.methodFlags = abc.methodFlags[self.method];
        self.maxStack = abc.bodyMaxStack[body];
        self.localCount = abc.bodyLocalCount[body];
        self.outer = outer orelse &empty_scope;
        try self.reset();
        // A rejected body keeps its Code, with the VerifyError and the
        // instructions decoded so far.
        self.walk(body) catch |err| switch (err) {
            error.Verify => return code,
            error.OutOfMemory => return error.OutOfMemory,
        };
        try self.pack();
        return code;
    }

    /// decode's walks: the checks, the first pass, and the second.
    fn walk(self: *BodyDecoder, body: u32) Error!void {
        // As Verifier::verify: frame limits, exception handlers, then parameters.
        try self.checkFrame(body);
        try self.checkHandlers();
        try self.checkParams();
        if (self.typed) {
            try self.initTypes();
        }

        // Code starting with a label is a block target, so loops may branch to it.
        // Otherwise the entry block has no target, but a typed walk may need to
        // walk it again, so its state is kept all the same.
        self.stack = 0;
        self.scope = 0;
        if (self.opAt(0) == .label) {
            try targets.target(self, -1, 0, 0, 0);
        } else {
            if (self.typed) {
                self.entryStack[0] = 0;
                self.entryScope[0] = 0;
                try targets.saveEntry(self, 0);
            }

            try self.block(0, 0, 0);
        }

        while (self.workCount != 0) {
            self.workCount -= 1;
            const start = self.work[self.workCount];
            self.pending[start] = 0;
            targets.loadEntry(self, start);
            try self.block(start, self.entryStack[start], self.entryScope[start]);
        }

        if (self.overlap) {
            return self.fail(.kInvalidBranchTargetError);
        }

        if (self.typed) {
            try self.secondPass();
        }
    }

    /// As the verifier's phase 2: walk the blocks in code order with their
    /// final entry states, writing the IR.
    fn secondPass(self: *BodyDecoder) Error!void {
        self.emitPass = true;
        defer self.emitPass = false;
        self.captured.clearRetainingCapacity();
        self.claims.clearRetainingCapacity();
        const ir = &self.ir;
        ir.reset(self.localCount, self.maxScope, self.frameSize);
        // The IR adds a coercion or check here and there to the ABC's instructions.
        try ir.reserve(self.instructions + (self.instructions >> 2) + 16);
        ir.outerSize = self.outer.size;
        var blocks: u32 = 0;
        for (0..self.length) |p| {
            if (p == 0 or self.known[p] != 0) {
                self.blockOf[p] = blocks;
                blocks += 1;
            }
        }

        // A handler nothing in its range can throw into has no block, and no use.
        const abc = self.abc;
        for (0..self.handlerCount) |i| {
            const h = self.handlerFirst + @as(u32, @intCast(i));
            const to = abc.exceptionTarget[h];
            if (self.known[to] == 0) {
                continue;
            }

            try ir.addHandler(abc.exceptionFrom[h], abc.exceptionTo[h], self.blockOf[to], self.handlerTypeAt(@intCast(i)), self.handlerScopeAt(@intCast(i)));
        }

        var pc: u32 = 0;
        while (pc < self.length) : (pc += 1) {
            if (pc == 0 or self.known[pc] != 0) {
                targets.loadEntry(self, pc);
                try ir.addBlock(pc, self.entryStack[pc], self.entryScope[pc], self.valueType, self.valueFlags);
                try self.block(pc, self.entryStack[pc], self.entryScope[pc]);
            }
        }
    }

    /// Write an IR instruction, typed as its destination is now.
    pub fn emit(self: *BodyDecoder, op: IrOp, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32, pc: u32) Error!void {
        const ir = &self.ir;
        const i = try ir.add(op, dst, src, count, a, b, c, pc);
        if (dst >= 0) {
            const d: u32 = @intCast(dst);
            ir.type[i] = typeColumn(self.valueType[d]);
            ir.notNull[i] = @intFromBool(self.valueFlags[d].not_null);
        }
    }

    /// Zeroed scratch for this body, growing it if the body is the longest yet.
    fn reset(self: *BodyDecoder) Allocator.Error!void {
        const length = self.length;
        if (length <= self.capacity) {
            @memset(self.cover[0..length], .unseen);
            @memset(self.known[0..length], 0);
            @memset(self.loopHeader[0..length], 0);
            @memset(self.pending[0..length], 0);
            return;
        }

        const capacity = @max(length, self.capacity *| 2);
        const gpa = self.gpa;
        self.cover = try memory.allocZeroed(gpa, Cover, capacity);
        self.known = try memory.allocZeroed(gpa, u8, capacity);
        self.loopHeader = try memory.allocZeroed(gpa, u8, capacity);
        self.pending = try memory.allocZeroed(gpa, u8, capacity);
        self.slotNext = try memory.allocZeroed(gpa, u32, capacity);
        self.slotA = try memory.allocZeroed(gpa, i32, capacity);
        self.slotB = try memory.allocZeroed(gpa, u32, capacity);
        self.slotC = try memory.allocZeroed(gpa, u32, capacity);
        self.stackAt = try memory.allocZeroed(gpa, u32, capacity);
        self.scopeAt = try memory.allocZeroed(gpa, u32, capacity);
        self.entryStack = try memory.allocZeroed(gpa, u32, capacity);
        self.entryScope = try memory.allocZeroed(gpa, u32, capacity);
        self.entryAt = try memory.allocZeroed(gpa, u32, capacity);
        self.walkOf = try memory.allocZeroed(gpa, u32, capacity);
        self.blockOf = try memory.allocZeroed(gpa, u32, capacity);
        self.work = try memory.allocZeroed(gpa, u32, capacity);
        self.capacity = capacity;
    }

    /// As Verifier::checkFrameDefinition: a scope size that is a u30, and a frame that fits.
    fn checkFrame(self: *BodyDecoder, body: u32) Rejected!void {
        const abc = self.abc;
        const scope = @as(i64, abc.bodyMaxScopeDepth[body]) - abc.bodyInitScopeDepth[body];
        const frame = @as(i64, self.localCount) + scope + self.maxStack;
        if (scope < 0 or frame > 0x7fffffff / 8) {
            return self.fail(.kCorruptABCError);
        }

        self.maxScope = @intCast(scope);
        self.frameSize = @intCast(frame);
    }

    /// As Verifier::checkParams: registers for this, the parameters and any rest or arguments.
    fn checkParams(self: *BodyDecoder) Rejected!void {
        const abc = self.abc;
        const params = abc.methodParamStart[self.method + 1] - abc.methodParamStart[self.method];
        if (self.localCount < params +% 1) {
            return self.fail(.kCorruptABCError);
        }

        if (self.methodFlags.need_rest or self.methodFlags.need_arguments) {
            try self.checkLocal(params + 1);
        }
    }

    pub fn checkLocal(self: *BodyDecoder, register: u32) Rejected!void {
        if (register >= self.localCount) {
            return self.failWith(.kInvalidRegisterError, register, 0);
        }
    }

    /// As Verifier::parseExceptionHandlers: known catch types, binding catch
    /// names and sane ranges.
    fn checkHandlers(self: *BodyDecoder) Error!void {
        const abc = self.abc;
        const domain = self.domain;
        const typed = self.typed;
        if (typed and self.handlerType.len < self.handlerCount) {
            const capacity = @max(self.handlerCount, self.handlerType.len * 2);
            self.handlerType = try self.gpa.alloc(TypeId, capacity);
            self.handlerScope = try self.gpa.alloc(TypeId, capacity);
        }

        // An earlier body's handler types read for this one's would give the
        // poison build other output.
        if (memory.poison and typed) {
            @memset(std.mem.sliceAsBytes(self.handlerType[0..self.handlerCount]), memory.poison_byte);
            @memset(std.mem.sliceAsBytes(self.handlerScope[0..self.handlerCount]), memory.poison_byte);
        }

        for (0..self.handlerCount) |i_| {
            const i: u32 = @intCast(i_);
            const h = self.handlerFirst + i;
            const from = abc.exceptionFrom[h];
            const to = abc.exceptionTo[h];
            const target = abc.exceptionTarget[h];
            const name = abc.exceptionName[h];
            var ty: TypeId = .any;
            if (typed and abc.exceptionType[h] != 0) {
                ty = try properties.typeName(self, abc.exceptionType[h]);
            }

            if (name != 0 and !isBinding(&abc.pool, name)) {
                return self.fail(.kCorruptABCError);
            }

            if (to < from or target < to or target >= self.length) {
                return self.fail(.kIllegalExceptionHandlerError);
            }

            if (i == 0 or from < self.tryFrom) {
                self.tryFrom = from;
            }

            if (i == 0 or to > self.tryTo) {
                self.tryTo = to;
            }

            if (typed) {
                self.handlerType[i] = ty;
                const scope = if (name == 0) domain.objectType() else try domain.catchTraits(self.index, h, name, ty);
                self.handlerScope[i] = scope;
            }
        }

        if (self.handlerCount == 0) {
            self.tryFrom = 0;
            self.tryTo = 0;
        }
    }

    /// As the start of Verifier::verify: the method's signature, and the entry
    /// state: `this` and the parameters of their types, `this` not null, the
    /// rest or arguments array, then untyped locals.
    fn initTypes(self: *BodyDecoder) Error!void {
        const domain = self.domain;
        const traits = &domain.traits;
        self.global = domain.methodStart.get(self.index) + self.method;
        self.declarer = traits.methodTraits.get(self.global);
        var diag: Diagnostics = .{};
        traits.sign(domain, self.global, &diag) catch |err| return self.linkFailed(err, &diag);

        if (self.valueType.len < self.frameSize) {
            const gpa = self.gpa;
            self.valueType = try memory.allocZeroed(gpa, TypeId, self.frameSize);
            self.valueFlags = try memory.allocZeroed(gpa, Flags, self.frameSize);
            self.origin = try memory.allocZeroed(gpa, Origin, self.frameSize);
            self.originWrite = try memory.allocZeroed(gpa, u32, self.frameSize);
            self.localWrites = try memory.allocZeroed(gpa, u32, self.frameSize);
        }

        const m = self.global;
        const count = traits.paramCount.get(m);
        self.setValue(0, traits.receiverType.get(m), .{ .not_null = true });
        for (0..count) |p| {
            self.setValue(@intCast(p + 1), traits.paramType.get(traits.paramStart.get(m) + @as(u32, @intCast(p))), .none);
        }

        var firstLocal = count + 1;
        if (self.methodFlags.need_rest or self.methodFlags.need_arguments) {
            self.setValue(firstLocal, domain.arrayType, .{ .not_null = true });
            firstLocal += 1;
        }

        var i = firstLocal;
        while (i < self.localCount) : (i += 1) {
            self.setValue(i, .any, .none);
        }
    }

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
    fn originOf(self: *BodyDecoder, i: u32) Origin {
        const o = self.origin[i];
        if (!o.isLocal() or self.originWrite[i] != self.localWrites[o.local()]) {
            return .none;
        }

        self.testWrite = self.originWrite[i];
        return o;
    }

    /// As originOf, a copy as what its truth tells: no local is null or undefined and true.
    fn truthOf(self: *BodyDecoder, i: u32) Origin {
        const o = self.originOf(i);
        return if (o.isLocal() and o.kind() == .copy) o.asTest(.if_true) else o;
    }

    /// What `==` of the top two values tells, one of them a null or undefined pushed, the other a local's copy.
    fn equalsNull(self: *BodyDecoder) Origin {
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
    fn nullTest(self: *BodyDecoder, opcode: Op) Origin {
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
    fn markChecked(self: *BodyDecoder, local: u32) Flags {
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
    inline fn mergeRange(self: *BodyDecoder, at: u32, from: u32, to: u32) Rejected!bool {
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

    /// Decode and check one block from `start` until it ends or runs into another block.
    pub fn block(self: *BodyDecoder, start: u32, stack: u32, scope: u32) Error!void {
        const code = &self.code;
        self.stack = stack;
        self.scope = scope;
        var pc = start;
        // Every way in has its own copies.
        if (self.typed) {
            @memset(self.origin[0..self.frameSize], .none);
        }

        while (true) {
            if (pc >= self.length) {
                return self.fail(.kCannotFallOffMethodError);
            }

            const opcode = self.opAt(pc);
            const info = opcode.info();
            const operands = info.operands;
            if (operands == .illegal or
                (!self.abc.hasFloatSupport() and
                    (opcode == .pushfloat or opcode == .convert_f or opcode == .unplus)))
            {
                return self.failWith(.kIllegalOpcodeError, @backingInt(opcode), pc);
            }

            if (pc != start and (opcode == .label or self.known[pc] != 0)) {
                return targets.target(self, @as(i64, pc) - 1, pc, self.stack, self.scope);
            }

            // A loop header's implicit interrupt check can throw too, with the
            // state the block is entered with.
            const flags = info.flags;
            if (flags.throws or (pc == start and self.typed and self.loopHeader[pc] != 0)) {
                try targets.throwsAt(self, pc);
            }

            // Decoded already, walking through from an earlier block: without types
            // it was checked with the same depths, so only a typed walk goes on.
            if (self.cover[pc] == .start) {
                if (!self.typed) {
                    return;
                }
            } else {
                try self.decodeAt(pc, opcode, operands);
            }

            self.walkOf[pc] = start;
            self.stackAt[pc] = self.stack;
            self.scopeAt[pc] = self.scope;
            const testing: Origin = if (self.typed) self.nullTest(opcode) else .none;
            try verify.verifyAt(self, pc, opcode);

            if (testing.isLocal() and (opcode == .equals or opcode == .not)) {
                const i = self.peek(1);
                self.origin[i] = testing;
                self.originWrite[i] = self.testWrite;
            }

            // Targets get the state after the instruction, as in the verifier.
            const next = self.slotNext[pc];
            const now_stack = self.stack;
            const now_scope = self.scope;
            if (operands == .branch) {
                // A test of a local goes on with it neither null nor undefined where it tells so.
                const local = if (testing.isLocal()) testing.local() else 0;
                const kind = testing.kind();
                const before: Flags = if (testing.isLocal() and kind == .if_true) self.markChecked(local) else .none;
                try targets.target(self, pc, @as(i64, next) + self.slotA[pc], now_stack, now_scope);

                if (testing.isLocal()) {
                    if (kind == .if_true) {
                        self.valueFlags[local] = before;
                        self.localsVersion += 1;
                    } else {
                        _ = self.markChecked(local);
                    }
                }
            } else if (opcode == .lookupswitch) {
                try targets.target(self, pc, @as(i64, pc) + self.slotA[pc], now_stack, now_scope);

                const first = self.slotC[pc];
                const last = first + self.slotB[pc];
                var i = first;
                while (i <= last) : (i += 1) {
                    try targets.target(self, pc, @as(i64, pc) + code.cases[i], now_stack, now_scope);
                }
            }

            if (flags.terminal) {
                return;
            }

            pc = next;
        }
    }

    /// Decode the instruction at `pc` into its slots.
    fn decodeAt(self: *BodyDecoder, pc: u32, opcode: Op, operands: ops.Operands) Error!void {
        const code = &self.code;
        const r = &self.r;
        r.pos = self.start + pc + 1;

        var a: i32 = 0;
        var b: u32 = 0;
        var c: u32 = 0;
        var wide: u32 = 0;
        switch (operands) {
            .u30 => {
                wide = r.u32_();
                a = @bitCast(wide);
            },
            .u30u30 => {
                a = @bitCast(r.u32_());
                b = r.u32_();
                wide = @as(u32, @bitCast(a)) | b;
            },
            .branch => a = r.s24(),
            .byte => a = @as(i8, @bitCast(@as(u8, @truncate(r.u8_())))),
            // The one u30 operand not range-checked: its low 16 bits are sign-extended.
            .short => a = @as(i16, @bitCast(@as(u16, @truncate(r.u32_())))),
            .debug => {
                a = @intCast(r.u8_());
                b = r.u32_();
                c = r.u8_();
                _ = r.u32_();
                wide = b;
            },
            .switch_table => {
                a = r.s24();
                b = r.u32_();
                wide = b;
            },
            else => {},
        }

        if (wide & 0xc0000000 != 0) {
            return self.fail(.kCorruptABCError);
        }

        const codeEnd = self.start + self.length;
        if (r.failed or r.pos > codeEnd) {
            return self.fail(.kLastInstExceedsCodeSizeError);
        }

        if (opcode == .lookupswitch) {
            c = code.caseCount;
            const caseCount = @as(u64, b) + 1;
            if (@as(u64, r.pos) + caseCount * 3 > codeEnd) {
                return self.fail(.kLastInstExceedsCodeSizeError);
            }

            var i: u64 = 0;
            while (i < caseCount) : (i += 1) {
                try code.pushCase(r.s24());
            }
        }

        const next: u32 = @intCast(r.pos - self.start);
        var p = pc + 1;
        while (p < next) : (p += 1) {
            if (self.cover[p] == .start) {
                self.overlap = true;
            }

            self.cover[p] = .inside;
        }

        if (self.cover[pc] == .inside) {
            self.overlap = true;
        }

        self.cover[pc] = .start;
        self.slotNext[pc] = next;
        self.slotA[pc] = a;
        self.slotB[pc] = b;
        self.slotC[pc] = c;
        self.instructions += 1;
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
            try self.emit(.ir_coerce, @intCast(i), @intCast(i), 1, 0, 0, typeColumn(ty), self.pc);
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
            try self.emit(.ir_check_null, -1, @intCast(i), 1, 0, 0, 0, self.pc);
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

    /// Reject the body with VerifyError `err`.
    pub fn fail(self: *BodyDecoder, err: C.VerifyError) Rejected {
        self.code.fail(err);
        return error.Verify;
    }

    /// The body rejected with the VerifyError linking rejected with, `err`
    /// from a call given `diag`; running out of memory goes on up.
    pub fn linkFailed(self: *BodyDecoder, err: errors.Error, diag: *const Diagnostics) Error {
        return switch (err) {
            error.Verify => self.fail(diag.code),
            error.OutOfMemory => error.OutOfMemory,
        };
    }

    /// fail, with the numbers its message names.
    pub fn failWith(self: *BodyDecoder, err: C.VerifyError, a: u32, b: u32) Rejected {
        self.code.failWith(err, a, b);
        return error.Verify;
    }

    /// Copy the decoded instructions into `code` in offset order.
    fn pack(self: *BodyDecoder) Allocator.Error!void {
        const code = &self.code;
        try code.reserve(self.instructions);

        var i: u32 = 0;
        for (0..self.length) |p_| {
            const p: u32 = @intCast(p_);
            if (self.cover[p] == .start) {
                code.offset[i] = p;
                code.next[i] = self.slotNext[p];
                code.opcode[i] = self.opAt(p);
                code.a[i] = self.slotA[p];
                code.b[i] = self.slotB[p];
                code.c[i] = self.slotC[p];
                i += 1;
            }
        }

        code.count = i;
    }
};

/// As avmplus' Multiname::isBinding for a catch variable: a QName or Multiname
/// with a name, not an attribute or runtime name. A TypeName stands for its base.
pub fn isBinding(pool: *const ConstantPool, index: u32) bool {
    return switch (pool.baseName(index)) {
        .qname => |q| !q.attribute and q.ns != 0 and q.name != 0,
        .multiname => |m| !m.attribute and m.name != 0,
        else => false,
    };
}

/// A multiname's parts.
pub fn nameParts(pool: *const ConstantPool, index: u32) NameParts {
    const mn = pool.baseName(index);
    var parts: NameParts = switch (mn) {
        .qname => .{ .qname = true },
        .rtqname => .{ .qname = true, .rtns = true },
        .rtqname_late => .{ .qname = true, .rtns = true, .rtname = true },
        .multiname_late => .{ .rtname = true },
        .multiname, .type_name, .none => .{},
    };
    parts.attr = mn.isAttribute();
    return parts;
}

/// Verify, with types, every method of ABC `index` that its scripts can
/// run: each script's initializer and methods, then each class's and
/// function's methods once creating them captured their scope chain, as
/// avmplus verifies each before it first runs. The result is each body's VerifyError, 0
/// if it verified, or -1 if nothing could run it.
pub fn verifyMethods(domain: *Domain, index: u32) Allocator.Error![]i32 {
    var verifier = try Verifier.init(domain, domain.scratch, index);
    _ = try verifier.run(std.math.maxInt(u64));
    return verifier.results;
}

/// verifyMethods a part at a time, so that the host gets control back
/// between parts of a large ABC: run until it returns true, with nothing
/// else decoding in between. The parts verify what verifyMethods does, in
/// its order, however they are cut. init counts the ABC as verified and
/// logs .verify at once, as verifyMethods does, so one left before it
/// is done leaves both, and what it resolved, in the domain (compile.zig's
/// abandon).
pub const Verifier = struct {
    domain: *Domain,
    /// Where its results and queue are, which a module written a part at a
    /// time keeps from one call to the next, past the call's arena.
    gpa: Allocator,
    index: u32,
    /// Each body's VerifyError, 0 if it verified, -1 if nothing runs it; complete once run returns true.
    results: []i32 = &.{},
    first: bool,
    entry: u32,
    captures: u32,
    queue: std.ArrayList(u32) = .empty,
    at: usize = 0,
    pass: i32 = 0,
    done: bool = false,
    /// The bytes of code the last run verified, as its budget counts them.
    spent: u64 = 0,

    pub fn init(domain: *Domain, gpa: Allocator, index: u32) Allocator.Error!Verifier {
        // Logged before what it resolves, as what it captures is a function's
        // scope before its signature; kept if it is the ABC's first, or finds
        // a scope the first did not.
        var self: Verifier = .{
            .domain = domain,
            .gpa = gpa,
            .index = index,
            .first = domain.abcVerified.get(index) == 0,
            .entry = domain.logKind.len,
            .captures = domain.captures,
        };
        try domain.put(domain.abcVerified.at(index), 1);
        try domain.logged(.verify, index, 0, 0);
        try self.start();
        return self;
    }

    /// Verify until done, or until the bodies verified by this call hold
    /// `budget` bytes of code, counting at least BODY_COST a body: whether done.
    pub fn run(self: *Verifier, budget: u64) Allocator.Error!bool {
        if (self.done) {
            return true;
        }

        const domain = self.domain;
        const index = self.index;
        const abc = domain.abcs.get(index);
        const traits = &domain.traits;
        const methods = domain.methodStart.get(index);
        const decoder = try bodyDecoder(domain, index);
        self.spent = 0;
        while (true) {
            while (self.at < self.queue.items.len) {
                if (self.spent >= budget) {
                    return false;
                }

                const m = self.queue.items[self.at];
                self.at += 1;
                const body = abc.methodBody[m - methods];
                const scope = traits.scopeOf(m);
                if (body < 0 or scope == null or self.results[@intCast(body)] != -1) {
                    continue;
                }

                const b: u32 = @intCast(body);
                self.results[b] = (try decoder.decode(b, scope)).@"error".number();
                self.spent += @max(@as(u64, abc.bodyCode[b].len), BODY_COST);
                try self.queue.appendSlice(self.gpa, decoder.captured.items);
            }

            if (self.pass >= SETTLE_PASSES or !try settleContests(domain, index)) {
                break;
            }

            self.pass += 1;
            try self.start();
        }

        if (!self.first and domain.captures == self.captures) {
            const entry = self.entry;
            if (domain.logKind.len == entry + 1) {
                // The entry this verifier added, maybe in an earlier call,
                // when it runs a part at a time: kept for a rollback, which
                // puts the log's length back but not a row written over.
                domain.keepTruncated(entry);
                domain.logKind.truncate(entry);
                domain.logAt.truncate(entry);
                domain.logAbc.truncate(entry);
                domain.logA.truncate(entry);
                domain.logB.truncate(entry);
            } else {
                try domain.put(domain.logKind.at(entry), .none);
            }
        }

        self.done = true;
        return true;
    }

    /// A pass over the ABC from its scripts, as each settling of its contested functions starts again.
    fn start(self: *Verifier) Allocator.Error!void {
        const domain = self.domain;
        const index = self.index;
        const abc = domain.abcs.get(index);
        const results = try self.gpa.alloc(i32, abc.bodyCount());
        @memset(results, -1);
        var queue: std.ArrayList(u32) = .empty;
        const scripts = domain.scriptTraits.get(index);
        for (0..abc.scriptCount()) |s| {
            try domain.methodsOf(self.gpa, scripts[s], &queue);
        }

        self.results = results;
        self.queue = queue;
        self.at = 0;
    }
};

/// What verifying a byte of a body's code weighs against the budget of a
/// module written a part at a time: about the garbage, in bytes, it once
/// made, measured on large ABCs. Kept, so that the parts fall where they
/// always did.
pub const VERIFY_COST: u64 = 5;

/// What a body counts for in Verifier.run's budget at least.
const BODY_COST: u64 = 64;

/// Verifications of an ABC again as its contested functions' merged scope chains settle, at most.
const SETTLE_PASSES = 8;

/// After verifying ABC `index`: each contested function's scope chain merged
/// from those it was created in (Scope.merged). Where one changed, the ABC's
/// functions' chains are let go of, for verifying it again: true.
fn settleContests(domain: *Domain, index: u32) Allocator.Error!bool {
    const traits = &domain.traits;
    const start = domain.methodStart.get(index);
    const end = start + domain.abcs.get(index).methodCount();
    var changed = false;
    var g = start;
    while (g < end) : (g += 1) {
        const scopes = traits.functionScopes.get(g);
        if (traits.functionContested.get(g) == 0 or scopes == null) {
            continue;
        }

        // Made in the call's arena, and kept in the domain's only where it changed.
        const merged = try Scope.merged(domain.scratch, scopes.?.items);
        const before = traits.functionMerged.get(g);
        if (before == null or !before.?.equals(merged)) {
            const keep = try domain.gpa.create(Scope);
            keep.* = merged.*;
            keep.types = try domain.gpa.dupe(TypeId, merged.types);
            keep.withs = try domain.gpa.dupe(u8, merged.withs);
            try domain.put(traits.functionMerged.at(g), keep);
            changed = true;
        }
    }

    if (!changed) {
        return false;
    }

    g = start;
    while (g < end) : (g += 1) {
        if (traits.methodFunction.get(g) != 0) {
            try domain.put(traits.functionScope.at(g), null);
            try domain.put(traits.functionScopes.at(g), null);
        }
    }

    return true;
}

/// The one decoder of a call, made for ABC `index`: its scratch kept from
/// one use to the next within the call, and given back with the call's
/// arena. The domain holds it for the call: each Change starts without one.
pub fn bodyDecoder(domain: *Domain, index: u32) Allocator.Error!*BodyDecoder {
    const abc = domain.abcs.get(index);
    const data = domain.abcBuffer.get(index);
    if (domain.decoder) |decoder| {
        decoder.retarget(abc, data, domain, index);
        return decoder;
    }

    const decoder = try domain.scratch.create(BodyDecoder);
    decoder.* = try .init(domain.scratch, abc, data, domain, index);
    domain.decoder = decoder;
    return decoder;
}
