// The test build's look inside a domain (assembly/testing/domain.ts): its
// lookups, traits and builtins. Verifying, the IR and a method's code come
// with stages 4 and 5.
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../output.zig");
const compile = @import("../compile.zig");
const domain_ = @import("../avm2/link/domain.zig");
const Domain = domain_.Domain;
const code = @import("../avm2/abc/code.zig");
const BodyDecoder = code.BodyDecoder;
const ops = @import("../avm2/abc/opcodes.zig");
const ir_ = @import("../avm2/ir/ir.zig");
const Ir = ir_.Ir;
const traits_ = @import("../avm2/link/traits.zig");
const Diagnostics = @import("../avm2/abc/errors.zig").Diagnostics;
const MethodEmitter = @import("../avm2/emit/method.zig").MethodEmitter;
const stack_names = @import("../avm2/emit/stack-names.zig");
const IrOp = @import("../avm2/ir/ir.zig").Op;

/// The domain's binding of `name` in the namespace of type `type` (NsType) and
/// URI `uri`, visible at `version` from application domain `appDomain`:
/// "abc A script S trait T", or "none".
pub fn domainFind(gpa: Allocator, type_: u8, uri: []const u8, name: []const u8, version: i32, appDomain: i32) Allocator.Error![]const u8 {
    const dom = try compile.domain();
    const uriId = dom.findString(uri);
    const nameId = dom.findString(name);
    if (uriId < 0 or nameId < 0) {
        return "none";
    }

    // An application domain never made: AssemblyScript reads past its tables there.
    if (dom.domainParent.len > 1 and (appDomain < 0 or appDomain >= dom.domainParent.len)) {
        return "none";
    }

    const ns = dom.findNamespace(@fromBackingInt(type_), @intCast(uriId));
    const b = if (ns < 0) -1 else dom.find(@intCast(ns), @intCast(nameId), @truncate(@as(u32, @bitCast(version))), @bitCast(appDomain));
    if (b < 0) {
        return "none";
    }

    const i: u32 = @intCast(b);
    return std.fmt.allocPrint(gpa, "abc {d} script {d} trait {d}", .{ dom.bindingAbc.get(i), dom.bindingScript.get(i), dom.bindingTrait.get(i) });
}

/// A decoded string's units, as AssemblyScript sorts strings by them.
const Units = struct {
    units: []const u16,
    bytes: []const u8,

    fn lessThan(_: void, a: Units, b: Units) bool {
        return std.mem.order(u16, a.units, b.units) == .lt;
    }
};

/// Counts of the domain's tables and recorded findings, then the URIs builtin ABCs version, sorted.
pub fn domainSummary(gpa: Allocator) Allocator.Error![]const u8 {
    const dom = try compile.domain();
    var uris: std.ArrayList(Units) = .empty;
    for (0..dom.versioned.len) |i_| {
        const i: u32 = @intCast(i_);
        if (dom.versioned.get(i) != 0) {
            const bytes = dom.stringOf(i);
            try uris.append(gpa, .{ .units = try output.decodeUnits(gpa, bytes), .bytes = bytes });
        }
    }

    std.mem.sort(Units, uris.items, {}, Units.lessThan);
    var out: std.Io.Writer.Allocating = .init(gpa);
    const w = &out.writer;
    write: {
        w.print("strings {d} namespaces {d} bindings {d} found {d} versioned ", .{ dom.stringPtr.len, dom.nsType.len, dom.bindingNs.len, dom.cachedDomain.len }) catch break :write;
        for (uris.items, 0..) |uri, k| {
            if (k > 0) {
                w.writeByte(',') catch break :write;
            }

            output.writeDecoded(w, uri.bytes) catch break :write;
        }

        return out.written();
    }

    return error.OutOfMemory;
}

fn writeText(w: *std.Io.Writer, dom: *const Domain, id: u32) std.Io.Writer.Error!void {
    if (id == 0xffffffff) {
        return w.writeByte('*');
    }

    return output.writeDecoded(w, dom.stringOf(id));
}

