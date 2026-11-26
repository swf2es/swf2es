// Traits laid out as their ABC loads, as avmplus' Traits::verifyBindings
// (assembly/avm2/link/bindings.ts): each member's name bound to a slot or a
// dispatch id, its base's inherited, an override of the kind it overrides,
// and the members of the interfaces a class implements bound in their own
// namespaces too.
const std = @import("std");
const Allocator = std.mem.Allocator;
const C = @import("../abc/constants.zig");
const Domain = @import("domain.zig").Domain;
const traits_ = @import("traits.zig");
const Binding = traits_.Binding;
const BindingKind = traits_.BindingKind;
const TraitsTable = traits_.TraitsTable;

/// As Traits::verifyBindings: bind t's members, whose base traits are
/// already laid out; 0, or the VerifyError.
pub fn layout(traits: *TraitsTable, dom: *Domain, t: u32) Allocator.Error!i32 {
    const gpa = dom.gpa;
    const index = traits.abc.get(t);
    const abc = dom.abcs.get(index);
    const base = traits.base.get(t);
    const baseSlots = if (base >= 0) traits.slotCount.get(@intCast(base)) else 0;
    var methodCount = if (base >= 0) traits.methodCount.get(@intCast(base)) else 0;
    const start = traits.memberTraits.len;
    traits.memberStart.set(t, start);
    traits.memberEnd.set(t, start);

    // A subclass sees its base's protected members in its own protected namespace.
    const protectedNs = traits.protectedNs.get(t);
    if (base >= 0 and protectedNs >= 0 and traits.protectedNs.get(@intCast(base)) >= 0) {
        const b: u32 = @intCast(base);
        const baseNs: u32 = @intCast(traits.protectedNs.get(b));
        const last = traits.memberEnd.get(b);
        var m = traits.memberStart.get(b);
        while (m < last) : (m += 1) {
            if (traits.memberNs.get(m) == baseNs) {
                try traits.add(gpa, t, @intCast(protectedNs), traits.memberName.get(m), traits.memberVersion.get(m), traits.memberBinding.get(m));
            }
        }
    }

    const first = traits.first.get(t);
    const end = traits.end.get(t);
    const nameCount = end - first;
    const early = traits.allowEarlyBinding(t);
    var slotCount = baseSlots;
    var i = first;
    while (i < end) : (i += 1) {
        traits.readName(dom, index, i);
        const nsId = traits.nameNs;
        const nsVersion = traits.nameNsVersion;
        const version = traits.nameVersion;
        const name = traits.nameId;
        const tag = abc.traitTag[i];
        const kind = tag.kind;
        switch (kind) {
            .slot, .constant, .class => {
                // As SlotIdCalcer: explicit ids only where slots may bind early.
                const id = abc.traitId[i];
                var slot: u32 = undefined;
                if (id == 0 or !early) {
                    slotCount +%= 1;
                    slot = slotCount;
                } else {
                    slot = id;
                    if (slotCount < id) {
                        slotCount = id;
                    }
                }

                if (id > nameCount and early) {
                    return C.kCorruptABCError;
                }

                // Slots are final, and cannot override anything else.
                if (slot -% 1 < baseSlots) {
                    return C.kIllegalOverrideError;
                }

                if (traits.own(t, nsId, name, version) != Binding.none) {
                    return C.kCorruptABCError;
                }

                if (traits.isInterface.get(t) != 0) {
                    return C.kIllegalSlotError;
                }

                const bkind: BindingKind = if (kind == .slot) .variable else .constant;
                try traits.add(gpa, t, nsId, name, version, .of(slot -% 1, bkind));
            },
            .method => {
                const baseBinding = overridden(traits, t, nsId, nsVersion, name, tag) orelse return C.kIllegalOverrideError;
                if (baseBinding == Binding.none) {
                    try traits.add(gpa, t, nsId, name, version, .of(methodCount, .method));
                    methodCount +%= 1;
                } else if (baseBinding.kind == .method) {
                    try traits.add(gpa, t, nsId, name, version, baseBinding);
                } else {
                    return C.kCorruptABCError;
                }
            },
            .getter, .setter => {
                // The other accessor of the pair may be defined here already.
                var baseBinding = traits.own(t, nsId, name, version);
                if (baseBinding == Binding.none) {
                    baseBinding = overridden(traits, t, nsId, nsVersion, name, tag) orelse return C.kIllegalOverrideError;
                }

                const us: BindingKind = if (kind == .getter) .get else .set;
                const them: BindingKind = if (kind == .getter) .set else .get;
                if (baseBinding == Binding.none) {
                    try traits.add(gpa, t, nsId, name, version, .of(methodCount, us));
                    methodCount +%= 2;
                } else if (baseBinding.kind.isAccessor()) {
                    try traits.add(gpa, t, nsId, name, version, if (baseBinding.kind == them) .{ .kind = .get_set, .id = baseBinding.id } else baseBinding);
                } else {
                    return C.kCorruptABCError;
                }
            },
            else => {},
        }
    }

    traits.slotCount.set(t, slotCount);
    traits.methodCount.set(t, methodCount);
    if (traits.kind.get(t) == .instance and traits.isInterface.get(t) == 0) {
        try bindInterfaces(traits, dom, t);
    }

    return 0;
}

