// The AVM2 compiler's modules (stage 5; assembly/compile.ts): the module
// written last, kept for its source map and entries, or being written a
// part at a time, and the bodies the JIT compiles alone.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../memory.zig");
const parseI32 = @import("../parse.zig").parseI32;
const domain_ = @import("../avm2/link/domain.zig");
const Domain = domain_.Domain;
const lifetime = @import("../avm2/link/lifetime.zig");
const code = @import("../avm2/abc/code.zig");
const output = @import("../output.zig");
const Output = output.Output;
const ModuleEmitter = @import("../avm2/emit/module.zig").ModuleEmitter;
const compile = @import("../compile.zig");
const rebuilds = @import("rebuild.zig");
const PART_BUDGET = compile.PART_BUDGET;
const abcIndex = compile.abcIndex;
const arena = compile.arena;
const changed = compile.changed;
const domain = compile.domain;
const leaveRebuild = rebuilds.leaveRebuild;

/// The arena the kept or pending module is in, while there is one.
var module_arena: ?memory.Arena = null;
/// The emitter of the module domainModule wrote last, if it was kept.
pub var written: ?*ModuleEmitter = null;
/// The module being written a part at a time, what it was started with, and the domain's rows before it.
pub var pending: ?*ModuleEmitter = null;
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
pub fn abandon() void {
    if (pending != null) {
        if (compile.current) |box| {
            lifetime.weigh(&box.dom, pending_index, pending_rows);
        }

        pending = null;
    }

    leaveRebuild();
}

/// The kept and pending modules let go of, and their memory with them.
pub fn forgetModules() void {
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
    const at = abcIndex(dom, index) orelse return "";

    const list = try splitHashes(gpa, hashes);
    const persist = moduleArena();
    const emitter = try persist.create(ModuleEmitter);
    emitter.* = try .init(persist, gpa, dom, at);
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
    const at = abcIndex(dom, index) orelse return null;

    const list = try splitHashes(gpa, hashes);
    const persist = moduleArena();
    const emitter = try persist.create(ModuleEmitter);
    emitter.* = try .init(persist, gpa, dom, at);
    pending = emitter;
    pending_index = at;
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
    if (!try emitter.step(compile.part_budget, fresh)) {
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
    compile.part_budget = if (bytes > 0) @intCast(bytes) else PART_BUDGET;
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
    const at = abcIndex(dom, abc) orelse return "";

    return emitEachOn(dom, arena(), gpa, bodies, reuse, at);
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

        const method = abc.bodyMethod[body];
        if (results[body] != 0 or abc.methodFlags[method].native) {
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
