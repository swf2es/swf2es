// Saving and loading a domain (assembly/avm2/link/lifetime.ts, stage 6):
// what a rebuild reads of it, for a replacement instance to rebuild the
// same domain (rebuild.zig) in a memory of its own.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const domain_ = @import("domain.zig");
const DomainState = domain_.DomainState;
const Domain = domain_.Domain;
const output = @import("../../output.zig");
const lifetime = @import("lifetime.zig");
const rebuild = @import("rebuild.zig");

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
    var w: SaveWriter = .{ .out = out, .gpa = gpa };
    try w.word(SAVED_Version);
    try w.word(dom.apiVersion);
    try w.word(dom.generation);
    const domains = dom.domainParent.len;
    try w.word(domains);
    for (0..domains) |d_| {
        const d: u32 = @intCast(d_);
        try w.word(@bitCast(dom.domainParent.get(d)));
        try w.word(dom.domainDepth.get(d));
        try w.kind(dom.domainState.get(d));
        try w.word(dom.domainEvicted.get(d));
    }

    const abcs = dom.abcs.len;
    try w.word(abcs);
    for (0..abcs) |i_| {
        const i: u32 = @intCast(i_);
        const abc = dom.abcs.get(i);
        const kept = abc != &lifetime.no_abc and dom.isLive(i);
        try w.word(dom.abcDomain.get(i));
        try w.word(dom.abcWeight.get(i));
        try w.word((if (kept) SAVED_Live else 0) | (if (abc.builtin) SAVED_Builtin else 0));
        try w.word(if (kept) abc.length else 0);
    }

    const entries = dom.logKind.len;
    try w.word(entries);
    for (0..entries) |e_| {
        const e: u32 = @intCast(e_);
        try w.kind(dom.logKind.get(e));
        try w.word(dom.logAt.get(e));
        try w.word(dom.logAbc.get(e));
        try w.word(dom.logA.get(e));
        try w.word(dom.logB.get(e));
    }

    const found = dom.foundDomain.len;
    try w.word(found);
    for (0..found) |f_| {
        const f: u32 = @intCast(f_);
        try w.word(dom.foundDomain.get(f));
        try w.kind(dom.foundKind.get(f));
        try w.word(dom.foundAbc.get(f));
        try w.word(dom.foundAsType.get(f));
        try w.text(dom.foundUri.get(f));
        try w.text(dom.foundName.get(f));
    }
}

/// saveDomain's words, little-endian, appended to `out`.
const SaveWriter = struct {
    out: *std.ArrayList(u8),
    gpa: Allocator,

    fn word(self: *SaveWriter, value: u32) Allocator.Error!void {
        try self.out.appendSlice(self.gpa, std.mem.asBytes(&std.mem.nativeToLittle(u32, value)));
    }

    /// A kind or a state, a byte, as a word.
    fn kind(self: *SaveWriter, value: anytype) Allocator.Error!void {
        try self.word(@backingInt(value));
    }

    /// A string as its UTF-16 units, a word each after their count, as AssemblyScript's strings of them.
    fn text(self: *SaveWriter, wtf8: []const u8) Allocator.Error!void {
        const units = try output.decodeUnits(self.gpa, wtf8);
        try self.word(@intCast(units.len));
        for (units) |u| {
            try self.word(u);
        }
    }
};

