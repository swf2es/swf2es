// What traits resolve when first used, as avmplus' Traits::resolveSignatures
// does after their supertypes (assembly/avm2/link/signatures.ts): each slot's
// type and each dispatch id's method, the slots' initial values checked
// against their types, and the overrides and implemented interfaces checked
// against the signatures they meet.
const std = @import("std");
const Allocator = std.mem.Allocator;
const C = @import("../abc/constants.zig");
const bindings = @import("bindings.zig");
const overridden = bindings.overridden;
const SlotIds = bindings.SlotIds;
const Domain = @import("domain.zig").Domain;
const traits_ = @import("traits.zig");
const Binding = traits_.Binding;
const TraitsTable = traits_.TraitsTable;
const TypeId = traits_.TypeId;
const resolveTypeId = @import("typenames.zig").resolveTypeId;
const errors = @import("../abc/errors.zig");
const Diagnostics = errors.Diagnostics;
const Error = errors.Error;

fn hasGetter(binding: Binding) bool {
    const kind = binding.kind;
    return kind == .get or kind == .get_set;
}

fn hasSetter(binding: Binding) bool {
    const kind = binding.kind;
    return kind == .set or kind == .get_set;
}

/// As Traits::finishSlotsAndMethods: each slot's type, and each method's
/// dispatch id; an overridden method must not be final.
pub fn resolveSlotsAndMethods(traits: *TraitsTable, dom: *Domain, t: u32, diag: *Diagnostics) Error!void {
    const gpa = dom.gpa;
    const index = traits.abc.get(t);
    const abc = dom.abcs.get(index);
    const base = traits.base.get(t);
    const slotCount = traits.slotCount.get(t);
    const slots = traits.slotType.len;
    try dom.put(traits.slotStart.at(t), slots);
    for (0..slotCount) |_| {
        try traits.slotType.push(gpa, .any);
        try traits.slotSet.push(gpa, 0);
    }

    const methodCount = traits.methodCount.get(t);
    const dispatch = traits.dispatch.len;
    try dom.put(traits.dispatchStart.at(t), dispatch);
    for (0..methodCount) |_| {
        try traits.dispatch.push(gpa, -1);
    }

    var baseSlots: u32 = 0;
    if (base != .none) {
        const b = base.index();
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
    var ids = SlotIds.init(traits, t);
    var i = traits.first.get(t);
    while (i < traits.end.get(t)) : (i += 1) {
        const tag = abc.traitTag[i];
        const kind = tag.kind;
        if (kind.bindsSlot()) {
            // A slot defined twice would give one memory location two types.
            const slot = ids.next(abc.traitId[i]);
            if (slot >= slotCount or traits.slotSet.get(slots + slot) != 0) {
                return diag.fail(.kCorruptABCError);
            }

            // A class not linked yet reads as *.
            const ty: TypeId = if (kind == .class)
                dom.classStatic.get(dom.classStart.get(index) + abc.traitIndex[i]).orAny()
            else
                try resolveTypeId(dom, index, abc.traitIndex[i], false, diag);

            traits.slotType.set(slots + slot, ty);
            traits.slotSet.set(slots + slot, 1);
        } else if (kind.bindsMethod()) {
            traits.readName(dom, index, i);
            const b = traits.own(t, traits.nameNs, traits.nameId, traits.nameVersion);
            if (b == Binding.none) {
                continue;
            }

            // Where a method took a setter's name, the setter finds the
            // method's id plus one, past the table. avmplus writes the
            // setter there all the same, which nothing reads.
            const d = b.index() + @intFromBool(kind == .setter);
            if (d >= methodCount) {
                continue;
            }

            const baseBinding = overridden(traits, t, traits.nameNs, traits.nameNsVersion, traits.nameId, tag) orelse Binding.none;
            if (baseBinding != Binding.none) {
                const bb = baseBinding;
                if (bb.kind == .method or
                    (hasGetter(bb) and kind == .getter) or
                    (hasSetter(bb) and kind == .setter))
                {
                    const virt = traits.dispatch.get(traits.dispatchStart.get(base.index()) + d);
                    if (virt >= 0 and traits.methodFinal.get(@intCast(virt)) != 0) {
                        return diag.fail(.kIllegalOverrideError);
                    }
                }
            }

            traits.dispatch.set(dispatch + d, @intCast(methods + abc.traitIndex[i]));
        }
    }
}

/// As Traits::genInitBody: every slot's initial value must suit its type.
pub fn checkInitialValues(traits: *const TraitsTable, dom: *const Domain, t: u32, diag: *Diagnostics) errors.Rejected!void {
    const index = traits.abc.get(t);
    const abc = dom.abcs.get(index);
    const slots = traits.slotStart.get(t);
    var ids = SlotIds.init(traits, t);
    var i = traits.first.get(t);
    while (i < traits.end.get(t)) : (i += 1) {
        const kind = abc.traitTag[i].kind;
        if (!kind.bindsSlot()) {
            continue;
        }

        const ty = traits.slotType.get(slots + ids.next(abc.traitId[i]));
        const value = if (kind == .class) 0 else abc.traitValue[i];
        try dom.checkDefault(index, value, abc.traitValueKind[i], ty, diag);
    }
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
    if (receiver == .any or
        !try traits.subtypeOf(dom.scratch, t, receiver.index()) or
        !dom.machineCompatible(.of(t), receiver))
    {
        if (dom.isMachineType(.of(t)) or receiver != dom.objectType()) {
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
            const cBinding = traits.find(.of(t), traits.memberNs.get(m), traits.memberName.get(m), traits.memberVersion.get(m));
            const iKind = iBinding.kind;
            if (!traits_.compatibleKind(iKind, cBinding.kind)) {
                return false;
            }

            const iId = iBinding.index();
            const cId = cBinding.index();
            if (iKind == .method) {
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
