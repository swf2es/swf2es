// The traits of a domain's classes, scripts and activations: what each
// defines by name, its slots and their types, and its methods by dispatch id
// (assembly/avm2/link/traits.ts).
//
// As in avmplus, traits are laid out when their ABC loads
// (Traits::verifyBindings, from AbcParser::parseTraits; bindings.zig): names
// bind to slots and dispatch ids, inheriting the base's, and overrides must
// be of the right kind. What needs types waits until the traits are first
// used (Traits::resolveSignatures; resolve, and signatures.zig): slot types
// and initial values, method signatures, final methods, override signatures
// and implemented interfaces.
//
// A type is a TypeId: a traits id, or * (any).
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const Rows = memory.Rows;
const C = @import("../abc/constants.zig");
const Value = @import("../abc/pool.zig").Value;
const domain_ = @import("domain.zig");
const Domain = domain_.Domain;
const signatures = @import("signatures.zig");
const table = @import("table.zig");
const IdTable = table.IdTable;
const hashPair = table.hashPair;
const typenames = @import("typenames.zig");
const errors = @import("../abc/errors.zig");
const Diagnostics = errors.Diagnostics;
const Error = errors.Error;

/// What a traits describes. The log's resolve entries carry it, so its
/// values are fixed, and an entry's is checked against the owned kinds
/// before it is read (`owned`); non-exhaustive for the same reason.
pub const TraitsKind = enum(u8) {
    instance = 1,
    class = 2,
    script = 3,
    activation = 4,
    /// The types of void and null, which avmplus also represents as traits.
    void = 5,
    null = 6,
    /// A catch block's scope, with the exception in its one slot.
    catch_scope = 7,
    _,

    /// Whether an ABC's entries own it: instance, class, script or
    /// activation, the kinds a resolve entry names.
    pub fn isOwned(kind: TraitsKind) bool {
        return switch (kind) {
            .instance, .class, .script, .activation => true,
            else => false,
        };
    }

    /// The owned kind a resolve entry's number names, else null: a
    /// journal's or a save's, read back.
    pub fn owned(n: u32) ?TraitsKind {
        if (n > 0xff) {
            return null;
        }

        const kind: TraitsKind = @fromBackingInt(@intCast(n));
        return if (kind.isOwned()) kind else null;
    }
};

/// A type: a traits id, or * (any). The same i32 as before.
pub const TypeId = enum(i32) {
    any = -1,
    _,

    /// The type of traits `t`.
    pub fn of(t: u32) TypeId {
        return @fromBackingInt(@intCast(t));
    }

    /// Its traits id; a type that is a traits'.
    pub inline fn index(t: TypeId) u32 {
        std.debug.assert(t.isTraits());
        return @intCast(@backingInt(t));
    }

    /// Whether it is a traits': not *.
    pub fn isTraits(t: TypeId) bool {
        return @backingInt(t) >= 0;
    }

    /// Whether it is builtin type `builtin`, one of Domain's builtin type
    /// fields, which hold * while the builtin is absent: an absent builtin
    /// is no type, so * is not it.
    pub fn isBuiltin(t: TypeId, builtin: TypeId) bool {
        return builtin != .any and t == builtin;
    }
};

/// A traits id that may be absent: a traits' base, a class's instance or
/// class object traits, which a class has once it links. Its none is -1,
/// the number of *, but it is no type: a ref becomes one by toType, which
/// none has not, or by orAny, which says where an absent ref is read as *.
/// The same i32 as before.
pub const TypeRef = enum(i32) {
    none = -1,
    _,

    pub fn of(t: u32) TypeRef {
        return @fromBackingInt(@intCast(t));
    }

    /// A type's traits: none for *, which has none.
    pub fn ofType(t: TypeId) TypeRef {
        return if (t.isTraits()) of(t.index()) else .none;
    }

    /// Its traits id; a ref that is not none.
    pub inline fn index(ref: TypeRef) u32 {
        std.debug.assert(ref != .none);
        return @intCast(@backingInt(ref));
    }

    /// As a type; a ref that is not none.
    pub fn toType(ref: TypeRef) TypeId {
        std.debug.assert(ref != .none);
        return @fromBackingInt(@backingInt(ref));
    }

    /// As a type, none as *: where an absent ref has always been read as
    /// *, which each caller says.
    pub fn orAny(ref: TypeRef) TypeId {
        return @fromBackingInt(@backingInt(ref));
    }
};

