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
const MethodEmitter = @import("../avm2/emit/method.zig").MethodEmitter;
const ModuleEmitter = @import("../avm2/emit/module.zig").ModuleEmitter;
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

            w.print("traits {d} kind {d} base {d} slots {d} methods {d}", .{ t, traits.kind.get(u), traits.base.get(u), traits.slotCount.get(u), traits.methodCount.get(u) }) catch break :write;
            var m = traits.memberStart.get(u);
            while (m < traits.memberEnd.get(u)) : (m += 1) {
                const binding = traits.memberBinding.get(m);
                w.writeAll("\n  ") catch break :write;
                writeText(w, dom, dom.nsUri.get(traits.memberNs.get(m))) catch break :write;
                w.writeAll("::") catch break :write;
                writeText(w, dom, traits.memberName.get(m)) catch break :write;
                w.print(" {d} {d}", .{ @backingInt(binding.kind), @as(u32, binding.id) }) catch break :write;
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
        const err = try dom.traits.resolve(dom, @bitCast(t));
        if (err != 0) {
            return err;
        }
    }

    return 0;
}

/// The builtin types the domain found, as traits ids.
pub fn domainBuiltins(gpa: Allocator) Allocator.Error![]const u8 {
    const d = try compile.domain();
    return std.fmt.allocPrint(gpa, "object {d} class {d} void {d} null {d} number {d} int {d} uint {d} boolean {d} string {d} namespace {d} vector {d} vectorObject {d} vectorInt {d} vectorUint {d} vectorDouble {d}", .{ d.objectType(), d.classClass, d.voidType, d.nullType, d.numberType, d.intType, d.uintType, d.booleanType, d.stringType, d.namespaceType, d.vectorClass, d.vectorObjectType, d.vectorIntType, d.vectorUintType, d.vectorDoubleType });
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
    if (t < 0 or try traits.resolve(dom, @intCast(t)) != 0) {
        return "unresolved";
    }

    const u: u32 = @intCast(t);
    var out: std.ArrayList(u8) = .empty;
    const start = traits.slotStart.get(u);
    for (0..traits.slotCount.get(u)) |s| {
        if (s > 0) {
            try out.appendSlice(gpa, ", ");
        }

        const ty = traits.slotType.get(start + @as(u32, @intCast(s)));
        if (ty < 0) {
            try out.append(gpa, '*');
        } else {
            try out.print(gpa, "abc {d} class {d}", .{ traits.abc.get(@intCast(ty)), traits.owner.get(@intCast(ty)) });
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
    if (result.@"error" != 0) {
        return std.fmt.allocPrint(gpa, "error {d}", .{result.@"error"});
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
    if (result.@"error" != 0) {
        return std.fmt.allocPrint(gpa, "error {d}", .{result.@"error"});
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
                writeType(w, dom, ir.entryType[at], ir.entryFlags[at] & 1) catch break :write;
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
                if (ir.dst[i] >= size or ir.dst[i] < -1) {
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
                    while (c <= ir.b[i] + @as(u32, @bitCast(ir.c[i]))) : (c += 1) {
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
                    w.print(" {d}:{d}", .{ ir.entryType[at], ir.entryFlags[at] }) catch break :write;
                }
            }

            for (0..ir.count) |i| {
                w.print("\n{d} {d} {d} {d} {d} {d} {d} {d} {d} {d}", .{ ir.op[i], ir.dst[i], ir.src[i], ir.srcCount[i], ir.a[i], ir.b[i], ir.c[i], ir.type[i], ir.notNull[i], ir.pc[i] }) catch break :write;
            }

            for (0..ir.handlerCount) |h| {
                w.print("\nhandler {d} {d} {d} {d} {d}", .{ ir.handlerFrom[h], ir.handlerTo[h], ir.handlerBlock[h], ir.handlerType[h], ir.handlerScope[h] }) catch break :write;
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
        while (c <= ir.b[i] + @as(u32, @bitCast(ir.c[i]))) : (c += 1) {
            if (c > ir.b[i]) try w.writeByte(' ');
            try w.print("B{d}", .{ir.cases[c]});
        }

        try w.writeByte(']');
    } else if (ir_.opcodeIs(op, ops.Op.isBranch)) {
        try w.print(" B{d}", .{ir.a[i]});
    } else if (op == .ir_coerce) {
        try w.writeByte(' ');
        try writeType(w, dom, ir.c[i], 0);
    } else if (ir.a[i] != 0 or ir.b[i] != 0 or ir.c[i] != 0) {
        try w.print(" [{d} {d} {d}]", .{ ir.a[i], ir.b[i], ir.c[i] });
    }

    if (dst >= 0) {
        try w.writeAll(" : ");
        try writeType(w, dom, ir.type[i], ir.notNull[i]);
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
fn writeType(w: *std.Io.Writer, dom: *const Domain, ty: i32, notNull: u8) std.Io.Writer.Error!void {
    const traits = &dom.traits;
    var t = ty;
    var vectors: u32 = 0;
    while (t >= 0) {
        const u: u32 = @intCast(t);
        const kind = traits.kind.get(u);
        const isVector = traits.param.get(u) != -1 or
            (kind == .instance and traits.first.get(u) == traits.end.get(u) and
                traits.base.get(u) == dom.vectorObjectType and t != dom.vectorObjectType);
        if (!isVector) {
            break;
        }

        try w.writeAll("Vector.<");
        vectors += 1;
        t = traits.param.get(u);
    }

    if (t < 0) {
        try w.writeByte('*');
    } else {
        const u: u32 = @intCast(t);
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
const testing = std.testing;

// The ABCs of tests/parity/link-abc.ts, which a unit test holds these to:
// a builtin one that links with nothing before it, a user one extending
// its class from another application domain, one that fails to link, and
// a wide one whose strings, namespaces and members outgrow an id table's
// first 64 slots in the call that links it, and the user one creating its
// class, for the verifier.
pub const link_builtin = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x03, 0x03, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, 0x15, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74,
    0x05, 0x43, 0x6c, 0x61, 0x73, 0x73, 0x08, 0x46, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e,
    0x04, 0x76, 0x6f, 0x69, 0x64, 0x05, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x01, 0x41, 0x01, 0x42,
    0x01, 0x49, 0x01, 0x46, 0x07, 0x4d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x01, 0x6d, 0x01,
    0x78, 0x09, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x74, 0x79, 0x70, 0x65, 0x03, 0x69, 0x6e, 0x74,
    0x04, 0x75, 0x69, 0x6e, 0x74, 0x06, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x06, 0x53, 0x74,
    0x72, 0x69, 0x6e, 0x67, 0x07, 0x42, 0x6f, 0x6f, 0x6c, 0x65, 0x61, 0x6e, 0x01, 0x6e, 0x04,
    0x16, 0x01, 0x16, 0x07, 0x08, 0x09, 0x02, 0x02, 0x01, 0x02, 0x17, 0x07, 0x01, 0x02, 0x07,
    0x01, 0x03, 0x07, 0x01, 0x04, 0x07, 0x01, 0x05, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x07,
    0x01, 0x08, 0x07, 0x01, 0x09, 0x07, 0x01, 0x0a, 0x07, 0x01, 0x0b, 0x07, 0x01, 0x0c, 0x07,
    0x01, 0x0d, 0x07, 0x01, 0x0e, 0x07, 0x01, 0x0f, 0x07, 0x01, 0x10, 0x07, 0x01, 0x11, 0x07,
    0x01, 0x12, 0x07, 0x01, 0x13, 0x07, 0x01, 0x14, 0x09, 0x07, 0x01, 0x07, 0x02, 0x07, 0x07,
    0x03, 0x0c, 0x13, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x00,
    0x00, 0x02, 0x00, 0x03, 0x01, 0x00, 0x00, 0x04, 0x00, 0x08, 0x00, 0x04, 0x00, 0x06, 0x01,
    0x16, 0x01, 0x00, 0x0d, 0x06, 0x01, 0x00, 0x01, 0x08, 0x08, 0x05, 0x0c, 0x00, 0x00, 0x06,
    0x00, 0x09, 0x06, 0x00, 0x01, 0x01, 0x03, 0x0b, 0x01, 0x00, 0x0e, 0x13, 0x02, 0x00, 0x0f,
    0x13, 0x03, 0x00, 0x10, 0x07, 0x06, 0x00, 0x00, 0x0a, 0x02, 0x0b, 0x21, 0x00, 0x11, 0x13,
    0x22, 0x00, 0x12, 0x01, 0x00, 0x03, 0x00, 0x05, 0x00, 0x07, 0x00, 0x09, 0x01, 0x0c, 0x00,
    0x00, 0x01, 0x00, 0x0b, 0x00, 0x01, 0x0c, 0x06, 0x01, 0x04, 0x01, 0x00, 0x02, 0x04, 0x02,
    0x01, 0x03, 0x04, 0x03, 0x02, 0x08, 0x04, 0x04, 0x03, 0x06, 0x04, 0x05, 0x04, 0x07, 0x04,
    0x06, 0x05, 0x01, 0x0c, 0x01, 0x01, 0x00, 0x01, 0x01, 0x47, 0x00, 0x00,
};

pub const link_user = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x03, 0x03, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, 0x15, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74,
    0x05, 0x43, 0x6c, 0x61, 0x73, 0x73, 0x08, 0x46, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e,
    0x04, 0x76, 0x6f, 0x69, 0x64, 0x05, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x01, 0x41, 0x01, 0x42,
    0x01, 0x49, 0x01, 0x46, 0x07, 0x4d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x01, 0x6d, 0x01,
    0x78, 0x09, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x74, 0x79, 0x70, 0x65, 0x03, 0x69, 0x6e, 0x74,
    0x04, 0x75, 0x69, 0x6e, 0x74, 0x06, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x06, 0x53, 0x74,
    0x72, 0x69, 0x6e, 0x67, 0x07, 0x42, 0x6f, 0x6f, 0x6c, 0x65, 0x61, 0x6e, 0x01, 0x6e, 0x04,
    0x16, 0x01, 0x16, 0x07, 0x08, 0x09, 0x02, 0x02, 0x01, 0x02, 0x17, 0x07, 0x01, 0x02, 0x07,
    0x01, 0x03, 0x07, 0x01, 0x04, 0x07, 0x01, 0x05, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x07,
    0x01, 0x08, 0x07, 0x01, 0x09, 0x07, 0x01, 0x0a, 0x07, 0x01, 0x0b, 0x07, 0x01, 0x0c, 0x07,
    0x01, 0x0d, 0x07, 0x01, 0x0e, 0x07, 0x01, 0x0f, 0x07, 0x01, 0x10, 0x07, 0x01, 0x11, 0x07,
    0x01, 0x12, 0x07, 0x01, 0x13, 0x07, 0x01, 0x14, 0x09, 0x07, 0x01, 0x07, 0x02, 0x07, 0x07,
    0x03, 0x0c, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x05, 0x07, 0x00, 0x00, 0x00, 0x02, 0x0b, 0x21, 0x00,
    0x03, 0x0d, 0x00, 0x00, 0x07, 0x00, 0x01, 0x00, 0x01, 0x02, 0x01, 0x05, 0x04, 0x01, 0x00,
    0x01, 0x02, 0x01, 0x01, 0x00, 0x01, 0x01, 0x47, 0x00, 0x00,
};

pub const link_failing = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x03, 0x03, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, 0x15, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74,
    0x05, 0x43, 0x6c, 0x61, 0x73, 0x73, 0x08, 0x46, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e,
    0x04, 0x76, 0x6f, 0x69, 0x64, 0x05, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x01, 0x41, 0x01, 0x42,
    0x01, 0x49, 0x01, 0x46, 0x07, 0x4d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x01, 0x6d, 0x01,
    0x78, 0x09, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x74, 0x79, 0x70, 0x65, 0x03, 0x69, 0x6e, 0x74,
    0x04, 0x75, 0x69, 0x6e, 0x74, 0x06, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x06, 0x53, 0x74,
    0x72, 0x69, 0x6e, 0x67, 0x07, 0x42, 0x6f, 0x6f, 0x6c, 0x65, 0x61, 0x6e, 0x01, 0x6e, 0x04,
    0x16, 0x01, 0x16, 0x07, 0x08, 0x09, 0x02, 0x02, 0x01, 0x02, 0x17, 0x07, 0x01, 0x02, 0x07,
    0x01, 0x03, 0x07, 0x01, 0x04, 0x07, 0x01, 0x05, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x07,
    0x01, 0x08, 0x07, 0x01, 0x09, 0x07, 0x01, 0x0a, 0x07, 0x01, 0x0b, 0x07, 0x01, 0x0c, 0x07,
    0x01, 0x0d, 0x07, 0x01, 0x0e, 0x07, 0x01, 0x0f, 0x07, 0x01, 0x10, 0x07, 0x01, 0x11, 0x07,
    0x01, 0x12, 0x07, 0x01, 0x13, 0x07, 0x01, 0x14, 0x09, 0x07, 0x01, 0x07, 0x02, 0x07, 0x07,
    0x03, 0x0c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x0a, 0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x02, 0x01, 0x0a, 0x04,
    0x01, 0x00, 0x01, 0x02, 0x01, 0x01, 0x00, 0x01, 0x01, 0x47, 0x00, 0x00,
};

pub const link_wide = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x00, 0x00, 0x00, 0xa4, 0x01, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65,
    0x63, 0x74, 0x04, 0x57, 0x69, 0x64, 0x65, 0x02, 0x77, 0x30, 0x04, 0x70, 0x2e, 0x77, 0x30,
    0x02, 0x77, 0x31, 0x04, 0x70, 0x2e, 0x77, 0x31, 0x02, 0x77, 0x32, 0x04, 0x70, 0x2e, 0x77,
    0x32, 0x02, 0x77, 0x33, 0x04, 0x70, 0x2e, 0x77, 0x33, 0x02, 0x77, 0x34, 0x04, 0x70, 0x2e,
    0x77, 0x34, 0x02, 0x77, 0x35, 0x04, 0x70, 0x2e, 0x77, 0x35, 0x02, 0x77, 0x36, 0x04, 0x70,
    0x2e, 0x77, 0x36, 0x02, 0x77, 0x37, 0x04, 0x70, 0x2e, 0x77, 0x37, 0x02, 0x77, 0x38, 0x04,
    0x70, 0x2e, 0x77, 0x38, 0x02, 0x77, 0x39, 0x04, 0x70, 0x2e, 0x77, 0x39, 0x03, 0x77, 0x31,
    0x30, 0x05, 0x70, 0x2e, 0x77, 0x31, 0x30, 0x03, 0x77, 0x31, 0x31, 0x05, 0x70, 0x2e, 0x77,
    0x31, 0x31, 0x03, 0x77, 0x31, 0x32, 0x05, 0x70, 0x2e, 0x77, 0x31, 0x32, 0x03, 0x77, 0x31,
    0x33, 0x05, 0x70, 0x2e, 0x77, 0x31, 0x33, 0x03, 0x77, 0x31, 0x34, 0x05, 0x70, 0x2e, 0x77,
    0x31, 0x34, 0x03, 0x77, 0x31, 0x35, 0x05, 0x70, 0x2e, 0x77, 0x31, 0x35, 0x03, 0x77, 0x31,
    0x36, 0x05, 0x70, 0x2e, 0x77, 0x31, 0x36, 0x03, 0x77, 0x31, 0x37, 0x05, 0x70, 0x2e, 0x77,
    0x31, 0x37, 0x03, 0x77, 0x31, 0x38, 0x05, 0x70, 0x2e, 0x77, 0x31, 0x38, 0x03, 0x77, 0x31,
    0x39, 0x05, 0x70, 0x2e, 0x77, 0x31, 0x39, 0x03, 0x77, 0x32, 0x30, 0x05, 0x70, 0x2e, 0x77,
    0x32, 0x30, 0x03, 0x77, 0x32, 0x31, 0x05, 0x70, 0x2e, 0x77, 0x32, 0x31, 0x03, 0x77, 0x32,
    0x32, 0x05, 0x70, 0x2e, 0x77, 0x32, 0x32, 0x03, 0x77, 0x32, 0x33, 0x05, 0x70, 0x2e, 0x77,
    0x32, 0x33, 0x03, 0x77, 0x32, 0x34, 0x05, 0x70, 0x2e, 0x77, 0x32, 0x34, 0x03, 0x77, 0x32,
    0x35, 0x05, 0x70, 0x2e, 0x77, 0x32, 0x35, 0x03, 0x77, 0x32, 0x36, 0x05, 0x70, 0x2e, 0x77,
    0x32, 0x36, 0x03, 0x77, 0x32, 0x37, 0x05, 0x70, 0x2e, 0x77, 0x32, 0x37, 0x03, 0x77, 0x32,
    0x38, 0x05, 0x70, 0x2e, 0x77, 0x32, 0x38, 0x03, 0x77, 0x32, 0x39, 0x05, 0x70, 0x2e, 0x77,
    0x32, 0x39, 0x03, 0x77, 0x33, 0x30, 0x05, 0x70, 0x2e, 0x77, 0x33, 0x30, 0x03, 0x77, 0x33,
    0x31, 0x05, 0x70, 0x2e, 0x77, 0x33, 0x31, 0x03, 0x77, 0x33, 0x32, 0x05, 0x70, 0x2e, 0x77,
    0x33, 0x32, 0x03, 0x77, 0x33, 0x33, 0x05, 0x70, 0x2e, 0x77, 0x33, 0x33, 0x03, 0x77, 0x33,
    0x34, 0x05, 0x70, 0x2e, 0x77, 0x33, 0x34, 0x03, 0x77, 0x33, 0x35, 0x05, 0x70, 0x2e, 0x77,
    0x33, 0x35, 0x03, 0x77, 0x33, 0x36, 0x05, 0x70, 0x2e, 0x77, 0x33, 0x36, 0x03, 0x77, 0x33,
    0x37, 0x05, 0x70, 0x2e, 0x77, 0x33, 0x37, 0x03, 0x77, 0x33, 0x38, 0x05, 0x70, 0x2e, 0x77,
    0x33, 0x38, 0x03, 0x77, 0x33, 0x39, 0x05, 0x70, 0x2e, 0x77, 0x33, 0x39, 0x03, 0x77, 0x34,
    0x30, 0x05, 0x70, 0x2e, 0x77, 0x34, 0x30, 0x03, 0x77, 0x34, 0x31, 0x05, 0x70, 0x2e, 0x77,
    0x34, 0x31, 0x03, 0x77, 0x34, 0x32, 0x05, 0x70, 0x2e, 0x77, 0x34, 0x32, 0x03, 0x77, 0x34,
    0x33, 0x05, 0x70, 0x2e, 0x77, 0x34, 0x33, 0x03, 0x77, 0x34, 0x34, 0x05, 0x70, 0x2e, 0x77,
    0x34, 0x34, 0x03, 0x77, 0x34, 0x35, 0x05, 0x70, 0x2e, 0x77, 0x34, 0x35, 0x03, 0x77, 0x34,
    0x36, 0x05, 0x70, 0x2e, 0x77, 0x34, 0x36, 0x03, 0x77, 0x34, 0x37, 0x05, 0x70, 0x2e, 0x77,
    0x34, 0x37, 0x03, 0x77, 0x34, 0x38, 0x05, 0x70, 0x2e, 0x77, 0x34, 0x38, 0x03, 0x77, 0x34,
    0x39, 0x05, 0x70, 0x2e, 0x77, 0x34, 0x39, 0x03, 0x77, 0x35, 0x30, 0x05, 0x70, 0x2e, 0x77,
    0x35, 0x30, 0x03, 0x77, 0x35, 0x31, 0x05, 0x70, 0x2e, 0x77, 0x35, 0x31, 0x03, 0x77, 0x35,
    0x32, 0x05, 0x70, 0x2e, 0x77, 0x35, 0x32, 0x03, 0x77, 0x35, 0x33, 0x05, 0x70, 0x2e, 0x77,
    0x35, 0x33, 0x03, 0x77, 0x35, 0x34, 0x05, 0x70, 0x2e, 0x77, 0x35, 0x34, 0x03, 0x77, 0x35,
    0x35, 0x05, 0x70, 0x2e, 0x77, 0x35, 0x35, 0x03, 0x77, 0x35, 0x36, 0x05, 0x70, 0x2e, 0x77,
    0x35, 0x36, 0x03, 0x77, 0x35, 0x37, 0x05, 0x70, 0x2e, 0x77, 0x35, 0x37, 0x03, 0x77, 0x35,
    0x38, 0x05, 0x70, 0x2e, 0x77, 0x35, 0x38, 0x03, 0x77, 0x35, 0x39, 0x05, 0x70, 0x2e, 0x77,
    0x35, 0x39, 0x03, 0x77, 0x36, 0x30, 0x05, 0x70, 0x2e, 0x77, 0x36, 0x30, 0x03, 0x77, 0x36,
    0x31, 0x05, 0x70, 0x2e, 0x77, 0x36, 0x31, 0x03, 0x77, 0x36, 0x32, 0x05, 0x70, 0x2e, 0x77,
    0x36, 0x32, 0x03, 0x77, 0x36, 0x33, 0x05, 0x70, 0x2e, 0x77, 0x36, 0x33, 0x03, 0x77, 0x36,
    0x34, 0x05, 0x70, 0x2e, 0x77, 0x36, 0x34, 0x03, 0x77, 0x36, 0x35, 0x05, 0x70, 0x2e, 0x77,
    0x36, 0x35, 0x03, 0x77, 0x36, 0x36, 0x05, 0x70, 0x2e, 0x77, 0x36, 0x36, 0x03, 0x77, 0x36,
    0x37, 0x05, 0x70, 0x2e, 0x77, 0x36, 0x37, 0x03, 0x77, 0x36, 0x38, 0x05, 0x70, 0x2e, 0x77,
    0x36, 0x38, 0x03, 0x77, 0x36, 0x39, 0x05, 0x70, 0x2e, 0x77, 0x36, 0x39, 0x03, 0x77, 0x37,
    0x30, 0x05, 0x70, 0x2e, 0x77, 0x37, 0x30, 0x03, 0x77, 0x37, 0x31, 0x05, 0x70, 0x2e, 0x77,
    0x37, 0x31, 0x03, 0x77, 0x37, 0x32, 0x05, 0x70, 0x2e, 0x77, 0x37, 0x32, 0x03, 0x77, 0x37,
    0x33, 0x05, 0x70, 0x2e, 0x77, 0x37, 0x33, 0x03, 0x77, 0x37, 0x34, 0x05, 0x70, 0x2e, 0x77,
    0x37, 0x34, 0x03, 0x77, 0x37, 0x35, 0x05, 0x70, 0x2e, 0x77, 0x37, 0x35, 0x03, 0x77, 0x37,
    0x36, 0x05, 0x70, 0x2e, 0x77, 0x37, 0x36, 0x03, 0x77, 0x37, 0x37, 0x05, 0x70, 0x2e, 0x77,
    0x37, 0x37, 0x03, 0x77, 0x37, 0x38, 0x05, 0x70, 0x2e, 0x77, 0x37, 0x38, 0x03, 0x77, 0x37,
    0x39, 0x05, 0x70, 0x2e, 0x77, 0x37, 0x39, 0x52, 0x16, 0x01, 0x16, 0x05, 0x16, 0x07, 0x16,
    0x09, 0x16, 0x0b, 0x16, 0x0d, 0x16, 0x0f, 0x16, 0x11, 0x16, 0x13, 0x16, 0x15, 0x16, 0x17,
    0x16, 0x19, 0x16, 0x1b, 0x16, 0x1d, 0x16, 0x1f, 0x16, 0x21, 0x16, 0x23, 0x16, 0x25, 0x16,
    0x27, 0x16, 0x29, 0x16, 0x2b, 0x16, 0x2d, 0x16, 0x2f, 0x16, 0x31, 0x16, 0x33, 0x16, 0x35,
    0x16, 0x37, 0x16, 0x39, 0x16, 0x3b, 0x16, 0x3d, 0x16, 0x3f, 0x16, 0x41, 0x16, 0x43, 0x16,
    0x45, 0x16, 0x47, 0x16, 0x49, 0x16, 0x4b, 0x16, 0x4d, 0x16, 0x4f, 0x16, 0x51, 0x16, 0x53,
    0x16, 0x55, 0x16, 0x57, 0x16, 0x59, 0x16, 0x5b, 0x16, 0x5d, 0x16, 0x5f, 0x16, 0x61, 0x16,
    0x63, 0x16, 0x65, 0x16, 0x67, 0x16, 0x69, 0x16, 0x6b, 0x16, 0x6d, 0x16, 0x6f, 0x16, 0x71,
    0x16, 0x73, 0x16, 0x75, 0x16, 0x77, 0x16, 0x79, 0x16, 0x7b, 0x16, 0x7d, 0x16, 0x7f, 0x16,
    0x81, 0x01, 0x16, 0x83, 0x01, 0x16, 0x85, 0x01, 0x16, 0x87, 0x01, 0x16, 0x89, 0x01, 0x16,
    0x8b, 0x01, 0x16, 0x8d, 0x01, 0x16, 0x8f, 0x01, 0x16, 0x91, 0x01, 0x16, 0x93, 0x01, 0x16,
    0x95, 0x01, 0x16, 0x97, 0x01, 0x16, 0x99, 0x01, 0x16, 0x9b, 0x01, 0x16, 0x9d, 0x01, 0x16,
    0x9f, 0x01, 0x16, 0xa1, 0x01, 0x16, 0xa3, 0x01, 0x00, 0x53, 0x07, 0x01, 0x02, 0x07, 0x01,
    0x03, 0x07, 0x02, 0x04, 0x07, 0x03, 0x06, 0x07, 0x04, 0x08, 0x07, 0x05, 0x0a, 0x07, 0x06,
    0x0c, 0x07, 0x07, 0x0e, 0x07, 0x08, 0x10, 0x07, 0x09, 0x12, 0x07, 0x0a, 0x14, 0x07, 0x0b,
    0x16, 0x07, 0x0c, 0x18, 0x07, 0x0d, 0x1a, 0x07, 0x0e, 0x1c, 0x07, 0x0f, 0x1e, 0x07, 0x10,
    0x20, 0x07, 0x11, 0x22, 0x07, 0x12, 0x24, 0x07, 0x13, 0x26, 0x07, 0x14, 0x28, 0x07, 0x15,
    0x2a, 0x07, 0x16, 0x2c, 0x07, 0x17, 0x2e, 0x07, 0x18, 0x30, 0x07, 0x19, 0x32, 0x07, 0x1a,
    0x34, 0x07, 0x1b, 0x36, 0x07, 0x1c, 0x38, 0x07, 0x1d, 0x3a, 0x07, 0x1e, 0x3c, 0x07, 0x1f,
    0x3e, 0x07, 0x20, 0x40, 0x07, 0x21, 0x42, 0x07, 0x22, 0x44, 0x07, 0x23, 0x46, 0x07, 0x24,
    0x48, 0x07, 0x25, 0x4a, 0x07, 0x26, 0x4c, 0x07, 0x27, 0x4e, 0x07, 0x28, 0x50, 0x07, 0x29,
    0x52, 0x07, 0x2a, 0x54, 0x07, 0x2b, 0x56, 0x07, 0x2c, 0x58, 0x07, 0x2d, 0x5a, 0x07, 0x2e,
    0x5c, 0x07, 0x2f, 0x5e, 0x07, 0x30, 0x60, 0x07, 0x31, 0x62, 0x07, 0x32, 0x64, 0x07, 0x33,
    0x66, 0x07, 0x34, 0x68, 0x07, 0x35, 0x6a, 0x07, 0x36, 0x6c, 0x07, 0x37, 0x6e, 0x07, 0x38,
    0x70, 0x07, 0x39, 0x72, 0x07, 0x3a, 0x74, 0x07, 0x3b, 0x76, 0x07, 0x3c, 0x78, 0x07, 0x3d,
    0x7a, 0x07, 0x3e, 0x7c, 0x07, 0x3f, 0x7e, 0x07, 0x40, 0x80, 0x01, 0x07, 0x41, 0x82, 0x01,
    0x07, 0x42, 0x84, 0x01, 0x07, 0x43, 0x86, 0x01, 0x07, 0x44, 0x88, 0x01, 0x07, 0x45, 0x8a,
    0x01, 0x07, 0x46, 0x8c, 0x01, 0x07, 0x47, 0x8e, 0x01, 0x07, 0x48, 0x90, 0x01, 0x07, 0x49,
    0x92, 0x01, 0x07, 0x4a, 0x94, 0x01, 0x07, 0x4b, 0x96, 0x01, 0x07, 0x4c, 0x98, 0x01, 0x07,
    0x4d, 0x9a, 0x01, 0x07, 0x4e, 0x9c, 0x01, 0x07, 0x4f, 0x9e, 0x01, 0x07, 0x50, 0xa0, 0x01,
    0x07, 0x51, 0xa2, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x02, 0x01, 0x00, 0x00, 0x00, 0x50, 0x03, 0x00, 0x01, 0x00, 0x00,
    0x04, 0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x03, 0x00, 0x00, 0x06, 0x00, 0x04, 0x00, 0x00,
    0x07, 0x00, 0x05, 0x00, 0x00, 0x08, 0x00, 0x06, 0x00, 0x00, 0x09, 0x00, 0x07, 0x00, 0x00,
    0x0a, 0x00, 0x08, 0x00, 0x00, 0x0b, 0x00, 0x09, 0x00, 0x00, 0x0c, 0x00, 0x0a, 0x00, 0x00,
    0x0d, 0x00, 0x0b, 0x00, 0x00, 0x0e, 0x00, 0x0c, 0x00, 0x00, 0x0f, 0x00, 0x0d, 0x00, 0x00,
    0x10, 0x00, 0x0e, 0x00, 0x00, 0x11, 0x00, 0x0f, 0x00, 0x00, 0x12, 0x00, 0x10, 0x00, 0x00,
    0x13, 0x00, 0x11, 0x00, 0x00, 0x14, 0x00, 0x12, 0x00, 0x00, 0x15, 0x00, 0x13, 0x00, 0x00,
    0x16, 0x00, 0x14, 0x00, 0x00, 0x17, 0x00, 0x15, 0x00, 0x00, 0x18, 0x00, 0x16, 0x00, 0x00,
    0x19, 0x00, 0x17, 0x00, 0x00, 0x1a, 0x00, 0x18, 0x00, 0x00, 0x1b, 0x00, 0x19, 0x00, 0x00,
    0x1c, 0x00, 0x1a, 0x00, 0x00, 0x1d, 0x00, 0x1b, 0x00, 0x00, 0x1e, 0x00, 0x1c, 0x00, 0x00,
    0x1f, 0x00, 0x1d, 0x00, 0x00, 0x20, 0x00, 0x1e, 0x00, 0x00, 0x21, 0x00, 0x1f, 0x00, 0x00,
    0x22, 0x00, 0x20, 0x00, 0x00, 0x23, 0x00, 0x21, 0x00, 0x00, 0x24, 0x00, 0x22, 0x00, 0x00,
    0x25, 0x00, 0x23, 0x00, 0x00, 0x26, 0x00, 0x24, 0x00, 0x00, 0x27, 0x00, 0x25, 0x00, 0x00,
    0x28, 0x00, 0x26, 0x00, 0x00, 0x29, 0x00, 0x27, 0x00, 0x00, 0x2a, 0x00, 0x28, 0x00, 0x00,
    0x2b, 0x00, 0x29, 0x00, 0x00, 0x2c, 0x00, 0x2a, 0x00, 0x00, 0x2d, 0x00, 0x2b, 0x00, 0x00,
    0x2e, 0x00, 0x2c, 0x00, 0x00, 0x2f, 0x00, 0x2d, 0x00, 0x00, 0x30, 0x00, 0x2e, 0x00, 0x00,
    0x31, 0x00, 0x2f, 0x00, 0x00, 0x32, 0x00, 0x30, 0x00, 0x00, 0x33, 0x00, 0x31, 0x00, 0x00,
    0x34, 0x00, 0x32, 0x00, 0x00, 0x35, 0x00, 0x33, 0x00, 0x00, 0x36, 0x00, 0x34, 0x00, 0x00,
    0x37, 0x00, 0x35, 0x00, 0x00, 0x38, 0x00, 0x36, 0x00, 0x00, 0x39, 0x00, 0x37, 0x00, 0x00,
    0x3a, 0x00, 0x38, 0x00, 0x00, 0x3b, 0x00, 0x39, 0x00, 0x00, 0x3c, 0x00, 0x3a, 0x00, 0x00,
    0x3d, 0x00, 0x3b, 0x00, 0x00, 0x3e, 0x00, 0x3c, 0x00, 0x00, 0x3f, 0x00, 0x3d, 0x00, 0x00,
    0x40, 0x00, 0x3e, 0x00, 0x00, 0x41, 0x00, 0x3f, 0x00, 0x00, 0x42, 0x00, 0x40, 0x00, 0x00,
    0x43, 0x00, 0x41, 0x00, 0x00, 0x44, 0x00, 0x42, 0x00, 0x00, 0x45, 0x00, 0x43, 0x00, 0x00,
    0x46, 0x00, 0x44, 0x00, 0x00, 0x47, 0x00, 0x45, 0x00, 0x00, 0x48, 0x00, 0x46, 0x00, 0x00,
    0x49, 0x00, 0x47, 0x00, 0x00, 0x4a, 0x00, 0x48, 0x00, 0x00, 0x4b, 0x00, 0x49, 0x00, 0x00,
    0x4c, 0x00, 0x4a, 0x00, 0x00, 0x4d, 0x00, 0x4b, 0x00, 0x00, 0x4e, 0x00, 0x4c, 0x00, 0x00,
    0x4f, 0x00, 0x4d, 0x00, 0x00, 0x50, 0x00, 0x4e, 0x00, 0x00, 0x51, 0x00, 0x4f, 0x00, 0x00,
    0x52, 0x00, 0x50, 0x00, 0x00, 0x01, 0x00, 0x01, 0x02, 0x51, 0x02, 0x04, 0x01, 0x00, 0x03,
    0x00, 0x02, 0x00, 0x00, 0x04, 0x00, 0x03, 0x00, 0x00, 0x05, 0x00, 0x04, 0x00, 0x00, 0x06,
    0x00, 0x05, 0x00, 0x00, 0x07, 0x00, 0x06, 0x00, 0x00, 0x08, 0x00, 0x07, 0x00, 0x00, 0x09,
    0x00, 0x08, 0x00, 0x00, 0x0a, 0x00, 0x09, 0x00, 0x00, 0x0b, 0x00, 0x0a, 0x00, 0x00, 0x0c,
    0x00, 0x0b, 0x00, 0x00, 0x0d, 0x00, 0x0c, 0x00, 0x00, 0x0e, 0x00, 0x0d, 0x00, 0x00, 0x0f,
    0x00, 0x0e, 0x00, 0x00, 0x10, 0x00, 0x0f, 0x00, 0x00, 0x11, 0x00, 0x10, 0x00, 0x00, 0x12,
    0x00, 0x11, 0x00, 0x00, 0x13, 0x00, 0x12, 0x00, 0x00, 0x14, 0x00, 0x13, 0x00, 0x00, 0x15,
    0x00, 0x14, 0x00, 0x00, 0x16, 0x00, 0x15, 0x00, 0x00, 0x17, 0x00, 0x16, 0x00, 0x00, 0x18,
    0x00, 0x17, 0x00, 0x00, 0x19, 0x00, 0x18, 0x00, 0x00, 0x1a, 0x00, 0x19, 0x00, 0x00, 0x1b,
    0x00, 0x1a, 0x00, 0x00, 0x1c, 0x00, 0x1b, 0x00, 0x00, 0x1d, 0x00, 0x1c, 0x00, 0x00, 0x1e,
    0x00, 0x1d, 0x00, 0x00, 0x1f, 0x00, 0x1e, 0x00, 0x00, 0x20, 0x00, 0x1f, 0x00, 0x00, 0x21,
    0x00, 0x20, 0x00, 0x00, 0x22, 0x00, 0x21, 0x00, 0x00, 0x23, 0x00, 0x22, 0x00, 0x00, 0x24,
    0x00, 0x23, 0x00, 0x00, 0x25, 0x00, 0x24, 0x00, 0x00, 0x26, 0x00, 0x25, 0x00, 0x00, 0x27,
    0x00, 0x26, 0x00, 0x00, 0x28, 0x00, 0x27, 0x00, 0x00, 0x29, 0x00, 0x28, 0x00, 0x00, 0x2a,
    0x00, 0x29, 0x00, 0x00, 0x2b, 0x00, 0x2a, 0x00, 0x00, 0x2c, 0x00, 0x2b, 0x00, 0x00, 0x2d,
    0x00, 0x2c, 0x00, 0x00, 0x2e, 0x00, 0x2d, 0x00, 0x00, 0x2f, 0x00, 0x2e, 0x00, 0x00, 0x30,
    0x00, 0x2f, 0x00, 0x00, 0x31, 0x00, 0x30, 0x00, 0x00, 0x32, 0x00, 0x31, 0x00, 0x00, 0x33,
    0x00, 0x32, 0x00, 0x00, 0x34, 0x00, 0x33, 0x00, 0x00, 0x35, 0x00, 0x34, 0x00, 0x00, 0x36,
    0x00, 0x35, 0x00, 0x00, 0x37, 0x00, 0x36, 0x00, 0x00, 0x38, 0x00, 0x37, 0x00, 0x00, 0x39,
    0x00, 0x38, 0x00, 0x00, 0x3a, 0x00, 0x39, 0x00, 0x00, 0x3b, 0x00, 0x3a, 0x00, 0x00, 0x3c,
    0x00, 0x3b, 0x00, 0x00, 0x3d, 0x00, 0x3c, 0x00, 0x00, 0x3e, 0x00, 0x3d, 0x00, 0x00, 0x3f,
    0x00, 0x3e, 0x00, 0x00, 0x40, 0x00, 0x3f, 0x00, 0x00, 0x41, 0x00, 0x40, 0x00, 0x00, 0x42,
    0x00, 0x41, 0x00, 0x00, 0x43, 0x00, 0x42, 0x00, 0x00, 0x44, 0x00, 0x43, 0x00, 0x00, 0x45,
    0x00, 0x44, 0x00, 0x00, 0x46, 0x00, 0x45, 0x00, 0x00, 0x47, 0x00, 0x46, 0x00, 0x00, 0x48,
    0x00, 0x47, 0x00, 0x00, 0x49, 0x00, 0x48, 0x00, 0x00, 0x4a, 0x00, 0x49, 0x00, 0x00, 0x4b,
    0x00, 0x4a, 0x00, 0x00, 0x4c, 0x00, 0x4b, 0x00, 0x00, 0x4d, 0x00, 0x4c, 0x00, 0x00, 0x4e,
    0x00, 0x4d, 0x00, 0x00, 0x4f, 0x00, 0x4e, 0x00, 0x00, 0x50, 0x00, 0x4f, 0x00, 0x00, 0x51,
    0x00, 0x50, 0x00, 0x00, 0x52, 0x00, 0x51, 0x00, 0x00, 0x01, 0x02, 0x01, 0x01, 0x00, 0x01,
    0x01, 0x47, 0x00, 0x00,
};

pub const link_created = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x03, 0x03, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, 0x15, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74,
    0x05, 0x43, 0x6c, 0x61, 0x73, 0x73, 0x08, 0x46, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e,
    0x04, 0x76, 0x6f, 0x69, 0x64, 0x05, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x01, 0x41, 0x01, 0x42,
    0x01, 0x49, 0x01, 0x46, 0x07, 0x4d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x01, 0x6d, 0x01,
    0x78, 0x09, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x74, 0x79, 0x70, 0x65, 0x03, 0x69, 0x6e, 0x74,
    0x04, 0x75, 0x69, 0x6e, 0x74, 0x06, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x06, 0x53, 0x74,
    0x72, 0x69, 0x6e, 0x67, 0x07, 0x42, 0x6f, 0x6f, 0x6c, 0x65, 0x61, 0x6e, 0x01, 0x6e, 0x04,
    0x16, 0x01, 0x16, 0x07, 0x08, 0x09, 0x02, 0x02, 0x01, 0x02, 0x17, 0x07, 0x01, 0x02, 0x07,
    0x01, 0x03, 0x07, 0x01, 0x04, 0x07, 0x01, 0x05, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x07,
    0x01, 0x08, 0x07, 0x01, 0x09, 0x07, 0x01, 0x0a, 0x07, 0x01, 0x0b, 0x07, 0x01, 0x0c, 0x07,
    0x01, 0x0d, 0x07, 0x01, 0x0e, 0x07, 0x01, 0x0f, 0x07, 0x01, 0x10, 0x07, 0x01, 0x11, 0x07,
    0x01, 0x12, 0x07, 0x01, 0x13, 0x07, 0x01, 0x14, 0x09, 0x07, 0x01, 0x07, 0x02, 0x07, 0x07,
    0x03, 0x0c, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x05, 0x07, 0x00, 0x00, 0x00, 0x02, 0x0b, 0x21, 0x00,
    0x03, 0x0d, 0x00, 0x00, 0x07, 0x00, 0x01, 0x00, 0x01, 0x02, 0x01, 0x05, 0x04, 0x01, 0x00,
    0x02, 0x02, 0x04, 0x01, 0x00, 0x03, 0x12, 0xd0, 0x30, 0xd0, 0x60, 0x01, 0x30, 0x60, 0x07,
    0x30, 0x60, 0x07, 0x58, 0x00, 0x1d, 0x1d, 0x68, 0x05, 0x47, 0x00, 0x00, 0x01, 0x01, 0x01,
    0x00, 0x01, 0x01, 0x47, 0x00, 0x00,
};

// tests/parity/verify-errors.ts's third: a function created in two scope
// chains, contested and settled, a handler with a catch scope, a switch of
// 20 cases.
pub const link_contested = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65, 0x63,
    0x74, 0x01, 0x43, 0x01, 0x78, 0x01, 0x41, 0x01, 0x6d, 0x01, 0x66, 0x03, 0x16, 0x01, 0x16,
    0x05, 0x02, 0x02, 0x01, 0x02, 0x08, 0x07, 0x01, 0x02, 0x07, 0x01, 0x03, 0x07, 0x01, 0x04,
    0x07, 0x02, 0x04, 0x09, 0x04, 0x01, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x05, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x01, 0x00, 0x00, 0x01, 0x03, 0x03, 0x00, 0x00, 0x00,
    0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x06, 0x01, 0x00, 0x03, 0x02, 0x00, 0x01, 0x00, 0x01,
    0x02, 0x04, 0x01, 0x00, 0x05, 0x00, 0x03, 0x01, 0x00, 0x03, 0x11, 0xd0, 0x30, 0xd0, 0x60,
    0x01, 0x30, 0x60, 0x01, 0x58, 0x00, 0x1d, 0x68, 0x02, 0x40, 0x04, 0x29, 0x47, 0x00, 0x00,
    0x01, 0x01, 0x01, 0x00, 0x01, 0x03, 0xd0, 0x30, 0x47, 0x00, 0x00, 0x02, 0x01, 0x01, 0x00,
    0x01, 0x01, 0x47, 0x00, 0x00, 0x03, 0x02, 0x01, 0x00, 0x02, 0x51, 0xd0, 0x30, 0x40, 0x04,
    0x29, 0x5d, 0x03, 0x29, 0x24, 0x01, 0x1b, 0x41, 0x00, 0x00, 0x13, 0x41, 0x00, 0x00, 0x41,
    0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41,
    0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41,
    0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41,
    0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x41, 0x00, 0x00, 0x47, 0x5a, 0x00, 0x29,
    0x29, 0x47, 0x01, 0x05, 0x4b, 0x4c, 0x00, 0x03, 0x00, 0x04, 0x02, 0x01, 0x00, 0x01, 0x01,
    0x47, 0x00, 0x00,
};

/// A digest of everything a domain holds but getBinding's memo, which a
/// rollback empties: each table's rows, each id table's slots, the numbers
/// beside them, and by their content what rows point at (each ABC's
/// tables, each string, each scope), never an address. Equal before a call
/// and after it ran out of memory, and for two domains given the same calls.
fn fingerprint(dom: *const Domain) u64 {
    var h: std.hash.Wyhash = .init(0);
    hashFields(&h, dom);
    return h.final();
}

const field_count = @typeInfo(Domain).@"struct".field_names.len + @typeInfo(@import("../avm2/link/traits.zig").TraitsTable).@"struct".field_names.len;

/// Each field's digest, to name the ones a rollback missed.
fn fieldPrints(dom: *const Domain) [field_count]u64 {
    var prints: [field_count]u64 = @splat(0);
    var k: usize = 0;
    inline for (@typeInfo(Domain).@"struct".field_names) |name| {
        var h: std.hash.Wyhash = .init(0);
        hashField(&h, dom, name);
        prints[k] = h.final();
        k += 1;
    }

    inline for (@typeInfo(@TypeOf(dom.traits)).@"struct".field_names) |name| {
        var h: std.hash.Wyhash = .init(0);
        hashValue(&h, @field(dom.traits, name));
        prints[k] = h.final();
        k += 1;
    }

    return prints;
}

fn printDiffering(a: [field_count]u64, b: [field_count]u64) void {
    var k: usize = 0;
    inline for (@typeInfo(Domain).@"struct".field_names ++ @typeInfo(@import("../avm2/link/traits.zig").TraitsTable).@"struct".field_names) |name| {
        if (a[k] != b[k]) {
            std.debug.print("differs: {s}\n", .{name});
        }

        k += 1;
    }
}

fn hashFields(h: *std.hash.Wyhash, dom: *const Domain) void {
    inline for (@typeInfo(Domain).@"struct".field_names) |name| {
        hashField(h, dom, name);
    }
}

fn hashField(h: *std.hash.Wyhash, dom: *const Domain, comptime name: []const u8) void {
    const skipped = comptime std.mem.eql(u8, name, "gpa") or
        std.mem.eql(u8, name, "scratch") or
        std.mem.eql(u8, name, "undo") or
        std.mem.eql(u8, name, "decoder") or
        std.mem.eql(u8, name, "bindingMemo") or
        // Addresses into the ABCs' bytes, which abcBuffer has by content.
        std.mem.eql(u8, name, "abcBase") or
        std.mem.eql(u8, name, "truncated") or
        std.mem.startsWith(u8, name, "memo");
    if (comptime std.mem.eql(u8, name, "stringPtr")) {
        h.update(std.mem.asBytes(&dom.stringPtr.len));
        for (0..dom.stringPtr.len) |i| {
            const bytes = dom.stringOf(@intCast(i));
            h.update(std.mem.asBytes(&bytes.len));
            h.update(bytes);
        }
    } else if (!skipped) {
        hashValue(h, @field(dom.*, name));
    }
}

fn hashValue(h: *std.hash.Wyhash, value: anytype) void {
    const T = @TypeOf(value);
    switch (@typeInfo(T)) {
        .int, .bool, .float => h.update(std.mem.asBytes(&value)),
        .optional => if (value) |inner| {
            h.update(&.{1});
            hashValue(h, inner);
        } else {
            h.update(&.{0});
        },
        .pointer => |ptr| switch (ptr.size) {
            .slice => {
                h.update(std.mem.asBytes(&value.len));
                switch (@typeInfo(ptr.child)) {
                    .int, .bool, .float => h.update(std.mem.sliceAsBytes(value)),
                    else => for (value) |item| hashValue(h, item),
                }
            },
            .one => hashValue(h, value.*),
            else => @compileError("an address the digest cannot follow: " ++ @typeName(T)),
        },
        .@"struct" => |info| if (@hasField(T, "directory")) {
            h.update(std.mem.asBytes(&value.len));
            var i: u32 = 0;
            while (i < value.len) : (i += 1) {
                hashValue(h, value.get(i));
            }
        } else {
            inline for (info.field_names) |name| {
                // An ArrayList's room, which differs as it grew.
                if (comptime !std.mem.eql(u8, name, "capacity")) {
                    hashValue(h, @field(value, name));
                }
            }
        },
        else => {},
    }
}

test "the link ABCs are tests/parity/link-abc.ts's, and link as AssemblyScript links them" {
    memory.arenas();
    defer compile.release();
    try compile.domainReset(50);
    try testing.expectEqual(0, try compile.domainAdd(&link_builtin, true, 0));
    const child = try compile.domainChild(0);
    try testing.expectEqual(0, try compile.domainAdd(&link_user, false, child));
    try testing.expectEqual(1103, try compile.domainAdd(&link_failing, false, 0));
    try testing.expectEqual(0, try compile.changed(domainResolve, .{0}));
    try testing.expectEqual(18, try domainTraitsCount());
    try testing.expectEqualStrings("abc 0 class 4, abc 0 class 0", try compile.changed(domainSlotTypes, .{ memory.call.allocator(), 0, 4 }));
    try testing.expectEqualStrings("abc 0 class 4, abc 0 class 0, abc 0 class 5", try compile.changed(domainSlotTypes, .{ memory.call.allocator(), 1, 0 }));
    memory.call.reset();
}

test "a name that is not valid UTF-8 is looked up as AssemblyScript decodes and encodes it again" {
    var arena: memory.Arena = .init(testing.allocator);
    defer arena.deinit();
    var dom: Domain = try .init(arena.allocator(), arena.allocator());
    const lone = try dom.internString("\xc3");
    const tail = try dom.internString("a\xc3");
    const surrogate = try dom.internString("\xed\xa0\x80b");
    const plain = try dom.internString("c");
    // A pair of surrogates each encoded alone decodes to the pair, which encodes as one code point.
    const pair = try dom.internString("\xed\xa0\x80\xed\xb0\x80");
    try testing.expectEqual(-1, try dom.underscoredName(lone));
    // A sequence cut short at the end decodes to nothing; a lone surrogate stays one, in WTF-8.
    const underscore = try dom.internString("_");
    const a = try dom.internString("_a");
    const kept = try dom.internString("_\xed\xa0\x80b");
    const c = try dom.internString("_c");
    const joined = try dom.internString("_\xf0\x90\x80\x80");
    try testing.expectEqual(@as(i32, @intCast(joined)), try dom.underscoredName(pair));
    try testing.expectEqual(@as(i32, @intCast(underscore)), try dom.underscoredName(lone));
    try testing.expectEqual(@as(i32, @intCast(a)), try dom.underscoredName(tail));
    try testing.expectEqual(@as(i32, @intCast(kept)), try dom.underscoredName(surrogate));
    try testing.expectEqual(@as(i32, @intCast(c)), try dom.underscoredName(plain));
}

/// A domain's life through compile.zig's entries, over the module's pages
/// replaced by `p`'s: each call that runs out of memory leaves the domain
/// as it was, which its fingerprint shows.
fn domainLife(_: Allocator, p: *memory.Pages) !void {
    memory.arenas();
    compile.release();
    memory.call.reset();
    const saved = memory.swapPages(p.*);
    defer {
        compile.release();
        memory.call.reset();
        p.* = memory.swapPages(saved);
    }

    try compile.domainReset(50);
    const steps = struct {
        fn run(step: u32) !void {
            memory.call.reset();
            switch (step) {
                0 => try testing.expectEqual(0, try compile.domainAdd(&link_builtin, true, 0)),
                1 => try testing.expectEqual(1, try compile.domainChild(0)),
                2 => try testing.expectEqual(0, try compile.domainAdd(&link_user, false, 1)),
                3 => try testing.expectEqual(1103, try compile.domainAdd(&link_failing, false, 0)),
                4 => try compile.domainFound(1, 0, "", "A", 0, true),
                5 => try testing.expectEqual(0, try compile.changed(domainResolve, .{0})),
                6 => try testing.expectEqualStrings("abc 0 class 4, abc 0 class 0, abc 0 class 5", try compile.changed(domainSlotTypes, .{ memory.call.allocator(), 1, 0 })),
                7 => try compile.domainEvict(1),
                8 => try testing.expectEqual(0, try compile.domainRevive(1, false)),
                9 => try testing.expectEqual(0, try compile.domainAdd(&link_user, false, 0)),
                10 => try testing.expect((try compile.domainModule(memory.call.allocator(), "own\nfirst", -1, true, false)).len > 0),
                11 => {
                    // Neither changes the domain: one that runs out leaves it as it was.
                    _ = try compile.domainSourceMap(memory.call.allocator());
                    _ = try compile.domainModuleEntries(memory.call.allocator());
                },
                12 => {
                    // A part a method, so that the module comes in many.
                    compile.domainPartBudget(1);
                    _ = try compile.domainModuleBytes(memory.call.allocator(), "", -1, true, false);
                },
                13 => {
                    // Each part a call of its own, its domain changes kept as
                    // the next starts: each checked alone.
                    while (!compile.domainModuleDone()) {
                        memory.call.reset();
                        compile.callStarts();
                        const dom = try compile.domain();
                        const before = fingerprint(dom);
                        _ = compile.domainModuleMoreBytes(memory.call.allocator()) catch {
                            try testing.expectEqual(before, fingerprint(dom));
                            return error.PartRanOut;
                        };
                    }

                    compile.domainPartBudget(0);
                },
                14 => _ = try compile.domainSourceMap(memory.call.allocator()),
                15 => _ = try compile.domainEmitEach(memory.call.allocator(), "0,1,2,3,9999", false, -1),
                16 => _ = try compile.domainEmitEach(memory.call.allocator(), "3,2,1,0", true, -1),
                else => try compile.domainDrop(1),
            }
        }
    };
    defer compile.domainPartBudget(0);
    for (0..18) |step| {
        const dom = try compile.domain();
        const before = fingerprint(dom);
        const prints = fieldPrints(dom);
        steps.run(@intCast(step)) catch |err| {
            if (err == error.PartRanOut) {
                return error.OutOfMemory;
            }

            if (before != fingerprint(dom)) {
                std.debug.print("step {d}\n", .{step});
                printDiffering(prints, fieldPrints(dom));
            }

            try testing.expectEqual(before, fingerprint(dom));
            return err;
        };
    }

    try testing.expectEqual(21, try domainTraitsCount());

    // Enough more that the smaller memories run out among them.
    for (0..100) |k| {
        const dom = try compile.domain();
        const before = fingerprint(dom);
        const prints = fieldPrints(dom);
        memory.call.reset();
        const added = more: {
            const child = compile.domainChild(0) catch |err| break :more err;
            try testing.expectEqual(@as(i32, @intCast(k + 2)), child);
            break :more compile.domainAdd(&link_user, false, child);
        };
        _ = added catch |err| {
            // The child, made by a call of its own, stays.
            if (dom.domainParent.len == k + 3) {
                dom.domainParent.truncate(@intCast(k + 2));
                dom.domainDepth.truncate(@intCast(k + 2));
                dom.domainState.truncate(@intCast(k + 2));
                dom.domainEvicted.truncate(@intCast(k + 2));
            }

            if (before != fingerprint(dom)) printDiffering(prints, fieldPrints(dom));
            try testing.expectEqual(before, fingerprint(dom));
            return err;
        };
    }
}

test "every call that changes the domain may run out of memory anywhere, and leaves it as it was" {
    try memory.atEveryMemorySize(domainLife);
}

/// The ABCs added, a child domain made, a finding recorded and every
/// traits resolved, straight into a Domain over `source`.
fn linkAll(source: Allocator) !void {
    var arena: memory.Arena = .init(source);
    defer arena.deinit();
    var scratch: memory.Arena = .init(source);
    defer scratch.deinit();
    const dom = try arena.allocator().create(Domain);
    dom.* = try .init(arena.allocator(), scratch.allocator());
    const steps = struct {
        fn run(d: *Domain, a: *memory.Arena, step: u32) !void {
            switch (step) {
                0 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_builtin, true, 0 })),
                1 => try testing.expectEqual(1, try domain_.changed(d, a, Domain.childDomain, .{0})),
                2 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_user, false, 1 })),
                3 => try testing.expectEqual(1103, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_failing, false, 0 })),
                4 => try domain_.changed(d, a, Domain.addFound, .{ 1, .public, "", "A", 0, true }),
                else => try testing.expectEqual(0, try domain_.changed(d, a, domainResolve, .{0})),
            }
        }
    };
    for (0..6) |step| {
        const before = fingerprint(dom);
        const mark = arena.mark();
        steps.run(dom, &arena, @intCast(step)) catch |err| {
            try testing.expectEqual(before, fingerprint(dom));
            try testing.expectEqual(mark, arena.mark());
            return err;
        };
    }
}

