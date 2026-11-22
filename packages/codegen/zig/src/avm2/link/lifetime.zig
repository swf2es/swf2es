// The lifetimes of application domains (assembly/avm2/link/lifetime.ts):
// dropped for good, or evicted and revived, and the ABCs' weight in the
// tables, by which a rebuild, linking the live ABCs again into a new Domain
// and doing again what its log records, is found worth it. The rebuild, and
// the saving and loading of a domain, come with stage 6; until then no ABC
// is let go of (NO_ABC), and a domain's generation never changes.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const Abc = @import("../abc/abc.zig").Abc;
const readAbc = @import("../abc/parse.zig").readAbc;
const PADDING = @import("../abc/reader.zig").PADDING;
const domain_ = @import("domain.zig");
const Domain = domain_.Domain;
const DOMAIN_Dropped = domain_.DOMAIN_Dropped;
const DOMAIN_Evicted = domain_.DOMAIN_Evicted;
const DOMAIN_Live = domain_.DOMAIN_Live;
const traits_ = @import("traits.zig");
const code = @import("../abc/code.zig");
const output = @import("../../output.zig");

/// The most memory a rebuild elsewhere grows the new instance by at once:
/// the allocator's largest block is a gigabyte.
pub const MOVE_Limit: u64 = (1 << 30) - (1 << 20);

/// The size of memory below which a rebuild elsewhere is not worth it for shrinking it alone.
const SHRINK_Floor: u64 = 32 << 20;

/// The weight of dead ABCs below which a rebuild is not worth it.
const DEAD_Floor: u64 = 4 << 20;

/// Whether tables of `weight`, with what its estimate misses, come within `reserve` of `size`.
fn full(weight: u64, reserve: u64, size: u64) bool {
    return weight + (weight >> 2) + (weight >> 3) + reserve >= size;
}

/// What takes the place of an ABC let go of in a rebuilt Domain (see vacate, stage 6).
pub var no_abc: Abc = .{};

/// Count what the domain's tables gained since they held `rows` as ABC `index`'s.
pub fn weigh(dom: *Domain, index: u32, rows: u64) void {
    const now = dom.rows();
    if (now > rows and index < dom.abcWeight.len) {
        dom.abcWeight.set(index, @intCast(@min(@as(u64, dom.abcWeight.get(index)) + now - rows, 0xffffffff)));
    }
}

/// Drop application domain `domain` and its descendants, as the runtime
/// lets go of them: what their ABCs define is seen by no domain from now
/// on, and they take no more ABCs. The root is never dropped.
pub fn drop(dom: *Domain, domain: u32) void {
    leave(dom, domain, DOMAIN_Dropped);
}

/// Evict application domain `domain` and its live descendants: as
/// dropped, until revive, given their ABCs again, links them back.
pub fn evict(dom: *Domain, domain: u32) void {
    if (domain < dom.domainState.len and dom.domainState.get(domain) == DOMAIN_Live) {
        leave(dom, domain, DOMAIN_Evicted);
    }
}

/// Put `domain` and its descendants in `state`, unless dropped already; never the root.
fn leave(dom: *Domain, domain: u32, state: u8) void {
    const count = dom.domainParent.len;
    if (domain == 0 or domain >= count or dom.domainState.get(domain) == DOMAIN_Dropped) {
        return;
    }

    // A child is made after its parent, so its number is higher.
    dom.domainState.set(domain, state);
    dom.domainEvicted.set(domain, dom.generation);
    var d = domain + 1;
    while (d < count) : (d += 1) {
        const parent = dom.domainState.get(@intCast(dom.domainParent.get(d)));
        if (parent != DOMAIN_Live and dom.domainState.get(d) < parent) {
            if (dom.domainState.get(d) == DOMAIN_Live) {
                dom.domainEvicted.set(d, dom.generation);
            }

            dom.domainState.set(d, parent);
        }
    }
}

