// Writes an ABC as one ES module (assembly/avm2/emit/module.ts, whose header
// shows its shape and tells why): its names, a factory per method, the
// layouts of its traits as the compiler computed them, its classes and its
// scripts.
//
// A module may be written a part at a time, a call each, and kept after for
// its source map and entries: what lasts from one call to the next is in the
// allocator it is made with, `persist`, and each call's garbage in the
// call's arena (prepare), as AssemblyScript's collector frees it between
// calls.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const output = @import("../../output.zig");
const Output = output.Output;
const code = @import("../abc/code.zig");
const BodyDecoder = code.BodyDecoder;
const Verifier = code.Verifier;
const C = @import("../abc/constants.zig");
const ir_ = @import("../ir/ir.zig");
const domain_ = @import("../link/domain.zig");
const Domain = domain_.Domain;
const traits_ = @import("../link/traits.zig");
const TypeRef = traits_.TypeRef;
const method_ = @import("method.zig");
const MethodEmitter = method_.MethodEmitter;
const METHOD_SLOT = method_.METHOD_SLOT;
const refs = @import("refs.zig");
const SourceMap = @import("sourcemap.zig").SourceMap;
const stack_names = @import("stack-names.zig");

/// The most slots a traits' fill sets (module.ts tells why).
const FILL_SLOTS: u32 = 1 << 16;

/// Where step is in a module: verifying its methods, writing F, writing A, or done.
const PHASE_Verify: u8 = 0;
const PHASE_Methods: u8 = 1;
const PHASE_Tables: u8 = 2;
const PHASE_Done: u8 = 3;

/// The garbage, roughly, in bytes, that writing a byte of a method's entry
/// makes in AssemblyScript, its text included: what step's budget counts,
/// with VERIFY_COST, so that both compilers part a module alike.
const EMIT_COST: u64 = 3;

fn List(comptime T: type) type {
    return std.ArrayList(T);
}

