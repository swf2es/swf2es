// What the verifier asks of types (assembly/avm2/link/types.ts): which
// binding a name has on a type, what type that binding holds, and how two
// types merge or assign.
const std = @import("std");
const Allocator = std.mem.Allocator;
const C = @import("../abc/constants.zig");
const Domain = @import("domain.zig").Domain;
const hashPair = @import("table.zig").hashPair;
const traits_ = @import("traits.zig");
const BIND_None = traits_.BIND_None;
const TYPE_Any = traits_.TYPE_Any;

/// A name bound differently in two namespaces of a set it is looked up in.
pub const BIND_Ambiguous: u32 = 0xffffffff;

/// As Multiname::isBinding: whether multiname `mn` of ABC `index` names
/// something that can be bound early, a name in known namespaces.
pub fn isBindingName(dom: *const Domain, index: u32, multiname: u32) bool {
    const pool = &dom.abcs.get(index).pool;
    var mn = multiname;
    var kind = pool.mnKind[mn];
    if (kind == C.CONSTANT_TypeName) {
        mn = pool.mnA[mn];
        kind = pool.mnKind[mn];
    }

    if (kind == C.CONSTANT_Qname) {
        return pool.mnA[mn] != 0 and pool.mnB[mn] != 0;
    }

    return kind == C.CONSTANT_Multiname and pool.mnB[mn] != 0;
}

/// As avmplus' getBinding: the binding multiname `mn` of ABC `index` has on
/// `type`, BIND_None, or BIND_Ambiguous if it binds differently in two of
/// its namespaces. The type's own members are searched before its base's.
pub fn getBinding(dom: *Domain, index: u32, type_: i32, mn: u32) Allocator.Error!u32 {
    dom.changing();
    if (type_ < 0) {
        return BIND_None;
    }

    // Answered before, as the verifier asks again and again (findProperty
    // tries each scope in turn, in every method).
    const hash = hashPair(hashPair(@intCast(type_), index), mn);
    const memo = &dom.bindingMemo;
    var slot = memo.start(hash);
    while (true) {
        const id = memo.at(slot);
        if (id < 0) {
            break;
        }

        const i: u32 = @intCast(id);
        if (memo.hashAt(slot) == hash and
            dom.memoType.get(i) == type_ and
            dom.memoAbc.get(i) == index and
            dom.memoName.get(i) == mn)
        {
            return dom.memoBinding.get(i);
        }

        slot = memo.next(slot);
    }

    const b = lookupBinding(dom, index, type_, mn);
    // The rows first, then the id that names them, so that the table never
    // holds an id past the rows, as AssemblyScript's order would where
    // memory runs out between the two.
    const gpa = dom.gpa;
    const id = dom.memoType.len;
    try dom.memoType.push(gpa, type_);
    try dom.memoAbc.push(gpa, index);
    try dom.memoName.push(gpa, mn);
    try dom.memoBinding.push(gpa, b);
    try memo.insert(gpa, hash, id);
    return b;
}

/// getBinding, looked up.
fn lookupBinding(dom: *const Domain, index: u32, type_: i32, multiname: u32) u32 {
    if (!isBindingName(dom, index, multiname)) {
        return BIND_None;
    }

    const pool = &dom.abcs.get(index).pool;
    var mn = multiname;
    if (pool.mnKind[mn] == C.CONSTANT_TypeName) {
        mn = pool.mnA[mn];
    }

    const traits = &dom.traits;
    const ids = dom.abcNs.get(index);
    const versions = dom.abcNsVersion.get(index);
    const name = dom.abcString.get(index)[pool.mnB[mn]];
    if (pool.mnKind[mn] == C.CONSTANT_Qname) {
        const ns = pool.mnA[mn];
        return traits.find(type_, ids[ns], name, versions[ns]);
    }

    const set = pool.mnA[mn];
    const first = pool.nsSetStart[set];
    const last = pool.nsSetStart[set + 1];
    var t = type_;
    while (t >= 0) : (t = traits.base.get(@intCast(t))) {
        var found = BIND_None;
        var m = first;
        while (m < last) : (m += 1) {
            const ns = pool.nsSetMembers[m];
            const b = traits.own(@intCast(t), ids[ns], name, versions[ns]);
            if (b == BIND_None) {
                continue;
            }

            if (found != BIND_None and found != b) {
                return BIND_Ambiguous;
            }

            found = b;
        }

        if (found != BIND_None) {
            return found;
        }
    }

    return BIND_None;
}