/// The domain's traits from `first` on: "traits T kind K base B slots S
/// methods M", then a "  uri::name kind id" line per own member.
pub fn domainTraits(gpa: Allocator, first: i32) Allocator.Error![]const u8 {
    const dom = try compile.domain();
    const traits = &dom.traits;
    var out: std.Io.Writer.Allocating = .init(gpa);
    const w = &out.writer;
    write: {
        // Below 0, AssemblyScript reads before its tables: from 0 here.
        const from: i32 = @max(first, 0);
        var t: i32 = from;
        while (t < traits.kind.len) : (t += 1) {
            const u: u32 = @bitCast(t);
            if (t > from) {
                w.writeByte('\n') catch break :write;
            }

            w.print("traits {d} kind {d} base {d} slots {d} methods {d}", .{ t, traits.kind.get(u), @backingInt(traits.base.get(u)), traits.slotCount.get(u), traits.methodCount.get(u) }) catch break :write;
            var m = traits.memberStart.get(u);
            while (m < traits.memberEnd.get(u)) : (m += 1) {
                const binding = traits.memberBinding.get(m);
                w.writeAll("\n  ") catch break :write;
                writeText(w, dom, dom.nsUri.get(traits.memberNs.get(m))) catch break :write;
                w.writeAll("::") catch break :write;
                writeText(w, dom, traits.memberName.get(m)) catch break :write;
                w.print(" {d} {d}", .{ @backingInt(binding.kind), binding.index() }) catch break :write;
            }
        }

        return out.written();
    }

    return error.OutOfMemory;
}

/// Resolve every traits of the domain from `first` on, as avmplus does when
/// each is first used: 0, or the first VerifyError.
pub fn domainResolve(dom: *Domain, first: i32) Allocator.Error!i32 {
    const count: i32 = @intCast(dom.traits.kind.len);
    var t: i32 = @max(first, 0);
    while (t < count) : (t += 1) {
        var diag: Diagnostics = .{};
        dom.traits.resolve(dom, @bitCast(t), &diag) catch |err| return switch (err) {
            error.Verify => diag.code.number(),
            error.OutOfMemory => error.OutOfMemory,
        };
    }

    return 0;
}

/// The builtin types the domain found, as traits ids.
pub fn domainBuiltins(gpa: Allocator) Allocator.Error![]const u8 {
    const d = try compile.domain();
    return std.fmt.allocPrint(gpa, "object {d} class {d} void {d} null {d} number {d} int {d} uint {d} boolean {d} string {d} namespace {d} vector {d} vectorObject {d} vectorInt {d} vectorUint {d} vectorDouble {d}", .{ @backingInt(d.objectType()), d.classClass, @backingInt(d.voidType), @backingInt(d.nullType), @backingInt(d.numberType), @backingInt(d.intType), @backingInt(d.uintType), @backingInt(d.booleanType), @backingInt(d.stringType), @backingInt(d.namespaceType), d.vectorClass, @backingInt(d.vectorObjectType), @backingInt(d.vectorIntType), @backingInt(d.vectorUintType), @backingInt(d.vectorDoubleType) });
}

/// The slot types of the instances of class `cls` of ABC `index`, resolving
/// them if they are not yet: each "abc A class C", or "*"; "none" if it has
/// no such class.
pub fn domainSlotTypes(dom: *Domain, gpa: Allocator, index: i32, cls: i32) Allocator.Error![]const u8 {
    if (index < 0 or index >= dom.abcs.len or cls < 0) {
        return "none";
    }

    if (@as(u32, @intCast(cls)) >= dom.abcs.get(@intCast(index)).classCount()) {
        return "none";
    }

    const traits = &dom.traits;
    const t = dom.classTraits.get(dom.classStart.get(@intCast(index)) + @as(u32, @intCast(cls)));
    if (t == .none or !try traits.resolves(dom, t.index())) {
        return "unresolved";
    }

    const u = t.index();
    var out: std.ArrayList(u8) = .empty;
    const start = traits.slotStart.get(u);
    for (0..traits.slotCount.get(u)) |s| {
        if (s > 0) {
            try out.appendSlice(gpa, ", ");
        }

        const ty = traits.slotType.get(start + @as(u32, @intCast(s)));
        if (!ty.isTraits()) {
            try out.append(gpa, '*');
        } else {
            try out.print(gpa, "abc {d} class {d}", .{ traits.abc.get(ty.index()), traits.owner.get(ty.index()) });
        }
    }

    return out.items;
}

