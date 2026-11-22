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
const C = @import("avm2/abc/constants.zig");
const code = @import("avm2/abc/code.zig");
const Output = @import("output.zig").Output;
const ModuleEmitter = @import("avm2/emit/module.zig").ModuleEmitter;

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

/// A call starts: what the last one made in its arena, the body decoder, is gone.
pub fn callStarts() void {
    if (current) |dom| {
        dom.decoder = null;
    }

    // A module neither kept nor pending was handed out by the last call,
    // which the host has copied by now.
    if (written == null and pending == null) {
        forgetModules();
    }
}

/// The domain given back, as when the module starts, for the tests.
pub fn release() void {
    forgetModules();
    forgetVerified();
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
    abandon();
    const version: u8 = @truncate(@as(u32, @bitCast(apiVersion)));
    const next: u1 = if (current == null) which else ~which;
    const dom = try make(next, version);
    if (current != null) {
        arena().deinit();
    }

    which = next;
    current = dom;
    api_version = version;
    forgetVerified();
    forgetModules();
}

/// The domain changed by `change`, given its arguments, all or nothing.
pub fn changed(comptime change: anytype, args: anytype) Allocator.Error!@typeInfo(@typeInfo(@TypeOf(change)).@"fn".return_type.?).error_union.payload {
    return domain_.changed(try domain(), arena(), change, args);
}

