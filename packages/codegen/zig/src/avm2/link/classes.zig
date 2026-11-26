// Linking an ABC's classes, as avmplus' AbcParser::parseInstanceInfos:
// each to its base class and interfaces,
// and the traits of its instances, class objects, scripts and activations
// laid out, their methods bound to them; with the first builtin ABC, the
// classes and types the rules treat specially.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const C = @import("../abc/constants.zig");
const layout = @import("bindings.zig").layout;
const domain_ = @import("domain.zig");
const Domain = domain_.Domain;
const traits_ = @import("traits.zig");
const Scope = traits_.Scope;
const TypeRef = traits_.TypeRef;
const typenames = @import("typenames.zig");
const errors = @import("../abc/errors.zig");
const Diagnostics = errors.Diagnostics;
/// How linking stops: the ABC rejected with a VerifyError, which the
/// Diagnostics holds, or memory run out.
pub const Error = errors.Error;

/// Link ABC `index`'s classes to their bases and interfaces; Error.Verify
/// with the first VerifyError, as avmplus stops at its first throw.
pub fn link(dom: *Domain, index: u32, diag: *Diagnostics) Error!void {
    const gpa = dom.gpa;
    const abc = dom.abcs.get(index);
    const first = dom.classAbc.len;
    try dom.classStart.push(gpa, first);
    for (0..abc.classCount()) |i| {
        try dom.classAbc.push(gpa, index);
        try dom.classInstance.push(gpa, @intCast(i));
        try dom.classBase.push(gpa, -1);
        try dom.classFlags.push(gpa, abc.instanceFlags[i]);
        try dom.classTraits.push(gpa, .none);
        try dom.classStatic.push(gpa, .none);
    }

    const ids = dom.abcNs.get(index);

    for (0..abc.classCount()) |i_| {
        const i: u32 = @intCast(i_);
        const id = first + i;
        const flags = abc.instanceFlags[i];
        const baseName = abc.instanceSuper[i];
        if (baseName != 0) {
            const b = try resolveClass(dom, index, baseName, diag);
            const base: i32 = @intCast(b);
            if (dom.classFlags.get(b).final or
                base == dom.classClass or
                (base == dom.functionClass and !abc.builtin))
            {
                return diag.fail(.kCannotExtendFinalClass);
            }

            if (dom.classFlags.get(b).interface) {
                return diag.fail(.kCannotExtendError);
            }

            dom.classBase.set(id, base);
        }

        const interfaces = dom.traits.interfaceList.len;
        const last = abc.instanceInterfaceStart[i + 1];
        var j = abc.instanceInterfaceStart[i];
        while (j < last) : (j += 1) {
            const t = resolveClass(dom, index, abc.interfaces[j], diag) catch |err| {
                dom.traits.interfaceList.truncate(interfaces);
                return err;
            };
            if (!dom.classFlags.get(t).interface) {
                dom.traits.interfaceList.truncate(interfaces);
                return diag.fail(.kCannotImplementError);
            }

            // As the word it is: an interface not linked yet goes in as none's.
            try dom.traits.interfaceList.push(gpa, @bitCast(@backingInt(dom.classTraits.get(t))));
        }

        if (flags.interface and baseName != 0) {
            return diag.fail(.kCannotExtendError);
        }

        // As avmplus' AvmCore: the first builtin class without a base is Object.
        if (baseName == 0 and abc.builtin and !dom.hasBuiltins and dom.objectClass < 0) {
            dom.objectClass = @intCast(id);
        }

        const base = dom.classBase.get(id);
        const protectedNs: i32 = if (flags.protected_ns) @intCast(ids[abc.instanceProtectedNs[i]]) else -1;
        const t = try dom.traits.create(gpa, .instance, index, i, if (base >= 0) dom.classTraits.get(@intCast(base)) else .none, protectedNs, abc.instanceTraitStart[i], abc.instanceTraitStart[i + 1]);
        dom.traits.isInterface.set(t, if (flags.interface) 1 else 0);
        dom.traits.interfaceStart.set(t, interfaces);
        dom.traits.interfaceEnd.set(t, dom.traits.interfaceList.len);
        dom.classTraits.set(id, .of(t));
        try layout(&dom.traits, dom, t, diag);

        try bindMethods(dom, t, @bitCast(abc.instanceInit[i]), flags.final);

        try typenames.nameInstance(dom, index, i);
    }

    if (abc.builtin) {
        const floatType = dom.builtinType("float");
        if (floatType != .any) {
            dom.floatType = floatType;
        }
    }

    // As AvmCore's first builtin pool: its classes include the special ones.
    if (abc.builtin and !dom.hasBuiltins) {
        dom.hasBuiltins = true;
        dom.classClass = dom.findBuiltin("Class");
        dom.functionClass = dom.findBuiltin("Function");
        dom.voidClass = @intCast(dom.classAbc.len);
        try dom.classAbc.push(gpa, index);
        try dom.classInstance.push(gpa, 0xffffffff);
        try dom.classBase.push(gpa, -1);
        try dom.classFlags.push(gpa, .{ .final = true });
        const void_ = try dom.traits.create(gpa, .void, index, 0, .none, -1, 0, 0);
        dom.voidType = .of(void_);
        dom.nullType = .of(try dom.traits.create(gpa, .null, index, 0, .none, -1, 0, 0));
        try dom.classTraits.push(gpa, .of(void_));
        try dom.classStatic.push(gpa, .none);
        findBuiltinTypes(dom);
        const empty = try dom.internNamespace(.public, try dom.internText(""));
        try typenames.nameType(dom, empty, try dom.internText("void"), domain_.API_AllVersions, dom.voidClass, -1, 0);
        dom.transientName = try dom.internText("Transient");
        dom.versionName = try dom.internText("Version");
        dom.nativeName = try dom.internText("native");
        dom.apiName = try dom.internText("API");
    }

    try layoutStatics(dom, index, diag);
    try layoutScripts(dom, index, diag);
    try layoutActivations(dom, index, diag);
}

