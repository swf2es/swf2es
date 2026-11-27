// Scopes and calls, as the method emitter writes them (objects.zig's
// object, and assembly/avm2/emit/objects.ts, whose comments tell each
// case's why): the scope chain a function or getscopeobject reads, and
// constructing, calling through an interface or a dispatch id, and the
// arguments.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const traits_ = @import("../../link/traits.zig");
const TypeId = traits_.TypeId;
const method_ = @import("../method.zig");
const MethodEmitter = method_.MethodEmitter;
const hasBoundEntry = method_.hasBoundEntry;
const refs = @import("../refs.zig");
const values = @import("../values.zig");
const objects = @import("../objects.zig");
const properties = @import("properties.zig");
const u = objects.u;
const stringMethod = properties.stringMethod;
const receiver = properties.receiver;

/// The method's global object: its scope chain's first, else its own first scope.
pub fn globalScope(em: *MethodEmitter) Error!void {
    if (em.ir.outerSize > 0) {
        try em.out.text("scope[0]");
        em.usesScope = true;
    } else {
        try em.reg(@intCast(em.ir.localCount));
    }
}

/// The scopes pushed so far, innermost last: [sc0, ...], with their with flags.
pub fn localScopes(em: *MethodEmitter) Error!void {
    const out = &em.out;
    try out.text("[");
    var withs: u32 = 0;
    for (0..em.scopeDepth) |d| {
        if (d != 0) {
            try out.text(", ");
        }

        try em.reg(@intCast(em.ir.localCount + d));
        // As AssemblyScript's u32 shift, whose count wraps at 32.
        withs |= @as(u32, em.scopeWith[d]) << @truncate(d);
    }

    try out.text("], ");
    try out.uint(withs);
}

/// The scope chain function `m` of the ABC, created here, runs in; for a
/// contested function, packed as it was compiled (Scope.merged).
pub fn functionScope(em: *MethodEmitter, m: u32) Error!void {
    const traits = &em.domain.traits;
    const g = em.domain.methodStart.get(em.index) + m;
    const merged = if (traits.functionContested.get(g) != 0) traits.functionMerged.get(g) else null;
    if (merged == null or merged.?.pack < 0) {
        return scopeHere(em);
    }

    try em.out.text("rt.packScope(");
    try scopeHere(em);
    try em.out.text(", ");
    try em.out.uint(@intCast(merged.?.pack));
    try em.out.text(")");
}

/// The scope chain a function or class created here runs in.
pub fn scopeHere(em: *MethodEmitter) Error!void {
    try em.out.text("rt.scope(scope, ");
    em.usesScope = true;
    try localScopes(em);
    try em.out.text(")");
}

/// `new` of what slot `slot` of register `src` holds, with `argc`
/// arguments after it: in place where the runtime marked the class as one
/// constructClass would only allocate and initialize (`$new`); anything
/// else by rt.construct (objects.ts tells why).
pub fn constructSlot(em: *MethodEmitter, src: i32, slot: u32, argc: u32, ctraits: TypeId) Error!void {
    const out = &em.out;
    em.constructsInPlace = true;
    try out.text("($c = ");
    try em.member(src);
    try refs.slotMember(out, slot);
    try out.text(")?.$new === true ? ($o = $c.$it.instance(), $c.$it.proto.");
    const init = boundConstructor(em, ctraits, argc);
    if (init >= 0) {
        // As avmplus' JIT, which coerces a known constructor's arguments at
        // the call site and calls it: its entry for bound calls.
        try out.text("$binit.call($o");
        const traits = &em.domain.traits;
        const start = traits.paramStart.get(@intCast(init));
        for (0..argc) |k| {
            const r = src + 1 + @as(i32, @intCast(k));
            try out.text(", ");
            try values.convert(em, "", r, traits.paramType.get(start + @as(u32, @intCast(k))), em.regType[u(r)], false);
        }
    } else {
        try out.text("$init.call($o");
        try args(em, src + 1, argc);
    }

    // A slot still empty is a null constructor: avmplus' JIT, which binds a
    // known constructor that takes the count, checks it first (1009); its
    // interpreter, which runs static initializers, constructs late (1007).
    try out.text(if (!em.staticInit and knownConstructor(em, ctraits, argc) >= 0)
        "), $o) : rt.construct($c ?? nn($c)"
    else
        "), $o) : rt.construct($c");
    try args(em, src + 1, argc);
    try out.text(")");
}

/// How `super()` calls the constructor of `base`: by its entry for bound
/// calls, if it has one.
pub fn superEntry(em: *MethodEmitter, base: TypeId) []const u8 {
    const init = if (base.isTraits()) em.domain.traits.init.get(base.index()) else -1;
    return if (init >= 0 and hasBoundEntry(em, @intCast(init)))
        "sup.$it.proto.$binit.call("
    else
        "sup.$it.proto.$init.call(";
}

