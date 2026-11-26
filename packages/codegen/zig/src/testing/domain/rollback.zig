// The test build's tests that hold a domain to rolling back: each call that
// changes it, run out of memory anywhere, leaves it as it was, which its
// fingerprint shows; made again, it ends as one never short of memory.
const std = @import("std");
const Allocator = std.mem.Allocator;
const compile = @import("../../compile.zig");
const domain_ = @import("../../avm2/link/domain.zig");
const Domain = domain_.Domain;
const code = @import("../../avm2/abc/code.zig");
const ModuleEmitter = @import("../../avm2/emit/module.zig").ModuleEmitter;
const memory = @import("../../memory.zig");
const lifetime = @import("../../avm2/link/lifetime.zig");
const testing = std.testing;
const dumps = @import("../domain.zig");
const abcs = @import("abcs.zig");
const domainResolve = dumps.domainResolve;
const domainSlotTypes = dumps.domainSlotTypes;
const domainVerifyAll = dumps.domainVerifyAll;
const domainEmit = dumps.domainEmit;
const domainIr = dumps.domainIr;
const domainCheckIr = dumps.domainCheckIr;
const domainIrAll = dumps.domainIrAll;
const domainTraitsCount = dumps.domainTraitsCount;
const link_builtin = abcs.link_builtin;
const link_user = abcs.link_user;
const link_failing = abcs.link_failing;
const link_wide = abcs.link_wide;
const link_created = abcs.link_created;
const link_contested = abcs.link_contested;

/// A digest of everything a domain holds but getBinding's memo, which a
/// rollback empties: each table's rows, each id table's slots, the numbers
/// beside them, and by their content what rows point at (each ABC's
/// tables, each string, each scope), never an address. Equal before a call
/// and after it ran out of memory, and for two domains given the same calls.
fn fingerprint(dom: *const Domain) u64 {
    var h: std.hash.Wyhash = .init(0);
    hashFields(&h, dom);
    return h.final();
}

const field_count = @typeInfo(Domain).@"struct".field_names.len + @typeInfo(@import("../../avm2/link/traits.zig").TraitsTable).@"struct".field_names.len;

/// Each field's digest, to name the ones a rollback missed.
fn fieldPrints(dom: *const Domain) [field_count]u64 {
    var prints: [field_count]u64 = @splat(0);
    var k: usize = 0;
    inline for (@typeInfo(Domain).@"struct".field_names) |name| {
        var h: std.hash.Wyhash = .init(0);
        hashField(&h, dom, name);
        prints[k] = h.final();
        k += 1;
    }

    inline for (@typeInfo(@TypeOf(dom.traits)).@"struct".field_names) |name| {
        var h: std.hash.Wyhash = .init(0);
        hashValue(&h, @field(dom.traits, name));
        prints[k] = h.final();
        k += 1;
    }

    return prints;
}

fn printDiffering(a: [field_count]u64, b: [field_count]u64) void {
    var k: usize = 0;
    inline for (@typeInfo(Domain).@"struct".field_names ++ @typeInfo(@import("../../avm2/link/traits.zig").TraitsTable).@"struct".field_names) |name| {
        if (a[k] != b[k]) {
            std.debug.print("differs: {s}\n", .{name});
        }

        k += 1;
    }
}

fn hashFields(h: *std.hash.Wyhash, dom: *const Domain) void {
    inline for (@typeInfo(Domain).@"struct".field_names) |name| {
        hashField(h, dom, name);
    }
}

fn hashField(h: *std.hash.Wyhash, dom: *const Domain, comptime name: []const u8) void {
    const skipped = comptime std.mem.eql(u8, name, "gpa") or
        std.mem.eql(u8, name, "scratch") or
        std.mem.eql(u8, name, "undo") or
        std.mem.eql(u8, name, "decoder") or
        std.mem.eql(u8, name, "bindingMemo") or
        // Addresses into the ABCs' bytes, which abcBuffer has by content.
        std.mem.eql(u8, name, "abcBase") or
        std.mem.eql(u8, name, "truncated") or
        std.mem.startsWith(u8, name, "memo");
    if (comptime std.mem.eql(u8, name, "stringPtr")) {
        h.update(std.mem.asBytes(&dom.stringPtr.len));
        for (0..dom.stringPtr.len) |i| {
            const bytes = dom.stringOf(@intCast(i));
            h.update(std.mem.asBytes(&bytes.len));
            h.update(bytes);
        }
    } else if (!skipped) {
        hashValue(h, @field(dom.*, name));
    }
}

