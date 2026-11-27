// What the test builds measure of the domain's memory, for the design of
// arenas per application domain (docs/zig-codegen.md, section 2, M2):
// the bytes each table takes, how many of its rows are of ABCs not live,
// how often its rows change owner, what dead ABCs hold, and the free runs
// of the page allocator. Read only; tests/bench/codegen-session.ts prints it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../memory.zig");
const output = @import("../output.zig");
const Output = output.Output;
const compile = @import("../compile.zig");
const domain_ = @import("../avm2/link/domain.zig");
const Domain = domain_.Domain;
const lifetime = @import("../avm2/link/lifetime.zig");
const rebuild = @import("../avm2/link/rebuild.zig");
const traits_ = @import("../avm2/link/traits.zig");
const IdTable = @import("../avm2/link/table.zig").IdTable;

/// Which rows a table's are, by what tells their owner: the ABC or the
/// application domain each is of, as the tables an ABC or a domain adds
/// to are paired below by name. A table named in none is counted whole.
const Space = enum { traits, members, methods, classes, bindings, types, memo, cached, found, log, catches, vectors };

const spaces = .{
    .{ Space.traits, .{ "kind", "abc", "owner", "base", "protectedNs", "isInterface", "first", "end", "slotCount", "methodCount", "memberStart", "memberEnd", "interfaceStart", "interfaceEnd", "param", "init", "scope", "resolved", "slotStart", "dispatchStart" } },
    .{ Space.members, .{ "memberTraits", "memberNs", "memberName", "memberVersion", "memberBinding" } },
    .{ Space.methods, .{ "methodTraits", "methodFinal", "methodVirtual", "methodFunction", "ignoresRest", "functionScope", "functionScopes", "functionContested", "functionMerged", "signed", "returnType", "receiverType", "paramStart", "paramCount", "optionalCount", "methodAbcIndex" } },
    .{ Space.classes, .{ "classAbc", "classInstance", "classBase", "classFlags", "classTraits", "classStatic" } },
    .{ Space.bindings, .{ "bindingNs", "bindingName", "bindingVersion", "bindingAbc", "bindingScript", "bindingTrait" } },
    .{ Space.types, .{ "typeNs", "typeName", "typeVersion", "typeClass", "typeOwner", "typeDomain" } },
    .{ Space.memo, .{ "memoType", "memoAbc", "memoName", "memoBinding" } },
    .{ Space.cached, .{ "cachedDomain", "cachedNs", "cachedName", "cachedBinding", "cachedClass" } },
    .{ Space.found, .{ "foundDomain", "foundKind", "foundUri", "foundName", "foundAbc", "foundAsType", "foundEntry" } },
    .{ Space.log, .{ "logKind", "logAt", "logAbc", "logA", "logB" } },
    .{ Space.catches, .{ "catchKey", "catchValue" } },
    .{ Space.vectors, .{ "vectorParam", "vectorTraits" } },
};

fn spaceOf(comptime name: []const u8) ?Space {
    @setEvalBranchQuota(100_000);
    inline for (spaces) |space| {
        inline for (space[1]) |field| {
            if (comptime std.mem.eql(u8, field, name)) return space[0];
        }
    }

    return null;
}

const Owner = struct { domain: u32, abc: ?u32 };

/// The application domain row `i` of `space` is of, and the ABC if it has
/// one; null where what names it is past its table, as a row of traits
/// that has none yet.
fn ownerOf(dom: *const Domain, space: Space, i: u32) ?Owner {
    const t = &dom.traits;
    const abc: u32 = switch (space) {
        .traits => t.abc.get(i),
        .members => traitsAbc(dom, t.memberTraits.get(i)) orelse return null,
        .methods => dom.methodAbcIndex.get(i),
        .classes => dom.classAbc.get(i),
        .bindings => dom.bindingAbc.get(i),
        .types => return .{ .domain = dom.typeDomain.get(i), .abc = null },
        .memo => dom.memoAbc.get(i),
        .cached => return .{ .domain = dom.cachedDomain.get(i), .abc = null },
        .found => return .{ .domain = dom.foundDomain.get(i), .abc = null },
        .log => dom.logAbc.get(i),
        .catches => @truncate(dom.catchKey.get(i) >> 32),
        .vectors => traitsAbc(dom, dom.vectorTraits.get(i)) orelse return null,
    };
    if (abc >= dom.abcDomain.len) {
        return null;
    }

    return .{ .domain = dom.abcDomain.get(abc), .abc = abc };
}

fn traitsAbc(dom: *const Domain, t: u32) ?u32 {
    return if (t < dom.traits.abc.len) dom.traits.abc.get(t) else null;
}

