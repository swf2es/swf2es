// A domain: the ABCs loaded together, the names their scripts define, and
// their classes, linked to their base classes and interfaces
// (assembly/avm2/link/domain.ts, whose comment tells the rules). Strings and
// namespaces are interned across ABCs, so a name is a pair of ids however
// many ABCs spell it.
//
// Memory (docs/zig-codegen.md, section 2, M1): every row of the domain's,
// and the ABCs' bytes and parsed tables, are in one arena, `gpa`, which a
// reset gives back whole; what a call only needs meanwhile goes to the
// call's arena, `scratch`. A call that changes the domain and runs out of
// memory leaves it as it was (see Change): its appends dropped with the
// arena's mark, its writes to rows from before the call undone (`put`).
const std = @import("std");
const Allocator = std.mem.Allocator;
const options = @import("options");
const memory = @import("../../memory.zig");
const Rows = memory.Rows;
const Abc = @import("../abc/abc.zig").Abc;
const errors = @import("../abc/errors.zig");
const Diagnostics = errors.Diagnostics;
const C = @import("../abc/constants.zig");
const ConstantPool = @import("../abc/pool.zig").ConstantPool;
const BodyDecoder = @import("../abc/code.zig").BodyDecoder;
const readAbc = @import("../abc/parse.zig").readAbc;
const PADDING = @import("../abc/reader.zig").PADDING;
const classes = @import("classes.zig");
const namespaces = @import("namespaces.zig");
const table = @import("table.zig");
const IdTable = table.IdTable;
const traits_ = @import("traits.zig");
const TraitsTable = traits_.TraitsTable;
const TypeId = traits_.TypeId;
const TypeRef = traits_.TypeRef;
const typenames = @import("typenames.zig");
const types = @import("types.zig");
const domain_queries = @import("domain/queries.zig");
const domain_names = @import("domain/names.zig");

/// A namespace's type, as avmplus' Namespace::NamespaceType tells names
/// apart. domainFound (an export) and the saved found entries carry it, so
/// its values are fixed; non-exhaustive, as a found entry's is taken as
/// given, as it was as a byte.
pub const NsType = enum(u8) {
    public = 0,
    package_internal = 1,
    protected = 2,
    explicit = 3,
    static_protected = 4,
    private = 5,
    _,

    /// The one reading of a word, a save's or an export's: its low byte.
    /// A save's word above 0xff is refused before (saved.zig's SaveReader.kind).
    pub fn fromWord(word: u32) @This() {
        return @fromBackingInt(@as(u8, @truncate(word)));
    }
};

/// avmplus' ApiVersion values that swf2es needs; see core/api-versions.h.
pub const API_AllVersions: u8 = 0;
pub const API_FP_10_0: u8 = 2;
/// kApiVersionLatest for Flash Player (SWF_31), avmshell's default.
pub const API_LatestFP: u8 = 50;
pub const API_Internal: u8 = 52;
/// The URI of a namespace written with string index 0.
pub const URI_None: u32 = 0xffffffff;

/// An application domain's state: live; evicted, let go of until the host
/// gives its ABCs again (see evict in lifetime.zig); or dropped for good.
/// Saved with the domain, so its values are fixed; non-exhaustive, and a
/// loaded save naming another is refused (saved.zig's consistent).
pub const DomainState = enum(u8) {
    live = 0,
    evicted = 1,
    dropped = 2,
    _,

    /// The one reading of a word, a save's or an export's: its low byte.
    /// A save's word above 0xff is refused before (saved.zig's SaveReader.kind).
    pub fn fromWord(word: u32) @This() {
        return @fromBackingInt(@as(u8, @truncate(word)));
    }

    /// Whether it is one of the named states, not a corrupt number.
    pub fn isNamed(state: DomainState) bool {
        return switch (state) {
            .live, .evicted, .dropped => true,
            _ => false,
        };
    }

    /// Whether it is nearer live than `other`. The order live, evicted,
    /// dropped is the tags' and is meant: a domain only moves away from
    /// live, but by revival, and a child is never nearer live than its
    /// parent.
    pub fn nearerLive(state: DomainState, other: DomainState) bool {
        return @backingInt(state) < @backingInt(other);
    }

    /// Of two states, the one further from live: dropped, then evicted.
    pub fn furthest(a: DomainState, b: DomainState) DomainState {
        return @fromBackingInt(@max(@backingInt(a), @backingInt(b)));
    }
};

/// What an ABC weighs for each of its bytes before it links: them, and what parsing them took.
pub const ABC_Weight: u64 = 3;

