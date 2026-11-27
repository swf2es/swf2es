// The AVM2 compiler as the exports give it (assembly/compile.ts): a domain
// the ABCs are added to, and, from stage 5 on, the modules they compile
// to. Stage 3 has the domain: its ABCs linked, its application domains'
// lifetimes, and what the runtime reports it found. The modules, the
// context, keys and log, and the rebuild are in compile/, and named here.
//
// The domain and everything of it is in its arena, which a reset gives
// back whole once the new domain is made in the other. Each call that
// changes the domain does so all or nothing (Domain.Change): one that runs
// out of memory leaves it as it was.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("memory.zig");
const domain_ = @import("avm2/link/domain.zig");
const Domain = domain_.Domain;
const lifetime = @import("avm2/link/lifetime.zig");
const output = @import("output.zig");
const Output = output.Output;

const modules = @import("compile/modules.zig");
const context = @import("compile/context.zig");
const rebuilds = @import("compile/rebuild.zig");
pub const forgetVerified = modules.forgetVerified;
pub const domainModule = modules.domainModule;
pub const domainModuleBytes = modules.domainModuleBytes;
pub const domainModuleMoreBytes = modules.domainModuleMoreBytes;
pub const domainModuleDone = modules.domainModuleDone;
pub const domainPartBudget = modules.domainPartBudget;
pub const domainSourceMap = modules.domainSourceMap;
pub const domainModuleEntries = modules.domainModuleEntries;
pub const domainEmitEach = modules.domainEmitEach;
pub const emitEachOn = modules.emitEachOn;
pub const domainContext = context.domainContext;
pub const domainKeyHeaderBytes = context.domainKeyHeaderBytes;
pub const domainKeyFork = context.domainKeyFork;
pub const domainKeyLogBytes = context.domainKeyLogBytes;
pub const domainRevision = context.domainRevision;
pub const domainLogMark = context.domainLogMark;
pub const domainLogSince = context.domainLogSince;
pub const journalBytes = context.journalBytes;
pub const replayEntry = context.replayEntry;
pub const domainReplay = context.domainReplay;
pub const leaveRebuild = rebuilds.leaveRebuild;
pub const domainCompact = rebuilds.domainCompact;
pub const domainRebuild = rebuilds.domainRebuild;
pub const domainRebuildStep = rebuilds.domainRebuildStep;
pub const domainRebuildBudget = rebuilds.domainRebuildBudget;
pub const domainSaveBytes = rebuilds.domainSaveBytes;
pub const domainSavedAbcBytes = rebuilds.domainSavedAbcBytes;
pub const domainLoad = rebuilds.domainLoad;
pub const domainLoadAbc = rebuilds.domainLoadAbc;
pub const domainLoadRebuild = rebuilds.domainLoadRebuild;
const abandon = modules.abandon;
const forgetModules = modules.forgetModules;
const numbers = context.numbers;
const newRebuild = rebuilds.newRebuild;
const dropRebuild = rebuilds.dropRebuild;
const dropLoading = rebuilds.dropLoading;
const startRebuild = rebuilds.startRebuild;

/// A domain and its arena, which gives back everything of it at once.
pub const Box = struct {
    arena: memory.Arena,
    dom: Domain,
};

/// The domain the exports compile against.
pub var current: ?*Box = null;
/// The API version the domain is made with, until a reset sets another.
var api_version: u8 = domain_.API_LatestFP;

/// The domain's arena.
pub fn arena() *memory.Arena {
    return &current.?.arena;
}

/// A new domain at `apiVersion` in an arena of its own.
pub fn make(apiVersion: u8) Allocator.Error!*Box {
    memory.arenas();
    const pages = memory.pages().allocator();
    const box = try pages.create(Box);
    errdefer pages.destroy(box);
    box.arena = .init(pages);
    errdefer box.arena.deinit();
    box.dom = try .init(box.arena.allocator(), memory.call.allocator());
    box.dom.apiVersion = apiVersion;
    return box;
}

/// Domain `box` and everything of it given back.
pub fn unmake(box: *Box) void {
    box.arena.deinit();
    memory.pages().allocator().destroy(box);
}

/// The domain, made the first time it is asked for, as AssemblyScript's is
/// when the module starts.
pub fn domain() Allocator.Error!*Domain {
    if (current == null) {
        current = try make(api_version);
    }

    return &current.?.dom;
}

/// A call starts: what the last one made in its arena, the body decoder, is gone.
pub fn callStarts() void {
    if (current) |box| {
        box.dom.decoder = null;
    }

    // A module neither kept nor pending was handed out by the last call,
    // which the host has copied by now.
    if (modules.written == null and modules.pending == null) {
        forgetModules();
    }
}

