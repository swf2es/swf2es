// An ABC's namespaces as avmplus' AbcParser::parseCpool reads them
// (assembly/avm2/link/namespaces.ts): each interned by its kind and URI,
// and given its API version, from the mark a builtin ABC's URI ends in,
// moved into the domain's series.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const Abc = @import("../abc/abc.zig").Abc;
const C = @import("../abc/constants.zig");
const domain_ = @import("domain.zig");
const NsType = domain_.NsType;
const Domain = domain_.Domain;

/// VM_INTERNAL is the last mark of the table a library was built with: 52
/// in core/api-versions.h, which avmplus' builtin and swf2es' playerglobal
/// have, 42 in the AIR 15 SDK's, which Flash Player's playerglobal has. A
/// library states its table by its marks: one that marks anything past 42 is
/// of the newer, whose 42 is SWF_27, and its internal mark is 52.
const API_OldInternalMark: i32 = 42;
const API_Count: u32 = 53;
const API_MinMark: u32 = 0xe294;

/// As AbcParser::parseCpool: each namespace's interned id and API version.
pub fn addNamespaces(dom: *Domain, abc: *const Abc, base: [*]const u8, strings: []const u32) Allocator.Error!void {
    const gpa = dom.gpa;
    const pool = &abc.pool;
    const count = pool.nsCount();
    const ids = try memory.allocZeroed(gpa, u32, count);
    const versions = try memory.allocZeroed(gpa, u8, count);
    const marks = try memory.allocZeroed(dom.scratch, i32, count);

    // A builtin ABC's marked URIs are versioned before any of its namespaces
    // get a version, as the player registers them before parsing.
    var highestMark: i32 = -1;
    for (1..@max(count, 1)) |i| {
        const index = pool.nsName[i];
        const mark = if (index != 0) versionMark(base, pool.strings[index].start, pool.strings[index].len) else -1;
        marks[i] = mark;
        if (mark > highestMark) {
            highestMark = mark;
        }

        if (abc.builtin and mark >= 0 and namespaceType(pool.nsKind[i]) == .public) {
            const uri = try dom.internString(base[pool.strings[index].start..][0 .. pool.strings[index].len - 3]);
            try dom.put(dom.versioned.at(uri), 1);
        }
    }

    const internalMark: i32 = if (highestMark > API_OldInternalMark) domain_.API_Internal else API_OldInternalMark;
    for (1..@max(count, 1)) |i| {
        const ty = namespaceType(pool.nsKind[i]);
        const index = pool.nsName[i];
        const mark = marks[i];
        var uri = if (index != 0) strings[index] else domain_.URI_None;
        var version = domain_.API_AllVersions;
        if (mark >= 0) {
            uri = try dom.internString(base[pool.strings[index].start..][0 .. pool.strings[index].len - 3]);
            version = @intCast(mark);
        }

        if (ty == .private) {
            version = domain_.API_AllVersions;
        } else if (index != 0 and abc.builtin) {
            if ((mark < 0 and ty == .public and dom.versioned.get(uri) != 0) or mark >= internalMark) {
                version = domain_.API_Internal;
            }
        } else if (index != 0 and ty == .public) {
            version = dom.apiVersion;
        }

        ids[i] = try dom.internNamespace(ty, uri);
        // As AvmCore::newNamespace: in the domain's series, so that a lookup
        // compares versions of the series its bindings have.
        versions[i] = activeVersion(dom, version);
    }

    try dom.abcNs.push(gpa, ids);
    try dom.abcNsVersion.push(gpa, versions);
}

/// As kApiVersionSeriesTransfer: a version of the other series becomes the
/// first later one of the domain's, which for Flash Player means AIR-only
/// versions become VM-internal.
fn activeVersion(dom: *const Domain, version: u8) u8 {
    const air = dom.apiVersion != domain_.API_AllVersions and isAir(dom.apiVersion);
    if (version == domain_.API_AllVersions or version >= domain_.API_Internal or isAir(version) == air) {
        return version;
    }

    if (!air) {
        return domain_.API_Internal;
    }

    // As AssemblyScript's u8 arithmetic, which wraps at 256 (where isAir holds again).
    var v = version +% 1;
    while (!isAir(v)) {
        v +%= 1;
    }

    return v;
}

/// Whether an API version belongs to AIR's series: versions alternate between
/// the series, FP_10_0, FP_10_0_32 and FP_10_1 aside, from FP_10_2 on.
fn isAir(version: u8) bool {
    if (version >= 10) {
        return (version & 1) == 1;
    }

    return version != domain_.API_FP_10_0 and version != 5 and version != 7;
}

pub fn namespaceType(kind: C.Constant) NsType {
    return switch (kind) {
        .package_internal_ns => .package_internal,
        .protected_namespace => .protected,
        .explicit_namespace => .explicit,
        .static_protected_ns => .static_protected,
        .private_ns => .private,
        else => .public,
    };
}

/// The API version a string's last character marks, or -1. The marks are
/// U+E294 to U+E2C8, three bytes in UTF-8.
fn versionMark(base: [*]const u8, start: u32, length: u32) i32 {
    if (length < 3) {
        return -1;
    }

    const p = base + start + length - 3;
    const b0: u32 = p[0];
    const b1: u32 = p[1];
    const b2: u32 = p[2];
    if ((b0 & 0xf0) != 0xe0 or (b1 & 0xc0) != 0x80 or (b2 & 0xc0) != 0x80) {
        return -1;
    }

    const c = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
    return if (c >= API_MinMark and c < API_MinMark + API_Count) @intCast(c - API_MinMark) else -1;
}

test "a version of the other series moves to the domain's" {
    try std.testing.expect(isAir(9));
    try std.testing.expect(!isAir(API_OldInternalMark));
    try std.testing.expect(!isAir(domain_.API_FP_10_0));
    try std.testing.expect(isAir(11));
}
