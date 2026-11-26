// What traits resolve when first used, as avmplus' Traits::resolveSignatures
// does after their supertypes (assembly/avm2/link/signatures.ts): each slot's
// type and each dispatch id's method, the slots' initial values checked
// against their types, and the overrides and implemented interfaces checked
// against the signatures they meet.
const std = @import("std");
const Allocator = std.mem.Allocator;
const C = @import("../abc/constants.zig");
const overridden = @import("bindings.zig").overridden;
const Domain = @import("domain.zig").Domain;
const traits_ = @import("traits.zig");
const TraitsTable = traits_.TraitsTable;
const TYPE_Any = traits_.TYPE_Any;
const resolveTypeId = @import("typenames.zig").resolveTypeId;

fn hasGetter(binding: u32) bool {
    const kind = binding & 7;
    return kind == traits_.BKIND_Get or kind == traits_.BKIND_GetSet;
}

fn hasSetter(binding: u32) bool {
    const kind = binding & 7;
    return kind == traits_.BKIND_Set or kind == traits_.BKIND_GetSet;
}

/// As Traits::finishSlotsAndMethods: each slot's type, and each method's
/// dispatch id; an overridden method must not be final.
pub fn resolveSlotsAndMethods(traits: *TraitsTable, dom: *Domain, t: u32) Allocator.Error!i32 {
    const gpa = dom.gpa;
    const index = traits.abc.get(t);
    const abc = dom.abcs.get(index);
    const base = traits.base.get(t);
    const slotCount = traits.slotCount.get(t);
    const slots = traits.slotType.len;
    try dom.put(traits.slotStart.at(t), slots);
    for (0..slotCount) |_| {
        try traits.slotType.push(gpa, TYPE_Any);
        try traits.slotSet.push(gpa, 0);
    }

    const methodCount = traits.methodCount.get(t);
    const dispatch = traits.dispatch.len;
    try dom.put(traits.dispatchStart.at(t), dispatch);
    for (0..methodCount) |_| {
        try traits.dispatch.push(gpa, -1);
    }

    var baseSlots: u32 = 0;
    if (base >= 0) {
        const b: u32 = @intCast(base);
        baseSlots = traits.slotCount.get(b);
        const from = traits.slotStart.get(b);
        for (0..baseSlots) |s_| {
            const s: u32 = @intCast(s_);
            traits.slotType.set(slots + s, traits.slotType.get(from + s));
            traits.slotSet.set(slots + s, 1);
        }

        const baseMethods = traits.methodCount.get(b);
        const fromDispatch = traits.dispatchStart.get(b);
        for (0..baseMethods) |d_| {
            const d: u32 = @intCast(d_);
            traits.dispatch.set(dispatch + d, traits.dispatch.get(fromDispatch + d));
        }
    }

    const methods = dom.methodStart.get(index);
    const early = traits.allowEarlyBinding(t);
    var next = baseSlots;
    var i = traits.first.get(t);
    while (i < traits.end.get(t)) : (i += 1) {
        const tag = abc.traitTag[i];
        const kind = tag & 0x0f;
        if (kind == C.TRAIT_Slot or kind == C.TRAIT_Const or kind == C.TRAIT_Class) {
            const id = abc.traitId[i];
            var slot: u32 = undefined;
            if (id == 0 or !early) {
                next +%= 1;
                slot = next;
            } else {
                slot = id;
                if (next < id) {
                    next = id;
                }
            }

            // A slot defined twice would give one memory location two types.
            slot -%= 1;
            if (slot >= slotCount or traits.slotSet.get(slots + slot) != 0) {
                return C.kCorruptABCError;
            }

            var ty: i32 = undefined;
            if (kind == C.TRAIT_Class) {
                ty = dom.classStatic.get(dom.classStart.get(index) + abc.traitIndex[i]);
            } else {
                ty = try resolveTypeId(dom, index, abc.traitIndex[i], false);
                if (ty < TYPE_Any) {
                    return dom.typeError;
                }
            }

            traits.slotType.set(slots + slot, ty);
            traits.slotSet.set(slots + slot, 1);
        } else if (kind == C.TRAIT_Method or kind == C.TRAIT_Getter or kind == C.TRAIT_Setter) {
            traits.readName(dom, index, i);
            const b = traits.own(t, traits.nameNs, traits.nameId, traits.nameVersion);
            if (b == traits_.BIND_None) {
                continue;
            }

            const d = (b >> 3) + @intFromBool(kind == C.TRAIT_Setter);
            const baseBinding = overridden(traits, t, traits.nameNs, traits.nameNsVersion, traits.nameId, tag);
            if (baseBinding > 0) {
                const bb: u32 = @intCast(baseBinding);
                if ((bb & 7) == traits_.BKIND_Method or
                    (hasGetter(bb) and kind == C.TRAIT_Getter) or
                    (hasSetter(bb) and kind == C.TRAIT_Setter))
                {
                    const virt = traits.dispatch.get(traits.dispatchStart.get(@intCast(base)) + d);
                    if (virt >= 0 and traits.methodFinal.get(@intCast(virt)) != 0) {
                        return C.kIllegalOverrideError;
                    }
                }
            }

            traits.dispatch.set(dispatch + d, @intCast(methods + abc.traitIndex[i]));
        }
    }

    return 0;
}

