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
const output = @import("../../output.zig");
const Abc = @import("../abc/abc.zig").Abc;
const C = @import("../abc/constants.zig");
const ConstantPool = @import("../abc/pool.zig").ConstantPool;
const BodyDecoder = @import("../abc/code.zig").BodyDecoder;
const readAbc = @import("../abc/parse.zig").readAbc;
const PADDING = @import("../abc/reader.zig").PADDING;
const classes = @import("classes.zig");
const namespaces = @import("namespaces.zig");
const table = @import("table.zig");
const IdTable = table.IdTable;
const hashBytes = table.hashBytes;
const hashPair = table.hashPair;
const traits_ = @import("traits.zig");
const TraitsTable = traits_.TraitsTable;
const TYPE_Any = traits_.TYPE_Any;
const typenames = @import("typenames.zig");
const types = @import("types.zig");

pub const NS_Public: u8 = 0;
pub const NS_PackageInternal: u8 = 1;
pub const NS_Protected: u8 = 2;
pub const NS_Explicit: u8 = 3;
pub const NS_StaticProtected: u8 = 4;
pub const NS_Private: u8 = 5;

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
pub const DOMAIN_Live: u8 = 0;
pub const DOMAIN_Evicted: u8 = 1;
pub const DOMAIN_Dropped: u8 = 2;

/// What an ABC weighs for each of its bytes before it links: them, and what parsing them took.
pub const ABC_Weight: u64 = 3;

/// The kinds of the log's entries (see Domain.logKind).
pub const LOG_None: u8 = 0;
/// A finding, by its index in the found tables.
pub const LOG_Found: u8 = 1;
/// Traits resolved, by their kind and owner in their ABC.
pub const LOG_Resolve: u8 = 2;
/// A method signed, by its index in its ABC.
pub const LOG_Sign: u8 = 3;
/// An ABC verified for the first time, or finding scopes for the first time.
pub const LOG_Verify: u8 = 4;

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
    if (err != 0) {
        // The error read first: the ABC is in what is given back.
        arena.restore(mark);
        return err;
    }

    _ = try dom.attach(abc, buffer, appDomain);
    return abc.@"error";
}