/// Verify every method of the domain's last ABC that its scripts can run,
/// with types: a "body B method M error N" line for each that fails, then
/// "verified V of B bodies".
pub fn domainVerifyAll(dom: *Domain, gpa: Allocator) Allocator.Error![]const u8 {
    if (dom.abcs.len == 0) {
        return "verified 0 of 0 bodies";
    }

    const index = dom.abcs.len - 1;
    const abc = dom.abcs.get(index);
    const results = try code.verifyMethods(dom, index);
    var out: std.ArrayList(u8) = .empty;
    var verified: u32 = 0;
    for (results, 0..) |result, b| {
        if (result >= 0) {
            verified += 1;
        }

        if (result > 0) {
            try out.print(gpa, "body {d} method {d} error {d}\n", .{ b, abc.bodyMethod[@intCast(b)], result });
        }
    }

    try out.print(gpa, "verified {d} of {d} bodies", .{ verified, results.len });
    return out.items;
}

/// The IR of body `body` of the domain's last ABC, after verifying the ABC
/// as domainVerifyAll does: "B<n> @<pc> stack [types] scope [types]" per
/// block, then a line per instruction, "<pc>: [dst =] op srcs [a b c] : type",
/// a trailing ! marking a type known not null; "error N" if it failed.
/// The JavaScript function body `body` of the domain's last ABC compiles to,
/// after verifying the ABC as domainVerifyAll does; "error N" if it failed.
pub fn domainEmit(dom: *Domain, gpa: Allocator, body: u32) Allocator.Error![]const u8 {
    if (dom.abcs.len == 0) {
        return "not verified";
    }

    const index = dom.abcs.len - 1;
    const abc = dom.abcs.get(index);
    const results = try code.verifyMethods(dom, index);
    if (body >= results.len) {
        return "not verified";
    }

    if (results[body] != 0) {
        return if (results[body] < 0) "not verified" else std.fmt.allocPrint(gpa, "error {d}", .{results[body]});
    }

    var decoder: BodyDecoder = try .init(gpa, abc, dom.abcBuffer.get(index), dom, index);
    const method = abc.bodyMethod[body];
    const global = dom.methodStart.get(index) + method;
    const result = try decoder.decode(body, dom.traits.scopeOf(global));
    if (result.@"error" != .none) {
        return std.fmt.allocPrint(gpa, "error {d}", .{result.@"error".number()});
    }

    var emitter: MethodEmitter = try .init(gpa, gpa, dom, index);
    emitter.claims = decoder.claims.items;
    emitter.functionName = try stack_names.identifierOf(gpa, try stack_names.stackName(dom, gpa, index, global));
    try emitter.method(method, global, &decoder.ir);
    return emitter.out.written();
}

pub fn domainIr(dom: *Domain, gpa: Allocator, body: u32) Allocator.Error![]const u8 {
    if (dom.abcs.len == 0) {
        return "not verified";
    }

    const index = dom.abcs.len - 1;
    const abc = dom.abcs.get(index);
    const results = try code.verifyMethods(dom, index);
    if (body >= results.len) {
        return "not verified";
    }

    if (results[body] != 0) {
        return if (results[body] < 0) "not verified" else std.fmt.allocPrint(gpa, "error {d}", .{results[body]});
    }

    var decoder: BodyDecoder = try .init(gpa, abc, dom.abcBuffer.get(index), dom, index);
    const m = dom.methodStart.get(index) + abc.bodyMethod[body];
    const result = try decoder.decode(body, dom.traits.scopeOf(m));
    if (result.@"error" != .none) {
        return std.fmt.allocPrint(gpa, "error {d}", .{result.@"error".number()});
    }

    const ir = &decoder.ir;
    var out: std.Io.Writer.Allocating = .init(gpa);
    const w = &out.writer;
    write: {
        const stackBase = ir.localCount + ir.maxScope;
        var lines: u32 = 0;
        for (0..ir.blockCount) |k_| {
            const k: u32 = @intCast(k_);
            const entry = k * ir.frameSize;
            if (lines > 0) w.writeByte('\n') catch break :write;
            lines += 1;
            w.print("B{d} @{d} stack [", .{ k, ir.blockPc[k] }) catch break :write;
            for (0..ir.blockStack[k]) |d| {
                if (d > 0) w.writeAll(", ") catch break :write;
                const at = entry + stackBase + @as(u32, @intCast(d));
                writeType(w, dom, ir.entryType[at], @intFromBool(ir.entryFlags[at].not_null)) catch break :write;
            }

            w.writeAll("] scope [") catch break :write;
            for (0..ir.blockScope[k]) |d| {
                if (d > 0) w.writeAll(", ") catch break :write;
                writeType(w, dom, ir.entryType[entry + ir.localCount + @as(u32, @intCast(d))], 1) catch break :write;
            }

            w.writeByte(']') catch break :write;
            const last = if (k + 1 < ir.blockCount) ir.blockFirst[k + 1] else ir.count;
            var i = ir.blockFirst[k];
            while (i < last) : (i += 1) {
                w.writeAll("\n  ") catch break :write;
                irLine(w, dom, ir, i) catch break :write;
            }
        }

        for (0..ir.handlerCount) |h| {
            if (lines > 0) w.writeByte('\n') catch break :write;
            lines += 1;
            w.print("handler {d}..{d} B{d} ", .{ ir.handlerFrom[h], ir.handlerTo[h], ir.handlerBlock[h] }) catch break :write;
            writeType(w, dom, ir.handlerType[h], 0) catch break :write;
        }

        return out.written();
    }

    return error.OutOfMemory;
}

