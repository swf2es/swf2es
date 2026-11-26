// A Domain's (domain.zig) names: strings and namespaces interned across
// ABCs, the script bindings by name, and what application domains find by
// a name: its methods, written here and named in it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const table = @import("../table.zig");
const hashBytes = table.hashBytes;
const hashPair = table.hashPair;
const domain_ = @import("../domain.zig");
const Domain = domain_.Domain;
const NsType = domain_.NsType;
const API_Internal = domain_.API_Internal;
const firstMember = domain_.firstMember;

pub fn findText(self: *const Domain, bytes: []const u8) i32 {
    return self.findString(bytes);
}

/// Intern a string that is not in an ABC, its bytes copied into the domain's arena.
pub fn internText(self: *Domain, bytes: []const u8) Allocator.Error!u32 {
    const found = self.findString(bytes);
    if (found >= 0) {
        return @intCast(found);
    }

    return self.internString(try self.gpa.dupe(u8, bytes));
}

pub fn internString(self: *Domain, bytes: []const u8) Allocator.Error!u32 {
    const found = self.findString(bytes);
    if (found >= 0) {
        return @intCast(found);
    }

    const id = self.stringPtr.len;
    try self.stringPtr.push(self.gpa, bytes.ptr);
    try self.stringLength.push(self.gpa, @intCast(bytes.len));
    try self.versioned.push(self.gpa, 0);
    try self.strings.insert(self.gpa, hashBytes(bytes), id);
    return id;
}

/// The bytes of interned string `id`.
pub fn stringOf(self: *const Domain, id: u32) []const u8 {
    return self.stringPtr.get(id)[0..self.stringLength.get(id)];
}

/// The id of a string already interned, or -1.
pub fn findString(self: *const Domain, bytes: []const u8) i32 {
    const hash = hashBytes(bytes);
    const strings = &self.strings;
    var slot = strings.start(hash);
    while (true) {
        const id = strings.at(slot);
        if (id < 0) {
            return -1;
        }

        if (strings.hashAt(slot) == hash and std.mem.eql(u8, self.stringOf(@intCast(id)), bytes)) {
            return id;
        }

        slot = strings.next(slot);
    }
}

/// The id of a namespace, interning it; private namespaces are always new.
pub fn internNamespace(self: *Domain, type_: NsType, uri: u32) Allocator.Error!u32 {
    if (type_ != .private) {
        const found = self.findNamespace(type_, uri);
        if (found >= 0) {
            return @intCast(found);
        }
    }

    const id = self.nsType.len;
    try self.nsType.push(self.gpa, type_);
    try self.nsUri.push(self.gpa, uri);
    if (type_ != .private) {
        try self.namespaces.insert(self.gpa, hashPair(@backingInt(type_), uri), id);
    }

    return id;
}

pub fn findNamespace(self: *const Domain, type_: NsType, uri: u32) i32 {
    const hash = hashPair(@backingInt(type_), uri);
    const ns = &self.namespaces;
    var slot = ns.start(hash);
    while (true) {
        const id = ns.at(slot);
        if (id < 0) {
            return -1;
        }

        if (self.nsType.get(@intCast(id)) == type_ and self.nsUri.get(@intCast(id)) == uri) {
            return id;
        }

        slot = ns.next(slot);
    }
}

/// The binding of `name` in namespace `ns` visible at `version` from
/// `domain`, or -1: the first one loaded, as a domain keeps the first
/// definition of a name.
pub fn find(self: *const Domain, ns: u32, name: u32, version: u8, domain: u32) i32 {
    if (self.domainParent.len > 1) {
        return self.findIn(ns, name, version, domain);
    }

    const hash = hashPair(ns, name);
    const b = &self.bindings;
    var slot = b.start(hash);
    while (true) {
        const id = b.at(slot);
        if (id < 0) {
            return -1;
        }

        const i: u32 = @intCast(id);
        // The slot's hash first: most slots a probe passes hold another key.
        if (b.hashAt(slot) == hash and self.bindingNs.get(i) == ns and self.bindingName.get(i) == name and self.bindingVersion.get(i) <= version) {
            return id;
        }

        slot = b.next(slot);
    }
}