/// Give ABC `index`, of an evicted application domain, its bytes again,
/// if a rebuild has let go of them, for revive to link it: 0, the
/// VerifyError they were rejected with, or -1 if they are not the ABC's.
/// Only bytes it adopts stay in `arena`, the domain's: a host gives an
/// evicted domain's ABCs back at each revival, held ones included.
pub fn restore(dom: *Domain, arena: *memory.Arena, index: u32, bytes: []const u8) Allocator.Error!i32 {
    if (index >= dom.abcs.len or dom.domainState.get(dom.abcDomain.get(index)) != DOMAIN_Evicted) {
        return -1;
    }

    if (dom.abcs.get(index) != &no_abc) {
        return 0;
    }

    const mark = arena.mark();
    const length: u32 = @intCast(bytes.len);
    const buffer = try memory.allocZeroed(dom.gpa, u8, length + PADDING);
    @memcpy(buffer[0..bytes.len], bytes);
    const abc = try readAbc(dom.gpa, dom.scratch, buffer, length, false);
    const err = abc.@"error";
    if (err != 0) {
        // The error read first: the ABC is in what is given back.
        arena.restore(mark);
        return err;
    }

    // Rows of an ABC let go of, which only a rebuild's vacate added, never one from before it: raw writes.
    dom.abcs.set(index, abc);
    dom.abcBase.set(index, buffer.ptr);
    dom.abcBuffer.set(index, buffer);
    dom.abcWeight.set(index, @intCast(@min(domain_.ABC_Weight * length, 0xffffffff)));
    return 0;
}

/// Make evicted application domain `domain` live again, with its evicted
/// ancestors, the first of them a child of a live one: 0 if their ABCs
/// and findings are in the tables still, as no rebuild has been since
/// any was evicted, 1 if a rebuild must link them again, and -1, leaving
/// them evicted, if they cannot be: `domain` is not evicted, the first
/// evicted ancestor's parent is not live, or an ABC of theirs that a
/// rebuild let go of was not restored.
pub fn revive(dom: *Domain, domain: u32) i32 {
    if (domain == 0 or domain >= dom.domainState.len or dom.domainState.get(domain) != DOMAIN_Evicted) {
        return -1;
    }

    var top = domain;
    while (dom.domainState.get(@intCast(dom.domainParent.get(top))) == DOMAIN_Evicted) {
        top = @intCast(dom.domainParent.get(top));
    }

    if (dom.domainState.get(@intCast(dom.domainParent.get(top))) != DOMAIN_Live) {
        return -1;
    }

    for (0..dom.abcs.len) |i| {
        if (dom.abcs.get(@intCast(i)) == &no_abc and inChain(dom, dom.abcDomain.get(@intCast(i)), top, domain)) {
            return -1;
        }
    }

    var stale = false;
    var d = domain;
    while (true) : (d = @intCast(dom.domainParent.get(d))) {
        stale = stale or dom.domainEvicted.get(d) != dom.generation;
        dom.domainState.set(d, DOMAIN_Live);
        if (d == top) {
            break;
        }
    }

    return if (stale) 1 else 0;
}

/// Make `domain` and its ancestors up to `top` evicted again, as revive found them.
pub fn unrevive(dom: *Domain, domain: u32, top: u32) void {
    var d = domain;
    while (true) : (d = @intCast(dom.domainParent.get(d))) {
        dom.domainState.set(d, DOMAIN_Evicted);
        if (d == top) {
            break;
        }
    }
}

/// The first evicted ancestor of `domain` from the root down, or `domain` itself.
pub fn evictedTop(dom: *const Domain, domain: u32) u32 {
    var top = domain;
    while (dom.domainState.get(@intCast(dom.domainParent.get(top))) == DOMAIN_Evicted) {
        top = @intCast(dom.domainParent.get(top));
    }

    return top;
}

/// Whether `d` is `bottom` or one of its ancestors up to `top`.
fn inChain(dom: *const Domain, d: u32, top: u32, bottom: u32) bool {
    var x = bottom;
    while (x != d and x != top) {
        x = @intCast(dom.domainParent.get(x));
    }

    return x == d;
}

