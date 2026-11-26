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
const Error = Allocator.Error;
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
    /// 0, or the VerifyError number avmplus would throw; then the lists are incomplete.
    @"error": i32 = 0,
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

    pub fn fail(self: *Code, err: i32) void {
        if (self.@"error" == 0) {
            self.@"error" = err;
            self.numbered = false;
        }
    }

    /// fail, with the two numbers its message names.
    pub fn failWith(self: *Code, err: i32, a: u32, b: u32) void {
        if (self.@"error" == 0) {
            self.@"error" = err;
            self.errorA = a;
            self.errorB = b;
            self.numbered = true;
        }
    }

    /// Room for `count` instructions; old contents are not kept.
    fn reserve(self: *Code, count: u32) Error!void {
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

    fn pushCase(self: *Code, offset: i32) Error!void {
        if (self.caseCount == self.cases.len) {
            const grown = try self.gpa.alloc(i32, @max(16, self.cases.len * 2));
            @memcpy(grown[0..self.caseCount], self.cases[0..self.caseCount]);
            self.cases = grown;
        }

        self.cases[self.caseCount] = offset;
        self.caseCount += 1;
    }
};

// Byte states in BodyDecoder.cover, which starts zeroed: unseen.
pub const START: u8 = 1;
const INSIDE: u8 = 2;

// Frame value flags.
pub const NOT_NULL: u8 = 1;
pub const WITH: u8 = 2;
/// Neither null nor undefined, as a null check of the same local found it
/// since it was last set, on every path here: the verifier still does not
/// know it not null, as avmplus' marks only the stack value it checked, but
/// no check of it needs code.
pub const CHECKED: u8 = 4;
pub const KNOWN: u8 = NOT_NULL | CHECKED;

// What a stack value tells of a local: it is a copy of the local, or the local
// is neither null nor undefined when the value is true, or when it is false.
pub const ORIGIN_Copy: i32 = 0;
pub const ORIGIN_IfTrue: i32 = 1;
pub const ORIGIN_IfFalse: i32 = 2;
/// A stack value pushnull or pushundefined pushed.
pub const ORIGIN_Nullish: i32 = -2;

