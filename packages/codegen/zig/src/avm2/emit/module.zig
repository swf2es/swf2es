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
const Verifier = code.Verifier;
const domain_ = @import("../link/domain.zig");
const Domain = domain_.Domain;
const method_ = @import("method.zig");
const MethodEmitter = method_.MethodEmitter;
const refs = @import("refs.zig");
const module_functions = @import("module/functions.zig");
const module_traits = @import("module/traits.zig");
const module_classes = @import("module/classes.zig");

/// Where step is in a module: verifying its methods, writing F, writing A, or done.
const PHASE_Verify: u8 = 0;
const PHASE_Methods: u8 = 1;
const PHASE_Tables: u8 = 2;
const PHASE_Done: u8 = 3;

/// The garbage, roughly, in bytes, that writing a byte of a method's entry
/// makes in AssemblyScript, its text included: what step's budget counts,
/// with VERIFY_COST, so that both compilers part a module alike.
pub const EMIT_COST: u64 = 3;

pub fn List(comptime T: type) type {
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
            for (pool.nsSet(i), 0..) |ns, k| {
                if (k > 0) {
                    try o.text(", ");
                }

                try o.uint(ns);
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

    // A factory a method, and the names and errors in it (module/functions.zig).
    const functions = module_functions.functions;
    pub const factory = module_functions.factory;
    pub const units = module_functions.units;
    pub const nativeArity = module_functions.nativeArity;
    pub const verifyError = module_functions.verifyError;
    pub const errorNumbers = module_functions.errorNumbers;
    pub const nativeName = module_functions.nativeName;
    pub const functionName = module_functions.functionName;
    pub const methodName = module_functions.methodName;

    // Traits' layouts, slots' values, signatures and metadata (module/traits.zig).
    pub const traits = module_traits.traits;
    pub const fill = module_traits.fill;
    pub const fillValue = module_traits.fillValue;
    pub const signature = module_traits.signature;
    pub const meta = module_traits.meta;
    pub const metadataOf = module_traits.metadataOf;
    pub const poolString = module_traits.poolString;
    pub const poolIndexOf = module_traits.poolIndexOf;

    // Classes, their aliases, scripts and activations (module/classes.zig).
    const classes = module_classes.classes;
    pub const aliases = module_classes.aliases;
    pub const aliasWritten = module_classes.aliasWritten;
    pub const classTrait = module_classes.classTrait;
    const scripts = module_classes.scripts;
    const activations = module_classes.activations;
};