/// The kinds of the log's entries (see Domain.logKind). Saved and
/// journaled, so their values are fixed. Non-exhaustive: a loaded save's
/// entry of another kind, or a word above 0xff, is refused at load
/// (saved.zig's SaveReader.kind and consistent); journal text's is refused
/// by replayEntry, which takes no kind past verify, and by replayed, which
/// does only verify, sign and resolve.
pub const LogKind = enum(u8) {
    /// An entry undone in place (a verification left before its end).
    none = 0,
    /// A finding, by its index in the found tables.
    found = 1,
    /// Traits resolved, by their kind and owner in their ABC.
    resolve = 2,
    /// A method signed, by its index in its ABC.
    sign = 3,
    /// An ABC verified for the first time, or finding scopes for the first time.
    verify = 4,
    _,

    /// The one reading of a word, a save's or an export's: its low byte.
    /// A save's word above 0xff is refused before (saved.zig's SaveReader.kind).
    pub fn fromWord(word: u32) @This() {
        return @fromBackingInt(@as(u8, @truncate(word)));
    }

    /// Whether it is one of the named kinds, not a corrupt number.
    pub fn isNamed(kind: LogKind) bool {
        return switch (kind) {
            .none, .found, .resolve, .sign, .verify => true,
            _ => false,
        };
    }
};

/// How many reads past the end of a namespace set's members the last call
/// made, where AssemblyScript's unchecked read gives whatever memory is
/// next (an empty last set, which a mutated ABC can give a name): Zig's
/// give namespace 0. The test build reports it, for the parity harness to
/// take such a case as unspecified.
pub var unspecified: u32 = 0;

/// The first member of namespace set `set`, as AssemblyScript reads
/// `nsSetMembers[nsSetStart[set]]`.
pub fn firstMember(pool: *const ConstantPool, set: u32) u32 {
    const at = pool.nsSetStart[set];
    if (at >= pool.nsSetMembers.len) {
        unspecified +%= 1;
        return 0;
    }

    return pool.nsSetMembers[at];
}

/// The old values of the rows a call wrote that it did not add, to put
/// back if it runs out of memory.
pub const Undo = struct {
    /// Rows that never move, so that a long journal leaves no outgrown copies in the call's arena.
    entries: Rows(Entry) = .{},

    const Entry = struct { at: usize, size: u8, old: u64 };

    fn record(self: *Undo, scratch: Allocator, ptr: anytype) Allocator.Error!void {
        const T = @TypeOf(ptr.*);
        comptime std.debug.assert(@sizeOf(T) <= 8);
        var old: u64 = 0;
        @memcpy(std.mem.asBytes(&old)[0..@sizeOf(T)], std.mem.asBytes(ptr));
        try self.entries.push(scratch, .{ .at = @intFromPtr(ptr), .size = @sizeOf(T), .old = old });
    }

    fn rollBack(self: *Undo) void {
        var i = self.entries.len;
        while (i > 0) {
            i -= 1;
            const entry = self.entries.get(i);
            const at: [*]u8 = @ptrFromInt(entry.at);
            @memcpy(at[0..entry.size], std.mem.asBytes(&entry.old)[0..entry.size]);
        }
    }
};

