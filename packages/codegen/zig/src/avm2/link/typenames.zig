// Class names and the types they name, as avmplus' PoolObject and DomainMgr
// resolve them (assembly/avm2/link/typenames.ts): a type name to a class an
// earlier ABC's script defines, or one of the ABC's own while it links,
// Vector.<T> made for each T, and the names of an ABC's classes made
// visible once it has linked.
const std = @import("std");
const Allocator = std.mem.Allocator;
const C = @import("../abc/constants.zig");
const domain_ = @import("domain.zig");
const Domain = domain_.Domain;
const hashPair = @import("table.zig").hashPair;
const traits_ = @import("traits.zig");
const TYPE_Any = traits_.TYPE_Any;

/// As PoolObject::resolveTypeName for a slot or parameter type: TYPE_Any
/// for index 0, or the type; below TYPE_Any on failure, with typeError set.
/// AssemblyScript recurses into a TypeName's parameter; a chain of them
/// (Vector.<Vector.<...>>) is as deep as the input makes it, so this walks
/// down it keeping each level's base, then makes the types back up, in
/// AssemblyScript's order.
pub fn resolveTypeId(dom: *Domain, index: u32, multiname: u32, allowVoid: bool) Allocator.Error!i32 {
    const pool = &dom.abcs.get(index).pool;
    var bases: std.ArrayList(i32) = .empty;
    var mn = multiname;
    var void_ok = allowVoid;
    const innermost: i32 = while (true) {
        if (mn == 0) {
            break TYPE_Any;
        }

        if (mn >= pool.multinameCount()) {
            dom.typeError = C.kCpoolIndexRangeError;
            return -2;
        }

        if (pool.mnKind[mn] != .type_name) {
            const c = resolveType(dom, index, mn);
            if (c == -C.kIllegalVoidError) {
                if (void_ok) {
                    break dom.voidType;
                }

                dom.typeError = C.kIllegalVoidError;
                return -2;
            }

            if (c < 0) {
                dom.typeError = -c;
                return -2;
            }

            break dom.classTraits.get(@intCast(c));
        }

        const base = resolveType(dom, index, pool.mnA[mn]);
        if (base == -C.kAmbiguousBindingError) {
            dom.typeError = C.kAmbiguousBindingError;
            return -2;
        }

        try bases.append(dom.scratch, base);
        mn = pool.mnB[mn];
        void_ok = false;
    };

    var param = innermost;
    var level = bases.items.len;
    while (level > 0) {
        level -= 1;
        const base = bases.items[level];
        const t = if (base >= 0) try parameterized(dom, base, param) else -1;
        if (t < 0) {
            dom.typeError = C.kClassNotFoundError;
            return -2;
        }

        param = t;
    }

    return param;
}

/// As PoolObject::resolveParameterizedType: Vector.<T>, which avmplus has
/// as its own classes for int, uint, Number and *, and otherwise makes as
/// a subclass of Vector.<*>; -1 if `base` is not Vector.
pub fn parameterized(dom: *Domain, base: i32, param: i32) Allocator.Error!i32 {
    if (base != dom.vectorClass or base < 0) {
        return -1;
    }

    switch (dom.builtin(param)) {
        .any => return dom.vectorObjectType,
        .int => return dom.vectorIntType,
        .uint => return dom.vectorUintType,
        .number => return dom.vectorDoubleType,
        else => {},
    }

    const made = dom.vectorFor(param);
    if (made >= 0) {
        return made;
    }

    // As Traits::newParameterizedITraits: a subclass of Vector.<*> with no members of its own.
    const traits = &dom.traits;
    const objects: u32 = @intCast(dom.vectorObjectType);
    const t = try traits.create(dom.gpa, .instance, traits.abc.get(objects), traits.owner.get(objects), @intCast(objects), -1, 0, 0);
    traits.param.set(t, param);
    traits.slotCount.set(t, traits.slotCount.get(objects));
    traits.methodCount.set(t, traits.methodCount.get(objects));
    traits.memberStart.set(t, traits.memberTraits.len);
    traits.memberEnd.set(t, traits.memberTraits.len);
    try dom.setVectorFor(param, @intCast(t));
    return @intCast(t);
}

/// As PoolObject::resolveTypeName for a base class or interface: the class
/// id, or minus the error: 1014 if nothing matches, 1008 if two classes do,
/// 1022 for void.
///
/// A TypeName's base is never a TypeName (the parser's typeNamesAreAcyclic),
/// but its parameter may be, as deep as the input makes it: AssemblyScript
/// recurses down the parameters, each level giving its base unless a
/// deeper one fails, which this walks in a loop.
pub fn resolveType(dom: *const Domain, index: u32, multiname: u32) i32 {
    const pool = &dom.abcs.get(index).pool;
    if (pool.mnKind[multiname] != .type_name) {
        return resolvePlain(dom, index, multiname);
    }

    const outer = resolvePlain(dom, index, pool.mnA[multiname]);
    var base = outer;
    var mn = multiname;
    while (base >= 0 and pool.mnB[mn] != 0) {
        mn = pool.mnB[mn];
        if (pool.mnKind[mn] != .type_name) {
            const t = resolvePlain(dom, index, mn);
            return if (t < 0) t else outer;
        }

        base = resolvePlain(dom, index, pool.mnA[mn]);
        if (base < 0) {
            return base;
        }
    }

    return outer;
}