/// The size of wasm memory, as AssemblyScript's memory.size() << 16 gives it;
/// natively, for the tests, of the chunks reached.
pub fn memorySize() u64 {
    if (builtin.cpu.arch.isWasm()) {
        return @as(u64, @wasmMemorySize(0)) << 16;
    }

    return @as(u64, memory.pages().reached()) * memory.chunk_size;
}

/// What wantsRebuild is asked: a rebuild in place with no spare instance, or beside one made or being made.
pub const WANT_InPlace: u8 = 0;
pub const WANT_InPlaceBesideSpare: u8 = 1;
/// A move to a spare instance (see saveDomain), or whether one will be due before long, for a host to make it ahead.
pub const WANT_Move: u8 = 2;
pub const WANT_Spare: u8 = 3;

/// Whether a rebuild is worth it now, as `want` asks (lifetime.ts tells
/// the policy): in this instance's memory, a part of `part` bytes of
/// garbage at a time, or in another's, parts of `movedPart` there. Zig's
/// memory is not AssemblyScript's, so the answers are its own.
pub fn wantsRebuild(dom: *Domain, part: u64, movedPart: u64, want: u8) bool {
    addWeights(dom);
    const size = memorySize();
    var largest: u64 = 0;
    var largestLive: u64 = 0;
    const count = dom.abcWeight.len;
    for (0..count) |i_| {
        const i: u32 = @intCast(i_);
        if (i + 16 >= count) {
            largest = @max(largest, dom.abcWeight.get(i));
        }

        if (dom.abcs.get(i) != &no_abc and dom.isLive(i)) {
            largestLive = @max(largestLive, dom.abcWeight.get(i));
        }
    }

    // A part may make more garbage than its budget counts.
    const garbage = part << 1;
    const reserve = @min(size >> 1, @max(size >> 4, (largest << 1) + garbage));
    const live = dom.liveWeight + dom.keptWeight;
    const dead = dom.deadWeight;
    // The new instance rebuilds with the parts its size was made for.
    const rebuilt = rebuiltSize(live, largestLive, movedPart);
    const smaller = rebuilt <= size - (size >> 3);
    const beside = live + dead + live;
    const fits = beside + (beside >> 4) + part < size;
    if (want == WANT_Move or want == WANT_Spare) {
        // A spare is made once a move is half way due, to be there when it is.
        const half: u6 = if (want == WANT_Spare) 1 else 0;
        const worth = dead >= @max(@max(DEAD_Floor, size >> 4), live >> 2) >> half;
        return ((worth and full(live + dead, reserve << half, size)) or
            size >= @max(SHRINK_Floor, rebuilt << (2 - half))) and
            (smaller or !fits) and
            rebuilt < MOVE_Limit;
    }

    return !(want == WANT_InPlaceBesideSpare and smaller) and
        dead >= @max(@max(DEAD_Floor >> 1, size >> 3), live >> 1) and
        fits and
        beside + (beside >> 4) + part + reserve >= size and
        !full(live, reserve, size);
}

/// The memory a rebuild elsewhere grows the new instance to at once, for
/// live ABCs of weight `live`, the largest `largest`, rebuilt a part of
/// `part` bytes of garbage at a time (lifetime.ts tells why).
pub fn rebuiltSize(live: u64, largest: u64, part: u64) u64 {
    const tables = live + (live >> 2) + (live >> 3);
    return tables + (tables >> 2) + (largest << 1) + (part << 1);
}

/// Add up liveWeight and deadWeight.
pub fn addWeights(dom: *Domain) void {
    var dead: u64 = 0;
    var live: u64 = 0;
    for (0..dom.abcs.len) |i_| {
        const i: u32 = @intCast(i_);
        if (dom.abcs.get(i) == &no_abc) {
            continue;
        }

        if (dom.isLive(i)) {
            live += dom.abcWeight.get(i);
        } else {
            dead += dom.abcWeight.get(i);
        }
    }

    dom.liveWeight = live;
    dom.deadWeight = dead;
}

