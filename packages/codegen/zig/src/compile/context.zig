// The AVM2 compiler's context, keys and log (assembly/compile.ts tells
// each export's why): what a module depends on in the domain beyond its
// ABC's bytes, for a host's cache key, and the log a compile adds, to
// replay without compiling.
const std = @import("std");
const Allocator = std.mem.Allocator;
const parseI32 = @import("../parse.zig").parseI32;
const domain_ = @import("../avm2/link/domain.zig");
const Domain = domain_.Domain;
const lifetime = @import("../avm2/link/lifetime.zig");
const code = @import("../avm2/abc/code.zig");
const output = @import("../output.zig");
const Output = output.Output;
const traits_ = @import("../avm2/link/traits.zig");
const compile = @import("../compile.zig");
const modules = @import("modules.zig");
const abandon = modules.abandon;
const abcIndex = compile.abcIndex;
const changed = compile.changed;
const domain = compile.domain;
const forgetModules = modules.forgetModules;
const forgetVerified = modules.forgetVerified;
const isLive = compile.isLive;

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
    if (kind == .none or place < 0) {
        return false;
    }

    const f = dom.logA.get(e);
    const depth = if (kind == .found) depthOf(dom, own, dom.foundDomain.get(f)) else 0;
    if (depth < 0) {
        return false;
    }

    try out.byte('\n');
    try out.uint(@backingInt(kind));
    try out.byte(' ');
    try out.int(place);
    try out.byte(' ');
    try out.uint(count);
    try out.byte(' ');
    if (kind != .found) {
        try out.uint(f);
        try out.byte(' ');
        try out.uint(dom.logB.get(e));
        return true;
    }

    try out.int(depth);
    try out.byte(' ');
    try out.uint(@backingInt(dom.foundKind.get(f)));
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
    const at = abcIndex(dom, index) orelse return "";

    const own = dom.abcDomain.get(at);
    const seen = try seenBy(dom, gpa, own);
    var out: Output = try .init(gpa);
    try writeSeen(&out, seen, at);
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
    const at = abcIndex(dom, index) orelse return null;

    const own = dom.abcDomain.get(at);
    const seen = try seenBy(dom, gpa, own);
    if (seen.len == 0) {
        return null;
    }

    var out: Output = try .init(gpa);
    try writeSeen(&out, seen, at);
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
    return numbers(gpa, .{ dom.abcs.len, dom.logKind.len, dom.generation });
}

/// Three numbers, a space between each.
pub fn numbers(gpa: Allocator, values: [3]u64) Allocator.Error![]const u8 {
    var out: Output = try .initCapacity(gpa, 64);
    for (values, 0..) |n, i| {
        if (i > 0) {
            try out.byte(' ');
        }

        try out.uint(n);
    }

    return out.written();
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
    const at = abcIndex(dom, index) orelse return "!";
    if (mark < 0) {
        return "!";
    }

    const seen = try seenBy(dom, gpa, dom.abcDomain.get(at));
    var out: Output = try .init(gpa);
    var lines: u32 = 0;
    var e: u32 = @intCast(mark);
    while (e < dom.logKind.len) : (e += 1) {
        const kind = dom.logKind.get(e);
        if (kind == .none) {
            continue;
        }

        const place = placeOf(seen, dom.logAbc.get(e));
        if (kind == .found or place < 0) {
            return "!";
        }

        if (lines > 0) {
            try out.byte('\n');
        }

        lines += 1;
        try out.uint(@backingInt(kind));
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
        if (kind == .none) {
            continue;
        }

        if (kind == .found) {
            return null;
        }

        try words.appendSlice(gpa, &.{ @backingInt(kind), dom.logAbc.get(e), dom.logA.get(e), dom.logB.get(e) });
    }
    return std.mem.sliceAsBytes(words.items);
}

pub fn replayEntry(kind: u32, index: u32, a: u32, b: u32) Allocator.Error!bool {
    const dom = try domain();
    if (kind > @backingInt(domain_.LogKind.verify) or index >= dom.abcs.len or !dom.isLive(index)) {
        return false;
    }

    return changed(replayOne, .{ domain_.LogKind.fromWord(kind), index, a, b });
}

fn replayOne(dom: *Domain, kind: domain_.LogKind, index: u32, a: u32, b: u32) Allocator.Error!bool {
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
    const at = abcIndex(dom, index) orelse return false;

    forgetVerified();
    forgetModules();
    return changed(replayLog, .{ gpa, log, at });
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

            const kind = parseI32(fields[0]);
            const place = parseI32(fields[1]);
            const a = parseI32(fields[2]);
            const b = parseI32(fields[3]);
            // As replayEntry: no kind past verify, nor one read as its low byte.
            if (kind < 0 or kind > @backingInt(domain_.LogKind.verify) or place < 0 or place >= seen.len or a < 0 or b < 0) {
                ok = false;
                break;
            }

            ok = try replayed(dom, domain_.LogKind.fromWord(@bitCast(kind)), seen[@intCast(place)], @intCast(a), @intCast(b));
        }
    }

    lifetime.weigh(dom, at, rows);
    return ok;
}

/// Entry `kind` of ABC `abc` done again, as a rebuild replays one, its numbers checked against the ABC first.
fn replayed(dom: *Domain, kind: domain_.LogKind, abc: u32, a: u32, b: u32) Allocator.Error!bool {
    const info = dom.abcs.get(abc);
    if (kind == .verify) {
        _ = try code.verifyMethods(dom, abc);
        return true;
    }

    if (kind == .sign) {
        return b < info.methodCount() and try dom.traits.signs(dom, dom.methodStart.get(abc) + b);
    }

    if (kind != .resolve) {
        return false;
    }

    const owned = traits_.TraitsKind.owned(a) orelse return false;
    const owners: u32 = switch (owned) {
        .script => info.scriptCount(),
        .activation => @intCast(dom.bodyTraits.get(abc).len),
        else => info.classCount(),
    };
    const t = if (b < owners) lifetime.traitsOf(dom, abc, owned, b) else .none;
    return t != .none and try dom.traits.resolves(dom, t.index());
}