fn hashValue(h: *std.hash.Wyhash, value: anytype) void {
    const T = @TypeOf(value);
    switch (@typeInfo(T)) {
        .int, .bool, .float => h.update(std.mem.asBytes(&value)),
        .optional => if (value) |inner| {
            h.update(&.{1});
            hashValue(h, inner);
        } else {
            h.update(&.{0});
        },
        .pointer => |ptr| switch (ptr.size) {
            .slice => {
                h.update(std.mem.asBytes(&value.len));
                switch (@typeInfo(ptr.child)) {
                    .int, .bool, .float => h.update(std.mem.sliceAsBytes(value)),
                    else => for (value) |item| hashValue(h, item),
                }
            },
            .one => hashValue(h, value.*),
            else => @compileError("an address the digest cannot follow: " ++ @typeName(T)),
        },
        .@"struct" => |info| if (@hasField(T, "directory")) {
            h.update(std.mem.asBytes(&value.len));
            var i: u32 = 0;
            while (i < value.len) : (i += 1) {
                hashValue(h, value.get(i));
            }
        } else {
            inline for (info.field_names) |name| {
                // An ArrayList's room, which differs as it grew.
                if (comptime !std.mem.eql(u8, name, "capacity")) {
                    hashValue(h, @field(value, name));
                }
            }
        },
        else => {},
    }
}

test "the link ABCs are tests/parity/link-abc.ts's, and link as AssemblyScript links them" {
    memory.arenas();
    defer compile.release();
    try compile.domainReset(50);
    try testing.expectEqual(0, try compile.domainAdd(&link_builtin, true, 0));
    const child = try compile.domainChild(0);
    try testing.expectEqual(0, try compile.domainAdd(&link_user, false, child));
    try testing.expectEqual(1103, try compile.domainAdd(&link_failing, false, 0));
    try testing.expectEqual(0, try compile.changed(domainResolve, .{0}));
    try testing.expectEqual(18, try domainTraitsCount());
    try testing.expectEqualStrings("abc 0 class 4, abc 0 class 0", try compile.changed(domainSlotTypes, .{ memory.call.allocator(), 0, 4 }));
    try testing.expectEqualStrings("abc 0 class 4, abc 0 class 0, abc 0 class 5", try compile.changed(domainSlotTypes, .{ memory.call.allocator(), 1, 0 }));
    memory.call.reset();
}

test "a name that is not valid UTF-8 is looked up as AssemblyScript decodes and encodes it again" {
    var arena: memory.Arena = .init(testing.allocator);
    defer arena.deinit();
    var dom: Domain = try .init(arena.allocator(), arena.allocator());
    const lone = try dom.internString("\xc3");
    const tail = try dom.internString("a\xc3");
    const surrogate = try dom.internString("\xed\xa0\x80b");
    const plain = try dom.internString("c");
    // A pair of surrogates each encoded alone decodes to the pair, which encodes as one code point.
    const pair = try dom.internString("\xed\xa0\x80\xed\xb0\x80");
    try testing.expectEqual(-1, try dom.underscoredName(lone));
    // A sequence cut short at the end decodes to nothing; a lone surrogate stays one, in WTF-8.
    const underscore = try dom.internString("_");
    const a = try dom.internString("_a");
    const kept = try dom.internString("_\xed\xa0\x80b");
    const c = try dom.internString("_c");
    const joined = try dom.internString("_\xf0\x90\x80\x80");
    try testing.expectEqual(@as(i32, @intCast(joined)), try dom.underscoredName(pair));
    try testing.expectEqual(@as(i32, @intCast(underscore)), try dom.underscoredName(lone));
    try testing.expectEqual(@as(i32, @intCast(a)), try dom.underscoredName(tail));
    try testing.expectEqual(@as(i32, @intCast(kept)), try dom.underscoredName(surrogate));
    try testing.expectEqual(@as(i32, @intCast(c)), try dom.underscoredName(plain));
}