/// The traits of ABC `abc` of `kind` and `owner`, as loggedResolve logged them, or -1.
pub fn traitsOf(dom: *const Domain, abc: u32, kind: u32, owner: u32) i32 {
    if (kind == traits_.TRAITS_Instance) {
        return dom.classTraits.get(dom.classStart.get(abc) + owner);
    }

    if (kind == traits_.TRAITS_Class) {
        return dom.classStatic.get(dom.classStart.get(abc) + owner);
    }

    if (kind == traits_.TRAITS_Script) {
        return @intCast(dom.scriptTraits.get(abc)[owner]);
    }

    return dom.bodyTraits.get(abc)[owner];
}

// The rebuild, saving and loading (stage 6).

/// What keeping a log entry of a domain not live weighs, in bytes.
const KEPT_Weight: u64 = 36;

/// Take the place of an ABC of an application domain not live, with
/// nothing in it, so that the ABCs after it keep their indices.
fn vacate(dom: *Domain, domain: u32) Allocator.Error!void {
    const gpa = dom.gpa;
    try dom.abcs.push(gpa, &no_abc);
    try dom.abcDomain.push(gpa, domain);
    try dom.abcBase.push(gpa, no_bytes.ptr);
    try dom.abcBuffer.push(gpa, &no_bytes);
    try dom.abcVerified.push(gpa, 0);
    try dom.abcWeight.push(gpa, 0);
    dom.loads += 1;
    try dom.abcOwner.push(gpa, dom.loads);
    try dom.methodStart.push(gpa, dom.traits.methodTraits.len);
    try dom.abcString.push(gpa, &.{});
    try dom.abcNs.push(gpa, &.{});
    try dom.abcNsVersion.push(gpa, &.{});
    try dom.classStart.push(gpa, dom.classAbc.len);
    try dom.scriptTraits.push(gpa, &.{});
    try dom.bodyTraits.push(gpa, &.{});
}

const no_bytes = [_]u8{};

/// The domain built again from its live ABCs and its log (lifetime.ts
/// tells how, and why a part at a time): step until it returns true, with
/// nothing else changing the domain or decoding in between, each step in a
/// Change of `fresh`. `failed` once done means an ABC did not link again
/// or an answer came out an error, which would be a bug; running out of
/// memory in a step leaves `fresh` to be let go of as well. `dom` is not
/// changed.
pub const Rebuild = struct {
    dom: *Domain,
    fresh: *Domain,
    entry: u32 = 0,
    next: u32 = 0,
    verifier: ?code.Verifier = null,
    done: bool = false,
    failed: bool = false,

    /// A rebuild of `dom` into `fresh`, a new Domain in an arena of its own.
    pub fn init(dom: *Domain, fresh: *Domain) Allocator.Error!Rebuild {
        const gpa = fresh.gpa;
        fresh.apiVersion = dom.apiVersion;
        fresh.generation = dom.generation + 1;
        // AssemblyScript's shares these arrays with the old domain, whose
        // tree a rebuild under way never sees grow (leaveRebuild).
        for (0..dom.domainParent.len) |d_| {
            const d: u32 = @intCast(d_);
            try fresh.domainParent.push(gpa, dom.domainParent.get(d));
            try fresh.domainDepth.push(gpa, dom.domainDepth.get(d));
            try fresh.domainState.push(gpa, dom.domainState.get(d));
            try fresh.domainEvicted.push(gpa, dom.domainEvicted.get(d));
        }

        return .{ .dom = dom, .fresh = fresh };
    }

    /// Go on until this call has made about `budget` bytes of garbage, as
    /// AssemblyScript's counts it, and at least one step: whether done.
    pub fn step(self: *Rebuild, budget: u64) Allocator.Error!bool {
        const dom = self.dom;
        const fresh = self.fresh;
        if (self.done) {
            return true;
        }

        const count = dom.abcs.len;
        var spent: u64 = 0;
        while (self.entry <= dom.logKind.len) : (self.entry += 1) {
            const e = self.entry;
            const at = if (e < dom.logKind.len) dom.logAt.get(e) else count;
            while (self.next < at) : (self.next += 1) {
                if (spent >= budget) {
                    return false;
                }

                if (!try reattach(dom, fresh, self.next)) {
                    return self.fail();
                }

                spent += dom.abcs.get(self.next).length;
            }

            if (e == dom.logKind.len) {
                break;
            }

            if (self.verifier) |*verifier| {
                // A verification under way, from the step before.
                if (!try verifier.run(@max((budget - @min(spent, budget)) / code.VERIFY_COST, 1))) {
                    return false;
                }

                spent += verifier.spent * code.VERIFY_COST;
                self.verifier = null;
                continue;
            }

            if (spent >= budget) {
                return false;
            }

            const kind = dom.logKind.get(e);
            const abc = dom.logAbc.get(e);
            const state = if (kind == domain_.LOG_Found)
                @max(dom.domainState.get(dom.foundDomain.get(dom.logA.get(e))), dom.domainState.get(dom.abcDomain.get(abc)))
            else
                dom.domainState.get(dom.abcDomain.get(abc));
            if (kind == domain_.LOG_None or state == DOMAIN_Dropped) {
                continue;
            }

            if (state == DOMAIN_Evicted or dom.abcs.get(abc) == &no_abc) {
                try keepEntry(fresh, dom, e);
                continue;
            }

            if (kind == domain_.LOG_Verify) {
                self.verifier = try code.Verifier.init(fresh, fresh.gpa, abc);
                if (!try self.verifier.?.run(@max((budget - spent) / code.VERIFY_COST, 1))) {
                    return false;
                }

                spent += self.verifier.?.spent * code.VERIFY_COST;
                self.verifier = null;
                continue;
            }

            if (!try replay(fresh, dom, e)) {
                return self.fail();
            }
        }

        self.done = true;
        return true;
    }

    fn fail(self: *Rebuild) bool {
        self.failed = true;
        self.verifier = null;
        self.done = true;
        return true;
    }
};