test "every allocation of a link may fail in turn, and leaves the domain and its arena as they were" {
    try testing.checkAllAllocationFailures(testing.allocator, linkAll, .{});
}

/// An allocator that fails its `fail_at`-th allocation or growth once, and
/// none after: a call that ran out of memory can be made again.
const FailOnce = struct {
    backing: Allocator,
    fail_at: usize,
    count: usize = 0,

    fn allocator(self: *FailOnce) Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn fails(self: *FailOnce) bool {
        defer self.count += 1;
        return self.count == self.fail_at;
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *FailOnce = @ptrCast(@alignCast(ctx));
        return if (self.fails()) null else self.backing.rawAlloc(len, alignment, ra);
    }

    fn resize(ctx: *anyopaque, memory_: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) bool {
        const self: *FailOnce = @ptrCast(@alignCast(ctx));
        if (new_len > memory_.len and self.fails()) {
            return false;
        }

        return self.backing.rawResize(memory_, alignment, new_len, ra);
    }

    fn remap(ctx: *anyopaque, memory_: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
        const self: *FailOnce = @ptrCast(@alignCast(ctx));
        if (new_len > memory_.len and self.fails()) {
            return null;
        }

        return self.backing.rawRemap(memory_, alignment, new_len, ra);
    }

    fn free(ctx: *anyopaque, memory_: []u8, alignment: std.mem.Alignment, ra: usize) void {
        const self: *FailOnce = @ptrCast(@alignCast(ctx));
        self.backing.rawFree(memory_, alignment, ra);
    }
};