/// A domain's life through compile.zig's entries, over the module's pages
/// replaced by `p`'s: each call that runs out of memory leaves the domain
/// as it was, which its fingerprint shows.
fn domainLife(_: Allocator, p: *memory.Pages) !void {
    memory.arenas();
    compile.release();
    memory.call.reset();
    const saved = memory.swapPages(p.*);
    defer {
        compile.release();
        memory.call.reset();
        p.* = memory.swapPages(saved);
    }

    try compile.domainReset(50);
    const steps = struct {
        fn run(step: u32) !void {
            memory.call.reset();
            switch (step) {
                0 => try testing.expectEqual(0, try compile.domainAdd(&link_builtin, true, 0)),
                1 => try testing.expectEqual(1, try compile.domainChild(0)),
                2 => try testing.expectEqual(0, try compile.domainAdd(&link_user, false, 1)),
                3 => try testing.expectEqual(1103, try compile.domainAdd(&link_failing, false, 0)),
                4 => try compile.domainFound(1, 0, "", "A", 0, true),
                5 => try testing.expectEqual(0, try compile.changed(domainResolve, .{0})),
                6 => try testing.expectEqualStrings("abc 0 class 4, abc 0 class 0, abc 0 class 5", try compile.changed(domainSlotTypes, .{ memory.call.allocator(), 1, 0 })),
                7 => try compile.domainEvict(1),
                8 => try testing.expectEqual(0, try compile.domainRevive(1, false)),
                9 => try testing.expectEqual(0, try compile.domainAdd(&link_user, false, 0)),
                10 => try testing.expect((try compile.domainModule(memory.call.allocator(), "own\nfirst", -1, true, false)).len > 0),
                11 => {
                    // Neither changes the domain: one that runs out leaves it as it was.
                    _ = try compile.domainSourceMap(memory.call.allocator());
                    _ = try compile.domainModuleEntries(memory.call.allocator());
                },
                12 => {
                    // A part a method, so that the module comes in many.
                    compile.domainPartBudget(1);
                    _ = try compile.domainModuleBytes(memory.call.allocator(), "", -1, true, false);
                },
                13 => {
                    // Each part a call of its own, its domain changes kept as
                    // the next starts: each checked alone.
                    while (!compile.domainModuleDone()) {
                        memory.call.reset();
                        compile.callStarts();
                        const dom = try compile.domain();
                        const before = fingerprint(dom);
                        _ = compile.domainModuleMoreBytes(memory.call.allocator()) catch {
                            try testing.expectEqual(before, fingerprint(dom));
                            return error.PartRanOut;
                        };
                    }

                    compile.domainPartBudget(0);
                },
                14 => _ = try compile.domainSourceMap(memory.call.allocator()),
                15 => _ = try compile.domainEmitEach(memory.call.allocator(), "0,1,2,3,9999", false, -1),
                16 => _ = try compile.domainEmitEach(memory.call.allocator(), "3,2,1,0", true, -1),
                else => try compile.domainDrop(1),
            }
        }
    };
    defer compile.domainPartBudget(0);
    for (0..18) |step| {
        const dom = try compile.domain();
        const before = fingerprint(dom);
        const prints = fieldPrints(dom);
        steps.run(@intCast(step)) catch |err| {
            if (err == error.PartRanOut) {
                return error.OutOfMemory;
            }

            if (before != fingerprint(dom)) {
                std.debug.print("step {d}\n", .{step});
                printDiffering(prints, fieldPrints(dom));
            }

            try testing.expectEqual(before, fingerprint(dom));
            return err;
        };
    }

    try testing.expectEqual(21, try domainTraitsCount());

    // Enough more that the smaller memories run out among them.
    for (0..100) |k| {
        const dom = try compile.domain();
        const before = fingerprint(dom);
        const prints = fieldPrints(dom);
        memory.call.reset();
        const added = more: {
            const child = compile.domainChild(0) catch |err| break :more err;
            try testing.expectEqual(@as(i32, @intCast(k + 2)), child);
            break :more compile.domainAdd(&link_user, false, child);
        };
        _ = added catch |err| {
            // The child, made by a call of its own, stays.
            if (dom.domainParent.len == k + 3) {
                dom.domainParent.truncate(@intCast(k + 2));
                dom.domainDepth.truncate(@intCast(k + 2));
                dom.domainState.truncate(@intCast(k + 2));
                dom.domainEvicted.truncate(@intCast(k + 2));
            }

            if (before != fingerprint(dom)) printDiffering(prints, fieldPrints(dom));
            try testing.expectEqual(before, fingerprint(dom));
            return err;
        };
    }
}