/// Link ABC `index` of `dom` again as `fresh`'s next, parsed again from its
/// bytes into `fresh`'s arena, or keep its place if it is not live: false
/// if it does not link.
fn reattach(dom: *Domain, fresh: *Domain, index: u32) Allocator.Error!bool {
    const abc = dom.abcs.get(index);
    if (abc == &no_abc or !dom.isLive(index)) {
        try vacate(fresh, dom.abcDomain.get(index));
        return true;
    }

    // The old domain's tables go with its arena: its bytes and tables are
    // made again in the new one's, as parsing them again makes them alike.
    const old = dom.abcBuffer.get(index);
    const buffer = try fresh.gpa.dupe(u8, old);
    const again = try readAbc(fresh.gpa, fresh.scratch, buffer, abc.length, abc.builtin);
    if (again.@"error" != 0 or !try fresh.attach(again, buffer, dom.abcDomain.get(index))) {
        return false;
    }

    // Its weight counts what compiling it added too.
    fresh.abcWeight.set(index, @max(fresh.abcWeight.get(index), dom.abcWeight.get(index)));
    return true;
}

/// Do entry `e` of `from`'s log again, a finding or a lazy answer, its ABC linked: false if it comes out an error.
fn replay(dom: *Domain, from: *const Domain, e: u32) Allocator.Error!bool {
    const kind = from.logKind.get(e);
    const abc = from.logAbc.get(e);
    if (kind == domain_.LOG_Found) {
        const f = from.logA.get(e);
        try dom.addFound(from.foundDomain.get(f), from.foundKind.get(f), from.foundUri.get(f), from.foundName.get(f), from.foundAbc.get(f), from.foundAsType.get(f) != 0);
        return true;
    }

    if (kind == domain_.LOG_Resolve) {
        const t = traitsOf(dom, abc, from.logA.get(e), from.logB.get(e));
        return t >= 0 and try dom.traits.resolve(dom, @intCast(t)) == 0;
    }

    return kind == domain_.LOG_Sign and try dom.traits.sign(dom, dom.methodStart.get(abc) + from.logB.get(e)) == 0;
}