/// The calls of linkLife's domain, in order.
fn lifeStep(d: *Domain, a: *memory.Arena, step: u32) !void {
    switch (step) {
        0 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_builtin, true, 0 })),
        1 => try testing.expectEqual(1, try domain_.changed(d, a, Domain.childDomain, .{0})),
        2 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_user, false, 1 })),
        3 => try testing.expectEqual(1103, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_failing, false, 0 })),
        4 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_wide, false, 0 })),
        5 => try domain_.changed(d, a, Domain.addFound, .{ 1, .public, "", "A", 0, true }),
        6 => try testing.expectEqual(0, try domain_.changed(d, a, domainResolve, .{0})),
        7 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_created, false, 0 })),
        8 => try testing.expectEqualStrings("verified 2 of 2 bodies", try domain_.changed(d, a, domainVerifyAll, .{d.scratch})),
        9 => try testing.expectEqualStrings("checked 2 bodies, 18 instructions", try domain_.changed(d, a, domainCheckIr, .{d.scratch})),
        10 => _ = try domain_.changed(d, a, domainIr, .{ d.scratch, 0 }),
        11 => _ = try domain_.changed(d, a, code.verifyMethods, .{0}),
        12 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_contested, false, 0 })),
        13 => try testing.expectEqualStrings("verified 5 of 5 bodies", try domain_.changed(d, a, domainVerifyAll, .{d.scratch})),
        14 => _ = try domain_.changed(d, a, domainIrAll, .{d.scratch}),
        15 => _ = try domain_.changed(d, a, domainIr, .{ d.scratch, 3 }),
        16 => _ = try domain_.changed(d, a, domainEmit, .{ d.scratch, 3 }),
        17 => _ = try domain_.changed(d, a, wholeModule, .{ d.scratch, d.abcs.len - 1 }),
        18 => _ = try domain_.changed(d, a, partedModule, .{ d.scratch, 4 }),
        else => try testing.expectEqual(0, try domain_.changed(d, a, lifetime.restore, .{ a, 1, &link_user })),
    }
}