/// A log entry as it was before a truncation (Domain.keepTruncated).
pub const Truncated = struct {
    entry: u32,
    kind: u8,
    at: u32,
    abc: u32,
    a: u32,
    b: u32,
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

    nsType: Rows(u8) = .{},
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
    memoType: Rows(i32) = .{},
    memoAbc: Rows(u32) = .{},
    memoName: Rows(u32) = .{},
    memoBinding: Rows(u32) = .{},
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
    classFlags: Rows(u8) = .{},
    /// The traits of the class's instances, and of the class object; -1 for void.
    classTraits: Rows(i32) = .{},
    classStatic: Rows(i32) = .{},

    traits: TraitsTable,
    /// Each ABC's first method id; the ABC of each method id.
    methodStart: Rows(u32) = .{},
    methodAbcIndex: Rows(u32) = .{},
    /// The error of the last resolveTypeId that failed.
    typeError: i32 = 0,
    /// Per ABC, each script's traits, and each body's activation traits or -1.
    scriptTraits: Rows([]u32) = .{},
    bodyTraits: Rows([]i32) = .{},

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
    /// Each domain's DOMAIN_ state: nothing sees what the ABCs of one not live define.
    domainState: Rows(u8) = .{},
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
    /// Each finding addFound recorded, as the runtime reported it (see LOG_Found).
    foundDomain: Rows(u32) = .{},
    foundKind: Rows(u8) = .{},
    foundUri: Rows([]const u8) = .{},
    foundName: Rows([]const u8) = .{},
    foundAbc: Rows(u32) = .{},
    foundAsType: Rows(u8) = .{},
    /// Each finding's entry in the log, in increasing order, as the findings are in the log's.
    foundEntry: Rows(u32) = .{},
    /// What the domain's tables hold that depends on when it happened, in
    /// the order it happened (domain.ts tells what): a LOG_ kind, the ABC it
    /// is of, and two numbers by kind; logAt, how many ABCs there were then,
    /// never decreases along the log.
    logKind: Rows(u8) = .{},
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
    // Builtin types by traits id, for the rules that treat them specially.
    voidType: i32 = -1,
    nullType: i32 = -1,
    numberType: i32 = -1,
    floatType: i32 = -1,
    intType: i32 = -1,
    uintType: i32 = -1,
    booleanType: i32 = -1,
    stringType: i32 = -1,
    namespaceType: i32 = -1,
    /// XML's and XMLList's traits.
    xmlType: i32 = -1,
    xmlListType: i32 = -1,
    /// QName's traits, whose == compares names as XML's compares content.
    qnameType: i32 = -1,
    /// Class's traits, the type of a value that is a class.
    classType: i32 = -1,
    vectorClass: i32 = -1,
    vectorObjectType: i32 = -1,
    vectorIntType: i32 = -1,
    vectorUintType: i32 = -1,
    vectorDoubleType: i32 = -1,
    arrayType: i32 = -1,
    functionType: i32 = -1,
    /// The traits of the Math class object, whose methods have faster variants.
    mathStatic: i32 = -1,
    /// The builtin ABC whose global's Math and Number slots are never null.
    builtinAbc: i32 = -1,
    /// Catch scope traits, by the ABC's index << 32 | its handler index.
    catchScopes: IdTable,
    catchKey: Rows(u64) = .{},
    catchValue: Rows(i32) = .{},
    /// Vector.<T> for other element types T, by T.
    vectorOf: IdTable,
    vectorParam: Rows(i32) = .{},
    vectorTraits: Rows(i32) = .{},

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
        try dom.domainState.push(gpa, DOMAIN_Live);
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
            strings[i] = try self.internString(buffer[pool.stringStart[i]..][0..pool.stringLength[i]]);
        }

        try self.abcString.push(gpa, strings);
        try namespaces.addNamespaces(self, abc, buffer.ptr, strings);
        const traitsCount = self.traits.kind.len;
        if (!try classes.link(self, index)) {
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
            self.clearBindingMemo();
            return false;
        }

        try typenames.addClassNames(self, index);
        try self.addBindings(index);
        // The bytes three times: a copy, and the tables parsing made of them.
        try self.abcWeight.push(gpa, @intCast(@min(ABC_Weight * abc.length + self.rows() - before, 0xffffffff)));
        return true;
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
        return self.domainState.get(self.abcDomain.get(index)) == DOMAIN_Live;
    }

    /// Append entry `kind` of ABC `abc` to the log.
    pub fn logged(self: *Domain, kind: u8, abc: u32, a: u32, b: u32) Allocator.Error!void {
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
        if (kind >= traits_.TRAITS_Instance and kind <= traits_.TRAITS_Activation and traits.param.get(t) == TYPE_Any) {
            try self.logged(LOG_Resolve, traits.abc.get(t), kind, traits.owner.get(t));
        }
    }

    /// Whether the machine type always holds a value: int, uint, Number and Boolean.
    pub fn typeNotNull(self: *const Domain, type_: i32) bool {
        const bt = self.builtin(type_);
        return bt == traits_.BUILTIN_Int or
            bt == traits_.BUILTIN_Uint or
            bt == traits_.BUILTIN_Number or
            bt == traits_.BUILTIN_Boolean or
            bt == traits_.BUILTIN_Float;
    }

    /// The traits of Class's instances, which class objects are.
    pub fn classInstanceType(self: *const Domain) i32 {
        return if (self.classClass < 0) TYPE_Any else self.classTraits.get(@intCast(self.classClass));
    }

    /// The class object traits of class `i` of ABC `index`.
    pub fn staticTraitsOf(self: *const Domain, index: u32, i: u32) i32 {
        return self.classStatic.get(self.classStart.get(index) + i);
    }

    /// As Traits::itraits: for a class object's traits, its instances'; else *.
    pub fn instanceTraitsOf(self: *const Domain, type_: i32) i32 {
        const traits = &self.traits;
        if (type_ < 0 or traits.kind.get(@intCast(type_)) != traits_.TRAITS_Class) {
            return TYPE_Any;
        }

        const t: u32 = @intCast(type_);
        return self.classTraits.get(self.classStart.get(traits.abc.get(t)) + traits.owner.get(t));
    }

    /// As Verifier::checkTypeName: the type multiname `mn` of ABC `index` names,
    /// void included, and Vector.<T>, or * for another parameterized type;
    /// below TYPE_Any on failure, with typeError set. AssemblyScript
    /// recurses into a TypeName's parameter; this walks the chain down,
    /// keeping each level's class, and makes the types back up.
    pub fn checkTypeName(self: *Domain, index: u32, multiname: u32) Allocator.Error!i32 {
        const pool = &self.abcs.get(index).pool;
        var classes_: std.ArrayList(i32) = .empty;
        var mn = multiname;
        const innermost: i32 = while (true) {
            const isTypeName = pool.mnKind[mn] == C.CONSTANT_TypeName;
            const c = typenames.resolveType(self, index, if (isTypeName) pool.mnA[mn] else mn);
            if (c < 0 and c != -C.kIllegalVoidError) {
                self.typeError = -c;
                return -2;
            }

            if (!isTypeName) {
                break if (c < 0) self.voidType else self.classTraits.get(@intCast(c));
            }

            try classes_.append(self.scratch, c);
            mn = pool.mnB[mn];
            if (mn == 0) {
                break TYPE_Any;
            }
        };

        var param = innermost;
        var level = classes_.items.len;
        while (level > 0) {
            level -= 1;
            const c = classes_.items[level];
            const t = if (c >= 0) try typenames.parameterized(self, c, param) else -1;
            param = if (t < 0) TYPE_Any else t;
        }

        return param;
    }

    /// Whether method m takes any number of extra arguments: into a rest or
    /// arguments array, or as a function avmplus lets ignore them (see
    /// TraitsTable.sign).
    pub fn allowsExtraArgs(self: *const Domain, m: u32) bool {
        const index = self.methodAbc(m);
        const abc = self.abcs.get(index);
        const local = m - self.methodStart.get(index);
        const flags = abc.methodFlags[local];
        if (flags & (C.METHOD_NeedRest | C.METHOD_NeedArguments) != 0) {
            return true;
        }

        return self.traits.ignoresRest.get(m) != 0;
    }

    /// Add to `out` the methods bound to traits t: its initializer, methods, getters and setters.
    pub fn methodsOf(self: *const Domain, gpa: Allocator, t: u32, out: *std.ArrayList(u32)) Allocator.Error!void {
        const traits = &self.traits;
        const index = traits.abc.get(t);
        const abc = self.abcs.get(index);
        const methods = self.methodStart.get(index);
        const initializer = traits.init.get(t);
        if (initializer >= 0) {
            try out.append(gpa, @intCast(initializer));
        }

        var i = traits.first.get(t);
        while (i < traits.end.get(t)) : (i += 1) {
            const kind = abc.traitTag.get(i) & 0x0f;
            if (kind == C.TRAIT_Method or kind == C.TRAIT_Getter or kind == C.TRAIT_Setter) {
                try out.append(gpa, methods + abc.traitIndex.get(i));
            }
        }
    }

    /// Whether method m is a method, getter or setter of some traits, which callstatic may call.
    pub fn isVirtual(self: *const Domain, m: u32) bool {
        return self.traits.methodVirtual.get(m) != 0;
    }

    /// Whether callstatic may call method m, as avmplus' AbcEnv keeps an
    /// environment for it once its traits have a vtable: a method, getter or
    /// setter of some traits, or the initializer of a class or of its
    /// instances. A script's has none outside AOT.
    pub fn staticallyCallable(self: *const Domain, m: u32) bool {
        const traits = &self.traits;
        if (traits.methodVirtual.get(m) != 0) {
            return true;
        }

        const t = traits.methodTraits.get(m);
        return t >= 0 and traits.init.get(@intCast(t)) == @as(i32, @bitCast(m)) and traits.kind.get(@intCast(t)) != traits_.TRAITS_Script;
    }

    /// As DomainMgr::findScriptInPoolByMultiname: the global object traits of
    /// the one script that defines multiname `mn` of ABC `index`, or -1 for
    /// none or several.
    pub fn findScript(self: *const Domain, index: u32, multiname: u32) i32 {
        const pool = &self.abcs.get(index).pool;
        var mn = multiname;
        if (pool.mnKind[mn] == C.CONSTANT_TypeName) {
            mn = pool.mnA[mn];
        }

        const ids = self.abcNs.get(index);
        const versions = self.abcNsVersion.get(index);
        const name = self.abcString.get(index)[pool.mnB[mn]];
        if (pool.mnKind[mn] == C.CONSTANT_Qname) {
            const ns = pool.mnA[mn];
            return self.scriptOf(self.find(ids[ns], name, versions[ns], self.abcDomain.get(index)));
        }

        const set = pool.mnA[mn];
        var found: i32 = -1;
        var m = pool.nsSetStart[set];
        while (m < pool.nsSetStart[set + 1]) : (m += 1) {
            const ns = pool.nsSetMembers[m];
            const script = self.scriptOf(self.find(ids[ns], name, versions[ns], self.abcDomain.get(index)));
            if (script >= 0) {
                if (found >= 0 and found != script) {
                    return -1;
                }

                found = script;
            }
        }

        return found;
    }

    /// The global object traits of the script binding b is in, or -1.
    pub fn scriptOf(self: *const Domain, b: i32) i32 {
        if (b < 0) {
            return -1;
        }

        const index = self.bindingAbc.get(@intCast(b));
        return @intCast(self.scriptTraits.get(index)[self.bindingScript.get(@intCast(b))]);
    }

    /// The interned id of multiname `mn`'s name with a leading underscore,
    /// or -1 if no ABC has it. AssemblyScript decodes the name to a string
    /// and encodes `_` and it again, so a name that is not valid UTF-8 is
    /// looked up as the decoding wrote it (output.writeDecoded).
    pub fn underscored(self: *const Domain, index: u32, mn: u32) Allocator.Error!i32 {
        return self.underscoredName(self.nameOf(index, mn));
    }

    /// underscored, of interned name `name`.
    pub fn underscoredName(self: *const Domain, name: u32) Allocator.Error!i32 {
        var underscore: std.Io.Writer.Allocating = .init(self.scratch);
        underscore.writer.writeByte('_') catch return error.OutOfMemory;
        output.writeDecoded(&underscore.writer, self.stringOf(name)) catch return error.OutOfMemory;
        return self.findText(underscore.written());
    }

    /// Whether multiname `mn` of ABC `index` is named Math or Number.
    pub fn isMathOrNumber(self: *const Domain, index: u32, mn: u32) bool {
        const pool = &self.abcs.get(index).pool;
        const name: i32 = @bitCast(self.abcString.get(index)[pool.mnB[mn]]);
        return name == self.findText("Math") or name == self.findText("Number");
    }

    /// As Multiname::containsAnyPublicNamespace, for a multiname with a namespace set.
    pub fn hasPublicNamespace(self: *const Domain, index: u32, mn: u32) bool {
        const pool = &self.abcs.get(index).pool;
        const kind = pool.mnKind[mn];
        if (kind != C.CONSTANT_Multiname and kind != C.CONSTANT_MultinameL and kind != C.CONSTANT_MultinameLA) {
            return false;
        }

        const set = pool.mnA[mn];
        var m = pool.nsSetStart[set];
        while (m < pool.nsSetStart[set + 1]) : (m += 1) {
            // As Namespace::isPublic: of the public kind, and with an empty URI.
            const ns = self.abcNs.get(index)[pool.nsSetMembers[m]];
            const uri = self.nsUri.get(ns);
            if (self.nsType.get(ns) == NS_Public and (uri == URI_None or self.stringLength.get(uri) == 0)) {
                return true;
            }
        }

        return false;
    }

    /// As TraitsBindings::findBindingAndDeclarer: the initializer of the traits
    /// that declares what multiname `mn` of ABC `index` binds to on `type`, a
    /// protected member belonging to the first base that has it; -1 if none.
    pub fn initOfDeclarer(self: *Domain, type_: i32, index: u32, mn: u32) i32 {
        const traits = &self.traits;
        var t = type_;
        while (t >= 0) : (t = traits.base.get(@intCast(t))) {
            const b = types.getOwnBinding(self, index, @intCast(t), mn);
            if (b == traits_.BIND_None) {
                continue;
            }

            var declarer = t;
            var ns = self.foundNs;
            while (ns == traits.protectedNs.get(@intCast(declarer))) {
                const parent = traits.base.get(@intCast(declarer));
                if (parent < 0 or traits.protectedNs.get(@intCast(parent)) < 0) {
                    break;
                }

                const parentNs: u32 = @intCast(traits.protectedNs.get(@intCast(parent)));
                const name = self.nameOf(index, mn);
                if (traits.find(parent, parentNs, name, API_Internal) != b) {
                    break;
                }

                declarer = parent;
                ns = @intCast(parentNs);
            }

            return traits.init.get(@intCast(declarer));
        }

        return -1;
    }

    /// The interned name of multiname `mn` of ABC `index`.
    pub fn nameOf(self: *const Domain, index: u32, multiname: u32) u32 {
        const pool = &self.abcs.get(index).pool;
        var mn = multiname;
        if (pool.mnKind[mn] == C.CONSTANT_TypeName) {
            mn = pool.mnA[mn];
        }

        return self.abcString.get(index)[pool.mnB[mn]];
    }

    /// As Verifier::emitCallpropertySlot: what calling a class slot of type
    /// `slotType` with one argument does to it: the builtin conversions give
    /// int, uint, Number, Boolean or String, a user class coerces to it, and
    /// anything else is a call (-2).
    pub fn conversionOf(self: *const Domain, slotType: i32) i32 {
        if (slotType < 0) {
            return -2;
        }

        if (self.floatType >= 0 and slotType == self.staticOf(self.floatType)) {
            return self.floatType;
        }

        for ([_]i32{ self.intType, self.uintType, self.numberType, self.booleanType, self.stringType }) |ty| {
            if (ty >= 0 and slotType == self.staticOf(ty)) {
                return ty;
            }
        }

        const traits = &self.traits;
        const s: u32 = @intCast(slotType);
        if (traits.kind.get(s) == traits_.TRAITS_Class and
            traits.base.get(s) == self.classInstanceType() and
            !self.abcs.get(traits.abc.get(s)).builtin)
        {
            return self.instanceTraitsOf(slotType);
        }

        return -2;
    }

    /// Whether calling class slot `slotType` converts to a builtin primitive, never null.
    pub fn isConversion(self: *const Domain, slotType: i32) bool {
        const converted = self.conversionOf(slotType);
        return converted >= 0 and
            (converted == self.intType or
                converted == self.uintType or
                converted == self.numberType or
                converted == self.floatType or
                converted == self.booleanType or
                converted == self.stringType);
    }

    /// The class object traits of instance traits `type`.
    pub fn staticOf(self: *const Domain, type_: i32) i32 {
        const traits = &self.traits;
        const t: u32 = @intCast(type_);
        const index = traits.abc.get(t);
        return self.classStatic.get(self.classStart.get(index) + traits.owner.get(t));
    }

    /// The catch scope of handler `h` of ABC `index`, as Traits::newCatchTraits:
    /// one slot, named `name`, of the handler's exception type.
    pub fn catchTraits(self: *Domain, index: u32, h: u32, name: u32, type_: i32) Allocator.Error!i32 {
        const key = (@as(u64, index) << 32) | h;
        const hash = hashPair(index, h);
        var slot = self.catchScopes.start(hash);
        while (self.catchScopes.at(slot) >= 0) : (slot = self.catchScopes.next(slot)) {
            const id: u32 = @intCast(self.catchScopes.at(slot));
            if (self.catchKey.get(id) == key) {
                return self.catchValue.get(id);
            }
        }

        const gpa = self.gpa;
        const pool = &self.abcs.get(index).pool;
        var mn = name;
        if (pool.mnKind[mn] == C.CONSTANT_TypeName) {
            mn = pool.mnA[mn];
        }

        const traits = &self.traits;
        const t = try traits.create(gpa, traits_.TRAITS_Catch, index, h, -1, -1, 0, 0);
        const start = traits.memberTraits.len;
        traits.memberStart.set(t, start);
        traits.memberEnd.set(t, start);
        var ns = pool.mnA[mn];
        if (pool.mnKind[mn] == C.CONSTANT_Multiname) {
            ns = firstMember(pool, ns);
        }

        const nsId = self.abcNs.get(index)[ns];
        const version = self.abcNsVersion.get(index)[ns];
        try traits.add(gpa, t, nsId, self.nameOf(index, name), version, traits_.BKIND_Var);
        traits.slotCount.set(t, 1);
        traits.slotStart.set(t, traits.slotType.len);
        try traits.slotType.push(gpa, type_);
        try traits.slotSet.push(gpa, 1);
        traits.dispatchStart.set(t, traits.dispatch.len);
        traits.resolved.set(t, 1);
        const id = self.catchKey.len;
        try self.catchKey.push(gpa, key);
        try self.catchValue.push(gpa, @intCast(t));
        try self.catchScopes.insert(gpa, hash, id);
        self.captures += 1;
        return @intCast(t);
    }

    /// The Vector.<T> made for `param`, or -1.
    pub fn vectorFor(self: *const Domain, param: i32) i32 {
        const hash = hashPair(@bitCast(param), 0);
        var slot = self.vectorOf.start(hash);
        while (self.vectorOf.at(slot) >= 0) : (slot = self.vectorOf.next(slot)) {
            const id: u32 = @intCast(self.vectorOf.at(slot));
            if (self.vectorParam.get(id) == param) {
                return self.vectorTraits.get(id);
            }
        }

        return -1;
    }

    pub fn setVectorFor(self: *Domain, param: i32, t: i32) Allocator.Error!void {
        const id = self.vectorParam.len;
        try self.vectorParam.push(self.gpa, param);
        try self.vectorTraits.push(self.gpa, t);
        try self.vectorOf.insert(self.gpa, hashPair(@bitCast(param), 0), id);
    }

    pub fn builtinType(self: *const Domain, name: []const u8) i32 {
        const c = self.findBuiltin(name);
        return if (c < 0) -1 else self.classTraits.get(@intCast(c));
    }

    /// As DomainMgr::findBuiltinTraitsByName: the first class of the ABC being
    /// linked named `name` in any namespace, or -1.
    pub fn findBuiltin(self: *const Domain, name: []const u8) i32 {
        const id_text = self.findText(name);
        if (id_text < 0) {
            return -1;
        }

        for (0..self.typeName.len) |id_| {
            const id: u32 = @intCast(id_);
            if (self.typeName.get(id) == @as(u32, @intCast(id_text)) and self.typeOwner.get(id) == self.loads) {
                return @intCast(self.typeClass.get(id));
            }
        }

        return -1;
    }

    pub fn objectType(self: *const Domain) i32 {
        return if (self.objectClass < 0) TYPE_Any else self.classTraits.get(@intCast(self.objectClass));
    }

    /// As Traits::getBuiltinType.
    pub fn builtin(self: *const Domain, type_: i32) u8 {
        if (type_ == TYPE_Any) return traits_.BUILTIN_Any;
        if (type_ == self.objectType()) return traits_.BUILTIN_Object;
        if (type_ == self.voidType) return traits_.BUILTIN_Void;
        if (type_ == self.booleanType) return traits_.BUILTIN_Boolean;
        if (type_ == self.intType) return traits_.BUILTIN_Int;
        if (type_ == self.uintType) return traits_.BUILTIN_Uint;
        if (type_ >= 0 and type_ == self.floatType) return traits_.BUILTIN_Float;
        if (type_ == self.numberType) return traits_.BUILTIN_Number;
        if (type_ == self.stringType) return traits_.BUILTIN_String;
        return if (type_ == self.namespaceType) traits_.BUILTIN_Namespace else traits_.BUILTIN_Other;
    }

    /// As Traits::isMachineType: Object, void, Boolean, int, uint and Number.
    pub fn isMachineType(self: *const Domain, type_: i32) bool {
        const bt = self.builtin(type_);
        return (bt >= traits_.BUILTIN_Object and bt <= traits_.BUILTIN_Number) or bt == traits_.BUILTIN_Float;
    }

    /// As Traits::isMachineCompatible: whether a and b have the same representation.
    pub fn machineCompatible(self: *const Domain, a: i32, b: i32) bool {
        if (a == b) {
            return true;
        }

        if (isAtom(self.builtin(a)) and isAtom(self.builtin(b))) {
            return true;
        }

        return a != TYPE_Any and b != TYPE_Any and !self.isMachineType(a) and !self.isMachineType(b);
    }

    pub fn methodAbc(self: *const Domain, m: u32) u32 {
        return self.methodAbcIndex.get(m);
    }

    /// The namespace id of the public namespace, or -1 if no ABC has one.
    pub fn publicNamespace(self: *const Domain) i32 {
        const empty = self.findText("");
        return if (empty < 0) -1 else self.findNamespace(NS_Public, @intCast(empty));
    }

    /// The version of ABC `index`'s public namespace, as AvmCore::getPublicNamespace(pool).
    pub fn publicVersion(self: *const Domain, index: u32) u8 {
        return if (self.abcs.get(index).builtin) API_Internal else self.apiVersion;
    }

    /// As PoolObject::getLegalDefaultValue: whether constant `value` of `kind`
    /// of ABC `index` may be the default of a slot or parameter of `type`; 0,
    /// or the VerifyError.
    pub fn checkDefault(self: *const Domain, index: u32, value: u32, kind: u8, type_: i32) i32 {
        // Legacy ABCs ignore the kind at index zero; AIR's float entry zero is NaN.
        const hasFloats = self.abcs.get(index).hasFloatSupport();
        if (value == 0 and (kind != C.CONSTANT_Float or !hasFloats)) {
            return 0;
        }

        if (kind == C.CONSTANT_Float and !hasFloats) {
            return if (type_ == TYPE_Any) C.kCorruptABCError else C.kIllegalDefaultValue;
        }

        if (!traits_.isDefaultKind(kind)) {
            return if (type_ == TYPE_Any) C.kCorruptABCError else C.kIllegalDefaultValue;
        }

        const pool = &self.abcs.get(index).pool;
        var number: f64 = 0;
        var count: u32 = 0xffffffff;
        switch (kind) {
            C.CONSTANT_Int => {
                count = @intCast(pool.ints.len);
                number = if (value < count) @floatFromInt(pool.ints[value]) else 0;
            },
            C.CONSTANT_UInt => {
                count = @intCast(pool.uints.len);
                number = if (value < count) @floatFromInt(pool.uints[value]) else 0;
            },
            C.CONSTANT_Float => {
                count = @intCast(pool.floats.len);
                number = if (value < count) pool.floats[value] else 0;
            },
            C.CONSTANT_Double => {
                count = @intCast(pool.doubles.len);
                number = if (value < count) pool.doubles[value] else 0;
            },
            C.CONSTANT_Utf8 => count = pool.stringCount(),
            // The value is the kind; its index is not read.
            C.CONSTANT_True, C.CONSTANT_False, C.CONSTANT_Null => {},
            // A namespace's kinds.
            else => count = pool.nsCount(),
        }

        if (value >= count) {
            return C.kCpoolIndexRangeError;
        }

        return if (traits_.legalDefault(self.builtin(type_), kind, number)) 0 else C.kIllegalDefaultValue;
    }

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
    pub fn internNamespace(self: *Domain, type_: u8, uri: u32) Allocator.Error!u32 {
        if (type_ != NS_Private) {
            const found = self.findNamespace(type_, uri);
            if (found >= 0) {
                return @intCast(found);
            }
        }

        const id = self.nsType.len;
        try self.nsType.push(self.gpa, type_);
        try self.nsUri.push(self.gpa, uri);
        if (type_ != NS_Private) {
            try self.namespaces.insert(self.gpa, hashPair(type_, uri), id);
        }

        return id;
    }

    pub fn findNamespace(self: *const Domain, type_: u8, uri: u32) i32 {
        const hash = hashPair(type_, uri);
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
            if (self.bindingNs.get(i) == ns and self.bindingName.get(i) == name and self.bindingVersion.get(i) <= version) {
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
                var mn = abc.traitName.get(t);
                if (pool.mnKind[mn] == C.CONSTANT_TypeName) {
                    mn = pool.mnA[mn];
                }

                const name = strings[pool.mnB[mn]];
                var first = pool.mnA[mn];
                var version = versions[first];
                if (pool.mnKind[mn] == C.CONSTANT_Multiname) {
                    const set = pool.mnA[mn];
                    const last = pool.nsSetStart[set + 1];
                    first = firstMember(pool, set);
                    version = API_Internal;
                    var m = pool.nsSetStart[set];
                    while (m < last) : (m += 1) {
                        const v = versions[pool.nsSetMembers[m]];
                        if (v < version) {
                            version = v;
                        }
                    }
                }

                try self.bind(ids[first], name, version, index, @intCast(script), t);
            }
        }
    }

    /// A new domain, a child of `parent`.
    pub fn childDomain(self: *Domain, parent: u32) Allocator.Error!u32 {
        const id = self.domainParent.len;
        try self.domainParent.push(self.gpa, @intCast(parent));
        try self.domainDepth.push(self.gpa, self.domainDepth.get(parent) + 1);
        try self.domainState.push(self.gpa, DOMAIN_Live);
        try self.domainEvicted.push(self.gpa, 0);
        return id;
    }

    /// Whether `domain` sees what `other` defines: `other` is it or an ancestor, and live.
    pub fn sees(self: *const Domain, domain: u32, other: u32) bool {
        if (self.domainState.get(other) != DOMAIN_Live) {
            return false;
        }

        var d: i32 = @intCast(domain);
        while (d >= 0) {
            if (@as(u32, @intCast(d)) == other) {
                return true;
            }

            d = self.domainParent.get(@intCast(d));
        }

        return false;
    }

    /// What `domain` has found by `ns` and `name`, as the runtime reports it
    /// (see addFound): a binding, or as a type a class; -1 if none.
    pub fn findCached(self: *const Domain, ns: u32, name: u32, version: u8, domain: u32, asType: bool) i32 {
        const c = &self.cached;
        var slot = c.start(hashPair(ns, name));
        while (true) {
            const id = c.at(slot);
            if (id < 0) {
                return -1;
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
        var slot = b.start(hashPair(ns, name));
        var best: i32 = -1;
        var bestDepth: u32 = 0;
        while (true) {
            const id = b.at(slot);
            if (id < 0) {
                return best;
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
        var slot = t.start(hashPair(ns, name));
        var best: i32 = -1;
        var bestDepth: u32 = 0;
        while (true) {
            const id = t.at(slot);
            if (id < 0) {
                return best;
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
    pub fn addFound(self: *Domain, domain: u32, type_: u8, uri: []const u8, name: []const u8, abc: u32, asType: bool) Allocator.Error!void {
        if (domain >= self.domainParent.len or
            self.domainState.get(domain) != DOMAIN_Live or
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
        try self.logged(LOG_Found, abc, self.foundDomain.len, 0);
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
};

/// *, Object and void are all represented as atoms.
fn isAtom(bt: u8) bool {
    return bt == traits_.BUILTIN_Any or bt == traits_.BUILTIN_Object or bt == traits_.BUILTIN_Void;
}