/// Check the IR of every method of the domain's last ABC that verifies
/// (testing/domain.ts tells what): "checked N bodies, R instructions" or
/// the first problem.
pub fn domainCheckIr(dom: *Domain, gpa: Allocator) Allocator.Error![]const u8 {
    if (dom.abcs.len == 0) {
        return "checked 0 bodies, 0 instructions";
    }

    const index = dom.abcs.len - 1;
    const abc = dom.abcs.get(index);
    const results = try code.verifyMethods(dom, index);
    var decoder: BodyDecoder = try .init(gpa, abc, dom.abcBuffer.get(index), dom, index);
    var bodies: u32 = 0;
    var rows: u32 = 0;
    for (0..abc.bodyCount()) |b| {
        const body: u32 = @intCast(b);
        if (results[body] != 0) {
            continue;
        }

        const m = dom.methodStart.get(index) + abc.bodyMethod[body];
        _ = try decoder.decode(body, dom.traits.scopeOf(m));
        const ir = &decoder.ir;
        bodies += 1;
        rows += ir.count;
        const size: i32 = @intCast(ir.frameSize);
        for (0..ir.blockCount) |k_| {
            const k: u32 = @intCast(k_);
            const first = ir.blockFirst[k];
            const last = if (k + 1 < ir.blockCount) ir.blockFirst[k + 1] else ir.count;
            const end = if (k + 1 < ir.blockCount) ir.blockPc[k + 1] else abc.bodyCode[body].len;
            if (last == first and k + 1 == ir.blockCount) {
                return std.fmt.allocPrint(gpa, "body {d} B{d}: empty last block", .{ body, k });
            }

            var i = first;
            while (i < last) : (i += 1) {
                const op = ir.op[i];
                const where = .{ body, k, i, irName(op) };
                if (ir.dst[i] >= size or ir.dst[i] < ir_.no_register) {
                    return std.fmt.allocPrint(gpa, "body {d} B{d} row {d} ({s}): dst {d} outside the frame of {d}", where ++ .{ ir.dst[i], size });
                }

                if (ir.srcCount[i] != 0 and (ir.src[i] < 0 or ir.src[i] + @as(i32, @bitCast(ir.srcCount[i])) > size)) {
                    return std.fmt.allocPrint(gpa, "body {d} B{d} row {d} ({s}): src {d}+{d} outside the frame of {d}", where ++ .{ ir.src[i], ir.srcCount[i], size });
                }

                if (ir.pc[i] < ir.blockPc[k] or ir.pc[i] >= end) {
                    return std.fmt.allocPrint(gpa, "body {d} B{d} row {d} ({s}): pc {d} outside {d}..{d}", where ++ .{ ir.pc[i], ir.blockPc[k], end });
                }

                const branches = ir_.opcodeIs(op, ops.Op.isBranch);
                if (branches and ir.a[i] >= ir.blockCount) {
                    return std.fmt.allocPrint(gpa, "body {d} B{d} row {d} ({s}): target B{d} of {d}", where ++ .{ ir.a[i], ir.blockCount });
                }

                if (ir.isSwitch(i)) {
                    if (ir.a[i] >= ir.blockCount) {
                        return std.fmt.allocPrint(gpa, "body {d} B{d} row {d} ({s}): default B{d}", where ++ .{ir.a[i]});
                    }

                    var c = ir.b[i];
                    while (c <= ir.b[i] + ir.cLastCase(i)) : (c += 1) {
                        if (ir.cases[c] >= ir.blockCount) {
                            return std.fmt.allocPrint(gpa, "body {d} B{d} row {d} ({s}): case B{d}", where ++ .{ir.cases[c]});
                        }
                    }
                }
            }

            // A block ends in a jump, switch, return or throw, or falls into the next.
            const lastOp: IrOp = if (last > first) ir.op[last - 1] else @fromBackingInt(0);
            const terminal = ir_.opcodeIs(lastOp, isTerminal);
            if (!terminal and k + 1 == ir.blockCount) {
                return std.fmt.allocPrint(gpa, "body {d} B{d}: falls off the end after {s}", .{ body, k, irName(lastOp) });
            }
        }

        for (0..ir.handlerCount) |h| {
            if (ir.handlerBlock[h] >= ir.blockCount) {
                return std.fmt.allocPrint(gpa, "body {d} handler {d}: block B{d}", .{ body, h, ir.handlerBlock[h] });
            }
        }
    }

    return std.fmt.allocPrint(gpa, "checked {d} bodies, {d} instructions", .{ bodies, rows });
}