/// As TraitsBindings::fixOneInterfaceBindings: for each interface t
/// implements that its base does not, a member of the interface that t
/// defines in the public namespace instead is bound in the interface's
/// namespace too.
fn bindInterfaces(traits: *TraitsTable, dom: *Domain, t: u32) Allocator.Error!void {
    const base = traits.base.get(t);
    const all = try traits.allInterfaces(dom.scratch, t);
    const index = traits.abc.get(t);
    const publicNs = dom.publicNamespace();
    const publicVersion = dom.publicVersion(index);
    for (all) |ifc| {
        if (base >= 0 and try traits.subtypeOf(dom.scratch, @intCast(base), ifc)) {
            continue;
        }

        const last = traits.memberEnd.get(ifc);
        var m = traits.memberStart.get(ifc);
        while (m < last) : (m += 1) {
            const ns = traits.memberNs.get(m);
            const name = traits.memberName.get(m);
            const version = traits.memberVersion.get(m);
            const iKind = traits.memberBinding.get(m).kind;
            if (traits_.compatibleKind(iKind, traits.find(@intCast(t), ns, name, version).kind)) {
                continue;
            }

            const p = if (publicNs >= 0) traits.find(@intCast(t), @intCast(publicNs), name, publicVersion) else Binding.none;
            if (traits_.compatibleKind(iKind, p.kind)) {
                try traits.add(dom.gpa, t, ns, name, version, p);
            }
        }
    }
}

/// As Traits::getOverride: the base binding a method or accessor named
/// `name` in `ns` meets, or null if the trait may not meet it that way:
/// overriding something of another kind, or with the override attribute
/// set where nothing is overridden, or not set where something is.
pub fn overridden(traits: *const TraitsTable, t: u32, ns: u32, version: u8, name: u32, tag: C.TraitTag) ?Binding {
    const base = traits.base.get(t);
    var binding = Binding.none;
    if (base >= 0) {
        const protectedNs = traits.protectedNs.get(t);
        const baseProtected = traits.protectedNs.get(@intCast(base));
        const lookup: u32 = if (protectedNs == @as(i32, @bitCast(ns)) and baseProtected >= 0) @intCast(baseProtected) else ns;
        binding = traits.find(base, lookup, name, version);
    }

    const baseKind = binding.kind;
    const kind = tag.kind;
    const desired: BindingKind = if (kind == .method) .method else if (kind == .getter) .get else .set;
    // The base kinds each trait kind may meet.
    const legal = baseKind == .none or (if (kind == .method) baseKind == .method else baseKind.isAccessor());
    if (!legal) {
        return null;
    }

    // Overriding is required exactly where the base has a binding of traits kind.
    const required = baseKind == desired or
        (baseKind == .get_set and (desired == .get or desired == .set));
    if (required != tag.override) {
        return null;
    }

    return binding;
}