/// ABC `index`'s module, written whole; its length.
fn wholeModule(dom: *Domain, gpa: Allocator, index: u32) Allocator.Error!usize {
    var emitter: ModuleEmitter = try .init(gpa, gpa, dom, index);
    try emitter.module(&.{ "own", "first" }, false);
    return emitter.out().len();
}

/// ABC `index`'s module, a part a method, each part's scratch made anew; its length.
fn partedModule(dom: *Domain, gpa: Allocator, index: u32) Allocator.Error!usize {
    var emitter: ModuleEmitter = try .init(gpa, gpa, dom, index);
    try emitter.begin(&.{}, true);
    while (!try emitter.step(1, false)) {
        try emitter.prepare(gpa);
    }

    return emitter.out().len();
}

const life_steps = 20;

/// linkLife's calls on a domain over `source`, each that runs out of memory
/// checked to leave the domain and its arena as they were, then made again:
/// the domain's digest at the end.
fn linkLife(source: Allocator) !u64 {
    var arena: memory.Arena = .init(source);
    defer arena.deinit();
    var scratch: memory.Arena = .init(source);
    defer scratch.deinit();
    const dom = try arena.allocator().create(Domain);
    dom.* = try .init(arena.allocator(), scratch.allocator());
    for (0..life_steps) |step| {
        if (step == life_steps - 1) {
            lifetime.evict(dom, 1);
        }

        const before = fingerprint(dom);
        const prints = fieldPrints(dom);
        const mark = arena.mark();
        lifeStep(dom, &arena, @intCast(step)) catch |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            if (before != fingerprint(dom)) {
                printDiffering(prints, fieldPrints(dom));
            }

            try testing.expectEqual(before, fingerprint(dom));
            try testing.expectEqual(mark, arena.mark());
            try lifeStep(dom, &arena, @intCast(step));
        };
    }

    return fingerprint(dom);
}