/// resolveType of a multiname that is not a TypeName.
fn resolvePlain(dom: *const Domain, index: u32, mn: u32) i32 {
    const abc = dom.abcs.get(index);
    const pool = &abc.pool;
    const kind = pool.mnKind[mn];

    const strings = dom.abcString.get(index);
    const ids = dom.abcNs.get(index);
    const versions = dom.abcNsVersion.get(index);
    const nameIndex = pool.mnB[mn];
    var found: i32 = -1;
    if (kind == .qname and pool.mnA[mn] != 0 and nameIndex != 0) {
        const ns = pool.mnA[mn];
        found = findType(dom, index, ids[ns], strings[nameIndex], versions[ns]);
    } else if (kind == .multiname and nameIndex != 0) {
        const set = pool.mnA[mn];
        const last = pool.nsSetStart[set + 1];
        var m = pool.nsSetStart[set];
        while (m < last) : (m += 1) {
            const ns = pool.nsSetMembers[m];
            const t = findType(dom, index, ids[ns], strings[nameIndex], versions[ns]);
            if (t >= 0 and found >= 0 and t != found) {
                return -C.kAmbiguousBindingError;
            }

            if (t >= 0) {
                found = t;
            }
        }
    }

    if (found < 0) {
        return -C.kClassNotFoundError;
    }

    return if (found == dom.voidClass) -C.kIllegalVoidError else found;
}

/// As DomainMgr::findTraitsInPoolByNameAndNS for ABC `index`: a class a
/// script defines, else one of the ABC's own; -1 if none.
fn findType(dom: *const Domain, index: u32, ns: u32, name: u32, version: u8) i32 {
    const found = findTypeOf(dom, ns, name, version, -1, dom.abcDomain.get(index));
    return if (found >= 0) found else findTypeOf(dom, ns, name, version, dom.abcOwner.get(index), 0);
}

/// A class name's class, of ABC `owner`'s own or else one `domain` sees; -1 if none.
fn findTypeOf(dom: *const Domain, ns: u32, name: u32, version: u8, owner: i32, domain: u32) i32 {
    if (owner < 0 and dom.domainParent.len > 1) {
        return dom.findTypeIn(ns, name, version, domain);
    }

    const hash = hashPair(ns, name);
    const t = &dom.types;
    var slot = t.start(hash);
    while (true) {
        const id = t.at(slot);
        if (id < 0) {
            return -1;
        }

        const i: u32 = @intCast(id);
        // The slot's hash first: most slots a probe passes hold another key.
        if (t.hashAt(slot) == hash and
            dom.typeNs.get(i) == ns and
            dom.typeName.get(i) == name and
            dom.typeVersion.get(i) <= version and
            dom.typeOwner.get(i) == owner)
        {
            return @intCast(dom.typeClass.get(i));
        }

        slot = t.next(slot);
    }
}

pub fn nameType(dom: *Domain, ns: u32, name: u32, version: u8, id: i32, owner: i32, domain: u32) Allocator.Error!void {
    const gpa = dom.gpa;
    const ty = dom.typeNs.len;
    try dom.typeDomain.push(gpa, domain);
    try dom.typeNs.push(gpa, ns);
    try dom.typeName.push(gpa, name);
    try dom.typeVersion.push(gpa, version);
    try dom.typeClass.push(gpa, @bitCast(id));
    try dom.typeOwner.push(gpa, owner);
    try dom.types.insert(gpa, hashPair(ns, name), ty);
}

/// As DomainMgr::addNamedInstanceTraits: instance i's name, unless something is already found by it.
pub fn nameInstance(dom: *Domain, index: u32, i: u32) Allocator.Error!void {
    const abc = dom.abcs.get(index);
    const pool = &abc.pool;
    var mn = abc.instanceName[i];
    if (pool.mnKind[mn] == .type_name) {
        mn = pool.mnA[mn];
    }

    var ns = pool.mnA[mn];
    if (pool.mnKind[mn] == .multiname) {
        ns = domain_.firstMember(pool, ns);
    }

    const nsId = dom.abcNs.get(index)[ns];
    const version = dom.abcNsVersion.get(index)[ns];
    const name = dom.abcString.get(index)[pool.mnB[mn]];
    if (findType(dom, index, nsId, name, version) < 0) {
        try nameType(dom, nsId, name, version, @intCast(dom.classStart.get(index) + i), dom.abcOwner.get(index), dom.abcDomain.get(index));
    }
}

/// As AbcParser::addNamedTraits: every class a script of ABC `index`
/// defines, visible to all later ABCs unless the domain has the name already.
pub fn addClassNames(dom: *Domain, index: u32) Allocator.Error!void {
    const abc = dom.abcs.get(index);
    const pool = &abc.pool;
    const ids = dom.abcNs.get(index);
    const versions = dom.abcNsVersion.get(index);
    const strings = dom.abcString.get(index);
    const first = abc.scriptTraitStart[0];
    const end = abc.scriptTraitStart[abc.scriptCount()];
    var t = first;
    while (t < end) : (t += 1) {
        if (abc.traitTag[t].kind != .class) {
            continue;
        }

        var mn = abc.traitName[t];
        if (pool.mnKind[mn] == .type_name) {
            mn = pool.mnA[mn];
        }

        var ns = pool.mnA[mn];
        var version = versions[ns];
        if (pool.mnKind[mn] == .multiname) {
            const set = ns;
            const last = pool.nsSetStart[set + 1];
            ns = domain_.firstMember(pool, set);
            version = domain_.API_Internal;
            var m = pool.nsSetStart[set];
            while (m < last) : (m += 1) {
                const v = versions[pool.nsSetMembers[m]];
                if (v < version) {
                    version = v;
                }
            }
        }

        const nsId = ids[ns];
        const name = strings[pool.mnB[mn]];
        const domain = dom.abcDomain.get(index);
        if (dom.nsType.get(nsId) != .private and findTypeOf(dom, nsId, name, version, -1, domain) < 0) {
            const id = dom.classStart.get(index) + abc.traitIndex[t];
            try nameType(dom, nsId, name, version, @intCast(id), -1, domain);
        }
    }
}