/// As Traits::genInitBody: every slot's initial value must suit its type.
pub fn checkInitialValues(traits: *const TraitsTable, dom: *const Domain, t: u32) i32 {
    const index = traits.abc.get(t);
    const abc = dom.abcs.get(index);
    const early = traits.allowEarlyBinding(t);
    const base = traits.base.get(t);
    const slots = traits.slotStart.get(t);
    var next = if (base >= 0) traits.slotCount.get(@intCast(base)) else 0;
    var i = traits.first.get(t);
    while (i < traits.end.get(t)) : (i += 1) {
        const kind = abc.traitTag[i] & 0x0f;
        if (kind != C.TRAIT_Slot and kind != C.TRAIT_Const and kind != C.TRAIT_Class) {
            continue;
        }

        const id = abc.traitId[i];
        var slot: u32 = undefined;
        if (id == 0 or !early) {
            next +%= 1;
            slot = next;
        } else {
            slot = id;
            if (next < id) {
                next = id;
            }
        }

        const ty = traits.slotType.get(slots + slot - 1);
        const value = if (kind == C.TRAIT_Class) 0 else abc.traitValue[i];
        const err = dom.checkDefault(index, value, abc.traitValueKind[i], ty);
        if (err != 0) {
            return err;
        }
    }

    return 0;
}

/// As TraitsBindings::checkOverride: `over`, t's method at a dispatch id,
/// has the signature of the method `virt` it overrides or implements,
/// except that its receiver may be t.
pub fn checkOverride(traits: *const TraitsTable, dom: *const Domain, t: u32, virt: u32, over: i32) Allocator.Error!bool {
    if (over < 0) {
        return false;
    }

    const o: u32 = @intCast(over);
    if (o == virt) {
        return true;
    }

    if (traits.returnType.get(o) != traits.returnType.get(virt) or
        traits.paramCount.get(o) != traits.paramCount.get(virt) or
        traits.optionalCount.get(o) != traits.optionalCount.get(virt))
    {
        return false;
    }

    const receiver = traits.receiverType.get(virt);
    if (receiver == TYPE_Any or
        !try traits.subtypeOf(dom.scratch, t, @intCast(receiver)) or
        !dom.machineCompatible(@intCast(t), receiver))
    {
        if (dom.isMachineType(@intCast(t)) or receiver != dom.objectType()) {
            return false;
        }
    }

    const oStart = traits.paramStart.get(o);
    const vStart = traits.paramStart.get(virt);
    for (0..traits.paramCount.get(o)) |p_| {
        const p: u32 = @intCast(p_);
        if (traits.paramType.get(oStart + p) != traits.paramType.get(vStart + p)) {
            return false;
        }
    }

    return true;
}

/// As TraitsBindings::checkLegalInterfaces: t implements every member of
/// every interface it has, with the interface's signatures.
pub fn checkInterfaces(traits: *const TraitsTable, dom: *const Domain, t: u32, interfaces: []const u32) Allocator.Error!bool {
    const dispatch = traits.dispatchStart.get(t);
    for (interfaces) |ifc| {
        const ifcDispatch = traits.dispatchStart.get(ifc);
        const last = traits.memberEnd.get(ifc);
        var m = traits.memberStart.get(ifc);
        while (m < last) : (m += 1) {
            const iBinding = traits.memberBinding.get(m);
            const cBinding = traits.find(@intCast(t), traits.memberNs.get(m), traits.memberName.get(m), traits.memberVersion.get(m));
            const iKind = iBinding & 7;
            if (!traits_.compatibleKind(iKind, cBinding & 7)) {
                return false;
            }

            const iId = iBinding >> 3;
            const cId = cBinding >> 3;
            if (iKind == traits_.BKIND_Method) {
                const virt = traits.dispatch.get(ifcDispatch + iId);
                const over = traits.dispatch.get(dispatch + cId);
                if (virt >= 0 and !try checkOverride(traits, dom, t, @intCast(virt), over)) {
                    return false;
                }

                continue;
            }

            if (hasGetter(iBinding)) {
                const virt = traits.dispatch.get(ifcDispatch + iId);
                const over = traits.dispatch.get(dispatch + cId);
                if (!hasGetter(cBinding) or (virt >= 0 and !try checkOverride(traits, dom, t, @intCast(virt), over))) {
                    return false;
                }
            }

            if (hasSetter(iBinding)) {
                const virt = traits.dispatch.get(ifcDispatch + iId + 1);
                const over = traits.dispatch.get(dispatch + cId + 1);
                if (!hasSetter(cBinding) or (virt >= 0 and !try checkOverride(traits, dom, t, @intCast(virt), over))) {
                    return false;
                }
            }
        }
    }

    return true;
}