test "a call that ran out of memory anywhere, made again, leaves the domain as one never short of memory" {
    var counting: FailOnce = .{ .backing = testing.allocator, .fail_at = std.math.maxInt(usize) };
    // The domain's own creation is not one of the calls: past it, every allocation fails once in turn.
    const want = try linkLife(counting.allocator());
    var at: usize = 0;
    while (at < counting.count) : (at += 1) {
        var once: FailOnce = .{ .backing = testing.allocator, .fail_at = at };
        const got = linkLife(once.allocator()) catch |err| {
            // The domain could not be made: no call to check.
            try testing.expectEqual(error.OutOfMemory, err);
            continue;
        };
        try testing.expectEqual(want, got);
    }
}

/// A domain over `source` with builtin and the contested ABC added, whose
/// functions' scope chains verifying makes: its arenas, and it.
const Made = struct {
    arena: memory.Arena,
    scratch: memory.Arena,
    dom: *Domain,

    fn init(self: *Made, source: Allocator) !void {
        self.arena = .init(source);
        self.scratch = .init(source);
        errdefer self.deinit();
        self.dom = try self.arena.allocator().create(Domain);
        self.dom.* = try .init(self.arena.allocator(), self.scratch.allocator());
        try testing.expectEqual(0, try domain_.changed(self.dom, &self.arena, domain_.addAbc, .{ &self.arena, &link_builtin, true, 0 }));
        try testing.expectEqual(0, try domain_.changed(self.dom, &self.arena, domain_.addAbc, .{ &self.arena, &link_contested, false, 0 }));
    }

    fn deinit(self: *Made) void {
        self.scratch.deinit();
        self.arena.deinit();
    }
};