/// A binding's kind, as avmplus' BindingKind: the low three bits of a
/// Binding. Kind 4 is one avmplus does not use.
pub const BindingKind = enum(u3) {
    none = 0,
    method = 1,
    variable = 2,
    constant = 3,
    get = 5,
    set = 6,
    get_set = 7,
    _,

    /// Whether it is an accessor's: get, set, or both.
    pub fn isAccessor(kind: BindingKind) bool {
        return kind == .get or kind == .set or kind == .get_set;
    }
};

/// A name's binding in a traits, as avmplus' Binding: the kind in the low
/// three bits and the id above them, `id << 3 | kind` in one u32 (checked
/// below), so that the tables keep the numbers avmplus' layout gives. The
/// id is the slot (variable, constant), the dispatch id (method, accessor:
/// a getter's, its setter's the next).
pub const Binding = packed struct(u32) {
    kind: BindingKind,
    id: u29,

    /// No binding: 0.
    pub const none: Binding = @bitCast(@as(u32, 0));
    /// Bound differently in two of the places a lookup searched
    /// (types.zig): 0xffffffff, kind get_set and the largest id, which no
    /// table holds.
    pub const ambiguous: Binding = @bitCast(@as(u32, 0xffffffff));

    /// Its id as the tables index by it: a slot, or a dispatch id.
    pub inline fn index(binding: Binding) u32 {
        return binding.id;
    }

    /// Kind `kind` at `id`, its top three bits dropped as `id << 3` in a
    /// u32 drops them.
    pub fn of(id: u32, kind: BindingKind) Binding {
        return .{ .kind = kind, .id = @truncate(id) };
    }
};

comptime {
    // The word avmplus' layout gives, which the tables and the modules hold.
    std.debug.assert(@sizeOf(Binding) == 4);
    std.debug.assert(@as(u32, @bitCast(Binding.of(5, .get))) == 5 << 3 | 5);
}
/// Types the rules below treat specially, as avmplus' BuiltinType.
/// Computed from a type id (Domain.builtin), never stored.
pub const Builtin = enum(u8) {
    any,
    object,
    void,
    boolean,
    int,
    uint,
    number,
    string,
    namespace,
    other,
    float,
};

/// As isCompatibleOverrideKind: whether `over` may implement a binding of kind `base`.
pub fn compatibleKind(base: BindingKind, over: BindingKind) bool {
    if (base == .method) {
        return over == .method;
    }

    return base.isAccessor() and over.isAccessor();
}

/// The scope chain a method is created in (avmplus' ScopeTypeChain): the
/// types of its `size` entries, and whether each is a with scope. An `extra`
/// type other than * constrains the method's first own scope, as for
/// class methods, whose `this` must be of their class.
pub const Scope = struct {
    size: u32 = 0,
    types: []TypeId = &.{},
    withs: []u8 = &.{},
    extra: TypeId = .any,

    /// Where a contested function's creators' chains differ in length (merged):
    /// how many entries they share, the index of the one entry after them that
    /// stands for the rest of whichever chain the function runs in; else -1.
    pack: i32 = -1,

    /// The scope chains `scopes` merged, for a function created in each: the
    /// entries of the shortest, each the type all have there; where they
    /// differ, of no type and a with scope, which binds nothing early, so
    /// that a name found nowhere before it is looked up along whichever
    /// chain the function runs in rather than in the global object alone.
    ///
    /// Chains of different lengths get one more such entry, the pack: what
    /// the chain the function runs in has past the shortest is put into it
    /// at run time (Runtime.packScope) and searched there.
    pub fn merged(gpa: Allocator, scopes: []const *const Scope) Allocator.Error!*Scope {
        const first = scopes[0];
        var size = first.size;
        var extra = first.extra;
        var uneven = false;
        for (scopes[1..]) |s| {
            uneven = uneven or s.size != first.size;
            size = @min(size, s.size);
            if (s.extra != first.extra) {
                extra = .any;
            }
        }

        const count = size + @intFromBool(uneven);
        const result = try gpa.create(Scope);
        result.* = .{ .size = count, .types = try gpa.alloc(TypeId, count), .withs = try gpa.alloc(u8, count), .extra = extra };
        for (0..size) |i| {
            const ty = first.types[i];
            var withs = first.withs[i];
            var differs = false;
            for (scopes[1..]) |s| {
                if (s.types[i] != ty) {
                    differs = true;
                }

                withs |= s.withs[i];
            }

            result.types[i] = if (differs) .any else ty;
            result.withs[i] = if (differs) 1 else withs;
        }

        if (uneven) {
            result.pack = @intCast(size);
            result.types[size] = .any;
            result.withs[size] = 1;
        }

        return result;
    }

    /// As ScopeTypeChain::equals.
    pub fn equals(self: *const Scope, other: *const Scope) bool {
        if (self.size != other.size or self.extra != other.extra or self.pack != other.pack) {
            return false;
        }

        for (0..self.size) |i| {
            if (self.types[i] != other.types[i] or self.withs[i] != other.withs[i]) {
                return false;
            }
        }

        return true;
    }
};