test "every call that changes the domain may run out of memory anywhere, and leaves it as it was" {
    try memory.atEveryMemorySize(domainLife);
}

/// The ABCs added, a child domain made, a finding recorded and every
/// traits resolved, straight into a Domain over `source`.
fn linkAll(source: Allocator) !void {
    var arena: memory.Arena = .init(source);
    defer arena.deinit();
    var scratch: memory.Arena = .init(source);
    defer scratch.deinit();
    const dom = try arena.allocator().create(Domain);
    dom.* = try .init(arena.allocator(), scratch.allocator());
    const steps = struct {
        fn run(d: *Domain, a: *memory.Arena, step: u32) !void {
            switch (step) {
                0 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_builtin, true, 0 })),
                1 => try testing.expectEqual(1, try domain_.changed(d, a, Domain.childDomain, .{0})),
                2 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_user, false, 1 })),
                3 => try testing.expectEqual(1103, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_failing, false, 0 })),
                4 => try domain_.changed(d, a, Domain.addFound, .{ 1, .public, "", "A", 0, true }),
                else => try testing.expectEqual(0, try domain_.changed(d, a, domainResolve, .{0})),
            }
        }
    };
    for (0..6) |step| {
        const before = fingerprint(dom);
        const mark = arena.mark();
        steps.run(dom, &arena, @intCast(step)) catch |err| {
            try testing.expectEqual(before, fingerprint(dom));
            try testing.expectEqual(mark, arena.mark());
            return err;
        };
    }
}

test "every allocation of a link may fail in turn, and leaves the domain and its arena as they were" {
    try testing.checkAllAllocationFailures(testing.allocator, linkAll, .{});
}

/// An allocator that fails its `fail_at`-th allocation or growth once, and
/// none after: a call that ran out of memory can be made again.
const FailOnce = struct {
    backing: Allocator,
    fail_at: usize,
    count: usize = 0,

    fn allocator(self: *FailOnce) Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn fails(self: *FailOnce) bool {
        defer self.count += 1;
        return self.count == self.fail_at;
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *FailOnce = @ptrCast(@alignCast(ctx));
        return if (self.fails()) null else self.backing.rawAlloc(len, alignment, ra);
    }

    fn resize(ctx: *anyopaque, memory_: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) bool {
        const self: *FailOnce = @ptrCast(@alignCast(ctx));
        if (new_len > memory_.len and self.fails()) {
            return false;
        }

        return self.backing.rawResize(memory_, alignment, new_len, ra);
    }

    fn remap(ctx: *anyopaque, memory_: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
        const self: *FailOnce = @ptrCast(@alignCast(ctx));
        if (new_len > memory_.len and self.fails()) {
            return null;
        }

        return self.backing.rawRemap(memory_, alignment, new_len, ra);
    }

    fn free(ctx: *anyopaque, memory_: []u8, alignment: std.mem.Alignment, ra: usize) void {
        const self: *FailOnce = @ptrCast(@alignCast(ctx));
        self.backing.rawFree(memory_, alignment, ra);
    }
};