/// A call that changes the domain, all or nothing: begun before, and on
/// running out of memory rolled back to the domain, its arena and its
/// rows as they were (memory.zig's `atEveryMemorySize` holds it to that).
pub const Change = struct {
    saved: Domain,
    mark: memory.Arena.Mark,
    undo: Undo = .{},

    /// `change` must stay where it is until done or rolled back: the domain points at its journal.
    pub fn begin(change: *Change, dom: *Domain, arena: *memory.Arena) void {
        // One Change at a time: a nested one would take the outer's journal.
        std.debug.assert(dom.undo == null);
        // A decoder of an earlier call is in what its arena gave back.
        dom.decoder = null;
        change.* = .{ .saved = dom.*, .mark = arena.mark() };
        change.saved.undo = null;
        dom.undo = &change.undo;
        dom.memoCleared = false;
        dom.truncated = null;
        change.saved.truncated = null;
    }

    pub fn done(_: *Change, dom: *Domain) void {
        dom.undo = null;
        dom.truncated = null;
    }

    pub fn rollBack(change: *Change, dom: *Domain, arena: *memory.Arena) void {
        const cleared = dom.memoCleared;
        const truncated = dom.truncated;
        change.undo.rollBack();
        dom.* = change.saved;
        // A row from before the Change, truncated and maybe written over by
        // a push since: its length is back, and its values with it.
        if (truncated) |t| {
            if (t.entry < dom.logKind.len) {
                dom.logKind.set(t.entry, t.kind);
                dom.logAt.set(t.entry, t.at);
                dom.logAbc.set(t.entry, t.abc);
                dom.logA.set(t.entry, t.a);
                dom.logB.set(t.entry, t.b);
            }
        }

        dom.strings.forgetFrom(dom.stringPtr.len);
        dom.namespaces.forgetFrom(dom.nsType.len);
        dom.bindings.forgetFrom(dom.bindingNs.len);
        dom.types.forgetFrom(dom.typeNs.len);
        dom.cached.forgetFrom(dom.cachedDomain.len);
        dom.catchScopes.forgetFrom(dom.catchKey.len);
        dom.vectorOf.forgetFrom(dom.vectorParam.len);
        dom.traits.members.forgetFrom(dom.traits.memberTraits.len);
        // A cache: its answers from before the call kept, as a retry then
        // finds and weighs them as the call would have; unless the call
        // cleared it, and wrote over its rows from the first.
        if (cleared) {
            dom.clearBindingMemo();
        } else {
            dom.bindingMemo.forgetFrom(dom.memoType.len);
        }

        arena.restore(change.mark);
    }
};

/// `change` called with `dom` and `args`, all or nothing: running out of
/// memory leaves `dom` and `arena`, its arena, as they were.
pub fn changed(dom: *Domain, arena: *memory.Arena, comptime change: anytype, args: anytype) Allocator.Error!@typeInfo(@typeInfo(@TypeOf(change)).@"fn".return_type.?).error_union.payload {
    var c: Change = undefined;
    c.begin(dom, arena);
    const result = @call(.auto, change, .{dom} ++ args) catch |err| {
        c.rollBack(dom, arena);
        return err;
    };
    c.done(dom);
    return result;
}

/// Parse a domain-owned copy. An in-place rebuild will need this space again beside the old domain.
pub fn parseOwned(arena: *memory.Arena, scratch: Allocator, bytes: []const u8, builtin: bool) Allocator.Error!struct { *Abc, []u8 } {
    const mark = arena.mark();
    const gpa = arena.allocator();
    const buffer = try memory.allocZeroed(gpa, u8, @as(u32, @intCast(bytes.len)) + PADDING);
    @memcpy(buffer[0..bytes.len], bytes);
    const abc = try readAbc(gpa, scratch, buffer, @intCast(bytes.len), builtin);
    abc.parsed_bytes = arena.bytesSince(mark);
    return .{ abc, buffer };
}

/// Add the ABC `bytes` to application domain `appDomain`, copied with
/// PADDING into `arena`, the domain's: 0, or the VerifyError it was
/// rejected with. One that does not parse leaves nothing: its bytes and
/// tables are the last the arena took.
pub fn addAbc(dom: *Domain, arena: *memory.Arena, bytes: []const u8, builtin: bool, appDomain: u32) Allocator.Error!i32 {
    const mark = arena.mark();
    const abc, const buffer = try parseOwned(arena, dom.scratch, bytes, builtin);
    const err = abc.@"error";
    if (err != .none) {
        // The error read first: the ABC is in what is given back.
        arena.restore(mark);
        return err.number();
    }

    _ = try dom.attach(abc, buffer, appDomain);
    return abc.@"error".number();
}

/// A log entry as it was before a truncation (Domain.keepTruncated).
pub const Truncated = struct {
    entry: u32,
    kind: LogKind,
    at: u32,
    abc: u32,
    a: u32,
    b: u32,
};

/// The fields the first builtin ABC's link sets (classes.zig), which a
/// link that fails gives back.
const builtin_fields = [_][]const u8{
    "hasBuiltins",
    "objectClass",
    "classClass",
    "functionClass",
    "voidClass",
    "transientName",
    "versionName",
    "nativeName",
    "apiName",
    "voidType",
    "nullType",
    "numberType",
    "floatType",
    "intType",
    "uintType",
    "booleanType",
    "stringType",
    "namespaceType",
    "xmlType",
    "xmlListType",
    "qnameType",
    "classType",
    "vectorClass",
    "vectorObjectType",
    "vectorIntType",
    "vectorUintType",
    "vectorDoubleType",
    "arrayType",
    "functionType",
    "mathStatic",
    "builtinAbc",
};

