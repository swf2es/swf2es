// Writes one method's IR as a JavaScript function whose blocks run in a
// dispatcher, or in structured code where the graph allows
// (assembly/avm2/emit/method.ts, whose comments tell each part). Registers
// are `let` variables named as the IR names them (l0, sc0, s0), and the
// runtime is `rt` in the enclosing module.
//
// The emitter's scratch is in the call's arena, sized to the largest method
// so far, as AssemblyScript's emitter keeps it from method to method.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const output = @import("../../output.zig");
const Output = output.Output;
const Abc = @import("../abc/abc.zig").Abc;
const C = @import("../abc/constants.zig");
const ir_ = @import("../ir/ir.zig");
const Ir = ir_.Ir;
const Domain = @import("../link/domain.zig").Domain;
const traits_ = @import("../link/traits.zig");
const TYPE_Any = traits_.TYPE_Any;
const blocks = @import("blocks.zig");
const copies = @import("copies.zig");
const CONSTANT = copies.CONSTANT;
const NONE = copies.NONE;
const floats = @import("floats.zig");
const handlers = @import("handlers.zig");
const refs = @import("refs.zig");
const SourceMap = @import("sourcemap.zig").SourceMap;
const structure = @import("structure.zig");
const values = @import("values.zig");

/// Whether method m (domain-wide) has an entry for bound calls besides its
/// checked one (method.ts tells which do; see MethodEmitter.boundEntry).
pub fn hasBoundEntry(em: *MethodEmitter, m: u32) bool {
    const domain = em.domain;
    const traits = &domain.traits;
    if (!(domain.isVirtual(m) or isConstructor(em, m)) or domain.allowsExtraArgs(m)) {
        return false;
    }

    const start = traits.paramStart.get(m);
    var classes = false;
    for (0..traits.paramCount.get(m)) |p| {
        const ty = traits.paramType.get(start + @as(u32, @intCast(p)));
        if (domain.builtin(ty) == .float) {
            return false;
        }

        if (refs.isClassRef(em, ir_.typeColumn(ty))) {
            classes = true;
        }
    }

    return classes;
}

/// Whether method m (domain-wide) is a class's instance initializer.
pub fn isConstructor(em: *MethodEmitter, m: u32) bool {
    const traits = &em.domain.traits;
    const t = traits.methodTraits.get(m);
    return t >= 0 and traits.kind.get(@intCast(t)) == .instance and traits.init.get(@intCast(t)) == @as(i32, @bitCast(m));
}

/// The deepest structured code a method is given; one deeper keeps the dispatcher.
pub const MAX_NESTING: u32 = 500;
/// The length of the end of a reset, ` = void 0;\n`.
const RESET_END: u32 = 11;
/// The longest text a register holds, and all of them together, in bytes.
const MAX_HELD: u32 = 1024;
const MAX_HELD_TEXT: u32 = 1 << 20;

/// In a method's types, the entry of a method of a primitive's class
/// (methodSlot): below the names', which count down from -1.
pub const METHOD_SLOT: i32 = std.math.minInt(i32);

fn List(comptime T: type) type {
    return std.ArrayList(T);
}

/// A table of the emitter's scratch at least `n` long, zeroed where it grew.
fn atLeast(gpa: Allocator, comptime T: type, table: *[]T, n: usize) Error!void {
    if (table.len < n) {
        const grown = try gpa.alloc(T, n);
        @memcpy(grown[0..table.len], table.*);
        @memset(grown[table.len..], std.mem.zeroes(T));
        table.* = grown;
    }
}