/// Every scope chain a function was created in, the first first.
pub const Scopes = std.ArrayList(*Scope);

pub const TraitsTable = struct {
    kind: Rows(TraitsKind) = .{},
    abc: Rows(u32) = .{},
    /// The class, script or body index in its ABC.
    owner: Rows(u32) = .{},
    /// The traits whose members these inherit, or none.
    base: Rows(TypeRef) = .{},
    /// Namespace id of the protected namespace, or -1.
    protectedNs: Rows(i32) = .{},
    isInterface: Rows(u8) = .{},
    /// Where these traits' traits_info entries are in their ABC's trait tables.
    first: Rows(u32) = .{},
    end: Rows(u32) = .{},
    /// Including the base's.
    slotCount: Rows(u32) = .{},
    methodCount: Rows(u32) = .{},
    /// These traits' own members are members [memberStart, memberEnd).
    memberStart: Rows(u32) = .{},
    memberEnd: Rows(u32) = .{},
    /// The interfaces a class names, as traits: interfaceList[interfaceStart, interfaceEnd).
    interfaceStart: Rows(u32) = .{},
    interfaceEnd: Rows(u32) = .{},
    interfaceList: Rows(u32) = .{},
    /// For Vector.<T> with T other than int, uint, Number and *, T; else *.
    param: Rows(TypeId) = .{},
    /// The initializer method (global id), or -1.
    init: Rows(i32) = .{},
    /// The scope chain the traits' methods are created in, once known.
    scope: Rows(?*Scope) = .{},

    memberTraits: Rows(u32) = .{},
    memberNs: Rows(u32) = .{},
    memberName: Rows(u32) = .{},
    memberVersion: Rows(u8) = .{},
    memberBinding: Rows(Binding) = .{},
    members: IdTable,

    // Filled when resolved: each slot's type and each dispatch id's method,
    // the base's included, at slotType[slotStart ..] and dispatch[dispatchStart ..].
    resolved: Rows(u8) = .{},
    slotStart: Rows(u32) = .{},
    dispatchStart: Rows(u32) = .{},
    slotType: Rows(TypeId) = .{},
    slotSet: Rows(u8) = .{},
    dispatch: Rows(i32) = .{},

    // Methods by domain-wide id; ABC a's method m is Domain.methodStart[a] + m.
    /// The traits each method is bound to, if any.
    methodTraits: Rows(TypeRef) = .{},
    methodFinal: Rows(u8) = .{},
    /// Bound by a method, getter or setter trait, not as an initializer.
    methodVirtual: Rows(u8) = .{},
    /// Made by newfunction rather than bound to traits: its receiver is Object.
    methodFunction: Rows(u8) = .{},
    /// A function that takes extra arguments without a rest array, as avmplus' _ignoreRest.
    ignoresRest: Rows(u8) = .{},
    /// A function's scope chain, captured by newfunction: the first one.
    functionScope: Rows(?*Scope) = .{},
    /// Every scope chain a function was created in, the first first (see captureFunction).
    functionScopes: Rows(?*Scopes) = .{},
    /// Created in scope chains that differ by methods of their own, which
    /// avmplus verifies as each first runs: the first to run takes the
    /// function and the others fail. Verified and compiled in functionMerged.
    functionContested: Rows(u8) = .{},
    /// A contested function's scope chain: its creators' where they agree, of any type where not.
    functionMerged: Rows(?*Scope) = .{},
    signed: Rows(u8) = .{},
    returnType: Rows(TypeId) = .{},
    receiverType: Rows(TypeId) = .{},
    /// Parameter types, at paramType[paramStart ..], and how many are optional.
    paramStart: Rows(u32) = .{},
    paramCount: Rows(u32) = .{},
    optionalCount: Rows(u32) = .{},
    paramType: Rows(TypeId) = .{},

    // The member name read by readName.
    nameNs: u32 = 0,
    nameNsVersion: u8 = 0,
    nameVersion: u8 = 0,
    nameId: u32 = 0,

    pub fn empty(gpa: Allocator) Allocator.Error!TraitsTable {
        return .{ .members = try .init(gpa) };
    }

    /// New traits over traits_info entries [first, end) of ABC `abc`.
    pub fn create(self: *TraitsTable, gpa: Allocator, kind: TraitsKind, abc: u32, owner: u32, base: TypeRef, protectedNs: i32, first: u32, end: u32) Allocator.Error!u32 {
        const t = self.kind.len;
        try self.kind.push(gpa, kind);
        try self.abc.push(gpa, abc);
        try self.owner.push(gpa, owner);
        try self.base.push(gpa, base);
        try self.protectedNs.push(gpa, protectedNs);
        try self.isInterface.push(gpa, 0);
        try self.first.push(gpa, first);
        try self.end.push(gpa, end);
        try self.slotCount.push(gpa, 0);
        try self.methodCount.push(gpa, 0);
        try self.memberStart.push(gpa, 0);
        try self.memberEnd.push(gpa, 0);
        try self.interfaceStart.push(gpa, 0);
        try self.interfaceEnd.push(gpa, 0);
        try self.param.push(gpa, .any);
        try self.init.push(gpa, -1);
        try self.scope.push(gpa, null);
        try self.resolved.push(gpa, 0);
        try self.slotStart.push(gpa, 0);
        try self.dispatchStart.push(gpa, 0);
        return t;
    }

    /// Forget traits from `count` on, left by an ABC that failed to link.
    pub fn truncate(self: *TraitsTable, count: u32) void {
        self.kind.truncate(count);
        self.abc.truncate(count);
        self.owner.truncate(count);
        self.base.truncate(count);
        self.protectedNs.truncate(count);
        self.isInterface.truncate(count);
        self.first.truncate(count);
        self.end.truncate(count);
        self.slotCount.truncate(count);
        self.methodCount.truncate(count);
        self.memberStart.truncate(count);
        self.memberEnd.truncate(count);
        self.interfaceStart.truncate(count);
        self.interfaceEnd.truncate(count);
        self.param.truncate(count);
        self.init.truncate(count);
        self.scope.truncate(count);
        self.resolved.truncate(count);
        self.slotStart.truncate(count);
        self.dispatchStart.truncate(count);
    }

    /// As MethodInfo::declaringScope: the scope chain method m runs in, or null if not yet known.
    pub fn scopeOf(self: *const TraitsTable, m: u32) ?*Scope {
        if (self.methodFunction.get(m) != 0) {
            const merged = if (self.functionContested.get(m) != 0) self.functionMerged.get(m) else null;
            return merged orelse self.functionScope.get(m);
        }

        const t = self.methodTraits.get(m);
        return if (t == .none) null else self.scope.get(t.index());
    }

    /// Room for `count` more methods, unbound and unsigned.
    pub fn addMethods(self: *TraitsTable, gpa: Allocator, count: u32) Allocator.Error!void {
        for (0..count) |_| {
            try self.methodTraits.push(gpa, .none);
            try self.methodFinal.push(gpa, 0);
            try self.methodVirtual.push(gpa, 0);
            try self.methodFunction.push(gpa, 0);
            try self.functionScope.push(gpa, null);
            try self.functionScopes.push(gpa, null);
            try self.functionContested.push(gpa, 0);
            try self.functionMerged.push(gpa, null);
            try self.ignoresRest.push(gpa, 0);
            try self.signed.push(gpa, 0);
            try self.returnType.push(gpa, .any);
            try self.receiverType.push(gpa, .any);
            try self.paramStart.push(gpa, 0);
            try self.paramCount.push(gpa, 0);
            try self.optionalCount.push(gpa, 0);
        }
    }

    pub fn truncateMethods(self: *TraitsTable, count: u32) void {
        self.methodTraits.truncate(count);
        self.methodFinal.truncate(count);
        self.methodVirtual.truncate(count);
        self.methodFunction.truncate(count);
        self.functionScope.truncate(count);
        self.functionScopes.truncate(count);
        self.functionContested.truncate(count);
        self.functionMerged.truncate(count);
        self.ignoresRest.truncate(count);
        self.signed.truncate(count);
        self.returnType.truncate(count);
        self.receiverType.truncate(count);
        self.paramStart.truncate(count);
        self.paramCount.truncate(count);
        self.optionalCount.truncate(count);
    }

    /// The binding of `name` in `ns` among t's own members, visible at `version`.
    pub fn own(self: *const TraitsTable, t: u32, ns: u32, name: u32, version: u8) Binding {
        const hash = hashPair(hashPair(t, ns), name);
        const members = &self.members;
        var slot = members.start(hash);
        while (true) {
            const id = members.at(slot);
            if (id < 0) {
                return Binding.none;
            }

            const m: u32 = @intCast(id);
            // The slot's hash first: most slots a probe passes hold another key.
            if (members.hashAt(slot) == hash and
                self.memberTraits.get(m) == t and
                self.memberNs.get(m) == ns and
                self.memberName.get(m) == name and
                self.memberVersion.get(m) <= version and
                // Members of traits that failed to link may remain in the table.
                m >= self.memberStart.get(t) and
                m < self.memberEnd.get(t))
            {
                return self.memberBinding.get(m);
            }

            slot = members.next(slot);
        }
    }

    /// As TraitsBindings::findBinding: t's own members, then its base's.
    pub fn find(self: *const TraitsTable, type_: TypeId, ns: u32, name: u32, version: u8) Binding {
        return self.findFrom(.ofType(type_), ns, name, version);
    }

    /// find from traits `ref`, none finding nothing.
    pub fn findFrom(self: *const TraitsTable, ref: TypeRef, ns: u32, name: u32, version: u8) Binding {
        var t = ref;
        while (t != .none) : (t = self.base.get(t.index())) {
            const b = self.own(t.index(), ns, name, version);
            if (b != Binding.none) {
                return b;
            }
        }

        return Binding.none;
    }

    /// As TraitsBindings::findBinding by name alone: the first member named
    /// `name` in any namespace of t or its bases.
    pub fn findName(self: *const TraitsTable, type_: TypeId, name: u32) Binding {
        var t = TypeRef.ofType(type_);
        while (t != .none) : (t = self.base.get(t.index())) {
            const last = self.memberEnd.get(t.index());
            var m = self.memberStart.get(t.index());
            while (m < last) : (m += 1) {
                if (self.memberName.get(m) == name) {
                    return self.memberBinding.get(m);
                }
            }
        }

        return Binding.none;
    }

    /// Bind a member of t, replacing one with the same name, namespace and version.
    pub fn add(self: *TraitsTable, gpa: Allocator, t: u32, ns: u32, name: u32, version: u8, binding: Binding) Allocator.Error!void {
        const hash = hashPair(hashPair(t, ns), name);
        const start = self.memberStart.get(t);
        var slot = self.members.start(hash);
        while (self.members.at(slot) >= 0) : (slot = self.members.next(slot)) {
            const m: u32 = @intCast(self.members.at(slot));
            if (m >= start and
                self.memberTraits.get(m) == t and
                self.memberNs.get(m) == ns and
                self.memberName.get(m) == name and
                self.memberVersion.get(m) == version)
            {
                // A member of t, which its own link adds: never one from before the call.
                self.memberBinding.set(m, binding);
                return;
            }
        }

        const id = self.memberTraits.len;
        try self.memberTraits.push(gpa, t);
        try self.memberNs.push(gpa, ns);
        try self.memberName.push(gpa, name);
        try self.memberVersion.push(gpa, version);
        try self.memberBinding.push(gpa, binding);
        try self.members.insert(gpa, hash, id);
        self.memberEnd.set(t, id + 1);
    }

    /// Read the name of trait `i` of ABC `index` into nameNs and nameId: its
    /// first namespace, whose own version is nameNsVersion, and nameVersion,
    /// the earliest version of its namespaces in the domain's series.
    pub fn readName(self: *TraitsTable, dom: *const Domain, index: u32, i: u32) void {
        const abc = dom.abcs.get(index);
        const pool = &abc.pool;
        const versions = dom.abcNsVersion.get(index);
        var mn = abc.traitName[i];
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

        self.nameNs = dom.abcNs.get(index)[ns];
        self.nameNsVersion = versions[ns];
        self.nameVersion = version;
        self.nameId = dom.abcString.get(index)[pool.mnB[mn]];
    }

    /// As Traits::allowEarlyBinding: slot ids from the ABC count only if no
    /// base with slots comes from another ABC, so early slot access cannot
    /// reach another ABC's private members.
    pub fn allowEarlyBinding(self: *const TraitsTable, t: u32) bool {
        const abc = self.abc.get(t);
        var b = self.base.get(t);
        while (b != .none) : (b = self.base.get(b.index())) {
            if (self.slotCount.get(b.index()) == 0) {
                break;
            }

            if (self.abc.get(b.index()) != abc) {
                return false;
            }
        }

        return true;
    }

    /// Every interface t implements, its bases' and the interfaces' own
    /// included, once each, in the order AssemblyScript's recursive walk
    /// finds them: each interface listed, then the ones it extends. The
    /// walk keeps its own stack, as the chain is as deep as the input
    /// makes it. Quadratic in the interfaces, as AssemblyScript's
    /// `includes` is.
    pub fn allInterfaces(self: *const TraitsTable, scratch: Allocator, t: u32) Allocator.Error![]u32 {
        var all: std.ArrayList(u32) = .empty;
        var stack: std.ArrayList(InterfaceFrame) = .empty;
        var c = TypeRef.of(t);
        while (c != .none) : (c = self.base.get(c.index())) {
            // Most bases name none: nothing taken for them, along a chain as long as the input's.
            if (self.interfaceStart.get(c.index()) != self.interfaceEnd.get(c.index())) {
                try self.addInterfaces(scratch, c.index(), &all, &stack);
            }
        }

        return all.items;
    }

    /// One traits' interfaces, as a frame of the walk: where in its list it is.
    const InterfaceFrame = struct { next: u32, end: u32 };

    fn addInterfaces(self: *const TraitsTable, scratch: Allocator, t: u32, all: *std.ArrayList(u32), stack: *std.ArrayList(InterfaceFrame)) Allocator.Error!void {
        try stack.append(scratch, .{ .next = self.interfaceStart.get(t), .end = self.interfaceEnd.get(t) });
        while (stack.items.len > 0) {
            const top = &stack.items[stack.items.len - 1];
            if (top.next == top.end) {
                _ = stack.pop();
                continue;
            }

            const ifc = self.interfaceList.get(top.next);
            top.next += 1;
            if (std.mem.indexOfScalar(u32, all.items, ifc) == null) {
                try all.append(scratch, ifc);
                try stack.append(scratch, .{ .next = self.interfaceStart.get(ifc), .end = self.interfaceEnd.get(ifc) });
            }
        }
    }

    /// As Traits::subtypeof: t is s, extends it, or implements it.
    pub fn subtypeOf(self: *const TraitsTable, scratch: Allocator, t: u32, s: u32) Allocator.Error!bool {
        var c = TypeRef.of(t);
        while (c != .none) : (c = self.base.get(c.index())) {
            if (c.index() == s) {
                return true;
            }
        }

        return std.mem.indexOfScalar(u32, try self.allInterfaces(scratch, t), s) != null;
    }

    /// As Traits::resolveSignatures: resolve t's supertypes, then t's slot
    /// types and initial values, its methods' signatures, and check its
    /// overrides and interfaces. AssemblyScript recurses into the base and
    /// then each interface; this keeps their frames on a stack of its own in
    /// the call's arena, so that a chain as deep as the input makes it
    /// resolves in the same order, the first error ending every frame.
    pub fn resolve(self: *TraitsTable, dom: *Domain, t: u32, diag: *Diagnostics) Error!void {
        dom.changing();
        if (self.resolved.get(t) != 0) {
            return;
        }

        const Frame = struct {
            t: u32,
            /// 0 before the base, 1 after it, 2 among the interfaces.
            stage: u8 = 0,
            interfaces: []u32 = &.{},
            next: usize = 0,
        };
        var stack: std.ArrayList(Frame) = .empty;
        try stack.append(dom.scratch, .{ .t = t });
        while (stack.items.len > 0) {
            const frame = &stack.items[stack.items.len - 1];
            switch (frame.stage) {
                0 => {
                    if (self.resolved.get(frame.t) != 0) {
                        _ = stack.pop();
                        continue;
                    }

                    frame.stage = 1;
                    const base = self.base.get(frame.t);
                    if (base != .none) {
                        try stack.append(dom.scratch, .{ .t = base.index() });
                    }
                },
                1 => {
                    frame.interfaces = try self.allInterfaces(dom.scratch, frame.t);
                    frame.stage = 2;
                },
                else => {
                    if (frame.next < frame.interfaces.len) {
                        const ifc = frame.interfaces[frame.next];
                        frame.next += 1;
                        try stack.append(dom.scratch, .{ .t = ifc });
                        continue;
                    }

                    const done = stack.pop().?;
                    try self.resolveOwn(dom, done.t, done.interfaces, diag);
                },
            }
        }
    }

    /// Whether t resolves, for a caller with no use for the VerifyError.
    /// Out of line: inlined into the module's walks, it cost 461 bytes and
    /// no time those walks would notice.
    pub noinline fn resolves(self: *TraitsTable, dom: *Domain, t: u32) Allocator.Error!bool {
        var diag: Diagnostics = .{};
        self.resolve(dom, t, &diag) catch |err| return switch (err) {
            error.Verify => false,
            error.OutOfMemory => error.OutOfMemory,
        };
        return true;
    }

    /// resolve for traits whose supertypes have resolved: what t itself resolves.
    fn resolveOwn(self: *TraitsTable, dom: *Domain, t: u32, interfaces: []const u32, diag: *Diagnostics) Error!void {
        const base = self.base.get(t);
        try signatures.resolveSlotsAndMethods(self, dom, t, diag);
        try signatures.checkInitialValues(self, dom, t, diag);

        // Every method's signature, then the initializer's.
        const dispatch = self.dispatchStart.get(t);
        for (0..self.methodCount.get(t)) |d| {
            const m = self.dispatch.get(dispatch + @as(u32, @intCast(d)));
            if (m >= 0) {
                try self.sign(dom, @intCast(m), diag);
            }
        }

        const initializer = self.init.get(t);
        if (initializer >= 0) {
            try self.sign(dom, @intCast(initializer), diag);
        }

        var legal = true;
        if (base != .none) {
            const baseDispatch = self.dispatchStart.get(base.index());
            for (0..self.methodCount.get(base.index())) |d| {
                const virt = self.dispatch.get(baseDispatch + @as(u32, @intCast(d)));
                const over = self.dispatch.get(dispatch + @as(u32, @intCast(d)));
                if (virt >= 0 and virt != over) {
                    legal = legal and try signatures.checkOverride(self, dom, t, @intCast(virt), over);
                }
            }
        }

        if (legal and self.isInterface.get(t) == 0) {
            legal = try signatures.checkInterfaces(self, dom, t, interfaces);
        }

        if (!legal) {
            return diag.fail(.kIllegalOverrideError);
        }

        try dom.put(self.resolved.at(t), 1);
        try dom.loggedResolve(t);
    }

    /// As MethodInfo::resolveSignature: resolve method m's return type (void
    /// allowed), parameter types (not), receiver, and check its optional
    /// parameters' default values.
    pub fn sign(self: *TraitsTable, dom: *Domain, m: u32, diag: *Diagnostics) Error!void {
        dom.changing();
        if (self.signed.get(m) != 0) {
            return;
        }

        const index = dom.methodAbc(m);
        const abc = dom.abcs.get(index);
        const local = m - dom.methodStart.get(index);
        const returnType = try typenames.resolveTypeId(dom, index, abc.methodReturnType[local], true, diag);

        const first = abc.methodParamStart[local];
        const count = abc.methodParamStart[local + 1] - first;
        const start = self.paramType.len;
        for (0..count) |p| {
            const ty = typenames.resolveTypeId(dom, index, abc.paramTypes[first + @as(u32, @intCast(p))], false, diag) catch |err| {
                self.paramType.truncate(start);
                return err;
            };

            try self.paramType.push(dom.gpa, ty);
        }

        const optionalFirst = abc.methodOptionalStart[local];
        const optional = abc.methodOptionalStart[local + 1] - optionalFirst;
        for (0..optional) |j_| {
            const j: u32 = @intCast(j_);
            const ty = self.paramType.get(start + count - optional + j);
            dom.checkDefault(index, abc.optionalValue[optionalFirst + j], abc.optionalKind[optionalFirst + j], ty, diag) catch |err| {
                self.paramType.truncate(start);
                return err;
            };
        }

        // As avmplus' unchecked-function hack: a function with only untyped
        // parameters and result takes them all as optional.
        var optionalCount = optional;
        if (self.methodFunction.get(m) != 0 and optional == 0 and returnType == .any and count > 0) {
            var untyped = true;
            for (0..count) |p| {
                untyped = untyped and self.paramType.get(start + @as(u32, @intCast(p))) == .any;
            }

            if (untyped) {
                optionalCount = count;
                try dom.put(self.ignoresRest.at(m), 1);
            }
        }

        if (self.methodFunction.get(m) != 0 and count == 0) {
            try dom.put(self.ignoresRest.at(m), 1);
        }

        const owner = self.methodTraits.get(m);
        try dom.put(self.returnType.at(m), returnType);
        try dom.put(self.receiverType.at(m), if (owner != .none) owner.toType() else dom.objectType());
        try dom.put(self.paramStart.at(m), start);
        try dom.put(self.paramCount.at(m), count);
        try dom.put(self.optionalCount.at(m), optionalCount);
        try dom.put(self.signed.at(m), 1);
        try dom.logged(.sign, index, 0, local);
    }

    /// Whether method m signs, for a caller with no use for the VerifyError.
    pub fn signs(self: *TraitsTable, dom: *Domain, m: u32) Allocator.Error!bool {
        var diag: Diagnostics = .{};
        self.sign(dom, m, &diag) catch |err| return switch (err) {
            error.Verify => false,
            error.OutOfMemory => error.OutOfMemory,
        };
        return true;
    }
};