/// The domain given back, as when the module starts, for the tests.
pub fn release() void {
    forgetModules();
    forgetVerified();
    dropRebuild();
    dropLoading();
    rebuilds.revived_bottom = -1;
    if (current) |box| {
        unmake(box);
        current = null;
    }

    api_version = domain_.API_LatestFP;
}

/// Start a new domain whose user ABCs have API version `apiVersion`, whose
/// series, Flash Player's or AIR's, is the domain's. All or nothing: the
/// new one is made before the old is given back, which stays where
/// memory runs out, as AssemblyScript's did when its allocation trapped.
pub fn domainReset(apiVersion: i32) Allocator.Error!void {
    abandon();
    const version: u8 = @truncate(@as(u32, @bitCast(apiVersion)));
    const box = try make(version);
    if (current) |old| {
        unmake(old);
    }

    current = box;
    api_version = version;
    forgetVerified();
    forgetModules();
}

/// The domain changed by `change`, given its arguments, all or nothing.
pub fn changed(comptime change: anytype, args: anytype) Allocator.Error!@typeInfo(@typeInfo(@TypeOf(change)).@"fn".return_type.?).error_union.payload {
    return domain_.changed(try domain(), arena(), change, args);
}

pub var last_add_linked: bool = false;

/// Add an ABC to the domain, loaded into application domain `appDomain`
/// (0, the root, or one domainChild made); 0, or the VerifyError it was
/// rejected with; -1 for an application domain never made or dropped.
pub fn domainAdd(bytes: []const u8, builtin: bool, appDomain: i32) Allocator.Error!i32 {
    abandon();
    const dom = try domain();
    last_add_linked = false;
    if (!isLive(dom, appDomain)) {
        return -1;
    }

    forgetVerified();
    const loads = dom.loads;
    const result = try changed(domain_.addAbc, .{ arena(), bytes, builtin, @as(u32, @intCast(appDomain)) });
    // attach advances loads even when linking rejects the ABC after interning names.
    last_add_linked = dom.loads != loads;
    return result;
}

/// A new application domain, a child of `parent`'s: its number, or -1 if `parent` was never made or was dropped.
pub fn domainChild(parent: i32) Allocator.Error!i32 {
    // A rebuild under way shares the domain tree this grows.
    leaveRebuild();
    if (!isLive(try domain(), parent)) {
        return -1;
    }

    return @intCast(try changed(Domain.childDomain, .{@as(u32, @intCast(parent))}));
}

pub fn isLive(dom: *const Domain, appDomain: i32) bool {
    const d = indexIn(appDomain, dom.domainParent.len) orelse return false;
    return dom.domainState.get(d) == .live;
}

/// A number the host gives, as a row of a table `len` long; none if it names no row.
pub fn indexIn(n: i32, len: u32) ?u32 {
    return if (n >= 0 and n < len) @intCast(n) else null;
}

/// Drop application domain `appDomain` and its descendants, as the runtime
/// has let go of them: their ABCs are seen by no other and compile no more,
/// and their indices are not given to others.
pub fn domainDrop(appDomain: i32) Allocator.Error!void {
    abandon();
    const dom = try domain();
    if (appDomain >= 0) {
        lifetime.drop(dom, @intCast(appDomain));
    }
}

/// Evict application domain `appDomain` and its descendants while the host
/// has no use for them: as dropped, until domainRevive.
pub fn domainEvict(appDomain: i32) Allocator.Error!void {
    abandon();
    const dom = try domain();
    if (appDomain >= 0) {
        lifetime.evict(dom, @intCast(appDomain));
    }
}

/// Application domain `appDomain`'s state: 0 live, 1 evicted, 2 dropped, -1 never made.
pub fn domainState(appDomain: i32) Allocator.Error!i32 {
    const dom = try domain();
    const d = indexIn(appDomain, dom.domainState.len) orelse return -1;
    return @backingInt(dom.domainState.get(d));
}

/// Give ABC `index`, of an evicted application domain, its bytes again, if
/// a rebuild has let go of them, before domainRevive: 0, the VerifyError
/// they were rejected with, or -1 if the ABC is not of an evicted domain.
pub fn domainRestore(index: i32, bytes: []const u8) Allocator.Error!i32 {
    abandon();
    _ = try domain();
    if (index < 0) {
        return -1;
    }

    return changed(lifetime.restore, .{ arena(), @as(u32, @intCast(index)), bytes });
}