/// Every script trait of ABC `index`, as AbcParser::addNamedScript binds it:
/// under its name's first namespace, with the earliest of their versions.
pub fn addBindings(self: *Domain, index: u32) Allocator.Error!void {
    const abc = self.abcs.get(index);
    const pool = &abc.pool;
    const strings = self.abcString.get(index);
    const ids = self.abcNs.get(index);
    const versions = self.abcNsVersion.get(index);
    for (0..abc.scriptCount()) |script| {
        const end = abc.scriptTraitStart[script + 1];
        var t = abc.scriptTraitStart[script];
        while (t < end) : (t += 1) {
            var mn = abc.traitName[t];
            if (pool.mnKind[mn] == .type_name) {
                mn = pool.mnA[mn];
            }

            const name = strings[pool.mnB[mn]];
            var first = pool.mnA[mn];
            var version = versions[first];
            if (pool.mnKind[mn] == .multiname) {
                const set = pool.mnA[mn];
                first = firstMember(pool, set);
                version = API_Internal;
                for (pool.nsSet(set)) |member| {
                    const v = versions[member];
                    if (v < version) {
                        version = v;
                    }
                }
            }

            try self.bind(ids[first], name, version, index, @intCast(script), t);
        }
    }
}

/// What `domain` has found by `ns` and `name`, as the runtime reports it
/// (see addFound): a binding, or as a type a class; -1 if none.
pub fn findCached(self: *const Domain, ns: u32, name: u32, version: u8, domain: u32, asType: bool) i32 {
    const c = &self.cached;
    const hash = hashPair(ns, name);
    var slot = c.start(hash);
    while (true) {
        const id = c.at(slot);
        if (id < 0) {
            return -1;
        }

        // The slot's hash first: most slots a probe passes hold another key.
        if (c.hashAt(slot) != hash) {
            slot = c.next(slot);
            continue;
        }

        const i: u32 = @intCast(id);
        const target = if (asType) self.cachedClass.get(i) else self.cachedBinding.get(i);
        if (self.cachedDomain.get(i) == domain and
            self.cachedNs.get(i) == ns and
            self.cachedName.get(i) == name and
            target >= 0)
        {
            return if (!asType and self.bindingVersion.get(@intCast(target)) > version) -1 else target;
        }

        slot = c.next(slot);
    }
}

/// find, from a domain other than the root's only one.
pub fn findIn(self: *const Domain, ns: u32, name: u32, version: u8, domain: u32) i32 {
    const cached = self.findCached(ns, name, version, domain, false);
    if (cached >= 0) {
        return cached;
    }

    const b = &self.bindings;
    const hash = hashPair(ns, name);
    var slot = b.start(hash);
    var best: i32 = -1;
    var bestDepth: u32 = 0;
    while (true) {
        const id = b.at(slot);
        if (id < 0) {
            return best;
        }

        // The slot's hash first: most slots a probe passes hold another key.
        if (b.hashAt(slot) != hash) {
            slot = b.next(slot);
            continue;
        }

        const i: u32 = @intCast(id);
        const d = self.abcDomain.get(self.bindingAbc.get(i));
        if (self.bindingNs.get(i) == ns and
            self.bindingName.get(i) == name and
            self.bindingVersion.get(i) <= version and
            (best < 0 or self.domainDepth.get(d) < bestDepth) and
            self.sees(domain, d))
        {
            best = id;
            bestDepth = self.domainDepth.get(d);
        }

        slot = b.next(slot);
    }
}

/// findTypeOf for the names scripts define, from a domain other than the root's only one.
pub fn findTypeIn(self: *const Domain, ns: u32, name: u32, version: u8, domain: u32) i32 {
    const cached = self.findCached(ns, name, version, domain, true);
    if (cached >= 0) {
        return cached;
    }

    const t = &self.types;
    const hash = hashPair(ns, name);
    var slot = t.start(hash);
    var best: i32 = -1;
    var bestDepth: u32 = 0;
    while (true) {
        const id = t.at(slot);
        if (id < 0) {
            return best;
        }

        if (t.hashAt(slot) != hash) {
            slot = t.next(slot);
            continue;
        }

        const i: u32 = @intCast(id);
        const d = self.typeDomain.get(i);
        if (self.typeNs.get(i) == ns and
            self.typeName.get(i) == name and
            self.typeVersion.get(i) <= version and
            self.typeOwner.get(i) == -1 and
            (best < 0 or self.domainDepth.get(d) < bestDepth) and
            self.sees(domain, d))
        {
            best = @intCast(self.typeClass.get(i));
            bestDepth = self.domainDepth.get(d);
        }

        slot = t.next(slot);
    }
}