/// The length of the table that tells `space`'s owners, which a table of
/// the space must have for its rows to be told apart.
fn spaceLength(dom: *const Domain, space: Space) u32 {
    const t = &dom.traits;
    return switch (space) {
        .traits => t.abc.len,
        .members => t.memberTraits.len,
        .methods => dom.methodAbcIndex.len,
        .classes => dom.classAbc.len,
        .bindings => dom.bindingAbc.len,
        .types => dom.typeDomain.len,
        .memo => dom.memoAbc.len,
        .cached => dom.cachedDomain.len,
        .found => dom.foundDomain.len,
        .log => dom.logAbc.len,
        .catches => dom.catchKey.len,
        .vectors => dom.vectorTraits.len,
    };
}

/// Whether ABC `abc` is let go of or of a domain not live.
fn deadAbc(dom: *const Domain, abc: u32) bool {
    return abc >= dom.abcs.len or dom.abcs.get(abc) == &lifetime.no_abc or !dom.isLive(abc);
}

fn dead(dom: *const Domain, owner: Owner) bool {
    if (owner.abc) |abc| {
        return deadAbc(dom, abc);
    }

    return owner.domain >= dom.domainState.len or dom.domainState.get(owner.domain) != .live;
}

/// What a space's rows hold together: dead rows, owner changes, and the
/// bytes of a row across its tables.
const SpaceTotals = struct {
    rows: u32 = 0,
    dead: u32 = 0,
    unowned: u32 = 0,
    alternations: u32 = 0,
    row_bytes: u64 = 0,
};

const space_count = @typeInfo(Space).@"enum".field_names.len;

const Report = struct {
    dom: *const Domain,
    out: Output,
    totals: [space_count]SpaceTotals = @splat(.{}),
    tables: u64 = 0,
    outgrown: u64 = 0,

    fn print(self: *Report, comptime format: []const u8, args: anytype) Allocator.Error!void {
        self.out.writer().print(format, args) catch return error.OutOfMemory;
    }

    /// A line for each table of `tables`, a Domain or its TraitsTable.
    fn tablesOf(self: *Report, tables: anytype) Allocator.Error!void {
        const info = @typeInfo(@TypeOf(tables.*)).@"struct";
        inline for (info.field_names, info.field_types) |field_name, T| {
            const value = &@field(tables, field_name);
            if (T == IdTable) {
                const bytes: u64 = @as(u64, @intCast(value.ids.len)) * 8;
                self.tables += bytes;
                try self.print("idtable {s} slots={d} count={d} bytes={d}\n", .{ field_name, value.ids.len, value.count, bytes });
            } else if (comptime domain_.isRows(T)) {
                const bytes = value.bytes();
                self.tables += bytes;
                self.outgrown += value.outgrownBytes();
                try self.print("rows {s} len={d} bytes={d} outgrown={d}", .{ field_name, value.len, bytes, value.outgrownBytes() });
                if (comptime spaceOf(field_name)) |space| {
                    const totals = &self.totals[@intFromEnum(space)];
                    if (value.len == spaceLength(self.dom, space)) {
                        totals.row_bytes += @sizeOf(@TypeOf(value.get(0)));
                    } else {
                        try self.print(" unpaired", .{});
                    }
                }

                try self.print("\n", .{});
            }
        }
    }

    fn spaceTotals(self: *Report) Allocator.Error!void {
        const info = @typeInfo(Space).@"enum";
        inline for (info.field_names, info.field_values) |space_name, value| {
            const space: Space = @enumFromInt(value);
            const totals = &self.totals[value];
            const count = spaceLength(self.dom, space);
            totals.rows = count;
            var previous: ?u32 = null;
            for (0..count) |i_| {
                const owner = ownerOf(self.dom, space, @intCast(i_)) orelse {
                    totals.unowned += 1;
                    continue;
                };
                if (dead(self.dom, owner)) {
                    totals.dead += 1;
                }

                if (previous != null and previous.? != owner.domain) {
                    totals.alternations += 1;
                }

                previous = owner.domain;
            }

            try self.print("space {s} rows={d} dead={d} unowned={d} alternations={d} row_bytes={d} dead_bytes={d}\n", .{ space_name, totals.rows, totals.dead, totals.unowned, totals.alternations, totals.row_bytes, @as(u64, totals.dead) * totals.row_bytes });
        }
    }
};