/// Whether ABC `index` of `dom` is one saveDomain names live, whose bytes the other instance is given.
pub fn savedLive(dom: *const Domain, index: u32) bool {
    return index < dom.abcs.len and dom.abcs.get(index) != &lifetime.no_abc and dom.isLive(index);
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

/// Words that are not saveDomain's: too few, or a kind no save writes.
const Malformed = error{Malformed};
const LoadError = Malformed || Allocator.Error;

/// saveDomain's words, read in turn, refused rather than read past.
const SaveReader = struct {
    bytes: []const u8,
    at: usize = 0,

    fn word(self: *SaveReader) Malformed!u32 {
        if (self.bytes.len - self.at < 4) {
            return error.Malformed;
        }

        const value = std.mem.readInt(u32, self.bytes[self.at..][0..4], .little);
        self.at += 4;
        return value;
    }

    /// A kind or a state, a byte saved as a word: one above 0xff, which a
    /// save never writes, is refused, not read as its low byte.
    fn kind(self: *SaveReader, comptime T: type) Malformed!T {
        const value = try self.word();
        if (value > 0xff) {
            return error.Malformed;
        }

        return T.fromWord(value);
    }

    /// A count of things of `size` words each, refused if more than the words left could hold.
    fn count(self: *SaveReader, size: u64) Malformed!u32 {
        const n = try self.word();
        if (@as(u64, n) * size * 4 > self.bytes.len - self.at) {
            return error.Malformed;
        }

        return n;
    }

    /// A string of UTF-16 units, as the domain keeps a finding's: WTF-8.
    fn text(self: *SaveReader, gpa: Allocator) LoadError![]const u8 {
        const units = try gpa.alloc(u16, try self.count(1));
        for (units) |*u| {
            // AssemblyScript's String.fromCharCodes keeps the low 16 bits.
            u.* = @truncate(try self.word());
        }

        return std.unicode.wtf16LeToWtf8Alloc(gpa, units);
    }
};

/// Load into `loaded.dom`, a new Domain, a domain as saveDomain saved it:
/// false if the words are not saveDomain's.
pub fn loadDomain(loaded: *Loaded, words: []const u8) Allocator.Error!bool {
    var reader: SaveReader = .{ .bytes = words };
    read(loaded, &reader) catch |err| switch (err) {
        // The first word that is not a save's ends the load, whatever follows.
        error.Malformed => return false,
        error.OutOfMemory => |e| return e,
    };

    return consistent(loaded.dom) and livesGiven(loaded);
}

/// loadDomain's reading of the words, before what they say is checked.
fn read(loaded: *Loaded, reader: *SaveReader) LoadError!void {
    const dom = loaded.dom;
    const gpa = dom.gpa;
    if (try reader.word() != SAVED_Version) {
        return error.Malformed;
    }

    dom.apiVersion = @truncate(try reader.word());
    dom.generation = try reader.word();
    // The saved domains, the root among them, in place of the new domain's.
    rebuild.truncateDomains(dom);
    const domains = try reader.count(4);
    for (0..domains) |_| {
        try dom.domainParent.push(gpa, @bitCast(try reader.word()));
        try dom.domainDepth.push(gpa, try reader.word());
        try dom.domainState.push(gpa, try reader.kind(DomainState));
        try dom.domainEvicted.push(gpa, try reader.word());
    }

    const abcs = try reader.count(4);
    for (0..abcs) |_| {
        try dom.abcs.push(gpa, &lifetime.no_abc);
        try dom.abcDomain.push(gpa, try reader.word());
        try dom.abcWeight.push(gpa, try reader.word());
        try loaded.flags.append(gpa, @truncate(try reader.word()));
        try loaded.lengths.append(gpa, try reader.word());
        try dom.abcBuffer.push(gpa, &rebuild.no_bytes);
        try dom.abcBase.push(gpa, &rebuild.no_bytes);
    }

    const entries = try reader.count(5);
    for (0..entries) |_| {
        try dom.logKind.push(gpa, try reader.kind(domain_.LogKind));
        try dom.logAt.push(gpa, try reader.word());
        try dom.logAbc.push(gpa, try reader.word());
        try dom.logA.push(gpa, try reader.word());
        try dom.logB.push(gpa, try reader.word());
    }

    const found = try reader.count(6);
    for (0..found) |_| {
        try dom.foundDomain.push(gpa, try reader.word());
        try dom.foundKind.push(gpa, try reader.kind(domain_.NsType));
        try dom.foundAbc.push(gpa, try reader.word());
        try dom.foundAsType.push(gpa, @truncate(try reader.word()));
        try dom.foundUri.push(gpa, try reader.text(gpa));
        try dom.foundName.push(gpa, try reader.text(gpa));
    }

    // Nothing after the last finding: a save ends there.
    if (reader.at != reader.bytes.len) {
        return error.Malformed;
    }
}

/// Whether every ABC of a live application domain is one saveDomain named
/// live, whose bytes it is then given: a live domain's ABCs are all linked.
fn livesGiven(loaded: *const Loaded) bool {
    const dom = loaded.dom;
    for (0..dom.abcs.len) |i| {
        const live = dom.domainState.get(dom.abcDomain.get(@intCast(i))) == .live;
        if (live and loaded.flags.items[i] & SAVED_Live == 0) {
            return false;
        }
    }

    return true;
}

/// Whether what a Rebuild indexes by a loaded Domain's numbers is in range, as saveDomain wrote them.
fn consistent(dom: *const Domain) bool {
    const domains = dom.domainParent.len;
    const abcs = dom.abcs.len;
    // The root is never evicted nor dropped: what walks up evicted parents stops at it.
    if (domains == 0 or dom.domainState.get(0) != .live) {
        return false;
    }

    for (0..domains) |d_| {
        const d: u32 = @intCast(d_);
        const parent = dom.domainParent.get(d);
        const bad = if (d == 0) parent != -1 else parent < 0 or @as(u32, @intCast(parent)) >= d;
        if (bad or !dom.domainState.get(d).isNamed()) {
            return false;
        }

        // Each domain a level below its parent, as domainChild makes it.
        const depth: u64 = if (d == 0) 0 else @as(u64, dom.domainDepth.get(@intCast(parent))) + 1;
        if (dom.domainDepth.get(d) != depth) {
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
        // An entry's ABC was added before it, as a rebuild attaches it first.
        if (dom.logAt.get(e) < at or
            dom.logAt.get(e) > abcs or
            dom.logAbc.get(e) >= dom.logAt.get(e) or
            !kind.isNamed() or
            (kind == .found and dom.logA.get(e) >= dom.foundDomain.len))
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
pub fn loadAbc(loaded: *Loaded, arena: *memory.Arena, index: u32, bytes: []const u8) Allocator.Error!i32 {
    const dom = loaded.dom;
    if (index >= dom.abcs.len or
        loaded.flags.items[index] & SAVED_Live == 0 or
        dom.abcs.get(index) != &lifetime.no_abc or
        bytes.len != loaded.lengths.items[index])
    {
        return -1;
    }

    const mark = arena.mark();
    errdefer arena.restore(mark);
    const abc, const buffer = try domain_.parseOwned(arena, dom.scratch, bytes, loaded.flags.items[index] & SAVED_Builtin != 0);
    const err = abc.@"error";
    if (err != .none) {
        arena.restore(mark);
        return err.number();
    }

    dom.abcs.set(index, abc);
    dom.abcBase.set(index, buffer.ptr);
    dom.abcBuffer.set(index, buffer);
    return 0;
}

/// The move estimate for a saved domain, checked before accepting a regular move.
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

    return lifetime.rebuiltSize(live, largest, part);
}

/// Whether every ABC saveDomain named live has been given its bytes (loadAbc).
pub fn loadedAll(loaded: *const Loaded) bool {
    const dom = loaded.dom;
    for (0..dom.abcs.len) |i| {
        if (loaded.flags.items[i] & SAVED_Live != 0 and dom.abcs.get(@intCast(i)) == &lifetime.no_abc) {
            return false;
        }
    }

    return true;
}