/// The calls of linkLife's domain, in order.
fn lifeStep(d: *Domain, a: *memory.Arena, step: u32) !void {
    switch (step) {
        0 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_builtin, true, 0 })),
        1 => try testing.expectEqual(1, try domain_.changed(d, a, Domain.childDomain, .{0})),
        2 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_user, false, 1 })),
        3 => try testing.expectEqual(1103, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_failing, false, 0 })),
        4 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_wide, false, 0 })),
        5 => try domain_.changed(d, a, Domain.addFound, .{ 1, .public, "", "A", 0, true }),
        6 => try testing.expectEqual(0, try domain_.changed(d, a, domainResolve, .{0})),
        7 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_created, false, 0 })),
        8 => try testing.expectEqualStrings("verified 2 of 2 bodies", try domain_.changed(d, a, domainVerifyAll, .{d.scratch})),
        9 => try testing.expectEqualStrings("checked 2 bodies, 18 instructions", try domain_.changed(d, a, domainCheckIr, .{d.scratch})),
        10 => _ = try domain_.changed(d, a, domainIr, .{ d.scratch, 0 }),
        11 => _ = try domain_.changed(d, a, code.verifyMethods, .{0}),
        12 => try testing.expectEqual(0, try domain_.changed(d, a, domain_.addAbc, .{ a, &link_contested, false, 0 })),
        13 => try testing.expectEqualStrings("verified 5 of 5 bodies", try domain_.changed(d, a, domainVerifyAll, .{d.scratch})),
        14 => _ = try domain_.changed(d, a, domainIrAll, .{d.scratch}),
        15 => _ = try domain_.changed(d, a, domainIr, .{ d.scratch, 3 }),
        16 => _ = try domain_.changed(d, a, domainEmit, .{ d.scratch, 3 }),
        17 => _ = try domain_.changed(d, a, wholeModule, .{ d.scratch, d.abcs.len - 1 }),
        18 => _ = try domain_.changed(d, a, partedModule, .{ d.scratch, 4 }),
        else => try testing.expectEqual(0, try domain_.changed(d, a, lifetime.restore, .{ a, 1, &link_user })),
    }
}

/// ABC `index`'s module, written whole; its length.
fn wholeModule(dom: *Domain, gpa: Allocator, index: u32) Allocator.Error!usize {
    var emitter: ModuleEmitter = try .init(gpa, gpa, dom, index);
    try emitter.module(&.{ "own", "first" }, false);
    return emitter.out().len();
}

/// ABC `index`'s module, a part a method, each part's scratch made anew; its length.
fn partedModule(dom: *Domain, gpa: Allocator, index: u32) Allocator.Error!usize {
    var emitter: ModuleEmitter = try .init(gpa, gpa, dom, index);
    try emitter.begin(&.{}, true);
    while (!try emitter.step(1, false)) {
        try emitter.prepare(gpa);
    }

    return emitter.out().len();
}

const life_steps = 20;

/// linkLife's calls on a domain over `source`, each that runs out of memory
/// checked to leave the domain and its arena as they were, then made again:
/// the domain's digest at the end.
fn linkLife(source: Allocator) !u64 {
    var arena: memory.Arena = .init(source);
    defer arena.deinit();
    var scratch: memory.Arena = .init(source);
    defer scratch.deinit();
    const dom = try arena.allocator().create(Domain);
    dom.* = try .init(arena.allocator(), scratch.allocator());
    for (0..life_steps) |step| {
        if (step == life_steps - 1) {
            lifetime.evict(dom, 1);
        }

        const before = fingerprint(dom);
        const prints = fieldPrints(dom);
        const mark = arena.mark();
        lifeStep(dom, &arena, @intCast(step)) catch |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            if (before != fingerprint(dom)) {
                printDiffering(prints, fieldPrints(dom));
            }

            try testing.expectEqual(before, fingerprint(dom));
            try testing.expectEqual(mark, arena.mark());
            try lifeStep(dom, &arena, @intCast(step));
        };
    }

    return fingerprint(dom);
}