/// domainEmitEach's bodies compiled three times on a domain over `source`,
/// each call that runs out of memory checked to leave the domain as it
/// was and made again: the texts' and the domain's digest.
fn emitRetried(source: Allocator) !u64 {
    compile.forgetVerified();
    defer compile.forgetVerified();
    var made: Made = undefined;
    try made.init(source);
    defer made.deinit();
    const dom = made.dom;
    var digest: u64 = 0;
    for (0..3) |round| {
        const before = fingerprint(dom);
        const index = dom.abcs.len - 1;
        const text = compile.emitEachOn(dom, &made.arena, dom.scratch, "0,1,2,3,4", round == 1, index) catch |err| retry: {
            try testing.expectEqual(error.OutOfMemory, err);
            try testing.expectEqual(before, fingerprint(dom));
            break :retry try compile.emitEachOn(dom, &made.arena, dom.scratch, "0,1,2,3,4", round == 1, index);
        };
        digest = digest *% 31 +% std.hash.Wyhash.hash(0, text);
    }

    return digest +% fingerprint(dom);
}

test "domainEmitEach that ran out of memory anywhere, made again, verifies again and compiles alike" {
    memory.arenas();
    var counting: FailOnce = .{ .backing = testing.allocator, .fail_at = std.math.maxInt(usize) };
    const want = try emitRetried(counting.allocator());
    var at: usize = 0;
    while (at < counting.count) : (at += 1) {
        var once: FailOnce = .{ .backing = testing.allocator, .fail_at = at };
        const got = emitRetried(once.allocator()) catch |err| {
            // The domain could not be made: no call to check.
            try testing.expectEqual(error.OutOfMemory, err);
            continue;
        };
        try testing.expectEqual(want, got);
    }
}