/// Record that `domain` has found the definition ABC `abc` gives `name`
/// in the namespace of kind `type` and URI `uri`: by name, its script's
/// binding, or as a type, its class. A name no ABC spells is not recorded.
pub fn addFound(self: *Domain, domain: u32, type_: NsType, uri: []const u8, name: []const u8, abc: u32, asType: bool) Allocator.Error!void {
    if (domain >= self.domainParent.len or
        self.domainState.get(domain) != .live or
        abc >= self.abcs.len or
        !self.isLive(abc))
    {
        return;
    }

    const uriId = self.findText(uri);
    const nameId = self.findText(name);
    const ns = if (uriId < 0) -1 else self.findNamespace(type_, @intCast(uriId));
    if (nameId < 0 or ns < 0) {
        return;
    }

    const nsU: u32 = @intCast(ns);
    const nameU: u32 = @intCast(nameId);
    var binding: i32 = -1;
    var cls: i32 = -1;
    if (asType) {
        for (0..self.typeNs.len) |id_| {
            const id: u32 = @intCast(id_);
            const c = self.typeClass.get(id);
            if (self.typeNs.get(id) == nsU and
                self.typeName.get(id) == nameU and
                @as(i32, @bitCast(c)) != self.voidClass and
                self.classAbc.get(c) == abc)
            {
                cls = @bitCast(c);
                break;
            }
        }
    } else {
        for (0..self.bindingNs.len) |id_| {
            const id: u32 = @intCast(id_);
            if (self.bindingNs.get(id) == nsU and self.bindingName.get(id) == nameU and self.bindingAbc.get(id) == abc) {
                binding = @intCast(id);
                break;
            }
        }
    }

    if (binding < 0 and cls < 0) {
        return;
    }

    // A domain's finding never changes, and the runtime reports it again
    // for each ABC the domain loads: one already recorded is left as it is.
    var slot = self.cached.start(hashPair(nsU, nameU));
    while (true) {
        const id = self.cached.at(slot);
        if (id < 0) {
            break;
        }

        const i: u32 = @intCast(id);
        if (self.cachedDomain.get(i) == domain and
            self.cachedNs.get(i) == nsU and
            self.cachedName.get(i) == nameU and
            self.cachedBinding.get(i) == binding and
            self.cachedClass.get(i) == cls)
        {
            return;
        }

        slot = self.cached.next(slot);
    }

    const gpa = self.gpa;
    const id = self.cachedDomain.len;
    try self.cachedDomain.push(gpa, domain);
    try self.cachedNs.push(gpa, nsU);
    try self.cachedName.push(gpa, nameU);
    try self.cachedBinding.push(gpa, binding);
    try self.cachedClass.push(gpa, cls);
    try self.cached.insert(gpa, hashPair(nsU, nameU), id);
    self.clearBindingMemo();
    try self.foundEntry.push(gpa, self.logKind.len);
    try self.logged(.found, abc, self.foundDomain.len, 0);
    try self.foundDomain.push(gpa, domain);
    try self.foundKind.push(gpa, type_);
    try self.foundUri.push(gpa, try gpa.dupe(u8, uri));
    try self.foundName.push(gpa, try gpa.dupe(u8, name));
    try self.foundAbc.push(gpa, abc);
    try self.foundAsType.push(gpa, @intFromBool(asType));
}

pub fn bind(self: *Domain, ns: u32, name: u32, version: u8, abc: u32, script: u32, trait: u32) Allocator.Error!void {
    const gpa = self.gpa;
    const id = self.bindingNs.len;
    try self.bindingNs.push(gpa, ns);
    try self.bindingName.push(gpa, name);
    try self.bindingVersion.push(gpa, version);
    try self.bindingAbc.push(gpa, abc);
    try self.bindingScript.push(gpa, script);
    try self.bindingTrait.push(gpa, trait);
    try self.bindings.insert(gpa, hashPair(ns, name), id);
}
