// The AVM2 compiler as the exports give it (assembly/compile.ts): a domain
// the ABCs are added to, and, from stage 5 on, the modules they compile
// to. Stage 3 has the domain: its ABCs linked, its application domains'
// lifetimes, and what the runtime reports it found.
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

/// Two arenas, the domain's and the one a reset makes the next in.
var arenas: [2]memory.Arena = undefined;
var which: u1 = 0;
var current: ?*Domain = null;
/// The API version the domain is made with, until a reset sets another.
var api_version: u8 = domain_.API_LatestFP;

/// The domain's arena.
fn arena() *memory.Arena {
    return &arenas[which];
}

/// A new domain at `apiVersion` in arena `slot`, made anew; the other is untouched.
fn make(slot: u1, apiVersion: u8) Allocator.Error!*Domain {
    memory.arenas();
    arenas[slot] = .init(memory.pages().allocator());
    errdefer arenas[slot].deinit();
    const gpa = arenas[slot].allocator();
    const dom = try gpa.create(Domain);
    dom.* = try .init(gpa, memory.call.allocator());
    dom.apiVersion = apiVersion;
    return dom;
}

/// The domain, made the first time it is asked for, as AssemblyScript's is
/// when the module starts.
pub fn domain() Allocator.Error!*Domain {
    if (current) |dom| {
        return dom;
    }

    current = try make(which, api_version);
    return current.?;
}

/// The domain given back, as when the module starts, for the tests.
pub fn release() void {
    if (current != null) {
        arena().deinit();
        current = null;
    }

    api_version = domain_.API_LatestFP;
}

/// Start a new domain whose user ABCs have API version `apiVersion`, whose
/// series, Flash Player's or AIR's, is the domain's. All or nothing: the
/// new one is made before the old is given back, which stays where
/// memory runs out, as AssemblyScript's did when its allocation trapped.
pub fn domainReset(apiVersion: i32) Allocator.Error!void {
    const version: u8 = @truncate(@as(u32, @bitCast(apiVersion)));
    const next: u1 = if (current == null) which else ~which;
    const dom = try make(next, version);
    if (current != null) {
        arena().deinit();
    }

    which = next;
    current = dom;
    api_version = version;
}

/// The domain changed by `change`, given its arguments, all or nothing.
pub fn changed(comptime change: anytype, args: anytype) Allocator.Error!@typeInfo(@typeInfo(@TypeOf(change)).@"fn".return_type.?).error_union.payload {
    return domain_.changed(try domain(), arena(), change, args);
}

/// Add an ABC to the domain, loaded into application domain `appDomain`
/// (0, the root, or one domainChild made); 0, or the VerifyError it was
/// rejected with; -1 for an application domain never made or dropped.
pub fn domainAdd(bytes: []const u8, builtin: bool, appDomain: i32) Allocator.Error!i32 {
    if (!isLive(try domain(), appDomain)) {
        return -1;
    }

    return changed(domain_.addAbc, .{ arena(), bytes, builtin, @as(u32, @intCast(appDomain)) });
}

/// A new application domain, a child of `parent`'s: its number, or -1 if `parent` was never made or was dropped.
pub fn domainChild(parent: i32) Allocator.Error!i32 {
    if (!isLive(try domain(), parent)) {
        return -1;
    }

    return @intCast(try changed(Domain.childDomain, .{@as(u32, @intCast(parent))}));
}

fn isLive(dom: *const Domain, appDomain: i32) bool {
    return appDomain >= 0 and
        appDomain < dom.domainParent.len and
        dom.domainState.get(@intCast(appDomain)) == domain_.DOMAIN_Live;
}

/// Drop application domain `appDomain` and its descendants, as the runtime
/// has let go of them: their ABCs are seen by no other and compile no more,
/// and their indices are not given to others.
pub fn domainDrop(appDomain: i32) Allocator.Error!void {
    const dom = try domain();
    if (appDomain >= 0) {
        lifetime.drop(dom, @intCast(appDomain));
    }
}

/// Evict application domain `appDomain` and its descendants while the host
/// has no use for them: as dropped, until domainRevive.
pub fn domainEvict(appDomain: i32) Allocator.Error!void {
    const dom = try domain();
    if (appDomain >= 0) {
        lifetime.evict(dom, @intCast(appDomain));
    }
}

/// Application domain `appDomain`'s state: 0 live, 1 evicted, 2 dropped, -1 never made.
pub fn domainState(appDomain: i32) Allocator.Error!i32 {
    const dom = try domain();
    return if (appDomain >= 0 and appDomain < dom.domainState.len) dom.domainState.get(@intCast(appDomain)) else -1;
}