/// Keep entry `e` of `from`'s log, not done, for when its domain is revived.
fn keepEntry(dom: *Domain, from: *const Domain, e: u32) Allocator.Error!void {
    const gpa = dom.gpa;
    var a = from.logA.get(e);
    if (from.logKind.get(e) == domain_.LOG_Found) {
        const f = a;
        a = dom.foundDomain.len;
        try dom.foundEntry.push(gpa, dom.logKind.len);
        try dom.foundDomain.push(gpa, from.foundDomain.get(f));
        try dom.foundKind.push(gpa, from.foundKind.get(f));
        try dom.foundUri.push(gpa, try gpa.dupe(u8, from.foundUri.get(f)));
        try dom.foundName.push(gpa, try gpa.dupe(u8, from.foundName.get(f)));
        try dom.foundAbc.push(gpa, from.foundAbc.get(f));
        try dom.foundAsType.push(gpa, from.foundAsType.get(f));
    }

    dom.keptWeight += KEPT_Weight;
    try dom.logKind.push(gpa, from.logKind.get(e));
    try dom.logAt.push(gpa, from.logAt.get(e));
    try dom.logAbc.push(gpa, from.logAbc.get(e));
    try dom.logA.push(gpa, a);
    try dom.logB.push(gpa, from.logB.get(e));
}

/// saveDomain's format, which loadDomain refuses another of.
const SAVED_Version: u32 = 1;
const SAVED_Live: u32 = 1;
const SAVED_Builtin: u32 = 2;

/// What a rebuild reads of `dom`, but the ABCs' bytes, as little-endian
/// words, for another instance to rebuild it in a memory of its own
/// (lifetime.ts tells what and why); a finding's names as their UTF-16
/// units, as AssemblyScript's strings of them.
pub fn saveDomain(dom: *const Domain, gpa: Allocator, out: *std.ArrayList(u8)) Allocator.Error!void {
    out.clearRetainingCapacity();
    const w = struct {
        fn word(list: *std.ArrayList(u8), a: Allocator, value: u32) Allocator.Error!void {
            try list.appendSlice(a, std.mem.asBytes(&std.mem.nativeToLittle(u32, value)));
        }
    };
    try w.word(out, gpa, SAVED_Version);
    try w.word(out, gpa, dom.apiVersion);
    try w.word(out, gpa, dom.generation);
    const domains = dom.domainParent.len;
    try w.word(out, gpa, domains);
    for (0..domains) |d_| {
        const d: u32 = @intCast(d_);
        try w.word(out, gpa, @bitCast(dom.domainParent.get(d)));
        try w.word(out, gpa, dom.domainDepth.get(d));
        try w.word(out, gpa, dom.domainState.get(d));
        try w.word(out, gpa, dom.domainEvicted.get(d));
    }

    const abcs = dom.abcs.len;
    try w.word(out, gpa, abcs);
    for (0..abcs) |i_| {
        const i: u32 = @intCast(i_);
        const abc = dom.abcs.get(i);
        const kept = abc != &no_abc and dom.isLive(i);
        try w.word(out, gpa, dom.abcDomain.get(i));
        try w.word(out, gpa, dom.abcWeight.get(i));
        try w.word(out, gpa, (if (kept) SAVED_Live else 0) | (if (abc.builtin) SAVED_Builtin else 0));
        try w.word(out, gpa, if (kept) abc.length else 0);
    }

    const entries = dom.logKind.len;
    try w.word(out, gpa, entries);
    for (0..entries) |e_| {
        const e: u32 = @intCast(e_);
        try w.word(out, gpa, dom.logKind.get(e));
        try w.word(out, gpa, dom.logAt.get(e));
        try w.word(out, gpa, dom.logAbc.get(e));
        try w.word(out, gpa, dom.logA.get(e));
        try w.word(out, gpa, dom.logB.get(e));
    }

    const found = dom.foundDomain.len;
    try w.word(out, gpa, found);
    for (0..found) |f_| {
        const f: u32 = @intCast(f_);
        try w.word(out, gpa, dom.foundDomain.get(f));
        try w.word(out, gpa, dom.foundKind.get(f));
        try w.word(out, gpa, dom.foundAbc.get(f));
        try w.word(out, gpa, dom.foundAsType.get(f));
        for ([_][]const u8{ dom.foundUri.get(f), dom.foundName.get(f) }) |text| {
            const units = try output.decodeUnits(gpa, text);
            try w.word(out, gpa, @intCast(units.len));
            for (units) |u| {
                try w.word(out, gpa, u);
            }
        }
    }
}