/// A module of the contested ABC written as the exports write it, a call a
/// part, each part its own change with the emitter's scratch made anew; a
/// part that runs out of memory checked to leave the domain as the parts
/// before it left it, the module then abandoned and written again from
/// the start: its text's digest.
fn partsRetried(source: Allocator) !u64 {
    var made: Made = undefined;
    try made.init(source);
    defer made.deinit();
    // Twice: the second verification of the ABC, not its first, drops its
    // log entry as it ends, a part after the one that added it.
    const first = try writeParts(source, &made);
    return first *% 31 +% try writeParts(source, &made);
}

fn writeParts(source: Allocator, made: *Made) !u64 {
    const dom = made.dom;
    const index = dom.abcs.len - 1;
    var attempt: u32 = 0;
    while (true) : (attempt += 1) {
        try testing.expect(attempt < 2);
        var persist: memory.Arena = .init(source);
        defer persist.deinit();
        const emitter = try persist.allocator().create(ModuleEmitter);
        emitter.* = try .init(persist.allocator(), dom.scratch, dom, index);
        const parts = struct {
            fn first(_: *Domain, e: *ModuleEmitter) Allocator.Error!bool {
                try e.begin(&.{ "own", "first" }, false);
                return e.step(1, false);
            }

            fn next(_: *Domain, e: *ModuleEmitter) Allocator.Error!bool {
                return e.step(1, false);
            }
        };
        var before = fingerprint(dom);
        var done = domain_.changed(dom, &made.arena, parts.first, .{emitter}) catch |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            try testing.expectEqual(before, fingerprint(dom));
            continue;
        };
        const ran_out = while (!done) {
            try emitter.prepare(dom.scratch);
            before = fingerprint(dom);
            done = domain_.changed(dom, &made.arena, parts.next, .{emitter}) catch |err| {
                try testing.expectEqual(error.OutOfMemory, err);
                try testing.expectEqual(before, fingerprint(dom));
                break true;
            };
        } else false;
        if (!ran_out) {
            return std.hash.Wyhash.hash(0, emitter.out().written());
        }
    }
}