/// Give ABC `index`, of an evicted application domain, its bytes again, if
/// a rebuild has let go of them, before domainRevive: 0, the VerifyError
/// they were rejected with, or -1 if the ABC is not of an evicted domain.
pub fn domainRestore(index: i32, bytes: []const u8) Allocator.Error!i32 {
    _ = try domain();
    if (index < 0) {
        return -1;
    }

    return changed(lifetime.restore, .{ arena(), @as(u32, @intCast(index)), bytes });
}

/// Make evicted application domain `appDomain` live again, with its evicted
/// ancestors: 0, or -1, leaving them evicted, if they cannot be. A revival
/// that needs a rebuild (1, or 2 `stepped`) waits for stage 6's: until
/// then no rebuild ever is, so none needs one.
pub fn domainRevive(appDomain: i32, stepped: bool) Allocator.Error!i32 {
    _ = stepped;
    const dom = try domain();
    if (appDomain < 0) {
        return -1;
    }

    const revived = lifetime.revive(dom, @intCast(appDomain));
    std.debug.assert(revived <= 0);
    return revived;
}

/// Record what application domain `appDomain` has found by a name, in the
/// namespace of kind `nsKind` and URI `uri`, as the runtime reports it where
/// it is not the first definition from the root down: the definition ABC
/// `abc` gives the name, its script's binding by name, or its class as a
/// type (`asType`). What the domain's later ABCs compile against.
pub fn domainFound(appDomain: i32, nsKind: i32, uri: []const u8, name: []const u8, abc: i32, asType: bool) Allocator.Error!void {
    try changed(Domain.addFound, .{ @as(u32, @bitCast(appDomain)), @as(u8, @truncate(@as(u32, @bitCast(nsKind)))), uri, name, @as(u32, @bitCast(abc)), asType });
}

/// ABC `index` of the domain, or the last added for -1; -1 again where
/// there is none, or its application domain is not live.
fn abcIndex(dom: *const Domain, index: i32) i32 {
    if (dom.abcs.len == 0 or index >= dom.abcs.len) {
        return -1;
    }

    const at: u32 = if (index < 0) dom.abcs.len - 1 else @intCast(index);
    return if (dom.isLive(at)) @intCast(at) else -1;
}

/// The indices of the ABCs that ABC `index` (the last added for -1) names as
/// linked, comma-separated in load order: those before it its domain sees.
pub fn domainLinked(gpa: Allocator, index: i32) Allocator.Error![]const u8 {
    const dom = try domain();
    const at = abcIndex(dom, index);
    if (at < 0) {
        return "";
    }

    const own = dom.abcDomain.get(@intCast(at));
    var out: std.ArrayList(u8) = .empty;
    var first = true;
    for (0..@intCast(at)) |i| {
        if (dom.sees(own, dom.abcDomain.get(@intCast(i)))) {
            if (!first) {
                try out.append(gpa, ',');
            }

            try out.print(gpa, "{d}", .{i});
            first = false;
        }
    }

    return out.items;
}

/// Whether a rebuild is due, as `want` asks (see wantsRebuild in
/// avm2/link/lifetime.zig). A pure query; Zig's memory is its own, so
/// its answers are too.
pub fn domainWantsCompact(want: i32) Allocator.Error!bool {
    const dom = try domain();
    return want >= 0 and want <= 3 and lifetime.wantsRebuild(dom, partBudget(), part_budget, @intCast(want));
}

/// The garbage a part of a rebuild makes, which stage 6's rebuild takes;
/// a sixteenth of memory, PART_BUDGET at least, as AssemblyScript's.
const PART_BUDGET: u64 = 2 << 20;
var part_budget: u64 = PART_BUDGET;

fn partBudget() u64 {
    return if (part_budget == PART_BUDGET) @max(PART_BUDGET, lifetime.memorySize() >> 4) else part_budget;
}

/// What the domain's ABCs hold of codegen's memory, roughly, and its size,
/// in bytes, "live dead memory" (see compile.ts). The first two count rows
/// as AssemblyScript does; the memory is Zig's own.
pub fn domainUsage(gpa: Allocator) Allocator.Error![]const u8 {
    const dom = try domain();
    lifetime.addWeights(dom);
    const live = dom.liveWeight + dom.keptWeight;
    return std.fmt.allocPrint(gpa, "{d} {d} {d}", .{ live, dom.deadWeight, lifetime.memorySize() });
}

/// Application domain `appDomain`'s parent; -1 for the root, or for one never made.
pub fn domainParent(appDomain: i32) Allocator.Error!i32 {
    const dom = try domain();
    return if (appDomain > 0 and appDomain < dom.domainParent.len) dom.domainParent.get(@intCast(appDomain)) else -1;
}