test "a call that ran out of memory anywhere, made again, leaves the domain as one never short of memory" {
    var counting: FailOnce = .{ .backing = testing.allocator, .fail_at = std.math.maxInt(usize) };
    // The domain's own creation is not one of the calls: past it, every allocation fails once in turn.
    const want = try linkLife(counting.allocator());
    var at: usize = 0;
    while (at < counting.count) : (at += 1) {
        var once: FailOnce = .{ .backing = testing.allocator, .fail_at = at };
        const got = linkLife(once.allocator()) catch |err| {
            // The domain could not be made: no call to check.
            try testing.expectEqual(error.OutOfMemory, err);
            continue;
        };
        try testing.expectEqual(want, got);
    }
}

/// A domain over `source` with builtin and the contested ABC added, whose
/// functions' scope chains verifying makes: its arenas, and it.
const Made = struct {
    arena: memory.Arena,
    scratch: memory.Arena,
    dom: *Domain,

    fn init(self: *Made, source: Allocator) !void {
        self.arena = .init(source);
        self.scratch = .init(source);
        errdefer self.deinit();
        self.dom = try self.arena.allocator().create(Domain);
        self.dom.* = try .init(self.arena.allocator(), self.scratch.allocator());
        try testing.expectEqual(0, try domain_.changed(self.dom, &self.arena, domain_.addAbc, .{ &self.arena, &link_builtin, true, 0 }));
        try testing.expectEqual(0, try domain_.changed(self.dom, &self.arena, domain_.addAbc, .{ &self.arena, &link_contested, false, 0 }));
    }

    fn deinit(self: *Made) void {
        self.scratch.deinit();
        self.arena.deinit();
    }
};

/// domainEmitEach's bodies compiled three times on a domain over `source`,
/// each call that runs out of memory checked to leave the domain as it
/// was and made again: the texts' and the domain's digest.
fn emitRetried(source: Allocator) !u64 {
    compile.forgetVerified();
    defer compile.forgetVerified();
    var made: Made = undefined;
    try made.init(source);
    defer made.deinit();
    const dom = made.dom;
    var digest: u64 = 0;
    for (0..3) |round| {
        const before = fingerprint(dom);
        const index = dom.abcs.len - 1;
        const text = compile.emitEachOn(dom, &made.arena, dom.scratch, "0,1,2,3,4", round == 1, index) catch |err| retry: {
            try testing.expectEqual(error.OutOfMemory, err);
            try testing.expectEqual(before, fingerprint(dom));
            break :retry try compile.emitEachOn(dom, &made.arena, dom.scratch, "0,1,2,3,4", round == 1, index);
        };
        digest = digest *% 31 +% std.hash.Wyhash.hash(0, text);
    }

    return digest +% fingerprint(dom);
}

test "domainEmitEach that ran out of memory anywhere, made again, verifies again and compiles alike" {
    memory.arenas();
    var counting: FailOnce = .{ .backing = testing.allocator, .fail_at = std.math.maxInt(usize) };
    const want = try emitRetried(counting.allocator());
    var at: usize = 0;
    while (at < counting.count) : (at += 1) {
        var once: FailOnce = .{ .backing = testing.allocator, .fail_at = at };
        const got = emitRetried(once.allocator()) catch |err| {
            // The domain could not be made: no call to check.
            try testing.expectEqual(error.OutOfMemory, err);
            continue;
        };
        try testing.expectEqual(want, got);
    }
}

/// A module of the contested ABC written as the exports write it, a call a
/// part, each part its own change with the emitter's scratch made anew; a
/// part that runs out of memory checked to leave the domain as the parts
/// before it left it, the module then abandoned and written again from
/// the start: its text's digest.
fn partsRetried(source: Allocator) !u64 {
    var made: Made = undefined;
    try made.init(source);
    defer made.deinit();
    // Twice: the second verification of the ABC, not its first, drops its
    // log entry as it ends, a part after the one that added it.
    const first = try writeParts(source, &made);
    return first *% 31 +% try writeParts(source, &made);
}