/// The instance initializer of the class whose class traits are
/// `ctraits`, where `new` of it with `argc` arguments can call its entry
/// for bound calls with them coerced; else -1.
fn boundConstructor(em: *MethodEmitter, ctraits: TypeId, argc: u32) i32 {
    const init = knownConstructor(em, ctraits, argc);
    return if (init >= 0 and hasBoundEntry(em, @intCast(init))) init else -1;
}

/// The instance initializer, domain-wide, of the class whose class traits
/// are `ctraits`, where avmplus' JIT binds `new` of it with `argc`
/// arguments; else -1.
fn knownConstructor(em: *MethodEmitter, ctraits: TypeId, argc: u32) i32 {
    const domain = em.domain;
    const traits = &domain.traits;
    const itraits = domain.instanceTraitsOf(ctraits);
    const init = if (itraits.isTraits()) traits.init.get(itraits.index()) else -1;
    if (init < 0 or traits.signed.get(@intCast(init)) == 0) {
        return -1;
    }

    const m: u32 = @intCast(init);
    const count = traits.paramCount.get(m);
    const required = count -% traits.optionalCount.get(m);
    return if (argc >= required and (argc <= count or domain.allowsExtraArgs(m))) init else -1;
}

/// A call of an interface's method, dispatch id `disp` in its layout, on
/// the receiver in `src` with `argc` arguments, by the alias every class
/// implementing the interface has of it (objects.ts tells why).
pub fn interfaceCall(em: *MethodEmitter, disp: u32, src: i32, argc: u32) Error!void {
    const out = &em.out;
    const domain = em.domain;
    const ifc = em.regType[u(src)];
    const m = refs.aliasedMember(domain, ifc.index(), disp);
    try em.member(src);
    if (m >= 0) {
        try out.text("[");
        try refs.interfaceAlias(out, domain, domain.traits.memberNs.get(@intCast(m)), domain.traits.memberName.get(@intCast(m)));
        try out.text("](");
    } else {
        try out.text("[rt.interfaceKey(");
        try refs.typeRef(em, ifc);
        try out.text(", ");
        try out.uint(disp);
        try out.text(", ");
        try em.read(src);
        try out.text(")](");
    }

    try list(em, src + 1, argc);
    try out.text(")");
}

/// `, r, r+1, ...` for `count` arguments from register `from`.
pub fn args(em: *MethodEmitter, from: i32, count: u32) Error!void {
    for (0..count) |k| {
        try em.out.text(", ");
        try em.reg(from + @as(i32, @intCast(k)));
    }
}

pub fn list(em: *MethodEmitter, from: i32, count: u32) Error!void {
    for (0..count) |k| {
        if (k != 0) {
            try em.out.text(", ");
        }

        try em.reg(from + @as(i32, @intCast(k)));
    }
}

/// A call by dispatch id `disp` on the receiver in `src`, with `argc`
/// arguments after it, which the verifier bound to method `m` (-1 for
/// none): a method of the receiver's prototype, or for a primitive
/// receiver, or a namespace, of its class's (objects.ts tells why).
pub fn virtual(em: *MethodEmitter, disp: u32, src: i32, argc: u32, m: i32) Error!void {
    const out = &em.out;
    const ty = em.regType[u(src)];
    // XML's methods look names up in the default XML namespace.
    if (ty == em.domain.xmlType or ty == em.domain.xmlListType) {
        em.seesDxns = true;
    }

    const bt = em.builtinOf(src);
    const primitive = switch (bt) {
        .int,
        .uint,
        .number,
        .float,
        .boolean,
        .string,
        .namespace,
        => true,
        else => false,
    };
    if (primitive) {
        const own = if (bt == .string) stringMethod(em, ty, disp, src, argc) else "";
        if (own.len > 0) {
            try receiver(em, src);
            try out.text(own);
            if (argc != 0) {
                try em.reg(src + 1);
            } else {
                try out.text("0");
            }

            try out.text(")");
            return;
        }

        // The method is kept from the first call on: its class's prototype
        // has it for good once the class is set up.
        try out.text("(T[");
        try out.uint(try em.methodSlot(ty, disp));
        try out.text("] ??= rt.prototypeOf(");
        try refs.typeRef(em, ty);
        try out.text(").$m");
        try out.uint(disp);
        try out.text(").call(");
        try em.reg(src);
        try args(em, src + 1, argc);
        try out.text(")");
        return;
    }

    // An Object may be a primitive, or a Namespace, whose methods are its
    // class prototype's; any other object has its own.
    if (bt == .object) {
        try out.text("(");
        try em.member(src);
        try out.text(".$m");
        try out.uint(disp);
        try out.text(" ?? rt.prototypeOf(");
        try refs.typeRef(em, ty);
        try out.text(").$m");
        try out.uint(disp);
        try out.text(").call(");
        try em.reg(src);
        try args(em, src + 1, argc);
        try out.text(")");
        return;
    }

    try em.member(src);
    try out.text(if (m >= 0 and hasBoundEntry(em, @intCast(m))) ".$b" else ".$m");
    try out.uint(disp);
    try out.text("(");
    try list(em, src + 1, argc);
    try out.text(")");
}