// Multiname parts, as avmplus' Multiname flags.
pub const MN_Attr: u8 = 1;
pub const MN_Rtns: u8 = 2;
pub const MN_Rtname: u8 = 4;
pub const MN_QName: u8 = 8;

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
    /// Whether each byte starts an instruction, lies inside one, or is unseen (0).
    cover: []u8 = &.{},
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
    valueFlags: []u8 = &.{},
    entryType: []TypeId = &.{},
    entryFlags: []u8 = &.{},
    entryUsed: u32 = 0,
    /// By stack value, what it tells of a local in the block being walked, as
    /// `local << 2 | ORIGIN_*`, or -1; with that local's count of writes then.
    origin: []i32 = &.{},
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
    savedFlags: []u8 = &.{},

    /// A decoder of ABC `index` of `domain`, or untyped, with no domain, its
    /// scratch in `gpa`. Operands may read past the code up to the end of
    /// the ABC, as avmplus' do into its padding.
    pub fn init(gpa: Allocator, abc: *Abc, data: []const u8, domain: ?*Domain, index: u32) Error!BodyDecoder {
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
    pub fn decode(self: *BodyDecoder, body: u32, outer: ?*const Scope) Error!*Code {
        const abc = self.abc;
        const code = &self.code;
        code.@"error" = 0;
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

        // As Verifier::verify: frame limits, exception handlers, then parameters.
        if (!self.checkFrame(body) or !try self.checkHandlers() or !self.checkParams()) {
            return code;
        }

        if (self.typed and !try self.initTypes()) {
            return code;
        }

        // Code starting with a label is a block target, so loops may branch to it.
        // Otherwise the entry block has no target, but a typed walk may need to
        // walk it again, so its state is kept all the same.
        self.stack = 0;
        self.scope = 0;
        if (self.opAt(0) == .label) {
            if (!try targets.target(self, -1, 0, 0, 0)) {
                return code;
            }
        } else {
            if (self.typed) {
                self.entryStack[0] = 0;
                self.entryScope[0] = 0;
                try targets.saveEntry(self, 0);
            }

            if (!try self.block(0, 0, 0)) {
                return code;
            }
        }

        while (self.workCount != 0) {
            self.workCount -= 1;
            const start = self.work[self.workCount];
            self.pending[start] = 0;
            targets.loadEntry(self, start);
            if (!try self.block(start, self.entryStack[start], self.entryScope[start])) {
                return code;
            }
        }

        if (self.overlap) {
            code.fail(C.kInvalidBranchTargetError);
            return code;
        }

        if (self.typed and !try self.secondPass()) {
            return code;
        }

        try self.pack();
        return code;
    }

    /// As the verifier's phase 2: walk the blocks in code order with their
    /// final entry states, writing the IR.
    fn secondPass(self: *BodyDecoder) Error!bool {
        self.emitPass = true;
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

        var ok = true;
        var pc: u32 = 0;
        while (pc < self.length and ok) : (pc += 1) {
            if (pc == 0 or self.known[pc] != 0) {
                targets.loadEntry(self, pc);
                try ir.addBlock(pc, self.entryStack[pc], self.entryScope[pc], self.valueType, self.valueFlags);
                ok = try self.block(pc, self.entryStack[pc], self.entryScope[pc]);
            }
        }

        self.emitPass = false;
        return ok;
    }

    /// Write an IR instruction, typed as its destination is now.
    pub fn emit(self: *BodyDecoder, op: IrOp, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32, pc: u32) Error!void {
        const ir = &self.ir;
        const i = try ir.add(op, dst, src, count, a, b, c, pc);
        if (dst >= 0) {
            const d: u32 = @intCast(dst);
            ir.type[i] = typeColumn(self.valueType[d]);
            ir.notNull[i] = self.valueFlags[d] & NOT_NULL;
        }
    }

    /// Zeroed scratch for this body, growing it if the body is the longest yet.
    fn reset(self: *BodyDecoder) Error!void {
        const length = self.length;
        if (length <= self.capacity) {
            @memset(self.cover[0..length], 0);
            @memset(self.known[0..length], 0);
            @memset(self.loopHeader[0..length], 0);
            @memset(self.pending[0..length], 0);
            return;
        }

        const capacity = @max(length, self.capacity *| 2);
        const gpa = self.gpa;
        self.cover = try memory.allocZeroed(gpa, u8, capacity);
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
    fn checkFrame(self: *BodyDecoder, body: u32) bool {
        const abc = self.abc;
        const scope = @as(i64, abc.bodyMaxScopeDepth[body]) - abc.bodyInitScopeDepth[body];
        const frame = @as(i64, self.localCount) + scope + self.maxStack;
        if (scope < 0 or frame > 0x7fffffff / 8) {
            self.code.fail(C.kCorruptABCError);
            return false;
        }

        self.maxScope = @intCast(scope);
        self.frameSize = @intCast(frame);
        return true;
    }

    /// As Verifier::checkParams: registers for this, the parameters and any rest or arguments.
    fn checkParams(self: *BodyDecoder) bool {
        const abc = self.abc;
        const params = abc.methodParamStart[self.method + 1] - abc.methodParamStart[self.method];
        if (self.localCount < params +% 1) {
            self.code.fail(C.kCorruptABCError);
            return false;
        }

        if (self.methodFlags.need_rest or self.methodFlags.need_arguments) {
            return self.checkLocal(params + 1);
        }

        return true;
    }

    pub fn checkLocal(self: *BodyDecoder, register: u32) bool {
        if (register >= self.localCount) {
            self.code.failWith(C.kInvalidRegisterError, register, 0);
            return false;
        }

        return true;
    }

    /// As Verifier::parseExceptionHandlers: known catch types, binding catch
    /// names and sane ranges.
    fn checkHandlers(self: *BodyDecoder) Error!bool {
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
                if (ty == TypeId.failed) {
                    return false;
                }
            }

            if (name != 0 and !isBinding(&abc.pool, name)) {
                self.code.fail(C.kCorruptABCError);
                return false;
            }

            if (to < from or target < to or target >= self.length) {
                self.code.fail(C.kIllegalExceptionHandlerError);
                return false;
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

        return true;
    }

    /// As the start of Verifier::verify: the method's signature, and the entry
    /// state: `this` and the parameters of their types, `this` not null, the
    /// rest or arguments array, then untyped locals.
    fn initTypes(self: *BodyDecoder) Error!bool {
        const domain = self.domain;
        const traits = &domain.traits;
        self.global = domain.methodStart.get(self.index) + self.method;
        self.declarer = traits.methodTraits.get(self.global);
        const err = try traits.sign(domain, self.global);
        if (err != 0) {
            return self.fail(err);
        }

        if (self.valueType.len < self.frameSize) {
            const gpa = self.gpa;
            self.valueType = try memory.allocZeroed(gpa, TypeId, self.frameSize);
            self.valueFlags = try memory.allocZeroed(gpa, u8, self.frameSize);
            self.origin = try memory.allocZeroed(gpa, i32, self.frameSize);
            self.originWrite = try memory.allocZeroed(gpa, u32, self.frameSize);
            self.localWrites = try memory.allocZeroed(gpa, u32, self.frameSize);
        }

        const m = self.global;
        const count = traits.paramCount.get(m);
        self.setValue(0, traits.receiverType.get(m), NOT_NULL);
        for (0..count) |p| {
            self.setValue(@intCast(p + 1), traits.paramType.get(traits.paramStart.get(m) + @as(u32, @intCast(p))), 0);
        }

        var firstLocal = count + 1;
        if (self.methodFlags.need_rest or self.methodFlags.need_arguments) {
            self.setValue(firstLocal, domain.arrayType, NOT_NULL);
            firstLocal += 1;
        }

        var i = firstLocal;
        while (i < self.localCount) : (i += 1) {
            self.setValue(i, .any, 0);
        }

        return true;
    }

    // Frame values: locals from 0, scope entries from localCount, the stack from
    // localCount + maxScope.

    pub inline fn setValue(self: *BodyDecoder, i: u32, ty: TypeId, flags: u8) void {
        self.valueType[i] = ty;
        self.valueFlags[i] = flags;
        if (i < self.localCount) {
            self.localsVersion += 1;
            self.localWrites[i] +%= 1;
        } else {
            self.origin[i] = -1;
        }
    }

    /// What stack value i tells of a local, if its local is unchanged since: an ORIGIN_* encoding or -1.
    fn originOf(self: *BodyDecoder, i: u32) i32 {
        const o = self.origin[i];
        if (o < 0 or self.originWrite[i] != self.localWrites[@intCast(o >> 2)]) {
            return -1;
        }

        self.testWrite = self.originWrite[i];
        return o;
    }

    /// As originOf, a copy as what its truth tells: no local is null or undefined and true.
    fn truthOf(self: *BodyDecoder, i: u32) i32 {
        const o = self.originOf(i);
        return if (o >= 0 and (o & 3) == ORIGIN_Copy) o | ORIGIN_IfTrue else o;
    }

    /// What `==` of the top two values tells, one of them a null or undefined pushed, the other a local's copy.
    fn equalsNull(self: *BodyDecoder) i32 {
        const lhs = self.peek(2);
        const rhs = self.peek(1);
        var o: i32 = -1;
        if (self.origin[rhs] == ORIGIN_Nullish) {
            o = self.originOf(lhs);
        } else if (self.origin[lhs] == ORIGIN_Nullish) {
            o = self.originOf(rhs);
        }

        return if (o >= 0 and (o & 3) == ORIGIN_Copy) o | ORIGIN_IfFalse else -1;
    }

    /// What instruction `opcode` tells of a local's being neither null nor
    /// undefined, from its operands: as an ORIGIN_* encoding, for a test
    /// its result's, for a conditional branch its condition's; -1 for nothing.
    fn nullTest(self: *BodyDecoder, opcode: Op) i32 {
        // Too few values fail the instruction's verification after this.
        const one = self.stack >= 1;
        const two = self.stack >= 2;
        var o: i32 = -1;
        switch (opcode) {
            .iftrue => return if (one) self.truthOf(self.peek(1)) else -1,
            .iffalse, .not => o = if (one) self.truthOf(self.peek(1)) else -1,
            .equals, .ifeq => return if (two) self.equalsNull() else -1,
            .ifne => o = if (two) self.equalsNull() else -1,
            else => return -1,
        }

        return if (o < 0) o else o ^ (ORIGIN_IfTrue | ORIGIN_IfFalse);
    }

    /// Mark local `local` checked, returning its flags before.
    fn markChecked(self: *BodyDecoder, local: u32) u8 {
        const flags = self.valueFlags[local];
        self.valueFlags[local] = flags | CHECKED;
        self.localsVersion += 1;
        return flags;
    }

    /// Push null or undefined, of `type`, as what equalsNull compares with.
    pub fn pushNullish(self: *BodyDecoder, ty: TypeId) bool {
        const i = self.stackBase() + self.stack;
        self.setValue(i, ty, 0);
        self.origin[i] = ORIGIN_Nullish;
        return true;
    }

    /// Push local `a`, as a copy of it.
    pub fn pushLocal(self: *BodyDecoder, a: u32) bool {
        const i = self.stackBase() + self.stack;
        self.setValue(i, self.typeOf(a), self.valueFlags[a] & KNOWN);
        self.origin[i] = @bitCast((a << 2) | @as(u32, @bitCast(ORIGIN_Copy)));
        self.originWrite[i] = self.localWrites[a];
        return true;
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
    /// wrote them for this body: in a typed walk, i below handlerCount.
    pub inline fn handlerTypeAt(self: *const BodyDecoder, i: u32) TypeId {
        std.debug.assert(i < self.handlerCount);
        return self.handlerType[i];
    }

    pub inline fn handlerScopeAt(self: *const BodyDecoder, i: u32) TypeId {
        std.debug.assert(i < self.handlerCount);
        return self.handlerScope[i];
    }

    pub inline fn isNotNull(self: *const BodyDecoder, i: u32) bool {
        return (self.valueFlags[i] & NOT_NULL) != 0;
    }

    /// As Verifier::mergeState: merge the current values into known target t's
    /// entry state, whose depths are the same: types to their common base, not
    /// null only if both are. Returns 1 if the entry changed, 0 if not, -1 after
    /// recording 1068 for a with scope meeting another scope.
    pub fn mergeEntry(self: *BodyDecoder, t: u32) i32 {
        const at = self.entryAt[t];
        const base = self.stackBase();
        // The locals and scopes, then the stack, not what lies between.
        const low = self.mergeRange(at, 0, self.localCount + self.scope);
        if (low < 0) {
            return -1;
        }

        const high = self.mergeRange(at, base, base + self.stack);
        return if (high < 0) -1 else low | high;
    }

    /// mergeEntry for values [from, to) of the entry state at `at`.
    inline fn mergeRange(self: *BodyDecoder, at: u32, from: u32, to: u32) i32 {
        var changed: i32 = 0;
        var i = from;
        while (i < to) : (i += 1) {
            const flags = self.valueFlags[i];
            const entryFlags = self.entryFlags[at + i];
            if ((flags ^ entryFlags) & WITH != 0) {
                _ = self.fail(C.kCannotMergeTypesError);
                return -1;
            }

            const entryType = self.entryType[at + i];
            const valueType = self.valueType[i];
            const mergedFlags = entryFlags & (flags | WITH);
            // Most merges meet the same type, which stays.
            if (valueType == entryType and mergedFlags == entryFlags) {
                continue;
            }

            const merged = types.commonBase(self.domain, entryType, valueType);
            if (merged != entryType or mergedFlags != entryFlags) {
                self.entryType[at + i] = merged;
                self.entryFlags[at + i] = mergedFlags;
                changed = 1;
            }
        }

        return changed;
    }

    /// Decode and check one block from `start` until it ends or runs into another block.
    pub fn block(self: *BodyDecoder, start: u32, stack: u32, scope: u32) Error!bool {
        const code = &self.code;
        self.stack = stack;
        self.scope = scope;
        var pc = start;
        // Every way in has its own copies.
        if (self.typed) {
            @memset(self.origin[0..self.frameSize], -1);
        }

        while (true) {
            if (pc >= self.length) {
                code.fail(C.kCannotFallOffMethodError);
                return false;
            }

            const opcode = self.opAt(pc);
            const info = opcode.info();
            const operands = info.operands;
            if (operands == .illegal or
                (!self.abc.hasFloatSupport() and
                    (opcode == .pushfloat or opcode == .convert_f or opcode == .unplus)))
            {
                code.failWith(C.kIllegalOpcodeError, @backingInt(opcode), pc);
                return false;
            }

            if (pc != start and (opcode == .label or self.known[pc] != 0)) {
                return targets.target(self, @as(i64, pc) - 1, pc, self.stack, self.scope);
            }

            // A loop header's implicit interrupt check can throw too, with the
            // state the block is entered with.
            const flags = info.flags;
            if (flags.throws or (pc == start and self.typed and self.loopHeader[pc] != 0)) {
                if (!try targets.throwsAt(self, pc)) {
                    return false;
                }
            }

            // Decoded already, walking through from an earlier block: without types
            // it was checked with the same depths, so only a typed walk goes on.
            if (self.cover[pc] == START) {
                if (!self.typed) {
                    return true;
                }
            } else if (!try self.decodeAt(pc, opcode, operands)) {
                return false;
            }

            self.walkOf[pc] = start;
            self.stackAt[pc] = self.stack;
            self.scopeAt[pc] = self.scope;
            const testing = if (self.typed) self.nullTest(opcode) else -1;
            if (!try verify.verifyAt(self, pc, opcode)) {
                return false;
            }

            if (testing >= 0 and (opcode == .equals or opcode == .not)) {
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
                const local: u32 = @bitCast(testing >> 2);
                const kind = testing & 3;
                const before = if (testing >= 0 and kind == ORIGIN_IfTrue) self.markChecked(local) else 0;
                if (!try targets.target(self, pc, @as(i64, next) + self.slotA[pc], now_stack, now_scope)) {
                    return false;
                }

                if (testing >= 0) {
                    if (kind == ORIGIN_IfTrue) {
                        self.valueFlags[local] = before;
                        self.localsVersion += 1;
                    } else {
                        _ = self.markChecked(local);
                    }
                }
            } else if (opcode == .lookupswitch) {
                if (!try targets.target(self, pc, @as(i64, pc) + self.slotA[pc], now_stack, now_scope)) {
                    return false;
                }

                const first = self.slotC[pc];
                const last = first + self.slotB[pc];
                var i = first;
                while (i <= last) : (i += 1) {
                    if (!try targets.target(self, pc, @as(i64, pc) + code.cases[i], now_stack, now_scope)) {
                        return false;
                    }
                }
            }

            if (flags.terminal) {
                return true;
            }

            pc = next;
        }
    }

    /// Decode the instruction at `pc` into its slots; false after recording the error.
    fn decodeAt(self: *BodyDecoder, pc: u32, opcode: Op, operands: ops.Operands) Error!bool {
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
            code.fail(C.kCorruptABCError);
            return false;
        }

        const codeEnd = self.start + self.length;
        if (r.failed or r.pos > codeEnd) {
            code.fail(C.kLastInstExceedsCodeSizeError);
            return false;
        }

        if (opcode == .lookupswitch) {
            c = code.caseCount;
            const caseCount = @as(u64, b) + 1;
            if (@as(u64, r.pos) + caseCount * 3 > codeEnd) {
                code.fail(C.kLastInstExceedsCodeSizeError);
                return false;
            }

            var i: u64 = 0;
            while (i < caseCount) : (i += 1) {
                try code.pushCase(r.s24());
            }
        }

        const next: u32 = @intCast(r.pos - self.start);
        var p = pc + 1;
        while (p < next) : (p += 1) {
            if (self.cover[p] == START) {
                self.overlap = true;
            }

            self.cover[p] = INSIDE;
        }

        if (self.cover[pc] == INSIDE) {
            self.overlap = true;
        }

        self.cover[pc] = START;
        self.slotNext[pc] = next;
        self.slotA[pc] = a;
        self.slotB[pc] = b;
        self.slotC[pc] = c;
        self.instructions += 1;
        return true;
    }

    // Typed helpers, working on the stack before the instruction's depth change.

    /// Push a value; the instruction's stack effect sets the depth afterwards.
    pub fn push(self: *BodyDecoder, ty: TypeId, flags: u8) bool {
        self.setValue(self.stackBase() + self.stack, ty, flags);
        return true;
    }

    /// Replace the top `n` values with one.
    pub fn popPush(self: *BodyDecoder, n: u32, ty: TypeId, flags: u8) bool {
        self.setValue(self.stackBase() + self.stack -% n, ty, flags);
        return true;
    }

    /// As Verifier::emitCoerce: value i becomes `type`, still null or not.
    pub fn coerce(self: *BodyDecoder, i: u32, ty: TypeId) Error!void {
        const changes = self.typeOf(i) != ty;
        // A coercion of a value neither null nor undefined is not either.
        self.setValue(i, ty, self.valueFlags[i] & KNOWN);
        if (self.emitPass and changes and ty != .any) {
            try self.emit(.ir_coerce, @intCast(i), @intCast(i), 1, 0, 0, typeColumn(ty), self.pc);
        }
    }

    /// As FrameState::setType from a conversion instruction: value i becomes `type`, without IR of its own.
    pub fn retype(self: *BodyDecoder, i: u32, ty: TypeId) void {
        self.setValue(i, ty, self.valueFlags[i] & KNOWN);
    }

    /// As Verifier::emitCheckNull: value i is known not null from here on. The
    /// local it copies, unchanged since, is checked too.
    pub fn checkNull(self: *BodyDecoder, i: u32) Error!void {
        if (self.emitPass and self.valueFlags[i] & KNOWN == 0) {
            try self.emit(.ir_check_null, -1, @intCast(i), 1, 0, 0, 0, self.pc);
        }

        self.valueFlags[i] = self.valueFlags[i] | NOT_NULL;
        if (i < self.localCount) {
            self.localsVersion += 1;
            return;
        }

        const o = self.originOf(i);
        if (o >= 0 and (o & 3) == ORIGIN_Copy) {
            _ = self.markChecked(@intCast(o >> 2));
        }
    }

    /// As Verifier::peekType: the value `n` from the top must be exactly `type`.
    pub fn peekType(self: *BodyDecoder, n: u32, ty: TypeId) bool {
        return if (self.typeOf(self.peek(n)) == ty) true else self.fail(C.kIllegalOperandTypeError);
    }

    /// Write the instruction's own IR row, instead of the generic one.
    pub fn emitOn(self: *BodyDecoder, op: IrOp, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32) Error!bool {
        if (self.emitPass) {
            try self.emit(op, dst, src, count, a, b, c, self.pc);
            self.emitted = true;
        }

        return true;
    }

    pub fn checkString(self: *BodyDecoder, index: u32) bool {
        return if (index == 0 or index >= self.abc.pool.stringCount()) self.fail(C.kCpoolIndexRangeError) else true;
    }

    pub fn fail(self: *BodyDecoder, err: i32) bool {
        self.code.fail(err);
        return false;
    }

    /// fail, with the number its message names.
    pub fn failWith(self: *BodyDecoder, err: i32, a: u32) bool {
        self.code.failWith(err, a, 0);
        return false;
    }

    /// Copy the decoded instructions into `code` in offset order.
    fn pack(self: *BodyDecoder) Error!void {
        const code = &self.code;
        try code.reserve(self.instructions);

        var i: u32 = 0;
        for (0..self.length) |p_| {
            const p: u32 = @intCast(p_);
            if (self.cover[p] == START) {
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

/// A multiname's MN_* parts, as avmplus' Multiname flags.
pub fn nameParts(pool: *const ConstantPool, index: u32) u8 {
    const mn = pool.baseName(index);
    const attr: u8 = if (mn.isAttribute()) MN_Attr else 0;
    return attr | switch (mn) {
        .qname => MN_QName,
        .rtqname => MN_QName | MN_Rtns,
        .rtqname_late => MN_QName | MN_Rtns | MN_Rtname,
        .multiname_late => MN_Rtname,
        .multiname, .type_name, .none => 0,
    };
}

/// Verify, with types, every method of ABC `index` that its scripts can
/// run: each script's initializer and methods, then each class's and
/// function's methods once creating them captured their scope chain, as
/// avmplus verifies each before it first runs. The result is each body's VerifyError, 0
/// if it verified, or -1 if nothing could run it.
pub fn verifyMethods(domain: *Domain, index: u32) Error![]i32 {
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

    pub fn init(domain: *Domain, gpa: Allocator, index: u32) Error!Verifier {
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
    pub fn run(self: *Verifier, budget: u64) Error!bool {
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
                self.results[b] = (try decoder.decode(b, scope)).@"error";
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
    fn start(self: *Verifier) Error!void {
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
fn settleContests(domain: *Domain, index: u32) Error!bool {
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
pub fn bodyDecoder(domain: *Domain, index: u32) Error!*BodyDecoder {
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