/// Lay out each class object's traits, whose base is Class.
fn layoutStatics(dom: *Domain, index: u32, diag: *Diagnostics) Error!void {
    const abc = dom.abcs.get(index);
    const first = dom.classStart.get(index);
    const classTraits = if (dom.classClass >= 0) dom.classTraits.get(@intCast(dom.classClass)) else .none;
    for (0..abc.classCount()) |i_| {
        const i: u32 = @intCast(i_);
        const t = try dom.traits.create(dom.gpa, .class, index, i, classTraits, dom.traits.protectedNs.get(dom.classTraits.get(first + i).index()), abc.classTraitStart[i], abc.classTraitStart[i + 1]);
        dom.classStatic.set(first + i, .of(t));
        try layout(&dom.traits, dom, t, diag);

        try bindMethods(dom, t, @bitCast(abc.classInit[i]), false);
    }
}

/// Lay out each script's global object traits, whose base is Object.
fn layoutScripts(dom: *Domain, index: u32, diag: *Diagnostics) Error!void {
    const gpa = dom.gpa;
    const abc = dom.abcs.get(index);
    const objectTraits = if (dom.objectClass >= 0) dom.classTraits.get(@intCast(dom.objectClass)) else .none;
    const scripts = try memory.allocZeroed(gpa, u32, abc.scriptCount());
    try dom.scriptTraits.push(gpa, scripts);
    for (0..abc.scriptCount()) |s_| {
        const s: u32 = @intCast(s_);
        const t = try dom.traits.create(gpa, .script, index, s, objectTraits, -1, abc.scriptTraitStart[s], abc.scriptTraitStart[s + 1]);
        scripts[s] = t;
        const scope = try gpa.create(Scope);
        scope.* = .{};
        dom.traits.scope.set(t, scope);
        try layout(&dom.traits, dom, t, diag);

        try bindMethods(dom, t, @bitCast(abc.scriptInit[s]), false);
    }
}

