// Linking an ABC's classes, as avmplus' AbcParser::parseInstanceInfos
// (assembly/avm2/link/classes.ts): each to its base class and interfaces,
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
const typenames = @import("typenames.zig");

/// Link ABC `index`'s classes to their bases and interfaces; false after recording the error.
pub fn link(dom: *Domain, index: u32) Allocator.Error!bool {
    const gpa = dom.gpa;
    const abc = dom.abcs.get(index);
    const first = dom.classAbc.len;
    try dom.classStart.push(gpa, first);
    for (0..abc.classCount()) |i| {
        try dom.classAbc.push(gpa, index);
        try dom.classInstance.push(gpa, @intCast(i));
        try dom.classBase.push(gpa, -1);
        try dom.classFlags.push(gpa, abc.instanceFlags[i]);
        try dom.classTraits.push(gpa, -1);
        try dom.classStatic.push(gpa, -1);
    }

    const ids = dom.abcNs.get(index);

    for (0..abc.classCount()) |i_| {
        const i: u32 = @intCast(i_);
        const id = first + i;
        const flags = abc.instanceFlags[i];
        const baseName = abc.instanceSuper[i];
        if (baseName != 0) {
            const base = typenames.resolveType(dom, index, baseName);
            if (base < 0) {
                return abc.fail(-base);
            }

            const b: u32 = @intCast(base);
            if (dom.classFlags.get(b) & C.INSTANCE_Final != 0 or
                base == dom.classClass or
                (base == dom.functionClass and !abc.builtin))
            {
                return abc.fail(C.kCannotExtendFinalClass);
            }

            if (dom.classFlags.get(b) & C.INSTANCE_Interface != 0) {
                return abc.fail(C.kCannotExtendError);
            }

            dom.classBase.set(id, base);
        }

        const interfaces = dom.traits.interfaceList.len;
        const last = abc.instanceInterfaceStart[i + 1];
        var j = abc.instanceInterfaceStart[i];
        while (j < last) : (j += 1) {
            const t = typenames.resolveType(dom, index, abc.interfaces.get(j));
            if (t < 0) {
                dom.traits.interfaceList.truncate(interfaces);
                return abc.fail(-t);
            }

            if (dom.classFlags.get(@intCast(t)) & C.INSTANCE_Interface == 0) {
                dom.traits.interfaceList.truncate(interfaces);
                return abc.fail(C.kCannotImplementError);
            }

            try dom.traits.interfaceList.push(gpa, @bitCast(dom.classTraits.get(@intCast(t))));
        }

        if (flags & C.INSTANCE_Interface != 0 and baseName != 0) {
            return abc.fail(C.kCannotExtendError);
        }

        // As avmplus' AvmCore: the first builtin class without a base is Object.
        if (baseName == 0 and abc.builtin and !dom.hasBuiltins and dom.objectClass < 0) {
            dom.objectClass = @intCast(id);
        }

        const base = dom.classBase.get(id);
        const protectedNs: i32 = if (flags & C.INSTANCE_ProtectedNs != 0) @intCast(ids[abc.instanceProtectedNs[i]]) else -1;
        const t = try dom.traits.create(gpa, traits_.TRAITS_Instance, index, i, if (base >= 0) dom.classTraits.get(@intCast(base)) else -1, protectedNs, abc.instanceTraitStart[i], abc.instanceTraitStart[i + 1]);
        dom.traits.isInterface.set(t, if (flags & C.INSTANCE_Interface != 0) 1 else 0);
        dom.traits.interfaceStart.set(t, interfaces);
        dom.traits.interfaceEnd.set(t, dom.traits.interfaceList.len);
        dom.classTraits.set(id, @intCast(t));
        const err = try layout(&dom.traits, dom, t);
        if (err != 0) {
            return abc.fail(err);
        }

        try bindMethods(dom, t, @bitCast(abc.instanceInit[i]), (flags & C.INSTANCE_Final) != 0);

        try typenames.nameInstance(dom, index, i);
    }

    if (abc.builtin) {
        const floatType = dom.builtinType("float");
        if (floatType >= 0) {
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
        try dom.classFlags.push(gpa, C.INSTANCE_Final);
        dom.voidType = @intCast(try dom.traits.create(gpa, traits_.TRAITS_Void, index, 0, -1, -1, 0, 0));
        dom.nullType = @intCast(try dom.traits.create(gpa, traits_.TRAITS_Null, index, 0, -1, -1, 0, 0));
        try dom.classTraits.push(gpa, dom.voidType);
        try dom.classStatic.push(gpa, -1);
        findBuiltinTypes(dom);
        const empty = try dom.internNamespace(domain_.NS_Public, try dom.internText(""));
        try typenames.nameType(dom, empty, try dom.internText("void"), domain_.API_AllVersions, dom.voidClass, -1, 0);
        dom.transientName = try dom.internText("Transient");
        dom.versionName = try dom.internText("Version");
        dom.nativeName = try dom.internText("native");
        dom.apiName = try dom.internText("API");
    }

    return try layoutStatics(dom, index) and try layoutScripts(dom, index) and try layoutActivations(dom, index);
}

/// Lay out each class object's traits, whose base is Class.
fn layoutStatics(dom: *Domain, index: u32) Allocator.Error!bool {
    const abc = dom.abcs.get(index);
    const first = dom.classStart.get(index);
    const classTraits = if (dom.classClass >= 0) dom.classTraits.get(@intCast(dom.classClass)) else -1;
    for (0..abc.classCount()) |i_| {
        const i: u32 = @intCast(i_);
        const t = try dom.traits.create(dom.gpa, traits_.TRAITS_Class, index, i, classTraits, dom.traits.protectedNs.get(@intCast(dom.classTraits.get(first + i))), abc.classTraitStart[i], abc.classTraitStart[i + 1]);
        dom.classStatic.set(first + i, @intCast(t));
        const err = try layout(&dom.traits, dom, t);
        if (err != 0) {
            return abc.fail(err);
        }

        try bindMethods(dom, t, @bitCast(abc.classInit[i]), false);
    }

    return true;
}

/// Lay out each script's global object traits, whose base is Object.
fn layoutScripts(dom: *Domain, index: u32) Allocator.Error!bool {
    const gpa = dom.gpa;
    const abc = dom.abcs.get(index);
    const objectTraits = if (dom.objectClass >= 0) dom.classTraits.get(@intCast(dom.objectClass)) else -1;
    const scripts = try memory.allocZeroed(gpa, u32, abc.scriptCount());
    try dom.scriptTraits.push(gpa, scripts);
    for (0..abc.scriptCount()) |s_| {
        const s: u32 = @intCast(s_);
        const t = try dom.traits.create(gpa, traits_.TRAITS_Script, index, s, objectTraits, -1, abc.scriptTraitStart[s], abc.scriptTraitStart[s + 1]);
        scripts[s] = t;
        const scope = try gpa.create(Scope);
        scope.* = .{};
        dom.traits.scope.set(t, scope);
        const err = try layout(&dom.traits, dom, t);
        if (err != 0) {
            return abc.fail(err);
        }

        try bindMethods(dom, t, @bitCast(abc.scriptInit[s]), false);
    }

    return true;
}

/// Lay out activation traits, for bodies that need an activation or declare traits.
fn layoutActivations(dom: *Domain, index: u32) Allocator.Error!bool {
    const gpa = dom.gpa;
    const abc = dom.abcs.get(index);
    const bodies = try memory.allocZeroed(gpa, i32, abc.bodyCount());
    for (0..abc.bodyCount()) |b_| {
        const b: u32 = @intCast(b_);
        const first = abc.bodyTraitStart.get(b);
        const end = abc.bodyTraitStart.get(b + 1);
        const flags = abc.methodFlags[abc.bodyMethod.get(b)];
        bodies[b] = -1;
        if (flags & C.METHOD_NeedActivation != 0 or end > first) {
            const t = try dom.traits.create(gpa, traits_.TRAITS_Activation, index, b, -1, -1, first, end);
            bodies[b] = @intCast(t);
            const err = try layout(&dom.traits, dom, t);
            if (err != 0) {
                return abc.fail(err);
            }

            try bindMethods(dom, t, -1, false);
        }
    }

    try dom.bodyTraits.push(gpa, bodies);
    return true;
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
        const tag = abc.traitTag.get(i);
        const kind = tag & 0x0f;
        if (kind == C.TRAIT_Method or kind == C.TRAIT_Getter or kind == C.TRAIT_Setter) {
            // A method of this ABC's, whose rows its link added.
            const m = methods + abc.traitIndex.get(i);
            traits.methodTraits.set(m, @intCast(t));
            traits.methodVirtual.set(m, 1);
            traits.methodFinal.set(m, if (tag & C.ATTR_Final != 0 or final) 1 else 0);
        }
    }

    if (init >= 0) {
        const m = methods + @as(u32, @intCast(init));
        traits.methodTraits.set(m, @intCast(t));
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
    dom.mathStatic = if (math < 0) -1 else dom.classStatic.get(@intCast(math));
    dom.builtinAbc = @intCast(dom.abcs.len - 1);
}