pub const MethodEmitter = struct {
    gpa: Allocator,
    out: Output,
    /// Where the code for each AS3 line starts, by debugfile and debugline.
    map: SourceMap,
    /// The file (a string of the pool, -1 if none) and line (0 if none) of what is being written.
    file: i32 = -1,
    line: u32 = 0,
    /// Each block's file and line where it starts.
    blockFile: []i32 = &.{},
    blockLine: []u32 = &.{},
    /// Each register's type as the instruction being written reads it.
    regType: []i32 = &.{},
    /// Locals whose float identity is known at every use; their storage is a JS number.
    unboxed: []u8 = &.{},
    /// Float stack values stay unboxed within a block, boxed only for a successor that needs them.
    rawFloat: []u8 = &.{},
    rawTop: i32 = 0,
    rawResult: bool = false,
    unboxResult: bool = false,
    /// Which local scope registers hold with scopes, and how many are pushed.
    scopeWith: []u8 = &.{},
    scopeDepth: u32 = 0,
    /// The classes and Vectors the method refers to, in the order its T
    /// holds them, and below zero the names among them (literalMultinames).
    types: List(i32) = .empty,
    /// By type: its index in types, where its stamp is typeGen, the method's.
    typeIndex: []u32 = &.{},
    typeStamp: []u32 = &.{},
    typeGen: u32 = 1,
    /// The names the method makes of a MultinameL and a string its code holds.
    literalMultinames: List(u32) = .empty,
    literalStrings: List(u32) = .empty,
    /// The methods of primitives' classes the method calls, each kept in an entry of T.
    heldTypes: List(i32) = .empty,
    heldMethods: List(u32) = .empty,
    heldSlots: List(u32) = .empty,
    /// By string: the index in types of the last such name of it, where its stamp is typeGen.
    literalIndex: []u32 = &.{},
    literalStamp: []u32 = &.{},
    /// The name the method being written is given, a JavaScript identifier; "" for none.
    functionName: []const u8 = "",
    /// Whether the method being written can see the default XML namespace.
    seesDxns: bool = false,
    /// Whether the method loads or stores domain memory in place, and where its try starts.
    inPlaceMemory: bool = false,
    memoryAt: u32 = 0,
    memoryMarks: i32 = 0,
    /// Whether the method reads its factory's scope chain, and its base class.
    usesScope: bool = false,
    usesSup: bool = false,
    /// Whether the method constructs a class in place, in the temporaries `$c` and `$o`.
    constructsInPlace: bool = false,
    /// Whether the method being written has an entry for bound calls.
    bound: bool = false,
    /// The functions the method creates, in pairs with their scope chains' indices.
    claims: []const u32 = &.{},
    dxnsAt: u32 = 0,
    dxnsMarks: i32 = 0,
    /// The method's name in its own code, for running it again (see checkEntry).
    entryName: []const u8 = "",
    /// The test its arguments' count fails, "" if none; how many it requires and takes, -1 for any.
    argsTest: []const u8 = "",
    argsRequired: u32 = 0,
    argsMax: i32 = -1,
    /// The method being written: its ABC index and body.
    current: u32 = 0,
    body: i32 = -1,
    /// Whether the method is a script's or class's initializer.
    staticInit: bool = false,
    /// Where the block being written ends: the instruction after its last.
    blockLast: u32 = 0,
    /// The register whose null check the next instruction makes where it first reads it.
    pendingNull: i32 = -1,
    pendingRead: i32 = -1,
    pendingUntil: u32 = 0,
    pendingAt: u32 = 0,
    pendingMarks: i32 = 0,
    /// By register: whether it holds an int or uint made a Number by the coercion before it.
    promoted: []u8 = &.{},
    /// The ABC offsets where the set of handlers covering an instruction can change.
    bounds: []u32 = &.{},
    /// Whether a handler covers region r + 1.
    covered: []u8 = &.{},
    boundCount: u32 = 0,
    region: i32 = -1,

    domain: *Domain,
    index: u32 = 0,
    abc: *Abc,
    /// The ABC's bytes and PADDING.
    data: []const u8,
    ir: *const Ir = undefined,

    // Structured control flow (structure.zig).
    succStart: []u32 = &.{},
    succ: List(u32) = .empty,
    rpo: []i32 = &.{},
    order: []u32 = &.{},
    idom: []i32 = &.{},
    forwardIn: []u32 = &.{},
    loopHeader: []u8 = &.{},
    predStart: []u32 = &.{},
    pred: List(u32) = .empty,
    childStart: []u32 = &.{},
    child: List(u32) = .empty,
    fill: []u32 = &.{},
    handlerOf: []i32 = &.{},
    normalStart: []u32 = &.{},
    tryStack: List(u32) = .empty,
    saved: List(i32) = .empty,
    /// The register or constant each scope and stack register copies, NONE if none.
    copyOf: []i32 = &.{},
    /// A register from which up none is a copy.
    copyTop: i32 = 0,
    /// How many scope and stack registers copy each register.
    copiedBy: []u32 = &.{},
    /// Each block's copies on entry, and flowCopies' scratch (copies.zig).
    copyIn: []i32 = &.{},
    flow: []i32 = &.{},
    dirty: []u8 = &.{},
    /// By register: whether it was checked not null since it was last written.
    checked: []u8 = &.{},
    inPlace: bool = false,
    kept: bool = false,
    target: i32 = -1,
    sunk: bool = false,
    unenclosed: bool = false,
    dfsStack: List(u32) = .empty,
    dfsEdge: List(u32) = .empty,
    reachable: u32 = 0,
    structured: bool = false,
    currentBlock: u32 = 0,
    resetEnd: i32 = -1,
    resetMarks: i32 = 0,
    resets: bool = false,

    // Folding (blocks.zig): held texts of pure expressions.
    held: []u8 = &.{},
    heldAt: []u32 = &.{},
    heldEnd: []u32 = &.{},
    heldLow: []i32 = &.{},
    heldHigh: []i32 = &.{},
    heldCount: u32 = 0,
    heldTop: i32 = 0,
    heldText: Output,
    readLow: i32 = std.math.maxInt(i32),
    readHigh: i32 = -1,

    pub fn init(persist: Allocator, scratch: Allocator, domain: *Domain, index: u32) Error!MethodEmitter {
        return .{
            .gpa = scratch,
            .out = try .init(persist),
            .map = .{ .gpa = persist },
            .heldText = try .init(scratch),
            .domain = domain,
            .index = index,
            .abc = domain.abcs.get(index),
            .data = domain.abcBuffer.get(index),
        };
    }

    /// Write method `method` (domain-wide id `global`) of the ABC, whose body's
    /// IR is `ir`, as `function (p1, ..., pn) { ... }`.
    pub fn method(self: *MethodEmitter, m: u32, global: u32, ir: *const Ir) Error!void {
        const gpa = self.gpa;
        const out = &self.out;
        const traits = &self.domain.traits;
        self.ir = ir;
        self.current = m;
        self.body = self.abc.methodBody[m];
        self.staticInit = values.isStaticInit(self, m);
        const frame = ir.frameSize;
        try atLeast(gpa, i32, &self.regType, frame);
        try atLeast(gpa, u8, &self.scopeWith, ir.maxScope);
        try atLeast(gpa, i32, &self.copyOf, frame);
        try atLeast(gpa, u32, &self.copiedBy, frame);
        try atLeast(gpa, u8, &self.promoted, frame);
        try atLeast(gpa, u8, &self.rawFloat, frame);
        @memset(self.copyOf[0..frame], NONE);
        try atLeast(gpa, u8, &self.held, frame);
        try atLeast(gpa, u32, &self.heldAt, frame);
        try atLeast(gpa, u32, &self.heldEnd, frame);
        try atLeast(gpa, i32, &self.heldLow, frame);
        try atLeast(gpa, i32, &self.heldHigh, frame);

        self.drop(0);

        self.recount();
        try atLeast(gpa, u8, &self.checked, frame);

        try floats.floatLocals(self);

        const count = traits.paramCount.get(global);
        // Named, for stacks and profiles: a name its code never binds (stack-names.zig).
        const name = self.functionName;
        self.bound = hasBoundEntry(self, global);
        // A method with an entry for bound calls is that entry, `name$u`, then
        // its checked entry, `name` (see boundEntry).
        const entry = if (self.bound) try std.fmt.allocPrint(gpa, "{s}$u", .{name}) else name;
        if (self.bound) {
            try out.text("{\n");
        }

        try out.text("function ");
        try out.text(entry);
        try out.text("(");
        try self.parameters(count);

        const flags = self.abc.methodFlags[m];
        if (flags.need_rest) {
            try out.text(if (count != 0) ", ...rest" else "...rest");
        }

        try out.text(") {\n");
        try self.claim(global - m);
        self.dxnsAt = out.len();
        self.dxnsMarks = self.map.count();
        self.entryName = entry;
        self.seesDxns = false;
        self.usesScope = false;
        self.usesSup = false;
        self.constructsInPlace = false;
        try self.prologue(m, global, flags);
        // A method that sets the default XML namespace gives its caller's
        // back when it returns or throws.
        const dxns = flags.sets_dxns;
        if (dxns) {
            try out.text("const $dxns = rt.enterDxns();\ntry {\n");
        }

        self.inPlaceMemory = false;
        self.memoryAt = out.len();
        self.memoryMarks = self.map.count();

        const handled = ir.handlerCount > 0;
        if (handled) {
            try handlers.regions(self);
        }

        try self.debugLines();
        try copies.flowCopies(self);
        const marks = self.map.count();

        // Structured control flow where the graph is reducible and each
        // handler's try encloses the code it covers; else the dispatcher.
        if (try structure.analyze(self)) {
            const start = out.len();
            if (handled) {
                try out.text("let t = 0;\n");
            }

            self.structured = true;
            self.unenclosed = false;
            self.tryStack.clearRetainingCapacity();
            try structure.node(self, 0);
            self.structured = false;
            if (!self.unenclosed) {
                try self.memoryEnd();
                try self.leaveDxns(dxns);
                try out.text("}");
                try self.checkEntry();
                try self.boundEntry(m, global);
                return;
            }

            out.shrink(start);
            self.map.truncate(marks);
        }

        if (handled) {
            try out.text("let b = 0, t = 0;\nfor (;;) try { switch (b) {\n");
        } else {
            try out.text("let b = 0;\nfor (;;) switch (b) {\n");
        }

        for (0..ir.blockCount) |k| {
            try blocks.block(self, @intCast(k));
        }

        // The verifier proved every block ends; a dispatcher still needs an end.
        try out.text("default: throw rt.unreachable();\n}");
        if (handled) {
            try out.text(" } catch (e) {\n");
            try handlers.handlers(self);
            try out.text("}");
        }

        try out.text("\n");
        try self.memoryEnd();
        try self.leaveDxns(dxns);
        try out.text("}");
        try self.checkEntry();
        try self.boundEntry(m, global);
    }

    /// `p1, p2, ...`, the parameters' names.
    fn parameters(self: *MethodEmitter, count: u32) Error!void {
        var p: u32 = 1;
        while (p <= count) : (p += 1) {
            try self.out.text(if (p > 1) ", p" else "p");
            try self.out.uint(p);
        }
    }

    /// The end of a method that loads or stores domain memory in place: its
    /// code in a try whose catch makes the view's RangeError avmplus'.
    pub fn memoryEnd(self: *MethodEmitter) Error!void {
        if (!self.inPlaceMemory) {
            return;
        }

        const start = "try {\n";
        try self.out.insert(self.memoryAt, start);
        self.map.shift(self.memoryMarks, @intCast(start.len));
        try self.space();
        try self.out.text("} catch (e) {\nthrow rt.memoryError(e);\n}\n");
    }

    /// The checks on entry, written first in the method once its code shows
    /// which it needs (method.ts tells which), and before them the
    /// temporaries of the classes it constructs in place.
    pub fn checkEntry(self: *MethodEmitter) Error!void {
        const temporaries: []const u8 = if (self.constructsInPlace) "var $c, $o;\n" else "";
        // A method with an entry for bound calls leaves the count to that entry.
        const entry = try self.entryCheck(if (self.bound) "" else self.argsTest);
        const check = try std.mem.concat(self.gpa, u8, &.{ temporaries, entry });
        if (check.len == 0) {
            return;
        }

        try self.out.insert(self.dxnsAt, check);
        self.map.shift(self.dxnsMarks, @intCast(check.len));
    }

    /// The statement that checks `args` and the default XML namespace on entry, "" for none.
    pub fn entryCheck(self: *MethodEmitter, args: []const u8) Error![]const u8 {
        const dxns = "rt.defaultXmlNamespace !== $dx";
        if (self.seesDxns and args.len > 0) {
            return std.fmt.allocPrint(self.gpa, "if ({s} || {s}) return rt.enter($dx, {s}, this, arguments, {d}, {d});\n", .{ args, dxns, self.entryName, self.argsRequired, self.argsMax });
        }

        if (self.seesDxns) {
            return std.fmt.allocPrint(self.gpa, "if ({s}) return rt.callInDxns($dx, {s}, this, arguments);\n", .{ dxns, self.entryName });
        }

        return if (args.len > 0) std.fmt.allocPrint(self.gpa, "if ({s}) ac({d}, arguments.length);\n", .{ args, self.argsRequired }) else "";
    }

    /// After a method with an entry for bound calls, `name$u`: its checked
    /// entry, `name` (method.ts tells what it does).
    pub fn boundEntry(self: *MethodEmitter, m: u32, global: u32) Error!void {
        if (!self.bound) {
            return;
        }

        const out = &self.out;
        const count = self.domain.traits.paramCount.get(global);
        const unchecked = self.entryName;
        const name = unchecked[0 .. unchecked.len - 2];
        self.entryName = name;
        try out.text("\nfunction ");
        try out.text(name);
        try out.text("(");
        try self.parameters(count);
        try out.text(") {\n");
        try self.claim(global - m);
        try out.text(try self.entryCheck(self.argsTest));
        try out.text("return ");
        try out.text(unchecked);
        try out.text(".call(this");
        var p: u32 = 1;
        while (p <= count) : (p += 1) {
            try out.text(", ");
            try self.parameter(m, global, p, true);
        }

        try out.text(");\n}\n");
        try out.text(name);
        try out.text(".$bound = ");
        try out.text(unchecked);
        try out.text(";\nreturn ");
        try out.text(name);
        try out.text(";\n}");
    }

    /// The contested functions the method creates claimed, first thing, as
    /// avmplus verifies a method before it checks its arguments
    /// (Runtime.claim); `start` is the ABC's first method's domain-wide id.
    pub fn claim(self: *MethodEmitter, start: u32) Error!void {
        const traits = &self.domain.traits;
        const claims = self.claims;
        var c: usize = 0;
        while (c < claims.len) : (c += 2) {
            const g = claims[c];
            var seen = false;
            var d: usize = 0;
            while (d < c) : (d += 2) {
                seen = seen or claims[d] == g;
            }

            if (seen or traits.functionContested.get(g) == 0 or traits.functionMerged.get(g) == null) {
                continue;
            }

            try self.out.text("rt.claim(A, ");
            try self.out.uint(g - start);
            try self.out.text(", ");
            try self.out.uint(claims[c + 1]);
            try self.out.text(");\n");
        }
    }

    /// The end of a method that sets the default XML namespace: its caller's back.
    pub fn leaveDxns(self: *MethodEmitter, dxns: bool) Error!void {
        if (dxns) {
            try self.out.text("} finally {\nrt.defaultXmlNamespace = $dxns;\n}\n");
        }
    }

    /// Each block's file and line where it starts, from the debugfile and debugline instructions before it.
    fn debugLines(self: *MethodEmitter) Error!void {
        const ir = self.ir;
        if (self.blockFile.len < ir.blockCount) {
            self.blockFile = try self.gpa.alloc(i32, @max(ir.blockCount, 64));
            self.blockLine = try self.gpa.alloc(u32, @max(ir.blockCount, 64));
        }

        var file: i32 = -1;
        var line: u32 = 0;
        for (0..ir.blockCount) |k| {
            self.blockFile[k] = file;
            self.blockLine[k] = line;
            const end = if (k + 1 < ir.blockCount) ir.blockFirst[k + 1] else ir.count;
            var i = ir.blockFirst[k];
            while (i < end) : (i += 1) {
                if (ir.op[i] == .debugfile) {
                    file = @bitCast(ir.a[i]);
                } else if (ir.op[i] == .debugline) {
                    line = ir.a[i];
                }
            }
        }
    }

    /// The code written from here on is from the current file and line.
    pub fn mark(self: *MethodEmitter) Error!void {
        try self.map.mark(self.out.len(), self.file, self.line);
    }

    /// Declare the registers: `this`, the parameters, coerced, with defaults, then the rest.
    fn prologue(self: *MethodEmitter, m: u32, global: u32, flags: C.MethodFlags) Error!void {
        const out = &self.out;
        const ir = self.ir;
        const traits = &self.domain.traits;
        const count = traits.paramCount.get(global);

        // As MethodEnv's argcOk, before any coercion (method.ts tells how).
        const required = count - traits.optionalCount.get(global);
        const extra = self.domain.allowsExtraArgs(global);
        self.argsRequired = required;
        self.argsMax = if (extra) -1 else @intCast(count);
        if (required > 0 and !extra) {
            self.argsTest = if (required == count)
                try std.fmt.allocPrint(self.gpa, "arguments.length !== {d}", .{count})
            else
                try std.fmt.allocPrint(self.gpa, "arguments.length - {d} >>> 0 > {d}", .{ required, count - required });
        } else if (required > 0) {
            self.argsTest = try std.fmt.allocPrint(self.gpa, "arguments.length < {d}", .{required});
        } else if (!extra) {
            self.argsTest = try std.fmt.allocPrint(self.gpa, "arguments.length > {d}", .{count});
        } else {
            self.argsTest = "";
        }

        // var, not let: V8 starts a frame's registers undefined.
        try out.text("var l0 = this");
        var p: u32 = 1;
        while (p <= count) : (p += 1) {
            try out.text(", l");
            try out.uint(p);
            try out.text(" = ");
            try self.parameter(m, global, p, !self.bound);
        }

        var local = count + 1;
        if (flags.need_rest) {
            try out.text(", l");
            try out.uint(local);
            local += 1;
            try out.text(" = rt.array(rest)");
        } else if (flags.need_arguments) {
            // With the function itself and its receiver, for arguments.callee.
            try out.text(", l");
            try out.uint(local);
            local += 1;
            try out.text(" = rt.arguments(arguments, ");
            try out.text(self.functionName);
            try out.text(", l0)");
        }

        var r = local;
        while (r < ir.frameSize) : (r += 1) {
            try out.text(", ");
            try self.regName(@intCast(r));
        }

        try out.text(";\n");
    }

    /// Parameter p's value on entry: argument p, coerced to the parameter's
    /// type if `coerce`, or the parameter's default where it was not given.
    pub fn parameter(self: *MethodEmitter, m: u32, global: u32, p: u32, coerce: bool) Error!void {
        const out = &self.out;
        const abc = self.abc;
        const traits = &self.domain.traits;
        const count = traits.paramCount.get(global);
        const ty = traits.paramType.get(traits.paramStart.get(global) + p - 1);
        // The parameters with default values (method.ts tells about untyped functions).
        const optional = abc.methodOptionalStart[m + 1] - abc.methodOptionalStart[m];
        const first = count -% optional;
        if (p > first) {
            // A missing optional argument takes its default.
            try out.text("arguments.length < ");
            try out.uint(p);
            try out.text(" ? ");
            const o = abc.methodOptionalStart[m] + p - first - 1;
            if (self.unboxed[p] != 0) {
                try out.text("rt.toNumber(");
            }

            try refs.constant(self, abc.optionalValue[o], abc.optionalKind[o], ty);
            if (self.unboxed[p] != 0) {
                try out.text(")");
            }

            try out.text(" : ");
        }

        if (coerce) {
            try values.convert(self, "p", @intCast(p), ir_.typeColumn(ty), TYPE_Any, self.unboxed[p] != 0);
        } else {
            try out.text("p");
            try out.uint(p);
        }
    }

    /// Whether instruction i, reading register `r`, only makes its
    /// destination a copy, as flowCopies knows it.
    pub fn copies_(self: *MethodEmitter, i: u32, r: i32) bool {
        const ir = self.ir;
        const stack: i32 = @intCast(ir.localCount + ir.maxScope);
        const dst = ir.dst[i];
        if (dst < @as(i32, @intCast(ir.localCount))) {
            return false;
        }

        const copy = if (r < @as(i32, @intCast(ir.localCount))) NONE else self.copyOf[@intCast(r)];
        const from = if (copy == NONE) r else copy;
        if (dst < stack and (from < 0 or from >= stack)) {
            return false;
        }

        // Its own value again, as a nip of a dup: as it was.
        self.setCopy(dst, if (from == dst) NONE else from);
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
        return self.domain.builtin(ir_.columnType(ir.c[i])) == .number and (bt == .int or bt == .uint);
    }

    /// What a copy reads: a register, or the constant instruction `CONSTANT - copy` pushed.
    pub fn copied(self: *MethodEmitter, copy: i32, boxed: bool) Error!void {
        if (copy >= 0) {
            const c: u32 = @intCast(copy);
            if (self.held[c] != 0) {
                try self.inline_(copy);
                return;
            }

            self.readsAt(copy, copy);
            const wrap = boxed and (self.unboxedLocal(copy) or self.rawFloat[c] != 0);
            if (wrap) {
                try self.out.text("rt.float(");
            }

            try self.regName(copy);
            if (wrap) {
                try self.out.text(")");
            }

            return;
        }

        const out = &self.out;
        const pool = &self.abc.pool;
        const i: u32 = @intCast(CONSTANT - copy);
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
            self.setCopy(r, NONE);
        }

        if (from < self.copyTop) {
            self.copyTop = @max(from, 0);
        }
    }

    /// Register r now a copy of `copy`, or of nothing for NONE: copyTop and copiedBy kept.
    pub fn setCopy(self: *MethodEmitter, r: i32, copy: i32) void {
        const ru: u32 = @intCast(r);
        const old = self.copyOf[ru];
        if (old >= 0) {
            self.copiedBy[@intCast(old)] -%= 1;
        }

        self.copyOf[ru] = copy;
        if (copy >= 0) {
            self.copiedBy[@intCast(copy)] +%= 1;
        }

        if (copy != NONE and r >= self.copyTop) {
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
            if (copy >= 0) {
                self.copiedBy[@intCast(copy)] +%= 1;
            }

            if (copy != NONE) {
                top = @intCast(r + 1);
            }
        }

        self.copyTop = top;
    }

    /// The builtin type of register r's value now.
    pub fn builtinOf(self: *const MethodEmitter, r: i32) traits_.Builtin {
        return self.domain.builtin(ir_.columnType(self.regType[@intCast(r)]));
    }

    /// A new method's types: none yet.
    pub fn newTypes(self: *MethodEmitter) void {
        self.types.clearRetainingCapacity();
        self.literalMultinames.clearRetainingCapacity();
        self.literalStrings.clearRetainingCapacity();
        self.heldTypes.clearRetainingCapacity();
        self.heldMethods.clearRetainingCapacity();
        self.heldSlots.clearRetainingCapacity();
        self.typeGen +%= 1;
        if (self.typeGen == 0) {
            // Every 2^32 methods, the stamps of the first generation would match again.
            @memset(self.typeStamp, 0);
            @memset(self.literalStamp, 0);
            self.typeGen = 1;
        }
    }

    /// Class or Vector type t's index in the method's T, given it the next if new.
    pub fn typeSlot(self: *MethodEmitter, t: i32) Error!u32 {
        // t is a type of the domain's, which may have more since the tables were sized.
        const count = self.domain.traits.kind.len;
        if (self.typeStamp.len < count) {
            const size = @max(count, self.typeStamp.len * 2);
            const index = try self.gpa.alloc(u32, size);
            const stamp = try self.gpa.alloc(u32, size);
            @memcpy(index[0..self.typeIndex.len], self.typeIndex);
            @memset(index[self.typeIndex.len..], 0);
            @memcpy(stamp[0..self.typeStamp.len], self.typeStamp);
            @memset(stamp[self.typeStamp.len..], 0);
            self.typeIndex = index;
            self.typeStamp = stamp;
        }

        const tu: u32 = @intCast(t);
        if (self.typeStamp[tu] != self.typeGen) {
            self.typeStamp[tu] = self.typeGen;
            self.typeIndex[tu] = @intCast(self.types.items.len);
            try self.types.append(self.gpa, t);
        }

        return self.typeIndex[tu];
    }

    /// The index in the method's T of the name multiname `mn` makes of the
    /// pool's string `string`, given it the next if new.
    pub fn literalSlot(self: *MethodEmitter, mn: u32, string: u32) Error!u32 {
        // The tables grow only at a method's first such name: an ABC's methods share a pool.
        const count = self.abc.pool.stringCount();
        if (self.literalStamp.len < count) {
            self.literalIndex = try self.gpa.alloc(u32, count);
            self.literalStamp = try self.gpa.alloc(u32, count);
            @memset(self.literalIndex, 0);
            @memset(self.literalStamp, 0);
        }

        if (self.literalStamp[string] == self.typeGen) {
            const slot = self.literalIndex[string];
            if (self.literalMultinames.items[@intCast(-1 - self.types.items[slot])] == mn) {
                return slot;
            }
        }

        const slot: u32 = @intCast(self.types.items.len);
        try self.types.append(self.gpa, -1 - @as(i32, @intCast(self.literalMultinames.items.len)));
        try self.literalMultinames.append(self.gpa, mn);
        try self.literalStrings.append(self.gpa, string);
        self.literalStamp[string] = self.typeGen;
        self.literalIndex[string] = slot;

        return slot;
    }

    /// The index in the method's T of the method by dispatch id `disp` of
    /// type t's prototype, given it the next if new.
    pub fn methodSlot(self: *MethodEmitter, t: i32, disp: u32) Error!u32 {
        // A method calls few of them: a search costs less than tables by type.
        for (self.heldTypes.items, self.heldMethods.items, 0..) |ty, d, k| {
            if (ty == t and d == disp) {
                return self.heldSlots.items[k];
            }
        }

        const slot: u32 = @intCast(self.types.items.len);
        try self.types.append(self.gpa, METHOD_SLOT);
        try self.heldTypes.append(self.gpa, t);
        try self.heldMethods.append(self.gpa, disp);
        try self.heldSlots.append(self.gpa, slot);

        return slot;
    }

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
        if (r == self.pendingNull or self.copyOf[@intCast(r)] <= CONSTANT) {
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
        const copy = self.copyOf[@intCast(r)];
        if (copy == NONE) {
            try self.copied(r, true);
        } else {
            try self.copied(copy, true);
        }
    }

    pub fn unboxedLocal(self: *const MethodEmitter, r: i32) bool {
        return r >= 0 and r < @as(i32, @intCast(self.ir.localCount)) and self.unboxed[@intCast(r)] != 0;
    }

    pub fn unboxedTarget(self: *const MethodEmitter, i: u32) bool {
        const r = if (self.target >= 0) self.target else self.ir.dst[i];
        return self.unboxedLocal(r) or
            (r >= @as(i32, @intCast(self.ir.localCount + self.ir.maxScope)) and
                ir_.columnType(self.ir.type[i]).isBuiltin(self.domain.floatType));
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
        const which = if (copy == NONE) r else copy;
        if (copy <= CONSTANT and self.ir.op[@intCast(CONSTANT - copy)] == .pushfloat) {
            try self.literal(self.abc.pool.floats[self.ir.a[@intCast(CONSTANT - copy)]], true);
        } else if (self.unboxedLocal(which) or (copy >= NONE and self.rawFloat[@intCast(which)] != 0)) {
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
            ir_.columnType(self.ir.type[i]).isBuiltin(self.domain.floatType);
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
};