/// AssemblyScript's f64 to i32 and u32 conversions, which saturate, NaN to 0.
fn toI32(x: f64) f64 {
    if (std.math.isNan(x)) {
        return 0;
    }

    return @floatFromInt(@as(i32, @intFromFloat(std.math.clamp(@trunc(x), -2147483648.0, 2147483647.0))));
}

fn toU32(x: f64) f64 {
    if (std.math.isNan(x)) {
        return 0;
    }

    return @floatFromInt(@as(u32, @intFromFloat(std.math.clamp(@trunc(x), 0.0, 4294967295.0))));
}

/// As PoolObject::isLegalDefaultValue and getLegalDefaultValue: whether
/// default value `value` suits a slot or parameter of builtin type `bt`;
/// a number's value matters only for int and uint.
pub fn legalDefault(bt: Builtin, value: Value) bool {
    if (bt == .any) {
        return true;
    }

    const number: ?f64 = switch (value) {
        .int => |n| @floatFromInt(n),
        .uint => |n| @floatFromInt(n),
        .double => |n| n,
        .float => |n| n,
        .string, .boolean, .null, .namespace => null,
    };
    return switch (bt) {
        .object => true,
        .float, .number => number != null,
        .boolean => value == .boolean,
        .int => if (number) |n| n == toI32(n) and n >= -2147483648 and n <= 2147483647 else false,
        .uint => if (number) |n| n == toU32(n) and n >= 0 and n <= 4294967295 else false,
        .string => value == .null or value == .string,
        .namespace => value == .null or value == .namespace,
        else => value == .null,
    };
}