/// Make evicted application domain `appDomain` live again, with its evicted
/// ancestors, by a rebuild if one has been since any was evicted: 0, 1
/// after a rebuild, 2 for one started `stepped` (domainRebuildStep), or
/// -1, leaving them evicted, if they cannot be.
pub fn domainRevive(appDomain: i32, stepped: bool) Allocator.Error!i32 {
    abandon();
    const dom = try domain();
    if (appDomain < 0) {
        return -1;
    }

    const bottom: u32 = @intCast(appDomain);
    // The root has no parent: AssemblyScript's read past the table there,
    // which holds no evicted domain.
    const top = if (bottom > 0 and bottom < dom.domainState.len) lifetime.evictedTop(dom, bottom) else bottom;
    const revived = lifetime.revive(dom, bottom);
    if (revived <= 0) {
        return revived;
    }

    if (stepped) {
        startRebuild(newRebuild(dom, null, null) catch |err| {
            lifetime.unrevive(dom, bottom, top);
            return err;
        }, rebuilds.steppedBudget(partBudget()));
        rebuilds.revived_bottom = appDomain;
        rebuilds.revived_top = top;
        return 2;
    }

    const done = domainRebuild(false) catch |err| {
        lifetime.unrevive(dom, bottom, top);
        return err;
    };
    if (!done) {
        lifetime.unrevive(dom, bottom, top);
        return -1;
    }

    return 1;
}

/// Record what application domain `appDomain` has found by a name, in the
/// namespace of kind `nsKind` and URI `uri`, as the runtime reports it where
/// it is not the first definition from the root down: the definition ABC
/// `abc` gives the name, its script's binding by name, or its class as a
/// type (`asType`). What the domain's later ABCs compile against.
pub fn domainFound(appDomain: i32, nsKind: i32, uri: []const u8, name: []const u8, abc: i32, asType: bool) Allocator.Error!void {
    abandon();
    forgetVerified();
    try changed(Domain.addFound, .{ @as(u32, @bitCast(appDomain)), domain_.NsType.fromWord(@bitCast(nsKind)), uri, name, @as(u32, @bitCast(abc)), asType });
}

/// ABC `index` of the domain, or the last added for one below 0; none
/// where there is no such ABC, or its application domain is not live.
pub fn abcIndex(dom: *const Domain, index: i32) ?u32 {
    if (dom.abcs.len == 0 or index >= dom.abcs.len) {
        return null;
    }

    const at: u32 = if (index < 0) dom.abcs.len - 1 else @intCast(index);
    return if (dom.isLive(at)) at else null;
}

/// The indices of the ABCs that ABC `index` (the last added for -1) names as
/// linked, comma-separated in load order: those before it its domain sees.
pub fn domainLinked(gpa: Allocator, index: i32) Allocator.Error![]const u8 {
    const dom = try domain();
    const at = abcIndex(dom, index) orelse return "";

    const own = dom.abcDomain.get(at);
    var out: Output = try .initCapacity(gpa, 64);
    var first = true;
    for (0..at) |i| {
        if (dom.sees(own, dom.abcDomain.get(@intCast(i)))) {
            if (!first) {
                try out.byte(',');
            }

            try out.uint(i);
            first = false;
        }
    }

    return out.written();
}

/// Whether a rebuild is due, as `want` asks (see wantsRebuild in
/// avm2/link/lifetime.zig). A pure query; Zig's memory is its own, so
/// its answers are too.
pub fn domainWantsCompact(want: i32) Allocator.Error!bool {
    const dom = try domain();
    // Of the host's four only.
    if (want < 0 or want > @backingInt(lifetime.Want.spare)) {
        return false;
    }

    return lifetime.wantsRebuild(dom, partBudget(), part_budget, @fromBackingInt(@as(u8, @intCast(want))));
}

/// The garbage a part of a rebuild makes, which stage 6's rebuild takes;
/// a sixteenth of memory, PART_BUDGET at least, as AssemblyScript's.
pub const PART_BUDGET: u64 = 2 << 20;
pub var part_budget: u64 = PART_BUDGET;

pub fn partBudget() u64 {
    return if (part_budget == PART_BUDGET) @max(PART_BUDGET, lifetime.memorySize() >> 4) else part_budget;
}

/// What the domain's ABCs hold of codegen's memory, roughly, and its size,
/// in bytes, "live dead memory" (see compile.ts). The first two count rows
/// as AssemblyScript does; the memory is Zig's own.
pub fn domainUsage(gpa: Allocator) Allocator.Error![]const u8 {
    const dom = try domain();
    lifetime.addWeights(dom);
    return numbers(gpa, .{ dom.liveWeight + dom.keptWeight, dom.deadWeight, lifetime.memorySize() });
}

/// Application domain `appDomain`'s parent; -1 for the root, or for one never made.
pub fn domainParent(appDomain: i32) Allocator.Error!i32 {
    const dom = try domain();
    const d = indexIn(appDomain, dom.domainParent.len) orelse return -1;
    return if (d == 0) -1 else dom.domainParent.get(d);
}