/// The report, a line a measure: `rows`/`idtable` a table, `space` a set of
/// tables whose rows have owners, `abcs` what live and dead ABCs hold, split
/// for dead ones into their parse block, link arrays, rows and the strings
/// only they spell, `pages` the page allocator, `freeruns` its free runs by
/// length (2^k chunks a bucket) and `arena` the domain's arena.
pub fn domainMemoryReport(gpa: Allocator) Allocator.Error![]const u8 {
    const dom = try compile.domain();
    var report: Report = .{ .dom = dom, .out = try .initCapacity(gpa, 16 << 10) };
    try report.tablesOf(dom);
    try report.tablesOf(&dom.traits);
    try report.spaceTotals();

    // What each ABC holds that is its own: its bytes and parsed tables, and the arrays linking it made.
    var live_parse: u64 = 0;
    var dead_parse: u64 = 0;
    var live_link: u64 = 0;
    var dead_link: u64 = 0;
    var live_abcs: u32 = 0;
    var dead_abcs: u32 = 0;
    var vacated: u32 = 0;
    for (0..dom.abcs.len) |i_| {
        const i: u32 = @intCast(i_);
        const abc = dom.abcs.get(i);
        if (abc == &lifetime.no_abc) {
            vacated += 1;
            continue;
        }

        const link = @as(u64, dom.abcString.get(i).len) * 4 + @as(u64, dom.abcNs.get(i).len) * 4 + dom.abcNsVersion.get(i).len +
            @as(u64, dom.scriptTraits.get(i).len) * 4 + @as(u64, dom.bodyTraits.get(i).len) * @sizeOf(traits_.TypeRef);
        if (dom.isLive(i)) {
            live_abcs += 1;
            live_parse += abc.parsed_bytes;
            live_link += link;
        } else {
            dead_abcs += 1;
            dead_parse += abc.parsed_bytes;
            dead_link += link;
        }
    }

    // The strings only ABCs not live spell: 1 where a live one does, 2 where only others.
    const spelled = try gpa.alloc(u8, dom.stringPtr.len);
    @memset(spelled, 0);
    for (0..dom.abcs.len) |i_| {
        const i: u32 = @intCast(i_);
        const mark: u8 = if (deadAbc(dom, i)) 2 else 1;
        for (dom.abcString.get(i)) |id| {
            if (id < spelled.len and (spelled[id] == 0 or mark == 1)) {
                spelled[id] = mark;
            }
        }
    }

    var dead_strings: u32 = 0;
    var dead_string_bytes: u64 = 0;
    for (spelled, 0..) |mark, id| {
        if (mark == 2) {
            dead_strings += 1;
            dead_string_bytes += dom.stringLength.get(@intCast(id));
        }
    }

    var dead_rows: u64 = 0;
    for (report.totals) |t| {
        dead_rows += @as(u64, t.dead) * t.row_bytes;
    }

    try report.print("abcs live={d} dead={d} vacated={d} live_parse={d} live_link={d} dead_parse={d} dead_link={d} dead_rows={d} dead_strings={d} dead_string_bytes={d}\n", .{ live_abcs, dead_abcs, vacated, live_parse, live_link, dead_parse, dead_link, dead_rows, dead_strings, dead_string_bytes });
    try report.print("tables bytes={d} outgrown={d}\n", .{ report.tables, report.outgrown });

    const pages = memory.pages();
    var counts: [16]u32 = undefined;
    const at_end = pages.freeRuns(&counts);
    try report.print("pages chunks={d} used={d} free_at_end={d} reached={d}\nfreeruns", .{ pages.chunks, pages.used, at_end, pages.reached() });
    for (counts) |n| {
        try report.print(" {d}", .{n});
    }

    // What the domain's arena holds besides: the copies grown tables left
    // behind, scopes and signatures, findings' names, and runs' unused ends.
    const domain_bytes = compile.arena().runBytes();
    const accounted = report.tables + live_parse + dead_parse + live_link + dead_link;
    try report.print("\narena domain={d} global={d} call={d} unaccounted={d}\n", .{ domain_bytes, memory.global.runBytes(), memory.call.runBytes(), domain_bytes -| accounted });
    return report.out.written();
}

/// What the last step of a rebuild did: its kind (rebuild.Phase), the ABCs
/// it linked and their bytes, the verification it did by cost, the log
/// entries it replayed and kept.
pub fn domainRebuildStepWork(gpa: Allocator) Allocator.Error![]const u8 {
    const w = rebuild.last_step;
    var out: Output = try .initCapacity(gpa, 64);
    out.writer().print("{d} {d} {d} {d} {d} {d}", .{ @intFromEnum(w.phase), w.abcs, w.bytes, w.verify_cost, w.replays, w.kept }) catch return error.OutOfMemory;
    return out.written();
}