/// Whether ABC `index` of `dom` is one saveDomain names live, whose bytes the other instance is given.
pub fn savedLive(dom: *const Domain, index: u32) bool {
    return index < dom.abcs.len and dom.abcs.get(index) != &no_abc and dom.isLive(index);
}

/// The bytes of ABC `index` of `dom`, as added.
pub fn savedBytes(dom: *const Domain, index: u32) []const u8 {
    return dom.abcBuffer.get(index)[0..dom.abcs.get(index).length];
}

/// A Domain as saveDomain saved one, for a Rebuild of it: its live ABCs
/// not yet given (see loadAbc), the rest in their places as a rebuild
/// leaves them; and what saveDomain said of each ABC.
pub const Loaded = struct {
    dom: *Domain,
    flags: std.ArrayList(u8) = .empty,
    lengths: std.ArrayList(u32) = .empty,
};

/// saveDomain's words, read in turn, failing rather than reading past them.
const Words = struct {
    words: []const u8,
    at: usize = 0,
    failed: bool = false,

    fn next(self: *Words) u32 {
        if (self.at + 4 > self.words.len) {
            self.failed = true;
            return 0;
        }

        const value = std.mem.readInt(u32, self.words[self.at..][0..4], .little);
        self.at += 4;
        return value;
    }

    /// A count of things of `size` words each, refused if more than the words left could hold.
    fn count(self: *Words, size: u64) u32 {
        const n = self.next();
        if (@as(u64, n) * size * 4 > self.words.len - @min(self.at, self.words.len)) {
            self.failed = true;
            return 0;
        }

        return n;
    }

    /// A string of UTF-16 units, as the domain keeps a finding's: WTF-8.
    fn text(self: *Words, gpa: Allocator) Allocator.Error![]const u8 {
        const length = self.count(1);
        const units = try gpa.alloc(u16, length);
        for (units) |*u| {
            // AssemblyScript's String.fromCharCodes keeps the low 16 bits.
            u.* = @truncate(self.next());
        }

        return std.unicode.wtf16LeToWtf8Alloc(gpa, units);
    }
};

/// Load into `loaded.dom`, a new Domain, a domain as saveDomain saved it:
/// false if the words are not saveDomain's.
pub fn loadDomain(loaded: *Loaded, words: []const u8) Allocator.Error!bool {
    const dom = loaded.dom;
    const gpa = dom.gpa;
    var reader: Words = .{ .words = words };
    if (reader.next() != SAVED_Version) {
        return false;
    }

    dom.apiVersion = @truncate(reader.next());
    dom.generation = reader.next();
    const domains = reader.count(4);
    for (0..domains) |_| {
        try dom.domainParent.push(gpa, @bitCast(reader.next()));
        try dom.domainDepth.push(gpa, reader.next());
        try dom.domainState.push(gpa, @truncate(reader.next()));
        try dom.domainEvicted.push(gpa, reader.next());
    }

    const abcs = reader.count(4);
    for (0..abcs) |_| {
        try dom.abcs.push(gpa, &no_abc);
        try dom.abcDomain.push(gpa, reader.next());
        try dom.abcWeight.push(gpa, reader.next());
        try loaded.flags.append(gpa, @truncate(reader.next()));
        try loaded.lengths.append(gpa, reader.next());
        try dom.abcBuffer.push(gpa, &no_bytes);
        try dom.abcBase.push(gpa, no_bytes.ptr);
    }

    const entries = reader.count(5);
    for (0..entries) |_| {
        try dom.logKind.push(gpa, @truncate(reader.next()));
        try dom.logAt.push(gpa, reader.next());
        try dom.logAbc.push(gpa, reader.next());
        try dom.logA.push(gpa, reader.next());
        try dom.logB.push(gpa, reader.next());
    }

    const found = reader.count(6);
    for (0..found) |_| {
        try dom.foundDomain.push(gpa, reader.next());
        try dom.foundKind.push(gpa, @truncate(reader.next()));
        try dom.foundAbc.push(gpa, reader.next());
        try dom.foundAsType.push(gpa, @truncate(reader.next()));
        try dom.foundUri.push(gpa, try reader.text(gpa));
        try dom.foundName.push(gpa, try reader.text(gpa));
    }

    return !reader.failed and consistent(dom);
}