pub const ModuleEmitter = struct {
    persist: Allocator,
    methods: MethodEmitter,
    /// Each compiled method's entry in F: its body, and where it starts and ends in the module.
    entryBody: List(u32) = .empty,
    entryStart: List(u32) = .empty,
    entryEnd: List(u32) = .empty,
    domain: *Domain,
    index: u32,
    /// fill's scratch: each slot's declaring ABC and trait, and the traits from t to its root.
    fillAbc: List(i32) = .empty,
    fillTrait: List(u32) = .empty,
    fillChain: List(u32) = .empty,
    /// aliases' scratch: the interface members whose aliases it wrote for a class.
    aliasMembers: List(u32) = .empty,
    /// A module written a part at a time: what begin was given, and how far step has got.
    hashes: []const []const u8 = &.{},
    linkedOnly: bool = false,
    phase: u8 = PHASE_Done,
    verifier: ?Verifier = null,
    results: []i32 = &.{},
    cursor: u32 = 0,
    /// The garbage the current step has made, roughly, in bytes.
    spent: u64 = 0,

    /// An emitter whose module, entries and source map last in `persist`,
    /// and whose scratch is in `scratch` until the next prepare.
    pub fn init(persist: Allocator, scratch: Allocator, domain: *Domain, index: u32) Error!ModuleEmitter {
        const methods = try MethodEmitter.init(persist, scratch, domain, index);
        return .{ .persist = persist, .methods = methods, .domain = domain, .index = index };
    }

    /// A new emitter in place of this one, as AssemblyScript makes one, but
    /// with its buffers: each Output reserves a whole run of the call's arena.
    pub fn renew(self: *ModuleEmitter) void {
        const kept = self.methods;
        self.* = .{
            .persist = self.persist,
            .domain = self.domain,
            .index = self.index,
            .methods = .{
                .gpa = kept.gpa,
                .out = kept.out,
                .map = kept.map,
                .heldText = kept.heldText,
                .domain = kept.domain,
                .index = kept.index,
                .abc = kept.abc,
                .data = kept.data,
            },
        };
        self.methods.out.reset();
        self.methods.heldText.reset();
        self.methods.map.reset();
    }

    /// The module's text.
    pub fn out(self: *ModuleEmitter) *Output {
        return &self.methods.out;
    }

    /// A call starts: the method emitter's scratch, made in the last call's
    /// arena, is let go of, and made again in `scratch` as it is needed.
    pub fn prepare(self: *ModuleEmitter, scratch: Allocator) Error!void {
        const methods = &self.methods;
        const info = @typeInfo(MethodEmitter).@"struct";
        inline for (info.field_names, info.field_types, info.field_attrs) |name, T, attrs| {
            const kind = @typeInfo(T);
            const isSlice = kind == .pointer and kind.pointer.size == .slice;
            const isList = kind == .@"struct" and @hasField(T, "items") and @hasField(T, "capacity");
            if (comptime (isSlice or isList) and attrs.defaultValue(T) != null) {
                @field(methods, name) = comptime attrs.defaultValue(T).?;
            }
        }

        methods.gpa = scratch;
        methods.heldText = try .init(scratch);
        self.fillAbc = .empty;
        self.fillTrait = .empty;
        self.fillChain = .empty;
        self.aliasMembers = .empty;
    }

    /// Write the whole module; the result is in `out` (module.ts tells what
    /// `hashes` and `linkedOnly` are).
    pub fn module(self: *ModuleEmitter, hashes: []const []const u8, linkedOnly: bool) Error!void {
        try self.begin(hashes, linkedOnly);
        while (!try self.step(std.math.maxInt(u64), false)) {}
    }

    /// Start writing the module a part at a time, as module() writes it
    /// whole: its head now, then the rest by step.
    pub fn begin(self: *ModuleEmitter, hashes: []const []const u8, linkedOnly: bool) Error!void {
        const o = self.out();
        o.reset();
        self.methods.map.reset();
        const kept = try self.persist.alloc([]const u8, hashes.len);
        for (hashes, kept) |h, *k| {
            k.* = try self.persist.dupe(u8, h);
        }

        self.hashes = kept;
        self.linkedOnly = linkedOnly;
        self.cursor = 0;
        try o.text("export default function (rt) {\n");
        // Not named with a $, so that a stack starts at the method that called them.
        try o.text("  const nn = (v) => { throw rt.nullError(v); };\n");
        try o.text("  const ac = (n, given) => { throw rt.argumentCountError(n, given); };\n");
        try o.text("  const ns = (kind, uri) => rt.ns(kind, uri);\n");
        try o.text("  const cls = (n, name) => rt.cls(n, name);\n");
        try o.text("  const mn = (kind, set, name) => rt.name(N, V, kind, set, name);\n");
        try self.names();
        // Verified after the names are written, as before any method.
        self.verifier = try Verifier.init(self.domain, self.persist, self.index);
        self.phase = PHASE_Verify;
    }

    /// Write the next part of the module begin started, after `out`'s text,
    /// or in place of it with `fresh`, until about `budget` bytes of garbage
    /// are made (module.ts tells how they are counted): whether it is done.
    pub fn step(self: *ModuleEmitter, budget: u64, fresh: bool) Error!bool {
        const o = self.out();
        if (fresh) {
            self.methods.map.rebase(o.len());
            o.reset();
        }

        self.spent = 0;
        if (self.phase == PHASE_Verify) {
            if (self.verifier) |*verifier| {
                if (!try verifier.run(@max(budget / code.VERIFY_COST, 1))) {
                    return false;
                }

                self.spent = verifier.spent * code.VERIFY_COST;
                self.results = verifier.results;
            }

            self.verifier = null;
            self.phase = PHASE_Methods;
            try o.text("  const F = [");
        }

        if (self.phase == PHASE_Methods) {
            if (!try self.functions(budget)) {
                return false;
            }

            try o.text("];\n");
            self.phase = PHASE_Tables;
            // A's garbage is about a part's in a large ABC: a call of its own,
            // unless this one has made little.
            if (self.spent >= budget / 2) {
                return false;
            }
        }

        if (self.phase == PHASE_Tables) {
            try self.tables();
            self.phase = PHASE_Done;
        }

        return true;
    }

    /// The module's A, after F: the ABC its classes, scripts and activations.
    fn tables(self: *ModuleEmitter) Error!void {
        const o = self.out();
        const hashes = self.hashes;
        try o.text("  const A = rt.abc({\n    hash: ");
        const own: u32 = if (self.linkedOnly) 0 else self.index;
        try o.string(if (own < hashes.len) hashes[own] else "");
        try o.text(",\n    linked: [");
        const domain = self.domain;
        const appDomain = domain.abcDomain.get(self.index);
        var linked: u32 = 0;
        for (0..self.index) |i| {
            if (!domain.sees(appDomain, domain.abcDomain.get(@intCast(i)))) {
                continue;
            }

            if (linked > 0) {
                try o.text(", ");
            }

            linked += 1;
            const at = if (self.linkedOnly) linked else @as(u32, @intCast(i));
            try o.string(if (at < hashes.len) hashes[at] else "");
        }

        try o.text("],\n    names: M,\n    classes: [");
        try self.classes();
        try o.text("],\n    scripts: [");
        try self.scripts();
        try o.text("],\n    activations: [");
        try self.activations();
        try o.text("],\n  });\n  return A;\n}\n");
    }

    /// The source map of the module just written, as JSON, into `map`.
    pub fn sourceMap(self: *ModuleEmitter, map: *Output) Error!void {
        const methods = &self.methods;
        try methods.map.write(map, &methods.out, &self.domain.abcs.get(self.index).pool, methods.data);
    }

    /// N: the pool's namespaces; S: its namespace sets; M: its multinames.
    fn names(self: *ModuleEmitter) Error!void {
        const o = self.out();
        const domain = self.domain;
        const pool = &domain.abcs.get(self.index).pool;
        const ids = domain.abcNs.get(self.index);
        const versions = domain.abcNsVersion.get(self.index);
        try o.text("  const N = [null");
        var i: u32 = 1;
        while (i < pool.nsCount()) : (i += 1) {
            try o.text(", ");
            const id = ids[i];
            if (domain.nsType.get(id) == .private) {
                try o.text("rt.privateNs(");
                try refs.uri(&self.methods, domain.nsUri.get(id));
                try o.text(")");
            } else {
                try refs.namespace(&self.methods, id);
            }
        }

        try o.text("];\n  const V = [0");
        i = 1;
        while (i < pool.nsCount()) : (i += 1) {
            try o.text(", ");
            try o.uint(versions[i]);
        }

        try o.text("];\n  const S = [null");
        i = 1;
        while (i < pool.nsSetCount()) : (i += 1) {
            try o.text(", [");
            var j = pool.nsSetStart[i];
            while (j < pool.nsSetStart[i + 1]) : (j += 1) {
                if (j > pool.nsSetStart[i]) {
                    try o.text(", ");
                }

                try o.uint(pool.nsSetMembers[j]);
            }

            try o.text("]");
        }

        try o.text("];\n  const M = [null");
        i = 1;
        while (i < pool.multinameCount()) : (i += 1) {
            try o.text(",\n    ");
            try self.multiname(i);
        }

        try o.text("];\n");
    }

    /// Multiname i as mn(kind, namespace indices, name), or rt.typeName for
    /// a TypeName (module.ts tells the parts).
    fn multiname(self: *ModuleEmitter, i: u32) Error!void {
        const o = self.out();
        const pool = &self.domain.abcs.get(self.index).pool;
        const kind = pool.mnKind[i];
        if (kind == .type_name) {
            try o.text("rt.typeName(N, V, S, ");
            try o.uint(pool.mnA[i]);
            try o.text(", ");
            try o.uint(pool.mnB[i]);
            try o.text(")");
            return;
        }

        try o.text("mn(");
        try o.uint(@backingInt(kind));
        try o.text(", ");
        switch (kind) {
            .qname, .qname_a => {
                try o.text("[");
                try o.uint(pool.mnA[i]);
                try o.text("]");
            },
            .multiname, .multiname_a, .multiname_l, .multiname_la => {
                try o.text("S[");
                try o.uint(pool.mnA[i]);
                try o.text("]");
            },
            else => try o.text("[]"),
        }

        try o.text(", ");
        const hasName = switch (kind) {
            .qname, .qname_a, .rtqname, .rtqname_a, .multiname, .multiname_a => true,
            else => false,
        };
        const name = if (hasName) pool.mnB[i] else 0;
        if (name != 0) {
            try refs.poolString(&self.methods, name);
        } else {
            try o.text("null");
        }

        try o.text(")");
    }

    /// The text `units` and then `tail`, a string of AssemblyScript's, as
    /// a JavaScript string literal, encoded as its String.UTF8 encodes one:
    /// WTF-8, a lone surrogate as three bytes of its own.
    fn units(self: *ModuleEmitter, text: []const u16, tail: []const u8) Error!void {
        const gpa = self.methods.gpa;
        const bytes = try std.unicode.wtf16LeToWtf8Alloc(gpa, text);
        try self.out().string(try std.mem.concat(gpa, u8, &.{ bytes, tail }));
    }

    /// F's entries from the cursor on, a factory per method (module.ts tells
    /// each kind), until `spent` reaches `budget`: whether F is done.
    fn functions(self: *ModuleEmitter, budget: u64) Error!bool {
        const o = self.out();
        const domain = self.domain;
        const abc = domain.abcs.get(self.index);
        const results = self.results;
        // Asked for again by each part, as another may have retargeted it.
        const decoder = try code.bodyDecoder(domain, self.index);
        const start = domain.methodStart.get(self.index);
        while (self.cursor < abc.methodCount()) {
            if (self.spent >= budget) {
                return false;
            }

            const m = self.cursor;
            self.cursor += 1;
            const before = o.len();
            try o.text(if (m != 0) ",\n    " else "\n    ");
            const global = start + m;
            const body = abc.methodBody[m];
            if (abc.methodFlags[m].native) {
                try o.text("rt.native(");
                try self.nativeName(global);
                try self.nativeArity(global);
                try o.text(")");
                continue;
            }

            if (body < 0) {
                try o.text("rt.noBody(");
                try self.units(try stack_names.stackName(domain, self.methods.gpa, self.index, global), "()");
                try o.text(")");
                continue;
            }

            const b: u32 = @intCast(body);
            const result = results[b];
            if (result < 0) {
                try o.text("rt.unverified");
                continue;
            }

            if (result > 0) {
                try self.verifyError(result, global, b, decoder);
                continue;
            }

            _ = try decoder.decode(b, domain.traits.scopeOf(global));
            try self.entryBody.append(self.persist, b);
            try self.entryStart.append(self.persist, o.len());
            try self.factory(m, global, decoder);
            try self.entryEnd.append(self.persist, o.len());
            self.spent += @as(u64, o.len() - before) * EMIT_COST;
        }

        return true;
    }

    /// Method m's entry in F, from its IR in `decoder`: `(scope, sup) =>
    /// function`, inside a function of its table T if it has one; the same
    /// whether the module is being written or the method compiled alone.
    pub fn factory(self: *ModuleEmitter, m: u32, global: u32, decoder: *BodyDecoder) Error!void {
        const o = self.out();
        const methods = &self.methods;
        methods.newTypes();
        const at = o.len();
        const marks = methods.map.count();
        methods.functionName = try self.functionName(global);
        methods.claims = decoder.claims.items;
        try methods.method(m, global, &decoder.ir);
        methods.functionName = "";
        // Its parameters, up to the last the method uses; $dx: the default XML
        // namespace when the factory runs, as avmplus' scope chain captures it.
        const params = if (methods.seesDxns)
            "(scope, sup, $dx = rt.defaultXmlNamespace) => "
        else if (methods.usesSup)
            "(scope, sup) => "
        else if (methods.usesScope)
            "(scope) => "
        else
            "() => ";
        try o.insert(at, params);
        methods.map.shift(marks, @intCast(params.len));
        const types = methods.types.items;
        if (types.len == 0) {
            return;
        }

        // The table's function goes before the method, which it now knows the types of.
        const head = "((...T) => ";
        try o.insert(at, head);
        methods.map.shift(marks, head.len);
        try o.text(")(");
        for (types, 0..) |t, k| {
            try o.text(if (k != 0) ", " else "");
            if (t >= 0) {
                try refs.typeExpr(methods, ir_.columnType(t));
                continue;
            }

            if (t == METHOD_SLOT) {
                try o.text("null");
                continue;
            }

            const n: usize = @intCast(-1 - t);
            try o.text("rt.literalName(M[");
            try o.uint(methods.literalMultinames.items[n]);
            try o.text("], ");
            try refs.poolString(methods, methods.literalStrings.items[n]);
            try o.text(")");
        }

        try o.text(")");
    }

    /// A native method's argument counts, as MethodEnv's argcOk checks them,
    /// when it has any: `, required, max`, max -1 where it takes more than it
    /// declares.
    fn nativeArity(self: *ModuleEmitter, m: u32) Error!void {
        const table = &self.domain.traits;
        // Its signature, as avmplus resolves it before the first call; one that
        // fails to resolve fails when called, as the runtime has it.
        if (try table.sign(self.domain, m) != 0) {
            return;
        }

        const required = table.paramCount.get(m) -% table.optionalCount.get(m);
        const extra = self.domain.allowsExtraArgs(m);
        if (required == 0 and extra) {
            return;
        }

        const o = self.out();
        try o.text(", ");
        try o.uint(required);
        try o.text(", ");
        if (extra) {
            try o.text("-1");
        } else {
            try o.uint(table.paramCount.get(m));
        }
    }

    /// The factory of method `global`, whose body failed verification with
    /// `err`: the VerifyError with the arguments avmplus' message takes
    /// (module.ts tells which).
    fn verifyError(self: *ModuleEmitter, err: i32, global: u32, body: u32, decoder: *BodyDecoder) Error!void {
        const o = self.out();
        try o.text("rt.verifyError(");
        try o.uint(@intCast(err));
        switch (err) {
            C.kIllegalOpcodeError => {
                try o.text(", ");
                try self.units(try stack_names.stackName(self.domain, self.methods.gpa, self.index, global), "()");
                try self.errorNumbers(err, global, body, decoder, 2);
            },
            C.kStackDepthUnbalancedError, C.kScopeDepthUnbalancedError => try self.errorNumbers(err, global, body, decoder, 2),
            C.kGetScopeObjectBoundsError, C.kInvalidRegisterError => try self.errorNumbers(err, global, body, decoder, 1),
            C.kIllegalSetDxns, C.kIllegalSuperCallError => {
                try o.text(", ");
                try self.units(try stack_names.stackName(self.domain, self.methods.gpa, self.index, global), "()");
            },
            else => {},
        }

        try o.text(")");
    }

    /// The `count` numbers verifying `body` again records with `err`, as
    /// arguments; none for another error, or if it records none.
    fn errorNumbers(self: *ModuleEmitter, err: i32, global: u32, body: u32, decoder: *BodyDecoder, count: u32) Error!void {
        const result = try decoder.decode(body, self.domain.traits.scopeOf(global));
        if (result.@"error" != err or !result.numbered) {
            return;
        }

        const o = self.out();
        try o.text(", ");
        try o.uint(result.errorA);
        if (count > 1) {
            try o.text(", ");
            try o.uint(result.errorB);
        }
    }

    /// A native method's name, as avmplus binds its C++ ones (module.ts
    /// tells the forms).
    fn nativeName(self: *ModuleEmitter, m: u32) Error!void {
        try self.units(try self.methodName(m), "");
    }

    /// Method m's name as a JavaScript identifier for its function: its name
    /// in a stack trace, escaped (stack-names.zig).
    fn functionName(self: *ModuleEmitter, m: u32) Error![]const u8 {
        const gpa = self.methods.gpa;
        return stack_names.identifierOf(gpa, try stack_names.stackName(self.domain, gpa, self.index, m));
    }

    /// Method m's name: "Class.name", "Class#name", or a script's qualified
    /// name, "" if no trait binds it; as UTF-16 units, as AssemblyScript's
    /// string of it.
    fn methodName(self: *ModuleEmitter, m: u32) Error![]const u16 {
        const gpa = self.methods.gpa;
        const domain = self.domain;
        const table = &domain.traits;
        const t = table.methodTraits.get(m);
        const abc = domain.abcs.get(self.index);
        const local = m - domain.methodStart.get(self.index);
        var text: List(u16) = .empty;
        if (t == .none) {
            return &.{};
        }

        const tu = t.index();
        const kind = table.kind.get(tu);
        if (kind == .instance or kind == .class) {
            try text.appendSlice(gpa, try refs.className(&self.methods, table, tu));
            try text.append(gpa, if (kind == .class) '.' else '#');
        }

        // The trait that binds the method names it.
        var i = table.first.get(tu);
        while (i < table.end.get(tu)) : (i += 1) {
            const tk = abc.traitTag[i].kind;
            if (tk.bindsMethod() and abc.traitIndex[i] == local) {
                switch (tk) {
                    .getter => try text.appendSlice(gpa, &[_]u16{ 'g', 'e', 't', ':' }),
                    .setter => try text.appendSlice(gpa, &[_]u16{ 's', 'e', 't', ':' }),
                    else => {},
                }

                table.readName(domain, self.index, i);
                try text.appendSlice(gpa, try refs.qualified(&self.methods, table.nameNs, table.nameId));
                return text.items;
            }
        }

        return &.{};
    }

    /// Traits t as { slots, defaults, types, bindings, methods }, resolved
    /// here; or the VerifyError resolving them gives (module.ts tells why).
    fn traits(self: *ModuleEmitter, t: u32) Error!void {
        const o = self.out();
        const domain = self.domain;
        const table = &domain.traits;
        const abc = domain.abcs.get(self.index);
        const err = try table.resolve(domain, t);
        if (err != 0) {
            try o.text("{ error: ");
            try o.uint(@as(u32, @bitCast(err)));
            try o.text(", slots: 0, defaults: [], bindings: [], methods: [] }");
            return;
        }

        try o.text("{ slots: ");
        try o.uint(table.slotCount.get(t));
        try o.text(", defaults: [");
        var first = true;
        const slotStart = table.slotStart.get(t);
        const base = table.base.get(t);
        var i = table.first.get(t);
        while (i < table.end.get(t)) : (i += 1) {
            const kind = abc.traitTag[i].kind;
            if (!kind.bindsSlot()) {
                continue;
            }

            table.readName(domain, self.index, i);
            const b = table.own(t, table.nameNs, table.nameId, table.nameVersion);
            const slot = b.index();
            try o.text(if (first) "[" else ", [");
            first = false;
            try o.uint(slot);
            try o.text(", ");
            const ty = table.slotType.get(slotStart + slot);
            if (kind == .class) {
                try o.text("null");
            } else {
                try refs.constant(&self.methods, abc.traitValue[i], abc.traitValueKind[i], ty);
            }

            try o.text(", ");
            try refs.typeExpr(&self.methods, ty);
            try o.text("]");
        }

        try o.text("], bindings: [");
        first = true;
        var m = table.memberStart.get(t);
        while (m < table.memberEnd.get(t)) : (m += 1) {
            try o.text(if (first) "[" else ", [");
            first = false;
            const ns = table.memberNs.get(m);
            if (domain.nsType.get(ns) == .private) {
                try o.text("N[");
                try o.uint(self.poolIndexOf(ns));
                try o.text("]");
            } else {
                try refs.namespace(&self.methods, ns);
            }

            try o.text(", ");
            try o.uint(table.memberVersion.get(m));
            try o.text(", ");
            try o.string(domain.stringOf(table.memberName.get(m)));
            try o.text(", ");
            try o.uint(@as(u32, @bitCast(table.memberBinding.get(m))));
            try o.text("]");
        }

        try o.text("], methods: [");
        first = true;
        const dispatch = table.dispatchStart.get(t);
        const baseDispatch = if (base != .none) table.dispatchStart.get(base.index()) else 0;
        const baseMethods: u32 = if (base != .none) table.methodCount.get(base.index()) else 0;
        const start = domain.methodStart.get(self.index);
        for (0..table.methodCount.get(t)) |d_| {
            const d: u32 = @intCast(d_);
            const method = table.dispatch.get(dispatch + d);
            if (method < 0 or (d < baseMethods and table.dispatch.get(baseDispatch + d) == method)) {
                continue;
            }

            try o.text(if (first) "[" else ", [");
            first = false;
            // Its dispatch id, factory, and method id, as avmplus writes a function [object Function-id].
            const id = @as(u32, @intCast(method)) -% start;
            try o.uint(d);
            try o.text(", F[");
            try o.uint(id);
            try o.text("], ");
            try o.uint(id);
            try o.text(", ");
            try self.signature(@intCast(method), true);
            try o.text("]");
        }

        try o.text("]");
        try self.meta(t);
        try self.fill(t);
        try o.text(" }");
    }

    /// Traits t's `fill`, when it has slots: `(o, v) => { o.$n = ...; ... }`,
    /// which sets each slot of a new object, highest first (module.ts tells
    /// why, and which values are literals).
    fn fill(self: *ModuleEmitter, t: u32) Error!void {
        const domain = self.domain;
        const table = &domain.traits;
        const count = table.slotCount.get(t);
        if (count == 0 or count > FILL_SLOTS) {
            return;
        }

        // Each slot's declaring trait: its ABC (-1 for none) and its index there.
        const gpa = self.methods.gpa;
        self.fillAbc.clearRetainingCapacity();
        self.fillTrait.clearRetainingCapacity();
        try self.fillAbc.appendNTimes(gpa, -1, count);
        try self.fillTrait.appendNTimes(gpa, 0, count);

        // The bases' first, as the runtime lists the initial values, so that a
        // slot named twice has the value the runtime sets last.
        const chain = &self.fillChain;
        chain.clearRetainingCapacity();
        var u = TypeRef.of(t);
        while (u != .none) : (u = table.base.get(u.index())) {
            try chain.append(gpa, u.index());
        }

        var c = chain.items.len;
        while (c > 0) {
            c -= 1;
            const v = chain.items[c];
            const index = table.abc.get(v);
            const abc = domain.abcs.get(index);
            var i = table.first.get(v);
            while (i < table.end.get(v)) : (i += 1) {
                const kind = abc.traitTag[i].kind;
                if (!kind.bindsSlot()) {
                    continue;
                }

                table.readName(domain, index, i);
                const slot = table.own(v, table.nameNs, table.nameId, table.nameVersion).index();
                if (slot < count) {
                    self.fillAbc.items[slot] = @intCast(index);
                    self.fillTrait.items[slot] = i;
                }
            }
        }

        const o = self.out();
        try o.text(", fill: (o, v) => {");
        // Those kept apart first, as an array literal, which V8 keeps packed.
        if (count > refs.SPILL_SLOTS) {
            try o.text(" o.$S = [");
            var s = refs.SPILL_SLOTS;
            while (s < count) : (s += 1) {
                if (s > refs.SPILL_SLOTS) {
                    try o.text(", ");
                }

                try self.fillValue(t, s);
            }

            try o.text("];");
        }

        var s: u32 = @min(count, refs.SPILL_SLOTS);
        while (s > 0) {
            s -= 1;
            if (self.fillAbc.items[s] < 0) {
                continue;
            }

            try o.text(" o.$");
            try o.uint(s);
            try o.text(" = ");
            try self.fillValue(t, s);
            try o.text(";");
        }

        try o.text(" }");
    }

    /// Slot `s`'s initial value in traits t's fill: a literal where it is one
    /// wherever the module is compiled, else the runtime's, `v[s]`; undefined
    /// for a slot no trait declares.
    fn fillValue(self: *ModuleEmitter, t: u32, s: u32) Error!void {
        const o = self.out();
        const index = self.fillAbc.items[s];
        if (index < 0) {
            return o.text("undefined");
        }

        const domain = self.domain;
        const table = &domain.traits;
        const abc = domain.abcs.get(@intCast(index));
        const i = self.fillTrait.items[s];
        const kind = abc.traitTag[i].kind;
        const value = abc.traitValue[i];
        const valueKind = abc.traitValueKind[i];
        if (kind == .class) {
            try o.text("null");
        } else if (value == 0 or (@as(u32, @intCast(index)) == self.index and literal(valueKind))) {
            try refs.constant(&self.methods, value, valueKind, table.slotType.get(table.slotStart.get(t) + s));
        } else {
            try o.text("v[");
            try o.uint(s);
            try o.text("]");
        }
    }

    /// Method m's signature for describeType: its return type (left out for
    /// a constructor), its parameter types, and how many are required; `null,
    /// [], 0` for one that does not resolve.
    fn signature(self: *ModuleEmitter, m: u32, returns: bool) Error!void {
        const o = self.out();
        const table = &self.domain.traits;
        if (try table.sign(self.domain, m) != 0) {
            return o.text(if (returns) "null, [], 0" else "[], 0");
        }

        if (returns) {
            try refs.typeExpr(&self.methods, table.returnType.get(m));
            try o.text(", ");
        }

        try o.text("[");
        const start = table.paramStart.get(m);
        for (0..table.paramCount.get(m)) |p| {
            try o.text(if (p != 0) ", " else "");
            try refs.typeExpr(&self.methods, table.paramType.get(start + @as(u32, @intCast(p))));
        }

        try o.text("], ");
        try o.uint(table.paramCount.get(m) -% table.optionalCount.get(m));
    }

    /// Traits t's own metadata, when it has any, as `meta` (module.ts tells
    /// the form).
    fn meta(self: *ModuleEmitter, t: u32) Error!void {
        const o = self.out();
        const table = &self.domain.traits;
        const abc = self.domain.abcs.get(self.index);
        var count: u32 = 0;
        var i = table.first.get(t);
        while (i < table.end.get(t)) : (i += 1) {
            if (abc.traitMetadataStart[i] == abc.traitMetadataStart[i + 1]) {
                continue;
            }

            const kind = abc.traitTag[i].kind;
            table.readName(self.domain, self.index, i);
            const b = table.own(t, table.nameNs, table.nameId, table.nameVersion);
            try o.text(if (count != 0) ", [" else ", meta: [[");
            count += 1;
            try o.uint(@backingInt(kind));
            try o.text(", ");
            try o.uint(b.index() + @as(u32, if (kind == .setter) 1 else 0));
            try o.text(", ");
            try self.metadataOf(i);
            try o.text("]");
        }

        if (count != 0) {
            try o.text("]");
        }
    }

    /// Trait i's metadata entries as [[name, [key, value, ...]], ...]; a
    /// builtin's Version, native and API entries left out, as avmplus'
    /// describeMetadataInfo leaves them.
    fn metadataOf(self: *ModuleEmitter, i: u32) Error!void {
        const o = self.out();
        const domain = self.domain;
        const abc = domain.abcs.get(self.index);
        const strings = domain.abcString.get(self.index);
        try o.text("[");
        var count: u32 = 0;
        var j = abc.traitMetadataStart[i];
        while (j < abc.traitMetadataStart[i + 1]) : (j += 1) {
            const md = abc.traitMetadata[j];
            const name = strings[abc.metadataName[md]];
            if (abc.builtin and (name == domain.versionName or name == domain.nativeName or name == domain.apiName)) {
                continue;
            }

            try o.text(if (count != 0) ", [" else "[");
            count += 1;
            try o.string(domain.stringOf(name));
            try o.text(", [");
            var k = abc.metadataItemStart[md];
            while (k < abc.metadataItemStart[md + 1]) : (k += 1) {
                try o.text(if (k > abc.metadataItemStart[md]) ", " else "");
                try self.poolString(abc.metadataKey[k]);
                try o.text(", ");
                try self.poolString(abc.metadataValue[k]);
            }

            try o.text("]]");
        }

        try o.text("]");
    }

    /// Pool string `index` of this ABC as a literal, or "" past the pool's
    /// end, as avmplus' poolstr reads an unchecked index.
    fn poolString(self: *ModuleEmitter, index: u32) Error!void {
        const domain = self.domain;
        const abc = domain.abcs.get(self.index);
        const id = if (index < abc.pool.stringCount()) domain.abcString.get(self.index)[index] else try domain.internText("");
        try self.out().string(domain.stringOf(id));
    }

    /// The pool index of this ABC's namespace with interned id `id`.
    fn poolIndexOf(self: *ModuleEmitter, id: u32) u32 {
        const ids = self.domain.abcNs.get(self.index);
        var i: u32 = 1;
        while (i < ids.len) : (i += 1) {
            if (ids[i] == id) {
                return i;
            }
        }

        return 0;
    }

    /// Each class as { name, base, interfaces, final, interface, protectedNs,
    /// instance, static, init, cinit }, names as indices into M.
    fn classes(self: *ModuleEmitter) Error!void {
        const o = self.out();
        const domain = self.domain;
        const abc = domain.abcs.get(self.index);
        const classStart = domain.classStart.get(self.index);
        for (0..abc.classCount()) |i_| {
            const i: u32 = @intCast(i_);
            try o.text(if (i != 0) ",\n    { name: " else "\n    { name: ");
            try o.uint(abc.instanceName[i]);
            try o.text(", base: ");
            try o.uint(abc.instanceSuper[i]);
            try o.text(", interfaces: [");
            var j = abc.instanceInterfaceStart[i];
            while (j < abc.instanceInterfaceStart[i + 1]) : (j += 1) {
                if (j > abc.instanceInterfaceStart[i]) {
                    try o.text(", ");
                }

                try o.uint(abc.interfaces[j]);
            }

            const flags = abc.instanceFlags[i];
            try o.text("], final: ");
            try o.text(if (flags.final) "true" else "false");
            try o.text(", interface: ");
            try o.text(if (flags.interface) "true" else "false");
            try o.text(", sealed: ");
            try o.text(if (flags.sealed) "true" else "false");
            try o.text(", protectedNs: ");
            try o.uint(abc.instanceProtectedNs[i]);
            try o.text(",\n      instance: ");
            const instance = domain.classTraits.get(classStart + i).index();
            try self.traits(instance);
            try o.text(",\n      static: ");
            try self.traits(domain.classStatic.get(classStart + i).index());
            try o.text(",\n      init: F[");
            try o.uint(abc.instanceInit[i]);
            try o.text("], cinit: F[");
            try o.uint(abc.classInit[i]);
            try o.text("]");
            if (!flags.interface) {
                try self.aliases(instance);
            }

            const ctor = domain.methodStart.get(self.index) + abc.instanceInit[i];
            if (try domain.traits.sign(domain, ctor) == 0 and domain.traits.paramCount.get(ctor) > 0) {
                try o.text(", ctor: [");
                try self.signature(ctor, false);
                try o.text("]");
            }

            const trait = self.classTrait(i);
            if (trait >= 0 and abc.traitMetadataStart[@intCast(trait)] != abc.traitMetadataStart[@as(u32, @intCast(trait)) + 1]) {
                try o.text(", meta: ");
                try self.metadataOf(@intCast(trait));
            }

            try o.text(" }");
        }
    }

    /// Instance traits t's `aliases`, where it needs any: for each method of
    /// the interfaces it implements, the name calls through the interface use
    /// and the dispatch id t binds it to (module.ts tells which are left out).
    fn aliases(self: *ModuleEmitter, t: u32) Error!void {
        const o = self.out();
        const gpa = self.methods.gpa;
        const domain = self.domain;
        const table = &domain.traits;
        if (try table.resolve(domain, t) != 0) {
            return;
        }

        const base = table.base.get(t);
        const dispatch = table.dispatchStart.get(t);
        const baseDispatch = if (base != .none) table.dispatchStart.get(base.index()) else 0;
        const baseMethods: u32 = if (base != .none) table.methodCount.get(base.index()) else 0;
        const all = try table.allInterfaces(gpa, t);
        const baseAll = if (base != .none) try table.allInterfaces(gpa, base.index()) else all;
        const written = &self.aliasMembers;
        written.clearRetainingCapacity();
        for (all) |ifc| {
            const inherited = base != .none and std.mem.indexOfScalar(u32, baseAll, ifc) != null;
            const last = table.memberEnd.get(ifc);
            var m = table.memberStart.get(ifc);
            while (m < last) : (m += 1) {
                const ns = table.memberNs.get(m);
                if (table.memberBinding.get(m).kind != .method or domain.nsType.get(ns) == .private) {
                    continue;
                }

                const name = table.memberName.get(m);
                const version = table.memberVersion.get(m);
                const b = table.find(.of(t), ns, name, version);
                if (b.kind != .method) {
                    continue;
                }

                const d = b.index();
                if (inherited and
                    table.findFrom(base, ns, name, version) == b and
                    d < baseMethods and
                    table.dispatch.get(dispatch + d) == table.dispatch.get(baseDispatch + d))
                {
                    continue;
                }

                if (self.aliasWritten(ns, name)) {
                    continue;
                }

                try o.text(if (written.items.len != 0) ", " else ", aliases: [");
                try written.append(gpa, m);
                try refs.interfaceAlias(o, domain, ns, name);
                try o.text(", ");
                try o.uint(d);
            }
        }

        if (written.items.len != 0) {
            try o.text("]");
        }
    }

    /// Whether aliases() wrote the alias of `name` in `ns` for the class already, through another interface.
    fn aliasWritten(self: *ModuleEmitter, ns: u32, name: u32) bool {
        const table = &self.domain.traits;
        for (self.aliasMembers.items) |m| {
            if (table.memberNs.get(m) == ns and table.memberName.get(m) == name) {
                return true;
            }
        }

        return false;
    }

    /// The trait of a script of this ABC that defines class i, whose metadata
    /// is the class's, as avmplus has it; -1 for none.
    fn classTrait(self: *ModuleEmitter, i: u32) i32 {
        const domain = self.domain;
        const abc = domain.abcs.get(self.index);
        const table = &domain.traits;
        const scripts_ = domain.scriptTraits.get(self.index);
        for (0..abc.scriptCount()) |s| {
            const t = scripts_[s];
            var k = table.first.get(t);
            while (k < table.end.get(t)) : (k += 1) {
                if (abc.traitTag[k].kind == .class and abc.traitIndex[k] == i) {
                    return @intCast(k);
                }
            }
        }

        return -1;
    }

    /// Each script as { traits, init }.
    fn scripts(self: *ModuleEmitter) Error!void {
        const o = self.out();
        const domain = self.domain;
        const abc = domain.abcs.get(self.index);
        const list = domain.scriptTraits.get(self.index);
        for (0..abc.scriptCount()) |s| {
            try o.text(if (s != 0) ",\n    { traits: " else "\n    { traits: ");
            try self.traits(list[s]);
            try o.text(", init: F[");
            try o.uint(abc.scriptInit[s]);
            try o.text("] }");
        }
    }

    /// Each body's activation traits, or null.
    fn activations(self: *ModuleEmitter) Error!void {
        const o = self.out();
        const bodies = self.domain.bodyTraits.get(self.index);
        for (bodies, 0..) |t, b| {
            try o.text(if (b != 0) ", " else "");
            if (t == .none) {
                try o.text("null");
            } else {
                try self.traits(t.index());
            }
        }
    }
};

/// Whether constant() writes a value of `kind` as a literal, not a namespace the runtime makes.
fn literal(kind: C.Constant) bool {
    return switch (kind) {
        .utf8, .int, .uint, .double, .false, .true, .null => true,
        else => false,
    };
}