/// A base class's or an interface's class: resolveType, void rejected.
fn resolveClass(dom: *const Domain, index: u32, multiname: u32, diag: *Diagnostics) errors.Rejected!u32 {
    return typenames.resolveType(dom, index, multiname, diag) catch |err| switch (err) {
        error.Void => diag.fail(.kIllegalVoidError),
        error.Verify => error.Verify,
    };
}

/// Lay out activation traits, for bodies that need an activation or declare traits.
fn layoutActivations(dom: *Domain, index: u32, diag: *Diagnostics) Error!void {
    const gpa = dom.gpa;
    const abc = dom.abcs.get(index);
    const bodies = try gpa.alloc(TypeRef, abc.bodyCount());
    for (0..abc.bodyCount()) |b_| {
        const b: u32 = @intCast(b_);
        const first = abc.bodyTraitStart[b];
        const end = abc.bodyTraitStart[b + 1];
        const flags = abc.methodFlags[abc.bodyMethod[b]];
        bodies[b] = .none;
        if (flags.need_activation or end > first) {
            const t = try dom.traits.create(gpa, .activation, index, b, .none, -1, first, end);
            bodies[b] = .of(t);
            try layout(&dom.traits, dom, t, diag);

            try bindMethods(dom, t, -1, false);
        }
    }

    try dom.bodyTraits.push(gpa, bodies);
}

/// As MethodInfo::makeMethodOf, after t's members bind: its methods,
/// getters, setters and `init` (-1 for none) become t's; `final` for a
/// final class, whose methods are all final.
fn bindMethods(dom: *Domain, t: u32, init: i32, final: bool) Allocator.Error!void {
    const traits = &dom.traits;
    const index = traits.abc.get(t);
    const abc = dom.abcs.get(index);
    const methods = dom.methodStart.get(index);
    var i = traits.first.get(t);
    while (i < traits.end.get(t)) : (i += 1) {
        const tag = abc.traitTag[i];
        const kind = tag.kind;
        if (kind.bindsMethod()) {
            // A method of this ABC's, whose rows its link added.
            const m = methods + abc.traitIndex[i];
            traits.methodTraits.set(m, .of(t));
            traits.methodVirtual.set(m, 1);
            traits.methodFinal.set(m, if (tag.final or final) 1 else 0);
        }
    }

    if (init >= 0) {
        const m = methods + @as(u32, @intCast(init));
        traits.methodTraits.set(m, .of(t));
        traits.init.set(t, @intCast(m));
    }
}

/// The types AvmCore's builtin traits hold, from the first builtin ABC.
fn findBuiltinTypes(dom: *Domain) void {
    dom.numberType = dom.builtinType("Number");
    dom.intType = dom.builtinType("int");
    dom.uintType = dom.builtinType("uint");
    dom.booleanType = dom.builtinType("Boolean");
    dom.stringType = dom.builtinType("String");
    dom.namespaceType = dom.builtinType("Namespace");
    dom.xmlType = dom.builtinType("XML");
    dom.xmlListType = dom.builtinType("XMLList");
    dom.qnameType = dom.builtinType("QName");
    dom.classType = dom.builtinType("Class");
    dom.vectorClass = dom.findBuiltin("Vector");
    dom.vectorObjectType = dom.builtinType("Vector$object");
    dom.vectorIntType = dom.builtinType("Vector$int");
    dom.vectorUintType = dom.builtinType("Vector$uint");
    dom.vectorDoubleType = dom.builtinType("Vector$double");
    dom.arrayType = dom.builtinType("Array");
    dom.functionType = dom.builtinType("Function");
    const math = dom.findBuiltin("Math");
    // * where Math is absent or not linked yet, as the builtin type fields hold it.
    dom.mathStatic = if (math < 0) .any else dom.classStatic.get(@intCast(math)).orAny();
    dom.builtinAbc = @intCast(dom.abcs.len - 1);
}
