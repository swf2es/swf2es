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
