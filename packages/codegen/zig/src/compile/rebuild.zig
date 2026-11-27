// The AVM2 compiler's rebuild, saving and loading (assembly/compile.ts
// tells each export's why): the domain built again from its live ABCs in
// a new arena, here or in another instance.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../memory.zig");
const domain_ = @import("../avm2/link/domain.zig");
const Domain = domain_.Domain;
const lifetime = @import("../avm2/link/lifetime.zig");
const rebuild_ = @import("../avm2/link/rebuild.zig");
const saved = @import("../avm2/link/saved.zig");
const compile = @import("../compile.zig");
const modules = @import("modules.zig");
const Box = compile.Box;
const abandon = modules.abandon;
const domain = compile.domain;
const forgetModules = modules.forgetModules;
const forgetVerified = modules.forgetVerified;
const indexIn = compile.indexIn;
const make = compile.make;
const partBudget = compile.partBudget;
const unmake = compile.unmake;

/// A rebuild under way: the new domain it builds, in an arena of its own,
/// and the domain it builds from where that is not the current one but a
/// loaded one, given back with it.
const Rebuilding = struct {
    previous_limit: ?u32 = null,
    box: *Box,
    source: ?*Box,
    rebuild: rebuild_.Rebuild,
};

/// The rebuild a part at a time and the garbage each part may make, and the
/// evicted domains it revives, from `revived_bottom` up to `revived_top`;
/// -1 for none.
var rebuilding: ?*Rebuilding = null;
var rebuilding_budget: u64 = 0;
pub var revived_bottom: i32 = -1;
pub var revived_top: u32 = 0;

/// The domain domainLoad started, until domainLoadRebuild, and the garbage its parts may make.
const Loading = struct {
    box: *Box,
    loaded: saved.Loaded,
    target: *Box,
};
var loading: ?*Loading = null;
var loading_budget: u64 = 0;

/// The garbage a part of a stepped rebuild of a move or a revival may make
/// at most, where the host asks for smaller parts than the default's
/// (domainRebuildBudget), so that each part blocks it for less; 0 for the
/// default's. What the rebuild builds is the same however it is parted.
var rebuild_budget: u64 = 0;

pub fn domainRebuildBudget(bytes: i32) void {
    rebuild_budget = if (bytes > 0) @intCast(bytes) else 0;
}

/// A stepped rebuild's budget, `default` unless domainRebuildBudget asked for less.
pub fn steppedBudget(default: u64) u64 {
    return if (rebuild_budget > 0) @min(rebuild_budget, default) else default;
}

/// A rebuild of `from`, `source`'s domain if one is given, into a new domain.
pub fn newRebuild(from: *Domain, source: ?*Box, target: ?*Box) Allocator.Error!*Rebuilding {
    const pages = memory.pages().allocator();
    const r = try pages.create(Rebuilding);
    errdefer pages.destroy(r);
    const box = target orelse try make(from.apiVersion);
    errdefer if (target == null) unmake(box);
    r.* = .{ .box = box, .source = source, .rebuild = try .init(from, &box.dom, &box.arena, target != null) };
    return r;
}

/// A rebuild's new domain, and the loaded one it built from, given back.
fn freeRebuild(r: *Rebuilding) void {
    unmake(r.box);
    if (r.source) |source| {
        unmake(source);
    }

    destroyRebuild(r);
}

fn destroyRebuild(r: *Rebuilding) void {
    r.rebuild.verifier_arena.deinit();
    const pages = memory.pages();
    if (r.previous_limit) |limit| pages.limit = limit;
    pages.allocator().destroy(r);
}

pub fn dropRebuild() void {
    if (rebuilding) |r| {
        freeRebuild(r);
        rebuilding = null;
    }
}

pub fn dropLoading() void {
    if (loading) |l| {
        unmake(l.target);
        unmake(l.box);
        memory.pages().allocator().destroy(l);
        loading = null;
    }
}

/// Start `r`, for domainRebuildStep to do a part of `budget` bytes of garbage at a time.
pub fn startRebuild(r: *Rebuilding, budget: u64) void {
    dropRebuild();
    rebuilding = r;
    rebuilding_budget = budget;
}

/// Leave the rebuild under way, which changed nothing of the domain but
/// what it revives.
pub fn leaveRebuild() void {
    if (rebuilding != null) {
        dropRebuild();
        unreviveRebuilt();
        if (compile.current) |box| {
            box.dom.decoder = null;
        }
    }
}

/// Evict again the domains a rebuild that failed or was left was reviving, as revive found them.
fn unreviveRebuilt() void {
    if (revived_bottom >= 0) {
        if (compile.current) |box| {
            lifetime.unrevive(&box.dom, @intCast(revived_bottom), revived_top);
        }

        revived_bottom = -1;
    }
}

/// A part of `r`, in a Change of its new domain: whether done. Running out
/// of memory leaves the new domain to be given back.
fn stepRebuild(r: *Rebuilding, budget: u64) Allocator.Error!bool {
    return domain_.changed(&r.box.dom, &r.box.arena, stepFresh, .{ &r.rebuild, budget });
}

fn stepFresh(_: *Domain, rebuild: *rebuild_.Rebuild, budget: u64) Allocator.Error!bool {
    return rebuild.step(budget);
}

/// Make `r`'s new domain the domain, if it did not fail: whether it was.
/// The old one is given back, with what was kept of it.
fn rebuilt(r: *Rebuilding) bool {
    if (r.rebuild.failed) {
        freeRebuild(r);
        return false;
    }

    // A closure's scope is found by verifying its ABC, which domainEmitEach
    // does once for its first method: the new domain has none found yet.
    forgetVerified();
    forgetModules();
    const old = compile.current;
    compile.current = r.box;
    compile.current.?.dom.decoder = null;
    if (old) |box| {
        unmake(box);
    }

    if (r.source) |source| {
        unmake(source);
    }

    destroyRebuild(r);
    return true;
}