pub const Domain = struct {
    /// The domain's arena, and the call's.
    gpa: Allocator,
    scratch: Allocator,
    /// The journal of the call changing the domain, if one is.
    undo: ?*Undo = null,
    /// The call's body decoder (code.bodyDecoder), in its arena.
    decoder: ?*BodyDecoder = null,

    /// The version of user ABCs' public namespaces, whose series is the domain's.
    apiVersion: u8 = API_LatestFP,

    abcs: Rows(*Abc) = .{},
    /// Where each ABC's bytes start: the bytes of every ABC that parsed,
    /// followed by PADDING, those rejected while linking included, stay in
    /// the arena, since interned strings may point into any of them.
    abcBase: Rows([*]const u8) = .{},
    /// Each ABC's bytes, by index, to link it again (see rebuilt in lifetime.ts).
    abcBuffer: Rows([]const u8) = .{},
    /// Per ABC, the interned id of each pool string, and of each namespace and its version.
    abcString: Rows([]u32) = .{},
    abcNs: Rows([]u32) = .{},
    abcNsVersion: Rows([]u8) = .{},

    stringPtr: Rows([*]const u8) = .{},
    stringLength: Rows(u32) = .{},
    strings: IdTable,
    /// URIs a builtin ABC marks with a version: their unmarked public names are VM-internal.
    versioned: Rows(u8) = .{},

    nsType: Rows(NsType) = .{},
    nsUri: Rows(u32) = .{},
    namespaces: IdTable,

    // Script traits by name, in load order; the first visible one wins.
    bindingNs: Rows(u32) = .{},
    bindingName: Rows(u32) = .{},
    bindingVersion: Rows(u8) = .{},
    bindingAbc: Rows(u32) = .{},
    bindingScript: Rows(u32) = .{},
    /// Index of the trait in its ABC's trait tables.
    bindingTrait: Rows(u32) = .{},
    bindings: IdTable,
    /// getBinding's answers, by type, ABC and multiname: a type's members do
    /// not change once its ABC links, and a link that fails, which reuses its
    /// traits' and its ABC's ids, clears them.
    bindingMemo: IdTable,
    memoType: Rows(TypeId) = .{},
    memoAbc: Rows(u32) = .{},
    memoName: Rows(u32) = .{},
    memoBinding: Rows(traits_.Binding) = .{},
    /// Whether the memo was cleared since the Change began, which a
    /// rollback then cannot give back its rows from before.
    memoCleared: bool = false,
    /// The log entry a verification truncated in the Change under way, as
    /// it was, for a rollback to write back (keepTruncated).
    truncated: ?Truncated = null,

    // Classes by domain-wide id; ABC a's instance i is classStart[a] + i.
    classStart: Rows(u32) = .{},
    classAbc: Rows(u32) = .{},
    classInstance: Rows(u32) = .{},
    /// The base class's id, or -1.
    classBase: Rows(i32) = .{},
    classFlags: Rows(C.InstanceFlags) = .{},
    /// The traits of the class's instances, and of the class object; none
    /// for void's class object, and for both until the class links.
    classTraits: Rows(TypeRef) = .{},
    classStatic: Rows(TypeRef) = .{},

    traits: TraitsTable,
    /// Each ABC's first method id; the ABC of each method id.
    methodStart: Rows(u32) = .{},
    methodAbcIndex: Rows(u32) = .{},
    /// Per ABC, each script's traits, and each body's activation traits, if any.
    scriptTraits: Rows([]u32) = .{},
    bodyTraits: Rows([]TypeRef) = .{},

    /// Class names. Those a script defines are visible to every ABC (owner -1);
    /// while an ABC links, its own classes are visible to it by instance name
    /// (owner: its load number, which a rejected ABC never gives to another).
    typeNs: Rows(u32) = .{},
    typeName: Rows(u32) = .{},
    typeVersion: Rows(u8) = .{},
    typeClass: Rows(u32) = .{},
    typeOwner: Rows(i32) = .{},
    types: IdTable,
    loads: i32 = 0,
    /// Each ABC's load number, the owner of its own class names.
    abcOwner: Rows(i32) = .{},
    /// Each domain's parent, -1 for the root, and its depth.
    domainParent: Rows(i32) = .{},
    domainDepth: Rows(u32) = .{},
    /// Each domain's state: nothing sees what the ABCs of one not live define.
    domainState: Rows(DomainState) = .{},
    /// The domain of each ABC, and of each class name.
    abcDomain: Rows(u32) = .{},
    typeDomain: Rows(u32) = .{},
    /// What a domain finds, as the runtime reports it where that is not the
    /// first definition from the root down (see addFound).
    cachedDomain: Rows(u32) = .{},
    cachedNs: Rows(u32) = .{},
    cachedName: Rows(u32) = .{},
    cachedBinding: Rows(i32) = .{},
    cachedClass: Rows(i32) = .{},
    cached: IdTable,
    /// Each finding addFound recorded, as the runtime reported it (see .found).
    foundDomain: Rows(u32) = .{},
    foundKind: Rows(NsType) = .{},
    foundUri: Rows([]const u8) = .{},
    foundName: Rows([]const u8) = .{},
    foundAbc: Rows(u32) = .{},
    foundAsType: Rows(u8) = .{},
    /// Each finding's entry in the log, in increasing order, as the findings are in the log's.
    foundEntry: Rows(u32) = .{},
    /// What the domain's tables hold that depends on when it happened, in
    /// the order it happened (domain.ts tells what): a LogKind, the ABC it
    /// is of, and two numbers by kind; logAt, how many ABCs there were then,
    /// never decreases along the log.
    logKind: Rows(LogKind) = .{},
    logAt: Rows(u32) = .{},
    logAbc: Rows(u32) = .{},
    logA: Rows(u32) = .{},
    logB: Rows(u32) = .{},
    /// Scopes, function scopes and catch scopes found first, for verifyMethods to tell whether it found any.
    captures: u32 = 0,
    /// Each ABC verified at least once, by index.
    abcVerified: Rows(u8) = .{},
    /// How much each ABC holds of the domain's memory, roughly, by index: its
    /// bytes, and the rows of the tables it added (see weigh in lifetime.zig).
    abcWeight: Rows(u32) = .{},
    /// How many rebuilds the domain is from the one reset made; each domain's when it was evicted.
    generation: u32 = 0,
    domainEvicted: Rows(u32) = .{},

    // The builtin classes linking treats specially, found when the first
    // builtin ABC links; -1 if it has none.
    hasBuiltins: bool = false,
    objectClass: i32 = -1,
    classClass: i32 = -1,
    functionClass: i32 = -1,
    /// avmplus registers void as a class, which nothing may extend.
    voidClass: i32 = -1,
    /// The interned id of "Transient", the metadata AMF and JSON leave a member out for.
    transientName: u32 = 0,
    /// The metadata names of the builtins' own that describeType leaves out, as avmplus does.
    versionName: u32 = 0,
    nativeName: u32 = 0,
    apiName: u32 = 0,
    // Builtin types, for the rules that treat them specially: * while the
    // builtin is absent (no builtin ABC has linked, or it has no such
    // class), which is no type. A test that must not take * for an absent
    // builtin says so by TypeId.isBuiltin.
    voidType: TypeId = .any,
    nullType: TypeId = .any,
    numberType: TypeId = .any,
    floatType: TypeId = .any,
    intType: TypeId = .any,
    uintType: TypeId = .any,
    booleanType: TypeId = .any,
    stringType: TypeId = .any,
    namespaceType: TypeId = .any,
    /// XML's and XMLList's traits.
    xmlType: TypeId = .any,
    xmlListType: TypeId = .any,
    /// QName's traits, whose == compares names as XML's compares content.
    qnameType: TypeId = .any,
    /// Class's traits, the type of a value that is a class.
    classType: TypeId = .any,
    vectorClass: i32 = -1,
    vectorObjectType: TypeId = .any,
    vectorIntType: TypeId = .any,
    vectorUintType: TypeId = .any,
    vectorDoubleType: TypeId = .any,
    arrayType: TypeId = .any,
    functionType: TypeId = .any,
    /// The traits of the Math class object, whose methods have faster variants.
    mathStatic: TypeId = .any,
    /// The builtin ABC whose global's Math and Number slots are never null.
    builtinAbc: i32 = -1,
    /// Catch scope traits, by the ABC's index << 32 | its handler index.
    catchScopes: IdTable,
    catchKey: Rows(u64) = .{},
    catchValue: Rows(u32) = .{},
    /// Vector.<T> for other element types T, by T.
    vectorOf: IdTable,
    vectorParam: Rows(TypeId) = .{},
    vectorTraits: Rows(u32) = .{},

    /// The live ABCs' weight and the others' still in the tables, as addWeights last added them up.
    liveWeight: u64 = 0,
    deadWeight: u64 = 0,
    /// The weight of the log entries kept for evicted domains, which no rebuild frees.
    keptWeight: u64 = 0,

    /// The namespace the last getOwnBinding found its binding in.
    foundNs: i32 = -1,

    /// A new domain, its rows in `gpa`, with the root application domain.
    pub fn init(gpa: Allocator, scratch: Allocator) Allocator.Error!Domain {
        var dom: Domain = .{
            .gpa = gpa,
            .scratch = scratch,
            .strings = try .init(gpa),
            .namespaces = try .init(gpa),
            .bindings = try .init(gpa),
            .bindingMemo = try .init(gpa),
            .types = try .init(gpa),
            .cached = try .init(gpa),
            .catchScopes = try .init(gpa),
            .vectorOf = try .init(gpa),
            .traits = try .empty(gpa),
        };
        try dom.domainParent.push(gpa, -1);
        try dom.domainDepth.push(gpa, 0);
        try dom.domainState.push(gpa, .live);
        try dom.domainEvicted.push(gpa, 0);
        return dom;
    }

    /// `ptr`, a row of the domain's, set to `value`, its old value kept for a rollback.
    pub fn put(self: *Domain, ptr: anytype, value: @TypeOf(ptr.*)) Allocator.Error!void {
        self.changing();
        if (self.undo) |undo| {
            try undo.record(self.scratch, ptr);
        }

        ptr.* = value;
    }

    /// In the test builds, that a Change is open: what writes the domain
    /// outside one would not be undone where memory runs out.
    pub fn changing(self: *const Domain) void {
        if (options.checks) {
            std.debug.assert(self.undo != null);
        }
    }

    /// Forget getBinding's answers. The table keeps its room: a lookup
    /// finds the same in it as in a new one, and a large one is not left
    /// behind in the arena by each finding the runtime reports.
    /// Keep log entry `entry` as it is, before a truncation, for a rollback.
    pub fn keepTruncated(self: *Domain, entry: u32) void {
        if (self.undo != null and self.truncated == null) {
            self.truncated = .{
                .entry = entry,
                .kind = self.logKind.get(entry),
                .at = self.logAt.get(entry),
                .abc = self.logAbc.get(entry),
                .a = self.logA.get(entry),
                .b = self.logB.get(entry),
            };
        }
    }

    pub fn clearBindingMemo(self: *Domain) void {
        self.memoCleared = true;
        self.bindingMemo.clear();
        self.memoType.truncate(0);
        self.memoAbc.truncate(0);
        self.memoName.truncate(0);
        self.memoBinding.truncate(0);
    }

    /// Link `abc`, parsed from `buffer` (the ABC and PADDING), into
    /// application domain `domain`, as the next ABC; false after recording
    /// the error, and then it is not added. Its rows are rolled back as
    /// AssemblyScript's are: the strings it interned stay, with its bytes.
    pub fn attach(self: *Domain, abc: *Abc, buffer: []const u8, domain: u32) Allocator.Error!bool {
        const gpa = self.gpa;
        const index = self.abcs.len;
        const before = self.rows();
        try self.abcs.push(gpa, abc);
        try self.abcDomain.push(gpa, domain);
        try self.abcBase.push(gpa, buffer.ptr);
        try self.abcBuffer.push(gpa, buffer);
        try self.abcVerified.push(gpa, 0);
        self.loads += 1;
        try self.abcOwner.push(gpa, self.loads);
        const methodCount = self.traits.methodTraits.len;
        try self.methodStart.push(gpa, methodCount);
        try self.traits.addMethods(gpa, abc.methodCount());
        for (0..abc.methodCount()) |_| {
            try self.methodAbcIndex.push(gpa, index);
        }

        const pool = &abc.pool;
        const strings = try memory.allocZeroed(gpa, u32, pool.stringCount());
        for (1..@max(pool.stringCount(), 1)) |i| {
            strings[i] = try self.internString(pool.string(buffer, @intCast(i)));
        }

        try self.abcString.push(gpa, strings);
        try namespaces.addNamespaces(self, abc, buffer.ptr, strings);
        const traitsCount = self.traits.kind.len;
        const classCount = self.classAbc.len;
        const typeCount = self.typeNs.len;
        const builtins = self.saveBuiltins();
        var diag: Diagnostics = .{};
        classes.link(self, index, &diag) catch |err| {
            if (err == error.OutOfMemory) {
                return error.OutOfMemory;
            }

            // Recorded, not unwound: the ABC keeps its error for its readers.
            abc.@"error" = diag.code;

            self.abcs.truncate(index);
            self.abcBase.truncate(index);
            self.abcBuffer.truncate(index);
            self.abcVerified.truncate(index);
            self.abcString.truncate(index);
            self.abcNs.truncate(index);
            self.abcNsVersion.truncate(index);
            self.classStart.truncate(index);
            self.scriptTraits.truncate(index);
            self.bodyTraits.truncate(index);
            self.abcOwner.truncate(index);
            self.abcDomain.truncate(index);
            self.methodStart.truncate(index);
            self.methodAbcIndex.truncate(methodCount);
            self.traits.truncate(traitsCount);
            self.traits.truncateMethods(methodCount);
            // Its classes and the names it gave them too: an ABC that takes
            // its index next must find no class of this one's by it.
            self.classAbc.truncate(classCount);
            self.classInstance.truncate(classCount);
            self.classBase.truncate(classCount);
            self.classFlags.truncate(classCount);
            self.classTraits.truncate(classCount);
            self.classStatic.truncate(classCount);
            self.typeDomain.truncate(typeCount);
            self.typeNs.truncate(typeCount);
            self.typeName.truncate(typeCount);
            self.typeVersion.truncate(typeCount);
            self.typeClass.truncate(typeCount);
            self.typeOwner.truncate(typeCount);
            try self.types.forget(gpa, typeCount);
            // The special classes and types, which the first builtin ABC's link
            // sets before it may still fail: the next builtin finds them again.
            self.restoreBuiltins(builtins);
            self.clearBindingMemo();
            return false;
        };

        try typenames.addClassNames(self, index);
        try self.addBindings(index);
        // The bytes three times: a copy, and the tables parsing made of them.
        try self.abcWeight.push(gpa, @intCast(@min(ABC_Weight * abc.length + self.rows() - before, 0xffffffff)));
        return true;
    }

    /// What builtin_fields hold, before a link that may fail.
    fn saveBuiltins(self: *const Domain) [builtin_fields.len]i64 {
        var saved: [builtin_fields.len]i64 = undefined;
        inline for (builtin_fields, 0..) |name, k| {
            const value = @field(self, name);
            saved[k] = switch (@TypeOf(value)) {
                bool => @intFromBool(value),
                TypeId => @backingInt(value),
                else => value,
            };
        }

        return saved;
    }

    fn restoreBuiltins(self: *Domain, saved: [builtin_fields.len]i64) void {
        inline for (builtin_fields, 0..) |name, k| {
            @field(self, name) = switch (@TypeOf(@field(self, name))) {
                bool => saved[k] != 0,
                TypeId => @fromBackingInt(@intCast(saved[k])),
                else => @intCast(saved[k]),
            };
        }
    }

    /// Roughly the bytes the domain's tables hold, by their rows, for
    /// weighing ABCs: what an ABC's link or compile adds is its own.
    pub fn rows(self: *const Domain) u64 {
        const t = &self.traits;
        return @as(u64, t.kind.len) * 144 +
            @as(u64, t.methodTraits.len) * 72 +
            @as(u64, t.memberTraits.len) * 60 +
            (@as(u64, t.slotType.len) + t.dispatch.len + t.paramType.len + t.interfaceList.len) * 9 +
            @as(u64, self.memoType.len) * 60 +
            @as(u64, self.stringPtr.len) * 36 +
            @as(u64, self.nsType.len) * 24 +
            (@as(u64, self.bindingNs.len) + self.typeNs.len + self.classAbc.len) * 48 +
            @as(u64, self.logKind.len) * 36;
    }

    /// Whether ABC `index` is of a live application domain, one neither evicted nor dropped.
    pub fn isLive(self: *const Domain, index: u32) bool {
        return self.domainState.get(self.abcDomain.get(index)) == .live;
    }

    /// Append entry `kind` of ABC `abc` to the log.
    pub fn logged(self: *Domain, kind: LogKind, abc: u32, a: u32, b: u32) Allocator.Error!void {
        try self.logKind.push(self.gpa, kind);
        try self.logAt.push(self.gpa, self.abcs.len);
        try self.logAbc.push(self.gpa, abc);
        try self.logA.push(self.gpa, a);
        try self.logB.push(self.gpa, b);
    }

    /// Log that traits t resolved, unless they are made on demand, which no lookup decides.
    pub fn loggedResolve(self: *Domain, t: u32) Allocator.Error!void {
        const traits = &self.traits;
        const kind = traits.kind.get(t);
        if (kind.isOwned() and traits.param.get(t) == .any) {
            try self.logged(.resolve, traits.abc.get(t), @backingInt(kind), traits.owner.get(t));
        }
    }

    // What the verifier and emitters ask of types, methods and builtins (domain/queries.zig).
    pub const typeNotNull = domain_queries.typeNotNull;
    pub const classInstanceType = domain_queries.classInstanceType;
    pub const staticTraitsOf = domain_queries.staticTraitsOf;
    pub const instanceTraitsOf = domain_queries.instanceTraitsOf;
    pub const checkTypeName = domain_queries.checkTypeName;
    pub const allowsExtraArgs = domain_queries.allowsExtraArgs;
    pub const methodsOf = domain_queries.methodsOf;
    pub const isVirtual = domain_queries.isVirtual;
    pub const staticallyCallable = domain_queries.staticallyCallable;
    pub const findScript = domain_queries.findScript;
    pub const scriptOf = domain_queries.scriptOf;
    pub const underscored = domain_queries.underscored;
    pub const underscoredName = domain_queries.underscoredName;
    pub const isMathOrNumber = domain_queries.isMathOrNumber;
    pub const hasPublicNamespace = domain_queries.hasPublicNamespace;
    pub const initOfDeclarer = domain_queries.initOfDeclarer;
    pub const nameOf = domain_queries.nameOf;
    pub const conversionOf = domain_queries.conversionOf;
    pub const isConversion = domain_queries.isConversion;
    pub const staticOf = domain_queries.staticOf;
    pub const catchTraits = domain_queries.catchTraits;
    pub const vectorFor = domain_queries.vectorFor;
    pub const setVectorFor = domain_queries.setVectorFor;
    pub const builtinType = domain_queries.builtinType;
    pub const findBuiltin = domain_queries.findBuiltin;
    pub const objectType = domain_queries.objectType;
    pub const builtin = domain_queries.builtin;
    pub const isMachineType = domain_queries.isMachineType;
    pub const machineCompatible = domain_queries.machineCompatible;
    pub const methodAbc = domain_queries.methodAbc;
    pub const publicNamespace = domain_queries.publicNamespace;
    pub const publicVersion = domain_queries.publicVersion;
    pub const checkDefault = domain_queries.checkDefault;

    // Strings and namespaces interned, and names bound and found (domain/names.zig).
    pub const findText = domain_names.findText;
    pub const internText = domain_names.internText;
    pub const internString = domain_names.internString;
    pub const stringOf = domain_names.stringOf;
    pub const findString = domain_names.findString;
    pub const internNamespace = domain_names.internNamespace;
    pub const findNamespace = domain_names.findNamespace;
    pub const find = domain_names.find;
    pub const addBindings = domain_names.addBindings;
    pub const findCached = domain_names.findCached;
    pub const findIn = domain_names.findIn;
    pub const findTypeIn = domain_names.findTypeIn;
    pub const addFound = domain_names.addFound;
    pub const bind = domain_names.bind;

    /// A new domain, a child of `parent`.
    pub fn childDomain(self: *Domain, parent: u32) Allocator.Error!u32 {
        const id = self.domainParent.len;
        try self.domainParent.push(self.gpa, @intCast(parent));
        try self.domainDepth.push(self.gpa, self.domainDepth.get(parent) + 1);
        try self.domainState.push(self.gpa, .live);
        try self.domainEvicted.push(self.gpa, 0);
        return id;
    }

    /// `domain`, then its parent, and so on up to the root.
    pub fn ancestors(self: *const Domain, domain: u32) Ancestors {
        return .{ .dom = self, .at = @intCast(domain) };
    }

    pub const Ancestors = struct {
        dom: *const Domain,
        /// The next domain, or -1 past the root.
        at: i32,

        pub fn next(it: *Ancestors) ?u32 {
            if (it.at < 0) {
                return null;
            }

            const d: u32 = @intCast(it.at);
            it.at = it.dom.domainParent.get(d);
            return d;
        }
    };

    /// Whether `domain` sees what `other` defines: `other` is it or an ancestor, and live.
    pub fn sees(self: *const Domain, domain: u32, other: u32) bool {
        if (self.domainState.get(other) != .live) {
            return false;
        }

        var it = self.ancestors(domain);
        while (it.next()) |d| {
            if (d == other) {
                return true;
            }
        }

        return false;
    }
};

/// *, Object and void are all represented as atoms.
pub fn isAtom(bt: traits_.Builtin) bool {
    return bt == .any or bt == .object or bt == .void;
}