const testing = std.testing;

test "a binding is the word id << 3 | kind, both ways" {
    const words = [_]u32{ 0, 1, 2 << 3 | 2, 12 << 3 | 3, 7 << 3 | 5, 7 << 3 | 6, 7 << 3 | 7, 0x1fffffff << 3 | 1, 0xffffffff };
    for (words) |word| {
        const b: Binding = @bitCast(word);
        try testing.expectEqual(word & 7, @backingInt(b.kind));
        try testing.expectEqual(word >> 3, b.id);
        try testing.expectEqual(word, @as(u32, @bitCast(Binding.of(word >> 3, b.kind))));
    }

    try testing.expectEqual(@as(u32, 0), @as(u32, @bitCast(Binding.none)));
    try testing.expectEqual(@as(u32, 0xffffffff), @as(u32, @bitCast(Binding.ambiguous)));
    // An id past 29 bits loses its top bits, as id << 3 in a u32 did.
    const wide: u32 = 0xe0000005;
    try testing.expectEqual(wide << 3 | 1, @as(u32, @bitCast(Binding.of(wide, .method))));
}

test "int and uint defaults are numbers they hold exactly" {
    try testing.expect(legalDefault(.int, .{ .double = -2147483648 }));
    try testing.expect(!legalDefault(.int, .{ .double = 2147483648 }));
    try testing.expect(!legalDefault(.int, .{ .double = 1.5 }));
    try testing.expect(!legalDefault(.int, .{ .double = std.math.nan(f64) }));
    try testing.expect(legalDefault(.uint, .{ .double = 4294967295 }));
    try testing.expect(!legalDefault(.uint, .{ .double = -1 }));
    try testing.expect(legalDefault(.string, .null));
    try testing.expect(!legalDefault(.boolean, .null));
}

test "an override meets accessors with accessors and methods with methods" {
    try testing.expect(compatibleKind(.method, .method));
    try testing.expect(!compatibleKind(.method, .get));
    try testing.expect(compatibleKind(.get, .get_set));
    try testing.expect(!compatibleKind(.variable, .variable));
}