test "a module written a part a call, that ran out of memory anywhere, is written again alike" {
    memory.arenas();
    var counting: FailOnce = .{ .backing = testing.allocator, .fail_at = std.math.maxInt(usize) };
    const want = try partsRetried(counting.allocator());
    var at: usize = 0;
    while (at < counting.count) : (at += 1) {
        var once: FailOnce = .{ .backing = testing.allocator, .fail_at = at };
        const got = partsRetried(once.allocator()) catch |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            continue;
        };
        try testing.expectEqual(want, got);
    }
}

test "bytes restore does not adopt stay out of the domain's arena" {
    var arena: memory.Arena = .init(testing.allocator);
    defer arena.deinit();
    var scratch: memory.Arena = .init(testing.allocator);
    defer scratch.deinit();
    const dom = try arena.allocator().create(Domain);
    dom.* = try .init(arena.allocator(), scratch.allocator());
    try testing.expectEqual(0, try domain_.changed(dom, &arena, domain_.addAbc, .{ &arena, &link_builtin, true, 0 }));
    try testing.expectEqual(1, try domain_.changed(dom, &arena, Domain.childDomain, .{0}));
    try testing.expectEqual(0, try domain_.changed(dom, &arena, domain_.addAbc, .{ &arena, &link_user, false, 1 }));
    lifetime.evict(dom, 1);
    const big = try testing.allocator.alloc(u8, 1 << 20);
    defer testing.allocator.free(big);
    @memset(big, 0);
    const mark = arena.mark();
    for (0..50) |_| {
        // ABC 0 is live: not the domain's to restore. ABC 1 is held still: nothing to adopt.
        try testing.expectEqual(-1, try domain_.changed(dom, &arena, lifetime.restore, .{ &arena, 0, big }));
        try testing.expectEqual(0, try domain_.changed(dom, &arena, lifetime.restore, .{ &arena, 1, big }));
    }

    try testing.expectEqual(mark, arena.mark());

    // One a rebuild let go of: bytes that do not parse leave nothing; its own are adopted.
    dom.abcs.set(1, &lifetime.no_abc);
    try testing.expectEqual(1107, try domain_.changed(dom, &arena, lifetime.restore, .{ &arena, 1, big[0..3] }));
    try testing.expectEqual(mark, arena.mark());
    try testing.expectEqual(0, try domain_.changed(dom, &arena, lifetime.restore, .{ &arena, 1, &link_user }));
    try testing.expect(dom.abcs.get(1) != &lifetime.no_abc);
}

fn isTerminal(op: ops.Op) bool {
    return op.info().flags.terminal;
}
