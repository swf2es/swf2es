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
const output = @import("output.zig");
const Output = output.Output;
const traits_ = @import("avm2/link/traits.zig");
const ModuleEmitter = @import("avm2/emit/module.zig").ModuleEmitter;

/// A domain and its arena, which gives back everything of it at once.
const Box = struct {
    arena: memory.Arena,
    dom: Domain,
};

/// The domain the exports compile against.
var current: ?*Box = null;
/// The API version the domain is made with, until a reset sets another.
var api_version: u8 = domain_.API_LatestFP;

/// The domain's arena.
fn arena() *memory.Arena {
    return &current.?.arena;
}

/// A new domain at `apiVersion` in an arena of its own.
fn make(apiVersion: u8) Allocator.Error!*Box {
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
fn unmake(box: *Box) void {
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
    if (written == null and pending == null) {
        forgetModules();
    }
}

/// The domain given back, as when the module starts, for the tests.
pub fn release() void {
    forgetModules();
    forgetVerified();
    dropRebuild();
    dropLoading();
    revived_bottom = -1;
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
        }, partBudget());
        revived_bottom = appDomain;
        revived_top = top;
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
        if (current) |box| {
            lifetime.weigh(&box.dom, pending_index, pending_rows);
        }

        pending = null;
    }

    leaveRebuild();
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

        const body: u32 = @bitCast(try parseI32(gpa, item));
        if (body >= abc.bodyCount()) {
            continue;
        }

        const method = abc.bodyMethod[body];
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

/// AssemblyScript's i32.parse and I32.parseInt of `text`, given as the
/// host's string was encoded (WTF-8): its strtol, on the string's UTF-16
/// units, a radix taken from a 0b, 0o or 0x prefix, 10 otherwise, and 0
/// where no digit leads; its arithmetic wraps as i32's does.
fn parseI32(gpa: Allocator, text: []const u8) Allocator.Error!i32 {
    const units = try output.decodeUnits(gpa, text);
    var at: usize = 0;
    var len = units.len;
    if (len == 0) {
        return 0;
    }

    while (at < units.len and isSpace(units[at])) {
        at += 1;
        len -%= 1;
    }

    var sign: i32 = 1;
    if (at < units.len and (units[at] == '-' or units[at] == '+')) {
        len -%= 1;
        if (len == 0) {
            return 0;
        }

        if (units[at] == '-') {
            sign = -1;
        }

        at += 1;
    }

    var radix: u32 = 10;
    if (at + 1 < units.len and units[at] == '0' and len > 2) {
        switch (units[at + 1] | 32) {
            'b' => radix = 2,
            'o' => radix = 8,
            'x' => radix = 16,
            else => {},
        }

        if (radix != 10) {
            at += 2;
            len -= 2;
        }
    }

    var n: i32 = 0;
    const initial = len -% 1;
    while (len > 0 and at < units.len) {
        len -= 1;
        var digit: u32 = units[at];
        if (digit -% '0' < 10) {
            digit -= '0';
        } else if (digit -% 'A' <= 'Z' - 'A') {
            digit -= 'A' - 10;
        } else if (digit -% 'a' <= 'z' - 'a') {
            digit -= 'a' - 10;
        }

        if (digit >= radix) {
            if (initial == len) {
                return 0;
            }

            break;
        }

        n = n *% @as(i32, @intCast(radix)) +% @as(i32, @intCast(digit));
        at += 1;
    }

    return sign *% n;
}

/// AssemblyScript's isSpace, of a UTF-16 unit.
fn isSpace(c: u32) bool {
    if (c < 0x1680) {
        return (c | 0x80) == 0xa0 or c -% 0x09 <= 0x0d - 0x09;
    }

    if (c -% 0x2000 <= 0x200a - 0x2000) {
        return true;
    }

    return switch (c) {
        0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        else => false,
    };
}

// Context, keys and the log (compile.ts tells each export's why).

/// The live ABCs application domain `own` sees, by index, in load order.
fn seenBy(dom: *const Domain, gpa: Allocator, own: u32) Allocator.Error![]u32 {
    var seen: std.ArrayList(u32) = .empty;
    for (0..dom.abcs.len) |i| {
        if (dom.sees(own, dom.abcDomain.get(@intCast(i)))) {
            try seen.append(gpa, @intCast(i));
        }
    }

    return seen.items;
}