/// Every verified body's whole IR, as numbers, for comparing compilers
/// (testing/domain.ts's domainIrAll).
pub fn domainIrAll(dom: *Domain, gpa: Allocator) Allocator.Error![]const u8 {
    if (dom.abcs.len == 0) {
        return "";
    }

    const index = dom.abcs.len - 1;
    const abc = dom.abcs.get(index);
    const results = try code.verifyMethods(dom, index);
    var decoder: BodyDecoder = try .init(gpa, abc, dom.abcBuffer.get(index), dom, index);
    var out: std.Io.Writer.Allocating = .init(gpa);
    const w = &out.writer;
    var first = true;
    write: {
        for (0..abc.bodyCount()) |b| {
            const body: u32 = @intCast(b);
            if (results[body] != 0) {
                continue;
            }

            const m = dom.methodStart.get(index) + abc.bodyMethod[body];
            _ = try decoder.decode(body, dom.traits.scopeOf(m));
            const ir = &decoder.ir;
            if (!first) w.writeByte('\n') catch break :write;
            first = false;
            w.print("body {d} frame {d} locals {d} scope {d} outer {d}", .{ body, ir.frameSize, ir.localCount, ir.maxScope, ir.outerSize }) catch break :write;
            for (0..ir.blockCount) |k| {
                w.print("\nblock {d} {d} {d} {d} {d} |", .{ k, ir.blockPc[k], ir.blockFirst[k], ir.blockStack[k], ir.blockScope[k] }) catch break :write;
                for (0..ir.frameSize) |v| {
                    const at = k * ir.frameSize + v;
                    w.print(" {d}:{d}", .{ @backingInt(ir.entryType[at]), @as(u8, @bitCast(ir.entryFlags[at])) }) catch break :write;
                }
            }

            for (0..ir.count) |i| {
                w.print("\n{d} {d} {d} {d} {d} {d} {d} {d} {d} {d}", .{ ir.op[i], ir.dst[i], ir.src[i], ir.srcCount[i], ir.a[i], ir.b[i], ir.c[i], @backingInt(ir.type[i]), @intFromBool(ir.notNull[i]), ir.pc[i] }) catch break :write;
            }

            for (0..ir.handlerCount) |h| {
                w.print("\nhandler {d} {d} {d} {d} {d}", .{ ir.handlerFrom[h], ir.handlerTo[h], ir.handlerBlock[h], @backingInt(ir.handlerType[h]), @backingInt(ir.handlerScope[h]) }) catch break :write;
            }

            w.writeAll("\ncases ") catch break :write;
            for (0..ir.caseCount) |c| {
                if (c > 0) w.writeByte(' ') catch break :write;
                w.print("{d}", .{ir.cases[c]}) catch break :write;
            }
        }

        return out.written();
    }

    return error.OutOfMemory;
}