/// The binding multiname `mn` of ABC `index` has among t's own members, or
/// BIND_None; Domain.foundNs is then the namespace it was found in.
pub fn getOwnBinding(dom: *Domain, index: u32, t: u32, multiname: u32) u32 {
    const pool = &dom.abcs.get(index).pool;
    var mn = multiname;
    if (pool.mnKind[mn] == C.CONSTANT_TypeName) {
        mn = pool.mnA[mn];
    }

    const traits = &dom.traits;
    const ids = dom.abcNs.get(index);
    const versions = dom.abcNsVersion.get(index);
    const name = dom.abcString.get(index)[pool.mnB[mn]];
    if (pool.mnKind[mn] == C.CONSTANT_Qname) {
        const ns = pool.mnA[mn];
        dom.foundNs = @intCast(ids[ns]);
        return traits.own(t, ids[ns], name, versions[ns]);
    }

    const set = pool.mnA[mn];
    var m = pool.nsSetStart[set];
    while (m < pool.nsSetStart[set + 1]) : (m += 1) {
        const ns = pool.nsSetMembers[m];
        const b = traits.own(t, ids[ns], name, versions[ns]);
        if (b != BIND_None) {
            dom.foundNs = @intCast(ids[ns]);
            return b;
        }
    }

    return BIND_None;
}

/// As Traits::readBinding: the type binding `b` holds on resolved `type`: a
/// slot's type, a getter's return type, and * for anything else.
pub fn bindingType(dom: *const Domain, type_: i32, b: u32) i32 {
    const kind = b & 7;
    const traits = &dom.traits;
    const t: u32 = @intCast(type_);
    if (kind == traits_.BKIND_Var or kind == traits_.BKIND_Const) {
        return traits.slotType.get(traits.slotStart.get(t) + (b >> 3));
    }

    if (kind == traits_.BKIND_Get or kind == traits_.BKIND_GetSet) {
        const m = traits.dispatch.get(traits.dispatchStart.get(t) + (b >> 3));
        return if (m < 0) TYPE_Any else traits.returnType.get(@intCast(m));
    }

    return TYPE_Any;
}

/// As Verifier::findCommonBase: the nearest type both are, null merging with any non-machine type.
pub fn commonBase(dom: *const Domain, a: i32, b: i32) i32 {
    if (a == b) {
        return a;
    }

    if (a == TYPE_Any or b == TYPE_Any) {
        return TYPE_Any;
    }

    const traits = &dom.traits;
    if (traits.kind.get(@intCast(a)) == traits_.TRAITS_Null and !dom.isMachineType(b)) {
        return b;
    }

    if (traits.kind.get(@intCast(b)) == traits_.TRAITS_Null and !dom.isMachineType(a)) {
        return a;
    }

    var t = b;
    while (t >= 0) : (t = traits.base.get(@intCast(t))) {
        var s = a;
        while (s >= 0) : (s = traits.base.get(@intCast(s))) {
            if (s == t) {
                return t;
            }
        }
    }

    return TYPE_Any;
}

/// As Traits::canAssign: a value of type `rhs` is already of type `lhs`.
pub fn canAssign(dom: *const Domain, lhs: i32, rhs: i32) bool {
    if (!dom.machineCompatible(lhs, rhs)) {
        return false;
    }

    if (lhs == TYPE_Any) {
        return true;
    }

    var t = rhs;
    while (t >= 0) : (t = dom.traits.base.get(@intCast(t))) {
        if (t == lhs) {
            return true;
        }
    }

    return false;
}

/// As Traits::isNumeric: int, uint or Number.
pub fn isNumeric(dom: *const Domain, type_: i32) bool {
    const bt = dom.builtin(type_);
    return bt == traits_.BUILTIN_Int or bt == traits_.BUILTIN_Uint or bt == traits_.BUILTIN_Number or bt == traits_.BUILTIN_Float;
}