/// ABC `abc`'s place in `seen`, or -1.
fn placeOf(seen: []const u32, abc: u32) i32 {
    var low: i32 = 0;
    var high: i32 = @as(i32, @intCast(seen.len)) - 1;
    while (low <= high) {
        const mid: i32 = @intCast(@as(u32, @bitCast(low + high)) >> 1);
        const at = seen[@intCast(mid)];
        if (at == abc) {
            return mid;
        }

        if (at < abc) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return -1;
}

/// How many parents up from application domain `own` `other` is, or -1 if it is not `own` or an ancestor.
fn depthOf(dom: *const Domain, own: u32, other: u32) i32 {
    var depth: i32 = 0;
    var d: i32 = @intCast(own);
    while (d >= 0) : (d = dom.domainParent.get(@intCast(d))) {
        if (@as(u32, @intCast(d)) == other) {
            return depth;
        }

        depth += 1;
    }

    return -1;
}

/// The first two lines of a context: the ABCs `seen`, comma-separated, and the place of ABC `at` among them.
fn writeSeen(out: *Output, seen: []const u32, at: u32) Allocator.Error!void {
    for (seen, 0..) |abc, i| {
        if (i > 0) {
            try out.byte(',');
        }

        try out.uint(abc);
    }

    try out.byte('\n');
    try out.uint(@as(u32, @bitCast(placeOf(seen, at))));
}

/// Log entry `e` as a context names it to application domain `own`, which
/// sees the ABCs `seen`, `count` of them added before it (compile.ts tells
/// the form): whether it wrote it.
fn writeEntry(dom: *const Domain, gpa: Allocator, out: *Output, e: u32, own: u32, seen: []const u32, count: u32) Allocator.Error!bool {
    const kind = dom.logKind.get(e);
    const place = placeOf(seen, dom.logAbc.get(e));
    if (kind == domain_.LOG_None or place < 0) {
        return false;
    }

    const f = dom.logA.get(e);
    const depth = if (kind == domain_.LOG_Found) depthOf(dom, own, dom.foundDomain.get(f)) else 0;
    if (depth < 0) {
        return false;
    }

    try out.byte('\n');
    try out.uint(kind);
    try out.byte(' ');
    try out.int(place);
    try out.byte(' ');
    try out.uint(count);
    try out.byte(' ');
    if (kind != domain_.LOG_Found) {
        try out.uint(f);
        try out.byte(' ');
        try out.uint(dom.logB.get(e));
        return true;
    }

    try out.int(depth);
    try out.byte(' ');
    try out.uint(dom.foundKind.get(f));
    try out.byte(' ');
    try out.uint(dom.foundAsType.get(f));
    try out.byte(' ');
    try named(gpa, out, dom.foundUri.get(f));
    try named(gpa, out, dom.foundName.get(f));
    return true;
}

/// A finding's name, as the host gave it (WTF-8), as domainContext writes
/// AssemblyScript's string of it: its length in UTF-16 units, ":", and its
/// units, a backslash, a control character or one past ASCII escaped.
fn named(gpa: Allocator, out: *Output, bytes: []const u8) Allocator.Error!void {
    const units = try output.decodeUnits(gpa, bytes);
    try out.uint(units.len);
    try out.byte(':');
    for (units) |c| {
        if (c >= 0x20 and c < 0x7f and c != '\\') {
            try out.byte(@intCast(c));
        } else {
            try out.unit(c);
        }
    }
}

/// The index of the first log entry made with more than `after` ABCs added, or the log's length.
fn firstAfter(dom: *const Domain, after: i32) u32 {
    var low: u32 = 0;
    var high: u32 = dom.logAt.len;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (@as(i64, dom.logAt.get(mid)) <= after) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low;
}

/// What ABC `index` (the last added for -1) depends on in the domain beyond
/// the ABCs' bytes, for a host's cache key (compile.ts tells the form);
/// "" if there is no such ABC.
pub fn domainContext(gpa: Allocator, index: i32, after: i32, upTo: i32) Allocator.Error![]const u8 {
    const dom = try domain();
    const at = abcIndex(dom, index);
    if (at < 0) {
        return "";
    }

    const own = dom.abcDomain.get(@intCast(at));
    const seen = try seenBy(dom, gpa, own);
    var out: Output = try .init(gpa);
    try writeSeen(&out, seen, @intCast(at));
    var count: u32 = 0;
    for (0..dom.logKind.len) |e_| {
        const e: u32 = @intCast(e_);
        // Visible ABCs added before the entry happened.
        while (count < seen.len and seen[count] < dom.logAt.get(e)) {
            count += 1;
        }

        const made: i64 = dom.logAt.get(e);
        if (made <= after or (upTo >= 0 and made > upTo)) {
            continue;
        }

        _ = try writeEntry(dom, gpa, &out, e, own, seen, count);
    }

    return out.written();
}

/// What a module cache key names of ABC `index` besides its application
/// domain's log (compile.ts tells the form); null, no address, if there is
/// no such ABC.
pub fn domainKeyHeaderBytes(gpa: Allocator, index: i32) Allocator.Error!?[]const u8 {
    const dom = try domain();
    const at = abcIndex(dom, index);
    if (at < 0) {
        return null;
    }

    const own = dom.abcDomain.get(@intCast(at));
    const seen = try seenBy(dom, gpa, own);
    if (seen.len == 0) {
        return null;
    }

    var out: Output = try .init(gpa);
    try writeSeen(&out, seen, @intCast(at));
    try out.byte('\n');
    try out.uint(own);
    try out.byte('\n');
    try out.uint(dom.generation);
    try out.byte('\n');
    try out.uint(firstAfter(dom, @intCast(seen[seen.len - 1])));
    return out.written();
}

/// How far live application domain `appDomain`'s log is its parent's,
/// entry for entry (compile.ts tells how it is bounded).
pub fn domainKeyFork(appDomain: i32) Allocator.Error!i32 {
    const dom = try domain();
    if (appDomain <= 0 or !isLive(dom, appDomain)) {
        return 0;
    }

    // Never past the entries made before the last ABC was added, which a
    // verification under way may still take back.
    const own: u32 = @intCast(appDomain);
    var bound = firstAfter(dom, @as(i32, @intCast(dom.abcs.len)) - 1);
    for (0..dom.abcs.len) |i| {
        if (dom.abcDomain.get(@intCast(i)) == own) {
            bound = firstAfter(dom, @intCast(i));
            break;
        }
    }

    for (0..dom.foundEntry.len) |k| {
        const e = dom.foundEntry.get(@intCast(k));
        if (e >= bound) {
            break;
        }

        if (depthOf(dom, own, dom.foundDomain.get(@intCast(k))) >= 0) {
            bound = e;
            break;
        }
    }

    return @intCast(bound);
}

/// Live application domain `appDomain`'s log as domainContext writes it,
/// from entry `from` to `to`, in blocks (compile.ts tells the form); null,
/// no address, if `appDomain` is not live.
pub fn domainKeyLogBytes(gpa: Allocator, appDomain: i32, after: i32, from: i32, to: i32, block: i32, filledIn: i32) Allocator.Error!?[]const u8 {
    const dom = try domain();
    if (!isLive(dom, appDomain) or from < 0 or filledIn < 0 or (block > 0 and filledIn >= block)) {
        return null;
    }

    var filled = filledIn;
    const own: u32 = @intCast(appDomain);
    const seen = try seenBy(dom, gpa, own);
    var out: Output = try .init(gpa);
    const length = dom.logKind.len;
    const end: u32 = if (to < 0 or to > length) length else @intCast(to);
    var count: u32 = 0;
    var e: u32 = @max(@as(u32, @intCast(from)), firstAfter(dom, after));
    while (e < end) : (e += 1) {
        while (count < seen.len and seen[count] < dom.logAt.get(e)) {
            count += 1;
        }

        if (try writeEntry(dom, gpa, &out, e, own, seen, count) and block > 0) {
            filled += 1;
            if (filled == block) {
                try out.byte('\n');
                try out.byte('#');
                try out.uint(e + 1);
                filled = 0;
            }
        }
    }

    try out.byte('\n');
    try out.byte('$');
    try out.uint(e);
    return out.written();
}

/// What changes whenever domainContext might: how many ABCs there are, how
/// long the log is, and how many rebuilds the domain is from its reset.
pub fn domainRevision(gpa: Allocator) Allocator.Error![]const u8 {
    const dom = try domain();
    return std.fmt.allocPrint(gpa, "{d} {d} {d}", .{ dom.abcs.len, dom.logKind.len, dom.generation });
}

/// How long the domain's log is, to tell what a compile adds to it (domainLogSince).
pub fn domainLogMark() Allocator.Error!i32 {
    return @intCast((try domain()).logKind.len);
}

/// The log's entries since `mark`, as a compile of ABC `index` added them,
/// a line each, for domainReplay; "!" if one is of another kind, or of an
/// ABC the domain does not see.
pub fn domainLogSince(gpa: Allocator, mark: i32, index: i32) Allocator.Error![]const u8 {
    const dom = try domain();
    const at = abcIndex(dom, index);
    if (at < 0 or mark < 0) {
        return "!";
    }

    const seen = try seenBy(dom, gpa, dom.abcDomain.get(@intCast(at)));
    var out: Output = try .init(gpa);
    var lines: u32 = 0;
    var e: u32 = @intCast(mark);
    while (e < dom.logKind.len) : (e += 1) {
        const kind = dom.logKind.get(e);
        if (kind == domain_.LOG_None) {
            continue;
        }

        const place = placeOf(seen, dom.logAbc.get(e));
        if (kind == domain_.LOG_Found or place < 0) {
            return "!";
        }

        if (lines > 0) {
            try out.byte('\n');
        }

        lines += 1;
        try out.uint(kind);
        try out.byte(' ');
        try out.int(place);
        try out.byte(' ');
        try out.uint(dom.logA.get(e));
        try out.byte(' ');
        try out.uint(dom.logB.get(e));
    }

    return out.written();
}

/// Recovery keeps absolute ABC indices. A compile in a transient child can resolve an ancestor.
pub fn journalBytes(gpa: Allocator, mark: u32) Allocator.Error!?[]const u8 {
    const dom = try domain();
    var words: std.ArrayList(u32) = .empty;
    for (@min(mark, dom.logKind.len)..dom.logKind.len) |e_| {
        const e: u32 = @intCast(e_);
        const kind = dom.logKind.get(e);
        if (kind == domain_.LOG_None) continue;
        if (kind == domain_.LOG_Found) return null;
        try words.appendSlice(gpa, &.{ kind, dom.logAbc.get(e), dom.logA.get(e), dom.logB.get(e) });
    }
    return std.mem.sliceAsBytes(words.items);
}

pub fn replayEntry(kind: u32, index: u32, a: u32, b: u32) Allocator.Error!bool {
    const dom = try domain();
    if (kind > domain_.LOG_Verify or index >= dom.abcs.len or !dom.isLive(index)) return false;

    return changed(replayOne, .{ @as(u8, @intCast(kind)), index, a, b });
}

fn replayOne(dom: *Domain, kind: u8, index: u32, a: u32, b: u32) Allocator.Error!bool {
    const rows = dom.rows();
    const ok = try replayed(dom, kind, index, a, b);
    lifetime.weigh(dom, index, rows);
    return ok;
}

/// Do again for ABC `index` what a compile of it added to the log, as
/// domainLogSince wrote it, without compiling (compile.ts tells why):
/// false if an entry is malformed or comes out an error; the entries
/// before it are done. All or nothing where memory runs out.
pub fn domainReplay(gpa: Allocator, log: []const u8, index: i32) Allocator.Error!bool {
    const dom = try domain();
    abandon();
    const at = abcIndex(dom, index);
    if (at < 0) {
        return false;
    }

    forgetVerified();
    forgetModules();
    return changed(replayLog, .{ gpa, log, @as(u32, @intCast(at)) });
}

fn replayLog(dom: *Domain, gpa: Allocator, log: []const u8, at: u32) Allocator.Error!bool {
    const rows = dom.rows();
    const seen = try seenBy(dom, gpa, dom.abcDomain.get(at));
    var ok = true;
    if (log.len > 0) {
        var lines = std.mem.splitScalar(u8, log, '\n');
        while (ok) {
            const line = lines.next() orelse break;
            var fields: [4][]const u8 = undefined;
            var count: usize = 0;
            var parts = std.mem.splitScalar(u8, line, ' ');
            while (parts.next()) |part| : (count += 1) {
                if (count < 4) {
                    fields[count] = part;
                }
            }

            if (count != 4) {
                ok = false;
                break;
            }

            const kind = try parseI32(gpa, fields[0]);
            const place = try parseI32(gpa, fields[1]);
            const a = try parseI32(gpa, fields[2]);
            const b = try parseI32(gpa, fields[3]);
            if (place < 0 or place >= seen.len or a < 0 or b < 0) {
                ok = false;
                break;
            }

            ok = try replayed(dom, @truncate(@as(u32, @bitCast(kind))), seen[@intCast(place)], @intCast(a), @intCast(b));
        }
    }

    lifetime.weigh(dom, at, rows);
    return ok;
}

/// Entry `kind` of ABC `abc` done again, as a rebuild replays one, its numbers checked against the ABC first.
fn replayed(dom: *Domain, kind: u8, abc: u32, a: u32, b: u32) Allocator.Error!bool {
    const info = dom.abcs.get(abc);
    if (kind == domain_.LOG_Verify) {
        _ = try code.verifyMethods(dom, abc);
        return true;
    }

    if (kind == domain_.LOG_Sign) {
        return b < info.methodCount() and try dom.traits.sign(dom, dom.methodStart.get(abc) + b) == 0;
    }

    if (kind != domain_.LOG_Resolve or a < traits_.TRAITS_Instance or a > traits_.TRAITS_Activation) {
        return false;
    }

    const owners: u32 = switch (a) {
        traits_.TRAITS_Script => info.scriptCount(),
        traits_.TRAITS_Activation => @intCast(dom.bodyTraits.get(abc).len),
        else => info.classCount(),
    };
    const t = if (b < owners) lifetime.traitsOf(dom, abc, a, b) else -1;
    return t >= 0 and try dom.traits.resolve(dom, @intCast(t)) == 0;
}

// The rebuild, saving and loading (compile.ts tells each export's why).

/// A rebuild under way: the new domain it builds, in an arena of its own,
/// and the domain it builds from where that is not the current one but a
/// loaded one, given back with it.
const Rebuilding = struct {
    previous_limit: ?u32 = null,
    box: *Box,
    source: ?*Box,
    rebuild: lifetime.Rebuild,
};

/// The rebuild a part at a time and the garbage each part may make, and the
/// evicted domains it revives, from `revived_bottom` up to `revived_top`;
/// -1 for none.
var rebuilding: ?*Rebuilding = null;
var rebuilding_budget: u64 = 0;
var revived_bottom: i32 = -1;
var revived_top: u32 = 0;

/// The domain domainLoad started, until domainLoadRebuild, and the garbage its parts may make.
const Loading = struct {
    box: *Box,
    loaded: lifetime.Loaded,
    target: *Box,
};
var loading: ?*Loading = null;
var loading_budget: u64 = 0;

/// A rebuild of `from`, `source`'s domain if one is given, into a new domain.
fn newRebuild(from: *Domain, source: ?*Box, target: ?*Box) Allocator.Error!*Rebuilding {
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

fn dropRebuild() void {
    if (rebuilding) |r| {
        freeRebuild(r);
        rebuilding = null;
    }
}

fn dropLoading() void {
    if (loading) |l| {
        unmake(l.target);
        unmake(l.box);
        memory.pages().allocator().destroy(l);
        loading = null;
    }
}

/// Start `r`, for domainRebuildStep to do a part of `budget` bytes of garbage at a time.
fn startRebuild(r: *Rebuilding, budget: u64) void {
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
        if (current) |box| {
            box.dom.decoder = null;
        }
    }
}

/// Evict again the domains a rebuild that failed or was left was reviving, as revive found them.
fn unreviveRebuilt() void {
    if (revived_bottom >= 0) {
        if (current) |box| {
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

fn stepFresh(_: *Domain, rebuild: *lifetime.Rebuild, budget: u64) Allocator.Error!bool {
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
    const old = current;
    current = r.box;
    current.?.dom.decoder = null;
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
    const want = if (stepped) lifetime.WANT_InPlace else lifetime.WANT_Synchronous;
    if (!lifetime.wantsRebuild(dom, partBudget(), part_budget, want)) {
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
    if (current) |box| {
        box.dom.decoder = null;
    }

    return -1;
}

/// What a rebuild reads of the domain but its ABCs' bytes, for another
/// instance to rebuild it in a memory of its own (domainLoad).
pub fn domainSaveBytes(gpa: Allocator) Allocator.Error![]const u8 {
    const dom = try domain();
    var out: std.ArrayList(u8) = .empty;
    try lifetime.saveDomain(dom, gpa, &out);
    return out.items;
}

/// The bytes of live ABC `index`, as added, for domainLoadAbc; null, no address, for another.
pub fn domainSavedAbcBytes(index: i32) Allocator.Error!?[]const u8 {
    const dom = try domain();
    if (index < 0 or !lifetime.savedLive(dom, @intCast(index))) {
        return null;
    }

    return lifetime.savedBytes(dom, @intCast(index));
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
    var loaded: lifetime.Loaded = .{ .dom = &box.dom };
    if (!try lifetime.loadDomain(&loaded, words)) {
        unmake(box);
        pages.destroy(l);
        return false;
    }

    // Zig grows in 64 KiB pages. Reserving the estimated AssemblyScript heap here
    // can make a move exceed the memory of the domain it is supposed to shrink.
    loading_budget = part_budget;
    if (!recovery) {
        const size = lifetime.loadedSize(&loaded, loading_budget);
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

    return lifetime.loadAbc(&l.loaded, &l.target.arena, @intCast(index), bytes);
}

/// Start rebuilding the domain domainLoad started, given all its live ABCs,
/// as the domain this instance compiles once domainRebuildStep is done:
/// whether it was started.
pub fn domainLoadRebuild() Allocator.Error!bool {
    const l = loading orelse return false;
    if (!lifetime.loadedAll(&l.loaded)) {
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