fn writeParts(source: Allocator, made: *Made) !u64 {
    const dom = made.dom;
    const index = dom.abcs.len - 1;
    var attempt: u32 = 0;
    while (true) : (attempt += 1) {
        try testing.expect(attempt < 2);
        var persist: memory.Arena = .init(source);
        defer persist.deinit();
        const emitter = try persist.allocator().create(ModuleEmitter);
        emitter.* = try .init(persist.allocator(), dom.scratch, dom, index);
        const parts = struct {
            fn first(_: *Domain, e: *ModuleEmitter) Allocator.Error!bool {
                try e.begin(&.{ "own", "first" }, false);
                return e.step(1, false);
            }

            fn next(_: *Domain, e: *ModuleEmitter) Allocator.Error!bool {
                return e.step(1, false);
            }
        };
        var before = fingerprint(dom);
        var done = domain_.changed(dom, &made.arena, parts.first, .{emitter}) catch |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            try testing.expectEqual(before, fingerprint(dom));
            continue;
        };
        const ran_out = while (!done) {
            try emitter.prepare(dom.scratch);
            before = fingerprint(dom);
            done = domain_.changed(dom, &made.arena, parts.next, .{emitter}) catch |err| {
                try testing.expectEqual(error.OutOfMemory, err);
                try testing.expectEqual(before, fingerprint(dom));
                break true;
            };
        } else false;
        if (!ran_out) {
            return std.hash.Wyhash.hash(0, emitter.out().written());
        }
    }
}

test "a module written a part a call, that ran out of memory anywhere, is written again alike" {
    memory.arenas();
    var counting: FailOnce = .{ .backing = testing.allocator, .fail_at = std.math.maxInt(usize) };
    const want = try partsRetried(counting.allocator());
    var at: usize = 0;
    while (at < counting.count) : (at += 1) {
        var once: FailOnce = .{ .backing = testing.allocator, .fail_at = at };
        const got = partsRetried(once.allocator()) catch |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            continue;
        };
        try testing.expectEqual(want, got);
    }
}

test "bytes restore does not adopt stay out of the domain's arena" {
    var arena: memory.Arena = .init(testing.allocator);
    defer arena.deinit();
    var scratch: memory.Arena = .init(testing.allocator);
    defer scratch.deinit();
    const dom = try arena.allocator().create(Domain);
    dom.* = try .init(arena.allocator(), scratch.allocator());
    try testing.expectEqual(0, try domain_.changed(dom, &arena, domain_.addAbc, .{ &arena, &link_builtin, true, 0 }));
    try testing.expectEqual(1, try domain_.changed(dom, &arena, Domain.childDomain, .{0}));
    try testing.expectEqual(0, try domain_.changed(dom, &arena, domain_.addAbc, .{ &arena, &link_user, false, 1 }));
    lifetime.evict(dom, 1);
    const big = try testing.allocator.alloc(u8, 1 << 20);
    defer testing.allocator.free(big);
    @memset(big, 0);
    const mark = arena.mark();
    for (0..50) |_| {
        // ABC 0 is live: not the domain's to restore. ABC 1 is held still: nothing to adopt.
        try testing.expectEqual(-1, try domain_.changed(dom, &arena, lifetime.restore, .{ &arena, 0, big }));
        try testing.expectEqual(0, try domain_.changed(dom, &arena, lifetime.restore, .{ &arena, 1, big }));
    }

    try testing.expectEqual(mark, arena.mark());

    // One a rebuild let go of: bytes that do not parse leave nothing; its own are adopted.
    dom.abcs.set(1, &lifetime.no_abc);
    try testing.expectEqual(1107, try domain_.changed(dom, &arena, lifetime.restore, .{ &arena, 1, big[0..3] }));
    try testing.expectEqual(mark, arena.mark());
    try testing.expectEqual(0, try domain_.changed(dom, &arena, lifetime.restore, .{ &arena, 1, &link_user }));
    try testing.expect(dom.abcs.get(1) != &lifetime.no_abc);
}
