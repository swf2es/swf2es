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
const TraitsTable = traits_.TraitsTable;
const BIND_None = traits_.BIND_None;
const BKIND_Get = traits_.BKIND_Get;
const BKIND_GetSet = traits_.BKIND_GetSet;
const BKIND_Method = traits_.BKIND_Method;
const BKIND_Set = traits_.BKIND_Set;

// Which base binding kinds each trait kind may meet (Traits::getOverride).
const LEGAL_Method: u32 = (1 << BIND_None) | (1 << BKIND_Method);
const LEGAL_Accessor: u32 = (1 << BIND_None) | (1 << BKIND_Get) | (1 << BKIND_Set) | (1 << BKIND_GetSet);

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

                if (traits.own(t, nsId, name, version) != BIND_None) {
                    return C.kCorruptABCError;
                }

                if (traits.isInterface.get(t) != 0) {
                    return C.kIllegalSlotError;
                }

                const bkind = if (kind == .slot) traits_.BKIND_Var else traits_.BKIND_Const;
                try traits.add(gpa, t, nsId, name, version, ((slot -% 1) << 3) | bkind);
            },
            .method => {
                const baseBinding = overridden(traits, t, nsId, nsVersion, name, tag);
                if (baseBinding < 0) {
                    return C.kIllegalOverrideError;
                }

                if (baseBinding == BIND_None) {
                    try traits.add(gpa, t, nsId, name, version, (methodCount << 3) | BKIND_Method);
                    methodCount +%= 1;
                } else if ((@as(u32, @intCast(baseBinding)) & 7) == BKIND_Method) {
                    try traits.add(gpa, t, nsId, name, version, @intCast(baseBinding));
                } else {
                    return C.kCorruptABCError;
                }
            },
            .getter, .setter => {
                // The other accessor of the pair may be defined here already.
                var baseBinding: i64 = traits.own(t, nsId, name, version);
                if (baseBinding == BIND_None) {
                    baseBinding = overridden(traits, t, nsId, nsVersion, name, tag);
                    if (baseBinding < 0) {
                        return C.kIllegalOverrideError;
                    }
                }

                const us = if (kind == .getter) BKIND_Get else BKIND_Set;
                const them = if (kind == .getter) BKIND_Set else BKIND_Get;
                const bb: u32 = @truncate(@as(u64, @bitCast(baseBinding)));
                const baseKind = bb & 7;
                if (baseBinding == BIND_None) {
                    try traits.add(gpa, t, nsId, name, version, (methodCount << 3) | us);
                    methodCount +%= 2;
                } else if (baseKind == BKIND_Get or baseKind == BKIND_Set or baseKind == BKIND_GetSet) {
                    const id = bb & ~@as(u32, 7);
                    try traits.add(gpa, t, nsId, name, version, if (baseKind == them) id | BKIND_GetSet else bb);
                } else {
                    return C.kCorruptABCError;
                }
            },
            else => {},
        }
    }

    traits.slotCount.set(t, slotCount);
    traits.methodCount.set(t, methodCount);
    if (traits.kind.get(t) == traits_.TRAITS_Instance and traits.isInterface.get(t) == 0) {
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
            const iKind = traits.memberBinding.get(m) & 7;
            if (traits_.compatibleKind(iKind, traits.find(@intCast(t), ns, name, version) & 7)) {
                continue;
            }

            const p = if (publicNs >= 0) traits.find(@intCast(t), @intCast(publicNs), name, publicVersion) else BIND_None;
            if (traits_.compatibleKind(iKind, p & 7)) {
                try traits.add(dom.gpa, t, ns, name, version, p);
            }
        }
    }
}

/// As Traits::getOverride: the base binding a method or accessor named
/// `name` in `ns` meets, or -1 if the trait may not meet it that way:
/// overriding something of another kind, or with the override attribute
/// set where nothing is overridden, or not set where something is.
pub fn overridden(traits: *const TraitsTable, t: u32, ns: u32, version: u8, name: u32, tag: C.TraitTag) i64 {
    const base = traits.base.get(t);
    var binding = BIND_None;
    if (base >= 0) {
        const protectedNs = traits.protectedNs.get(t);
        const baseProtected = traits.protectedNs.get(@intCast(base));
        const lookup: u32 = if (protectedNs == @as(i32, @bitCast(ns)) and baseProtected >= 0) @intCast(baseProtected) else ns;
        binding = traits.find(base, lookup, name, version);
    }

    const baseKind = binding & 7;
    const kind = tag.kind;
    const desired = if (kind == .method) BKIND_Method else if (kind == .getter) BKIND_Get else BKIND_Set;
    const legal = if (kind == .method) LEGAL_Method else LEGAL_Accessor;
    if ((legal >> @intCast(baseKind)) & 1 == 0) {
        return -1;
    }

    // Overriding is required exactly where the base has a binding of traits kind.
    const required = baseKind == desired or
        (baseKind == BKIND_GetSet and (desired == BKIND_Get or desired == BKIND_Set));
    if (required != tag.override) {
        return -1;
    }

    return binding;
}