/// Whether what a Rebuild indexes by a loaded Domain's numbers is in range, as saveDomain wrote them.
fn consistent(dom: *const Domain) bool {
    const domains = dom.domainParent.len;
    const abcs = dom.abcs.len;
    if (domains == 0) {
        return false;
    }

    for (0..domains) |d_| {
        const d: u32 = @intCast(d_);
        const parent = dom.domainParent.get(d);
        const bad = if (d == 0) parent != -1 else parent < 0 or @as(u32, @intCast(parent)) >= d;
        if (bad or dom.domainState.get(d) > 2) {
            return false;
        }
    }

    for (0..abcs) |i| {
        if (dom.abcDomain.get(@intCast(i)) >= domains) {
            return false;
        }
    }

    for (0..dom.foundDomain.len) |f_| {
        const f: u32 = @intCast(f_);
        if (dom.foundDomain.get(f) >= domains or dom.foundAbc.get(f) >= abcs) {
            return false;
        }
    }

    var at: u32 = 0;
    for (0..dom.logKind.len) |e_| {
        const e: u32 = @intCast(e_);
        const kind = dom.logKind.get(e);
        if (dom.logAt.get(e) < at or
            dom.logAt.get(e) > abcs or
            dom.logAbc.get(e) >= abcs or
            kind > domain_.LOG_Verify or
            (kind == domain_.LOG_Found and dom.logA.get(e) >= dom.foundDomain.len))
        {
            return false;
        }

        at = dom.logAt.get(e);
    }

    return true;
}

/// Give ABC `index` of a Domain loadDomain made its bytes, as added: 0, -1
/// if it is not one saveDomain named live or is not the length it named,
/// or the VerifyError the bytes were rejected with.
pub fn loadAbc(loaded: *Loaded, index: u32, bytes: []const u8) Allocator.Error!i32 {
    const dom = loaded.dom;
    if (index >= dom.abcs.len or
        loaded.flags.items[index] & SAVED_Live == 0 or
        dom.abcs.get(index) != &no_abc or
        bytes.len != loaded.lengths.items[index])
    {
        return -1;
    }

    const length: u32 = @intCast(bytes.len);
    const buffer = try memory.allocZeroed(dom.gpa, u8, length + PADDING);
    @memcpy(buffer[0..bytes.len], bytes);
    const abc = try readAbc(dom.gpa, dom.scratch, buffer, length, loaded.flags.items[index] & SAVED_Builtin != 0);
    if (abc.@"error" != 0) {
        return abc.@"error";
    }

    dom.abcs.set(index, abc);
    dom.abcBase.set(index, buffer.ptr);
    dom.abcBuffer.set(index, buffer);
    return 0;
}

/// rebuiltSize for a Domain loadDomain made: the memory the instance rebuilding it is grown to.
pub fn loadedSize(loaded: *const Loaded, part: u64) u64 {
    const dom = loaded.dom;
    var live: u64 = 0;
    var largest: u64 = 0;
    for (0..dom.abcs.len) |i| {
        if (loaded.flags.items[i] & SAVED_Live != 0) {
            const w = dom.abcWeight.get(@intCast(i));
            live += w;
            largest = @max(largest, w);
        }
    }

    return rebuiltSize(live, largest, part);
}

/// Whether every ABC saveDomain named live has been given its bytes (loadAbc).
pub fn loadedAll(loaded: *const Loaded) bool {
    const dom = loaded.dom;
    for (0..dom.abcs.len) |i| {
        if (loaded.flags.items[i] & SAVED_Live != 0 and dom.abcs.get(@intCast(i)) == &no_abc) {
            return false;
        }
    }

    return true;
}
