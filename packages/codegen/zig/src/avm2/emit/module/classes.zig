// A ModuleEmitter's (module.zig) classes, with the aliases their traits are
// also found by, its scripts and activations. Its methods, written here and
// named in it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const refs = @import("../refs.zig");
const module_ = @import("../module.zig");
const ModuleEmitter = module_.ModuleEmitter;

/// Each class as { name, base, interfaces, final, interface, protectedNs,
/// instance, static, init, cinit }, names as indices into M.
pub fn classes(self: *ModuleEmitter) Error!void {
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
        if (try domain.traits.signs(domain, ctor) and domain.traits.paramCount.get(ctor) > 0) {
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
pub fn aliases(self: *ModuleEmitter, t: u32) Error!void {
    const o = self.out();
    const gpa = self.methods.gpa;
    const domain = self.domain;
    const table = &domain.traits;
    if (!try table.resolves(domain, t)) {
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
pub fn aliasWritten(self: *ModuleEmitter, ns: u32, name: u32) bool {
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
pub fn classTrait(self: *ModuleEmitter, i: u32) i32 {
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
pub fn scripts(self: *ModuleEmitter) Error!void {
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
pub fn activations(self: *ModuleEmitter) Error!void {
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