/// Add an ABC to the domain, loaded into application domain `appDomain`
/// (0, the root, or one domainChild made); 0, or the VerifyError it was
/// rejected with; -1 for an application domain never made or dropped.
pub fn domainAdd(bytes: []const u8, builtin: bool, appDomain: i32) Allocator.Error!i32 {
    abandon();
    if (!isLive(try domain(), appDomain)) {
        return -1;
    }

    forgetVerified();
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
    return if (appDomain >= 0 and appDomain < dom.domainState.len) dom.domainState.get(@intCast(appDomain)) else -1;
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
/// ancestors: 0, or -1, leaving them evicted, if they cannot be. A revival
/// that needs a rebuild (1, or 2 `stepped`) waits for stage 6's: until
/// then no rebuild ever is, so none needs one.
pub fn domainRevive(appDomain: i32, stepped: bool) Allocator.Error!i32 {
    _ = stepped;
    abandon();
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
    abandon();
    forgetVerified();
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

// Modules (stage 5). The module written last, kept for its source map and
// entries, or being written a part at a time, lasts past the call that
// wrote it: in an arena of its own, given back when the next one starts,
// or the domain changes under it.

/// The arena the kept or pending module is in, while there is one.
var module_arena: ?memory.Arena = null;
/// The emitter of the module domainModule wrote last, if it was kept.
var written: ?*ModuleEmitter = null;
/// The module being written a part at a time, what it was started with, and the domain's rows before it.
var pending: ?*ModuleEmitter = null;
var pending_index: u32 = 0;
var pending_keep: bool = false;
var pending_rows: u64 = 0;

/// The last ABC's methods verified, kept for domainEmitEach, which compiles
/// them one at a time; another ABC added, or a new domain, starts over.
var verified: ?[]i32 = null;
var verified_index: u32 = 0;
var verified_domain: ?*const Domain = null;

/// Leave the module being written a part at a time, as the domain changes
/// under it; its rows are weighed to its ABC as a finished module's are
/// (compile.ts tells what it leaves fixed in the domain).
fn abandon() void {
    if (pending != null) {
        if (current) |dom| {
            lifetime.weigh(dom, pending_index, pending_rows);
        }

        pending = null;
    }
}

/// The kept and pending modules let go of, and their memory with them.
fn forgetModules() void {
    written = null;
    pending = null;
    if (module_arena) |*a| {
        a.deinit();
        module_arena = null;
    }
}

/// The bodies domainEmitEach verified, let go of.
pub fn forgetVerified() void {
    if (verified) |results| {
        memory.pages().allocator().free(results);
        verified = null;
    }
}

/// An arena for a new module, the last one's given back.
fn moduleArena() Allocator {
    forgetModules();
    memory.arenas();
    module_arena = .init(memory.pages().allocator());
    return module_arena.?.allocator();
}

/// `hashes`, one per line, as the cache key names them; none for "".
fn splitHashes(gpa: Allocator, hashes: []const u8) Allocator.Error![]const []const u8 {
    if (hashes.len == 0) {
        return &.{};
    }

    var list: std.ArrayList([]const u8) = .empty;
    var parts = std.mem.splitScalar(u8, hashes, '\n');
    while (parts.next()) |part| {
        try list.append(gpa, part);
    }

    return list.items;
}

/// The ES module ABC `index` compiles to, the last added for -1 (compile.ts
/// tells against what, and what `hashes` and `linkedOnly` are), as its
/// UTF-8 bytes; none if there is no such ABC.
pub fn domainModule(gpa: Allocator, hashes: []const u8, index: i32, keep: bool, linkedOnly: bool) Allocator.Error![]const u8 {
    const dom = try domain();
    abandon();
    forgetModules();
    // No ABC, no module: the caller asked before adding one.
    const at = abcIndex(dom, index);
    if (at < 0) {
        return "";
    }

    const list = try splitHashes(gpa, hashes);
    const persist = moduleArena();
    const emitter = try persist.create(ModuleEmitter);
    emitter.* = try .init(persist, gpa, dom, @intCast(at));
    changed(writeModule, .{ emitter, list, linkedOnly }) catch |err| {
        forgetModules();
        return err;
    };
    if (keep) {
        written = emitter;
    }

    return emitter.out().written();
}

fn writeModule(dom: *Domain, emitter: *ModuleEmitter, hashes: []const []const u8, linkedOnly: bool) Allocator.Error!void {
    const rows = dom.rows();
    try emitter.module(hashes, linkedOnly);
    lifetime.weigh(dom, emitter.index, rows);
}

/// domainModule's module a part at a time (compile.ts tells why): its first
/// part, and domainModuleDone false while there is more, which
/// domainModuleMoreBytes hands out, a call each; null, nothing handed out,
/// if there is no such ABC.
///
/// All or nothing holds for each call, not for the module: a part that
/// runs out of memory leaves the domain as the parts before it left it,
/// and the module is abandoned, as one the domain changed under is.
pub fn domainModuleBytes(gpa: Allocator, hashes: []const u8, index: i32, keep: bool, linkedOnly: bool) Allocator.Error!?[]const u8 {
    const dom = try domain();
    abandon();
    forgetModules();
    const at = abcIndex(dom, index);
    if (at < 0) {
        return null;
    }

    const list = try splitHashes(gpa, hashes);
    const persist = moduleArena();
    const emitter = try persist.create(ModuleEmitter);
    emitter.* = try .init(persist, gpa, dom, @intCast(at));
    pending = emitter;
    pending_index = @intCast(at);
    pending_keep = keep;
    pending_rows = dom.rows();
    changed(startModule, .{ emitter, list, linkedOnly }) catch |err| {
        abandon();
        forgetModules();
        return err;
    };
    return emitter.out().written();
}

fn startModule(dom: *Domain, emitter: *ModuleEmitter, hashes: []const []const u8, linkedOnly: bool) Allocator.Error!void {
    try emitter.begin(hashes, linkedOnly);
    try stepModule(dom, emitter, false);
}

fn stepModule(dom: *Domain, emitter: *ModuleEmitter, fresh: bool) Allocator.Error!void {
    if (!try emitter.step(part_budget, fresh)) {
        return;
    }

    pending = null;
    lifetime.weigh(dom, pending_index, pending_rows);
    if (pending_keep) {
        written = emitter;
    }
}

/// The next part of the module domainModuleBytes started; null, nothing
/// handed out, once it is done.
pub fn domainModuleMoreBytes(gpa: Allocator) Allocator.Error!?[]const u8 {
    _ = try domain();
    const emitter = pending orelse return null;
    // A module kept keeps all its text, for its source map and entries.
    const from = if (pending_keep) emitter.out().len() else 0;
    try emitter.prepare(gpa);
    changed(stepModule, .{ emitter, !pending_keep }) catch |err| {
        // The parts before this one changed the domain: weighed as an
        // abandoned module's are.
        abandon();
        forgetModules();
        return err;
    };
    return emitter.out().written()[from..];
}

/// Whether the module domainModuleBytes started is done, or was abandoned.
pub fn domainModuleDone() bool {
    return pending == null;
}

/// For tests: each part's budget, as step counts it; PART_BUDGET for 0 or less.
pub fn domainPartBudget(bytes: i32) void {
    part_budget = if (bytes > 0) @intCast(bytes) else PART_BUDGET;
}

/// The source map of the module domainModule wrote last, as JSON.
pub fn domainSourceMap(gpa: Allocator) Allocator.Error![]const u8 {
    const emitter = written orelse return "";
    var map: Output = try .init(gpa);
    try emitter.sourceMap(&map);
    return map.written();
}

/// The compiled methods' entries in F of the module domainModule wrote last:
/// for each, its body's index, U+0001, its entry, U+0002.
pub fn domainModuleEntries(gpa: Allocator) Allocator.Error![]const u8 {
    const emitter = written orelse return "";
    const text = emitter.out().written();
    var entries: Output = try .init(gpa);
    for (emitter.entryBody.items, emitter.entryStart.items, emitter.entryEnd.items) |body, start, end| {
        try entries.uint(body);
        try entries.byte(1);
        try entries.text(text[start..end]);
        try entries.byte(2);
    }

    return entries.written();
}

/// Method bodies of ABC `abc` (the last added for -1) compiled alone, as
/// domainModuleEntries writes them (compile.ts tells what `bodies` and
/// `reuse` are).
pub fn domainEmitEach(gpa: Allocator, bodies: []const u8, reuse: bool, abc: i32) Allocator.Error![]const u8 {
    const dom = try domain();
    abandon();
    const at = abcIndex(dom, abc);
    if (at < 0) {
        return "";
    }

    return emitEachOn(dom, arena(), gpa, bodies, reuse, @intCast(at));
}

/// domainEmitEach on domain `dom`, whose arena is `a`, changed all or
/// nothing; what it verifies kept for the next only once the change is.
pub fn emitEachOn(dom: *Domain, a: *memory.Arena, gpa: Allocator, bodies: []const u8, reuse: bool, index: u32) Allocator.Error![]const u8 {
    const cached = verified != null and verified_domain == dom and verified_index == index;
    return domain_.changed(dom, a, emitEach, .{ gpa, bodies, reuse, index }) catch |err| {
        // Verified in the change rolled back: what it fixed in the domain is
        // gone, so a retry verifies again.
        if (!cached) {
            forgetVerified();
        }

        return err;
    };
}

fn emitEach(dom: *Domain, gpa: Allocator, bodies: []const u8, reuse: bool, index: u32) Allocator.Error![]const u8 {
    const abc = dom.abcs.get(index);
    const rows = dom.rows();
    const results = try verifiedBodies(dom, index);
    const decoder = try code.bodyDecoder(dom, index);
    var entries: Output = try .init(gpa);
    var emitter: ModuleEmitter = try .init(gpa, gpa, dom, index);
    var list = std.mem.splitScalar(u8, bodies, ',');
    while (list.next()) |item| {
        // An empty item, or an index the ABC has no body for, names nothing.
        if (item.len == 0) {
            continue;
        }

        const body: u32 = @bitCast(parseI32(item));
        if (body >= abc.bodyCount()) {
            continue;
        }

        const method = abc.bodyMethod.get(body);
        if (results[body] != 0 or abc.methodFlags[method] & C.METHOD_Native != 0) {
            continue;
        }

        if (!reuse) {
            emitter.renew();
        }

        const global = dom.methodStart.get(index) + method;
        _ = try decoder.decode(body, dom.traits.scopeOf(global));
        const out = emitter.out();
        out.reset();
        emitter.methods.map.reset();
        try emitter.factory(method, global, decoder);
        try entries.uint(body);
        try entries.byte(1);
        try entries.text(out.written());
        try entries.byte(2);
    }

    lifetime.weigh(dom, index, rows);
    return entries.written();
}

/// The bodies of ABC `index` verified, kept from the last call that asked.
fn verifiedBodies(dom: *Domain, index: u32) Allocator.Error![]i32 {
    if (verified) |results| {
        if (verified_domain == dom and verified_index == index) {
            return results;
        }
    }

    const results = try code.verifyMethods(dom, index);
    // Kept past the call's arena, until the domain changes.
    const kept = try memory.pages().allocator().dupe(i32, results);
    forgetVerified();
    verified = kept;
    verified_index = index;
    verified_domain = dom;
    return kept;
}

/// AssemblyScript's i32.parse of a decimal item: digits after an optional
/// sign, up to the first other character; 0 for none.
fn parseI32(text: []const u8) i32 {
    var i: usize = 0;
    var negative = false;
    if (i < text.len and (text[i] == '-' or text[i] == '+')) {
        negative = text[i] == '-';
        i += 1;
    }

    var n: i32 = 0;
    while (i < text.len and text[i] >= '0' and text[i] <= '9') : (i += 1) {
        n = n *% 10 +% @as(i32, text[i] - '0');
    }

    return if (negative) -%n else n;
}