fn irLine(w: *std.Io.Writer, dom: *const Domain, ir: *const Ir, i: u32) std.Io.Writer.Error!void {
    const op = ir.op[i];
    const dst = ir.dst[i];
    try w.print("{d}: ", .{ir.pc[i]});
    if (dst >= 0) {
        try register(w, ir, dst);
        try w.writeAll(" = ");
    }

    try w.writeAll(irName(op));
    for (0..ir.srcCount[i]) |k| {
        try w.writeByte(' ');
        try register(w, ir, ir.src[i] + @as(i32, @intCast(k)));
    }

    if (ir.isSwitch(i)) {
        try w.print(" default B{d} [", .{ir.a[i]});
        var c = ir.b[i];
        while (c <= ir.b[i] + ir.cLastCase(i)) : (c += 1) {
            if (c > ir.b[i]) try w.writeByte(' ');
            try w.print("B{d}", .{ir.cases[c]});
        }

        try w.writeByte(']');
    } else if (ir_.opcodeIs(op, ops.Op.isBranch)) {
        try w.print(" B{d}", .{ir.a[i]});
    } else if (op == .ir_coerce) {
        try w.writeByte(' ');
        try writeType(w, dom, ir.cType(i), 0);
    } else if (ir.a[i] != 0 or ir.b[i] != 0 or ir.c[i] != 0) {
        try w.print(" [{d} {d} {d}]", .{ ir.a[i], ir.b[i], ir.c[i] });
    }

    if (dst >= 0) {
        try w.writeAll(" : ");
        try writeType(w, dom, ir.type[i], @intFromBool(ir.notNull[i]));
    }
}

fn register(w: *std.Io.Writer, ir: *const Ir, r: i32) std.Io.Writer.Error!void {
    const local: i32 = @intCast(ir.localCount);
    if (r < local) {
        return w.print("l{d}", .{r});
    }

    const scopes: i32 = @intCast(ir.maxScope);
    if (r < local + scopes) {
        return w.print("sc{d}", .{r - local});
    }

    return w.print("s{d}", .{r - local - scopes});
}

fn irName(op: IrOp) []const u8 {
    if (ir_.opcode(op)) |o| {
        return o.name();
    }

    return switch (op) {
        .ir_coerce => "coerce",
        .ir_check_null => "checknull",
        .ir_call_getter => "callgetter",
        .ir_call_setter => "callsetter",
        .ir_call_interface => "callinterface",
        .ir_call_super => "callsuperid",
        .ir_find_prop_global => "findpropglobal",
        .ir_find_prop_global_strict => "findpropglobalstrict",
        .ir_get_global_scope => "getglobalscope",
        .ir_nip => "nip",
        .ir_construct_slot => "constructslot",
        else => "ir?",
    };
}

/// A type's name: "*", void, null, a class's name, "Name$" for its class
/// object, Vector.<T> as deep as T nests (AssemblyScript recurses there;
/// this counts the levels).
fn writeType(w: *std.Io.Writer, dom: *const Domain, ty: traits_.TypeId, notNull: u8) std.Io.Writer.Error!void {
    const traits = &dom.traits;
    var t = ty;
    var vectors: u32 = 0;
    while (t.isTraits()) {
        const u = t.index();
        const kind = traits.kind.get(u);
        const isVector = traits.param.get(u) != .any or
            (kind == .instance and traits.first.get(u) == traits.end.get(u) and
                // No base reads as *, as an absent Vector.<*> does.
                traits.base.get(u).orAny() == dom.vectorObjectType and t != dom.vectorObjectType);
        if (!isVector) {
            break;
        }

        try w.writeAll("Vector.<");
        vectors += 1;
        t = traits.param.get(u);
    }

    if (!t.isTraits()) {
        try w.writeByte('*');
    } else {
        const u = t.index();
        switch (traits.kind.get(u)) {
            .void => try w.writeAll("void"),
            .null => try w.writeAll("null"),
            .script => try w.writeAll("global"),
            .activation => try w.writeAll("activation"),
            .catch_scope => try w.writeAll("catch"),
            else => |kind| {
                const index = traits.abc.get(u);
                const abc = dom.abcs.get(index);
                const id = dom.nameOf(index, abc.instanceName[traits.owner.get(u)]);
                try output.writeDecoded(w, dom.stringOf(id));
                if (kind == .class) {
                    try w.writeByte('$');
                }
            },
        }
    }

    for (0..vectors) |_| {
        try w.writeByte('>');
    }

    if (notNull != 0) {
        try w.writeByte('!');
    }
}

/// How many traits the domain has.
pub fn domainTraitsCount() Allocator.Error!i32 {
    return @intCast((try compile.domain()).traits.kind.len);
}

const memory = @import("../memory.zig");
const lifetime = @import("../avm2/link/lifetime.zig");

fn isTerminal(op: ops.Op) bool {
    return op.info().flags.terminal;
}

test {
    _ = @import("domain/rollback.zig");
}