/// Rebuild the domain without the ABCs of domains not live, once memory
/// would otherwise grow and they hold enough to keep it from growing:
/// whether it was (or, `stepped`, started).
pub fn domainCompact(stepped: bool) Allocator.Error!bool {
    const dom = try domain();
    const want: lifetime.Want = if (stepped) .in_place else .synchronous;
    if (!lifetime.wantsRebuild(dom, partBudget(), compile.part_budget, want)) {
        return false;
    }

    if (!stepped) return domainRebuild(false);

    // Replacing a pending compaction restores its outer limit before we save ours.
    leaveRebuild();
    // A compaction offered in place must fit inside memory already committed.
    const pages = memory.pages();
    const limit = pages.limit;
    pages.limit = pages.chunks;
    if (domainRebuild(true) catch false) {
        rebuilding.?.previous_limit = limit;
    } else {
        pages.limit = limit;
        return false;
    }
    return true;
}

/// The domain built again from its live ABCs, worth it or not; false,
/// leaving it, if one did not link. With `stepped`, started, for
/// domainRebuildStep to do a part at a time.
pub fn domainRebuild(stepped: bool) Allocator.Error!bool {
    abandon();
    const r = try newRebuild(try domain(), null, null);
    if (stepped) {
        startRebuild(r, partBudget());
        return true;
    }

    _ = stepRebuild(r, std.math.maxInt(u64)) catch |err| {
        freeRebuild(r);
        return err;
    };
    return rebuilt(r);
}

/// The next part of the rebuild domainCompact, domainRevive or
/// domainLoadRebuild started: 0 while some is left, 1 once done, -1 if it
/// failed, leaving the domain as it was and a domain being revived
/// evicted, or if none was started. Running out of memory fails it too.
pub fn domainRebuildStep() Allocator.Error!i32 {
    const r = rebuilding orelse return -1;
    const done = stepRebuild(r, rebuilding_budget) catch |err| {
        const bounded = r.previous_limit != null;
        rebuilding = null;
        freeRebuild(r);
        unreviveRebuilt();
        if (bounded) return -1;
        return err;
    };
    if (!done) {
        return 0;
    }

    rebuilding = null;
    if (rebuilt(r)) {
        revived_bottom = -1;
        return 1;
    }

    unreviveRebuilt();
    if (compile.current) |box| {
        box.dom.decoder = null;
    }

    return -1;
}

/// What a rebuild reads of the domain but its ABCs' bytes, for another
/// instance to rebuild it in a memory of its own (domainLoad).
pub fn domainSaveBytes(gpa: Allocator) Allocator.Error![]const u8 {
    const dom = try domain();
    var out: std.ArrayList(u8) = .empty;
    try saved.saveDomain(dom, gpa, &out);
    return out.items;
}

/// The bytes of live ABC `index`, as added, for domainLoadAbc; null, no address, for another.
pub fn domainSavedAbcBytes(index: i32) Allocator.Error!?[]const u8 {
    const dom = try domain();
    // The bound only makes the cast sound: savedLive checks the ABC's own.
    const i = indexIn(index, dom.abcs.len) orelse return null;
    return if (saved.savedLive(dom, i)) saved.savedBytes(dom, i) else null;
}

/// In a new instance, start a domain as another's domainSaveBytes saved
/// it: whether the words were that, for domainLoadAbc to give its live ABCs
/// and domainLoadRebuild to rebuild it.
pub fn domainLoad(words: []const u8, recovery: bool) Allocator.Error!bool {
    abandon();
    dropLoading();
    const dom = try domain();
    const pages = memory.pages().allocator();
    const l = try pages.create(Loading);
    errdefer pages.destroy(l);
    const box = try make(dom.apiVersion);
    errdefer unmake(box);
    var loaded: saved.Loaded = .{ .dom = &box.dom };
    if (!try saved.loadDomain(&loaded, words)) {
        unmake(box);
        pages.destroy(l);
        return false;
    }

    // Zig grows in 64 KiB pages. Reserving the estimated AssemblyScript heap here
    // can make a move exceed the memory of the domain it is supposed to shrink.
    loading_budget = steppedBudget(compile.part_budget);
    if (!recovery) {
        const size = saved.loadedSize(&loaded, loading_budget);
        if (size >= lifetime.MOVE_Limit) {
            unmake(box);
            pages.destroy(l);
            return false;
        }
    }
    l.* = .{ .box = box, .target = try make(box.dom.apiVersion), .loaded = loaded };
    loading = l;
    return true;
}

/// Give ABC `index` of the domain domainLoad started its bytes: 0, -1, or a VerifyError.
pub fn domainLoadAbc(index: i32, bytes: []const u8) Allocator.Error!i32 {
    const l = loading orelse return -1;
    if (index < 0) {
        return -1;
    }

    return saved.loadAbc(&l.loaded, &l.target.arena, @intCast(index), bytes);
}

/// Start rebuilding the domain domainLoad started, given all its live ABCs,
/// as the domain this instance compiles once domainRebuildStep is done:
/// whether it was started.
pub fn domainLoadRebuild() Allocator.Error!bool {
    const l = loading orelse return false;
    if (!saved.loadedAll(&l.loaded)) {
        return false;
    }

    abandon();
    forgetVerified();
    forgetModules();
    const r = try newRebuild(&l.box.dom, l.box, l.target);
    memory.pages().allocator().destroy(l);
    loading = null;
    startRebuild(r, loading_budget);
    return true;
}
