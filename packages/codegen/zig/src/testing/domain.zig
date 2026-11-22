// The test build's look inside a domain (assembly/testing/domain.ts): its
// lookups, traits and builtins. Verifying, the IR and a method's code come
// with stages 4 and 5.
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../output.zig");
const compile = @import("../compile.zig");
const domain_ = @import("../avm2/link/domain.zig");
const Domain = domain_.Domain;

/// The domain's binding of `name` in the namespace of type `type` (NS_*) and
/// URI `uri`, visible at `version` from application domain `appDomain`:
/// "abc A script S trait T", or "none".
pub fn domainFind(gpa: Allocator, type_: u8, uri: []const u8, name: []const u8, version: i32, appDomain: i32) Allocator.Error![]const u8 {
    const dom = try compile.domain();
    const uriId = dom.findString(uri);
    const nameId = dom.findString(name);
    if (uriId < 0 or nameId < 0) {
        return "none";
    }

    const ns = dom.findNamespace(type_, @intCast(uriId));
    const b = if (ns < 0) -1 else dom.find(@intCast(ns), @intCast(nameId), @truncate(@as(u32, @bitCast(version))), @bitCast(appDomain));
    if (b < 0) {
        return "none";
    }

    const i: u32 = @intCast(b);
    return std.fmt.allocPrint(gpa, "abc {d} script {d} trait {d}", .{ dom.bindingAbc.get(i), dom.bindingScript.get(i), dom.bindingTrait.get(i) });
}

/// A decoded string's units, as AssemblyScript sorts strings by them.
const Units = struct {
    units: []const u16,
    bytes: []const u8,

    fn lessThan(_: void, a: Units, b: Units) bool {
        return std.mem.order(u16, a.units, b.units) == .lt;
    }
};

/// Counts of the domain's tables and recorded findings, then the URIs builtin ABCs version, sorted.
pub fn domainSummary(gpa: Allocator) Allocator.Error![]const u8 {
    const dom = try compile.domain();
    var uris: std.ArrayList(Units) = .empty;
    for (0..dom.versioned.len) |i_| {
        const i: u32 = @intCast(i_);
        if (dom.versioned.get(i) != 0) {
            const bytes = dom.stringOf(i);
            try uris.append(gpa, .{ .units = try output.decodeUnits(gpa, bytes), .bytes = bytes });
        }
    }

    std.mem.sort(Units, uris.items, {}, Units.lessThan);
    var out: std.Io.Writer.Allocating = .init(gpa);
    const w = &out.writer;
    write: {
        w.print("strings {d} namespaces {d} bindings {d} found {d} versioned ", .{ dom.stringPtr.len, dom.nsType.len, dom.bindingNs.len, dom.cachedDomain.len }) catch break :write;
        for (uris.items, 0..) |uri, k| {
            if (k > 0) {
                w.writeByte(',') catch break :write;
            }

            output.writeDecoded(w, uri.bytes) catch break :write;
        }

        return out.written();
    }

    return error.OutOfMemory;
}

fn writeText(w: *std.Io.Writer, dom: *const Domain, id: u32) std.Io.Writer.Error!void {
    if (id == 0xffffffff) {
        return w.writeByte('*');
    }

    return output.writeDecoded(w, dom.stringOf(id));
}

/// The domain's traits from `first` on: "traits T kind K base B slots S
/// methods M", then a "  uri::name kind id" line per own member.
pub fn domainTraits(gpa: Allocator, first: i32) Allocator.Error![]const u8 {
    const dom = try compile.domain();
    const traits = &dom.traits;
    var out: std.Io.Writer.Allocating = .init(gpa);
    const w = &out.writer;
    write: {
        var t: i32 = first;
        while (t < traits.kind.len) : (t += 1) {
            const u: u32 = @bitCast(t);
            if (t > first) {
                w.writeByte('\n') catch break :write;
            }

            w.print("traits {d} kind {d} base {d} slots {d} methods {d}", .{ t, traits.kind.get(u), traits.base.get(u), traits.slotCount.get(u), traits.methodCount.get(u) }) catch break :write;
            var m = traits.memberStart.get(u);
            while (m < traits.memberEnd.get(u)) : (m += 1) {
                const binding = traits.memberBinding.get(m);
                w.writeAll("\n  ") catch break :write;
                writeText(w, dom, dom.nsUri.get(traits.memberNs.get(m))) catch break :write;
                w.writeAll("::") catch break :write;
                writeText(w, dom, traits.memberName.get(m)) catch break :write;
                w.print(" {d} {d}", .{ binding & 7, binding >> 3 }) catch break :write;
            }
        }

        return out.written();
    }

    return error.OutOfMemory;
}

/// Resolve every traits of the domain from `first` on, as avmplus does when
/// each is first used: 0, or the first VerifyError.
pub fn domainResolve(dom: *Domain, first: i32) Allocator.Error!i32 {
    const count: i32 = @intCast(dom.traits.kind.len);
    var t = first;
    while (t < count) : (t += 1) {
        const err = try dom.traits.resolve(dom, @bitCast(t));
        if (err != 0) {
            return err;
        }
    }

    return 0;
}

/// The builtin types the domain found, as traits ids.
pub fn domainBuiltins(gpa: Allocator) Allocator.Error![]const u8 {
    const d = try compile.domain();
    return std.fmt.allocPrint(gpa, "object {d} class {d} void {d} null {d} number {d} int {d} uint {d} boolean {d} string {d} namespace {d} vector {d} vectorObject {d} vectorInt {d} vectorUint {d} vectorDouble {d}", .{ d.objectType(), d.classClass, d.voidType, d.nullType, d.numberType, d.intType, d.uintType, d.booleanType, d.stringType, d.namespaceType, d.vectorClass, d.vectorObjectType, d.vectorIntType, d.vectorUintType, d.vectorDoubleType });
}

/// The slot types of the instances of class `cls` of ABC `index`, resolving
/// them if they are not yet: each "abc A class C", or "*"; "none" if it has
/// no such class.
pub fn domainSlotTypes(dom: *Domain, gpa: Allocator, index: i32, cls: i32) Allocator.Error![]const u8 {
    if (index < 0 or index >= dom.abcs.len or cls < 0) {
        return "none";
    }

    if (@as(u32, @intCast(cls)) >= dom.abcs.get(@intCast(index)).classCount()) {
        return "none";
    }

    const traits = &dom.traits;
    const t = dom.classTraits.get(dom.classStart.get(@intCast(index)) + @as(u32, @intCast(cls)));
    if (t < 0 or try traits.resolve(dom, @intCast(t)) != 0) {
        return "unresolved";
    }

    const u: u32 = @intCast(t);
    var out: std.ArrayList(u8) = .empty;
    const start = traits.slotStart.get(u);
    for (0..traits.slotCount.get(u)) |s| {
        if (s > 0) {
            try out.appendSlice(gpa, ", ");
        }

        const ty = traits.slotType.get(start + @as(u32, @intCast(s)));
        if (ty < 0) {
            try out.append(gpa, '*');
        } else {
            try out.print(gpa, "abc {d} class {d}", .{ traits.abc.get(@intCast(ty)), traits.owner.get(@intCast(ty)) });
        }
    }

    return out.items;
}

/// How many traits the domain has.
pub fn domainTraitsCount() Allocator.Error!i32 {
    return @intCast((try compile.domain()).traits.kind.len);
}

const memory = @import("../memory.zig");
const lifetime = @import("../avm2/link/lifetime.zig");
const testing = std.testing;

// The ABCs of tests/parity/link-abc.ts, which a unit test holds these to:
// a builtin one that links with nothing before it, a user one extending
// its class from another application domain, and one that fails to link.
pub const link_builtin = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x03, 0x03, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, 0x15, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74,
    0x05, 0x43, 0x6c, 0x61, 0x73, 0x73, 0x08, 0x46, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e,
    0x04, 0x76, 0x6f, 0x69, 0x64, 0x05, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x01, 0x41, 0x01, 0x42,
    0x01, 0x49, 0x01, 0x46, 0x07, 0x4d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x01, 0x6d, 0x01,
    0x78, 0x09, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x74, 0x79, 0x70, 0x65, 0x03, 0x69, 0x6e, 0x74,
    0x04, 0x75, 0x69, 0x6e, 0x74, 0x06, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x06, 0x53, 0x74,
    0x72, 0x69, 0x6e, 0x67, 0x07, 0x42, 0x6f, 0x6f, 0x6c, 0x65, 0x61, 0x6e, 0x01, 0x6e, 0x04,
    0x16, 0x01, 0x16, 0x07, 0x08, 0x09, 0x02, 0x02, 0x01, 0x02, 0x17, 0x07, 0x01, 0x02, 0x07,
    0x01, 0x03, 0x07, 0x01, 0x04, 0x07, 0x01, 0x05, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x07,
    0x01, 0x08, 0x07, 0x01, 0x09, 0x07, 0x01, 0x0a, 0x07, 0x01, 0x0b, 0x07, 0x01, 0x0c, 0x07,
    0x01, 0x0d, 0x07, 0x01, 0x0e, 0x07, 0x01, 0x0f, 0x07, 0x01, 0x10, 0x07, 0x01, 0x11, 0x07,
    0x01, 0x12, 0x07, 0x01, 0x13, 0x07, 0x01, 0x14, 0x09, 0x07, 0x01, 0x07, 0x02, 0x07, 0x07,
    0x03, 0x0c, 0x13, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x00,
    0x00, 0x02, 0x00, 0x03, 0x01, 0x00, 0x00, 0x04, 0x00, 0x08, 0x00, 0x04, 0x00, 0x06, 0x01,
    0x16, 0x01, 0x00, 0x0d, 0x06, 0x01, 0x00, 0x01, 0x08, 0x08, 0x05, 0x0c, 0x00, 0x00, 0x06,
    0x00, 0x09, 0x06, 0x00, 0x01, 0x01, 0x03, 0x0b, 0x01, 0x00, 0x0e, 0x13, 0x02, 0x00, 0x0f,
    0x13, 0x03, 0x00, 0x10, 0x07, 0x06, 0x00, 0x00, 0x0a, 0x02, 0x0b, 0x21, 0x00, 0x11, 0x13,
    0x22, 0x00, 0x12, 0x01, 0x00, 0x03, 0x00, 0x05, 0x00, 0x07, 0x00, 0x09, 0x01, 0x0c, 0x00,
    0x00, 0x01, 0x00, 0x0b, 0x00, 0x01, 0x0c, 0x06, 0x01, 0x04, 0x01, 0x00, 0x02, 0x04, 0x02,
    0x01, 0x03, 0x04, 0x03, 0x02, 0x08, 0x04, 0x04, 0x03, 0x06, 0x04, 0x05, 0x04, 0x07, 0x04,
    0x06, 0x05, 0x01, 0x0c, 0x01, 0x01, 0x00, 0x01, 0x01, 0x47, 0x00, 0x00,
};

pub const link_user = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x03, 0x03, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, 0x15, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74,
    0x05, 0x43, 0x6c, 0x61, 0x73, 0x73, 0x08, 0x46, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e,
    0x04, 0x76, 0x6f, 0x69, 0x64, 0x05, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x01, 0x41, 0x01, 0x42,
    0x01, 0x49, 0x01, 0x46, 0x07, 0x4d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x01, 0x6d, 0x01,
    0x78, 0x09, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x74, 0x79, 0x70, 0x65, 0x03, 0x69, 0x6e, 0x74,
    0x04, 0x75, 0x69, 0x6e, 0x74, 0x06, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x06, 0x53, 0x74,
    0x72, 0x69, 0x6e, 0x67, 0x07, 0x42, 0x6f, 0x6f, 0x6c, 0x65, 0x61, 0x6e, 0x01, 0x6e, 0x04,
    0x16, 0x01, 0x16, 0x07, 0x08, 0x09, 0x02, 0x02, 0x01, 0x02, 0x17, 0x07, 0x01, 0x02, 0x07,
    0x01, 0x03, 0x07, 0x01, 0x04, 0x07, 0x01, 0x05, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x07,
    0x01, 0x08, 0x07, 0x01, 0x09, 0x07, 0x01, 0x0a, 0x07, 0x01, 0x0b, 0x07, 0x01, 0x0c, 0x07,
    0x01, 0x0d, 0x07, 0x01, 0x0e, 0x07, 0x01, 0x0f, 0x07, 0x01, 0x10, 0x07, 0x01, 0x11, 0x07,
    0x01, 0x12, 0x07, 0x01, 0x13, 0x07, 0x01, 0x14, 0x09, 0x07, 0x01, 0x07, 0x02, 0x07, 0x07,
    0x03, 0x0c, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x05, 0x07, 0x00, 0x00, 0x00, 0x02, 0x0b, 0x21, 0x00,
    0x03, 0x0d, 0x00, 0x00, 0x07, 0x00, 0x01, 0x00, 0x01, 0x02, 0x01, 0x05, 0x04, 0x01, 0x00,
    0x01, 0x02, 0x01, 0x01, 0x00, 0x01, 0x01, 0x47, 0x00, 0x00,
};

pub const link_failing = [_]u8{
    0x10, 0x00, 0x2e, 0x00, 0x03, 0x03, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, 0x15, 0x00, 0x06, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74,
    0x05, 0x43, 0x6c, 0x61, 0x73, 0x73, 0x08, 0x46, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e,
    0x04, 0x76, 0x6f, 0x69, 0x64, 0x05, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x01, 0x41, 0x01, 0x42,
    0x01, 0x49, 0x01, 0x46, 0x07, 0x4d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x01, 0x6d, 0x01,
    0x78, 0x09, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x74, 0x79, 0x70, 0x65, 0x03, 0x69, 0x6e, 0x74,
    0x04, 0x75, 0x69, 0x6e, 0x74, 0x06, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x06, 0x53, 0x74,
    0x72, 0x69, 0x6e, 0x67, 0x07, 0x42, 0x6f, 0x6f, 0x6c, 0x65, 0x61, 0x6e, 0x01, 0x6e, 0x04,
    0x16, 0x01, 0x16, 0x07, 0x08, 0x09, 0x02, 0x02, 0x01, 0x02, 0x17, 0x07, 0x01, 0x02, 0x07,
    0x01, 0x03, 0x07, 0x01, 0x04, 0x07, 0x01, 0x05, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x07,
    0x01, 0x08, 0x07, 0x01, 0x09, 0x07, 0x01, 0x0a, 0x07, 0x01, 0x0b, 0x07, 0x01, 0x0c, 0x07,
    0x01, 0x0d, 0x07, 0x01, 0x0e, 0x07, 0x01, 0x0f, 0x07, 0x01, 0x10, 0x07, 0x01, 0x11, 0x07,
    0x01, 0x12, 0x07, 0x01, 0x13, 0x07, 0x01, 0x14, 0x09, 0x07, 0x01, 0x07, 0x02, 0x07, 0x07,
    0x03, 0x0c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x0a, 0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x02, 0x01, 0x0a, 0x04,
    0x01, 0x00, 0x01, 0x02, 0x01, 0x01, 0x00, 0x01, 0x01, 0x47, 0x00, 0x00,
};

/// A digest of everything a domain holds but getBinding's memo, which a
/// rollback empties: each table's rows, each id table's slots, and the
/// numbers beside them. Equal before a call and after it ran out of memory.
fn fingerprint(dom: *const Domain) u64 {
    var h: std.hash.Wyhash = .init(0);
    hashFields(&h, dom.*);
    return h.final();
}

const field_count = @typeInfo(Domain).@"struct".field_names.len + @typeInfo(@import("../avm2/link/traits.zig").TraitsTable).@"struct".field_names.len;

/// Each field's digest, to name the ones a rollback missed.
fn fieldPrints(dom: *const Domain) [field_count]u64 {
    var prints: [field_count]u64 = @splat(0);
    var k: usize = 0;
    inline for (@typeInfo(Domain).@"struct".field_names) |name| {
        var h: std.hash.Wyhash = .init(0);
        hashValue(&h, @field(dom.*, name));
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
    inline for (@typeInfo(Domain).@"struct".field_names ++ @typeInfo(@import("../avm2/link/traits.zig").TraitsTable).@"struct".field_names) |name| {
        if (a[k] != b[k]) {
            std.debug.print("differs: {s}\n", .{name});
        }

        k += 1;
    }
}

fn hashFields(h: *std.hash.Wyhash, value: anytype) void {
    inline for (@typeInfo(@TypeOf(value)).@"struct".field_names) |name| {
        const skipped = comptime std.mem.eql(u8, name, "gpa") or
            std.mem.eql(u8, name, "scratch") or
            std.mem.eql(u8, name, "undo") or
            std.mem.eql(u8, name, "bindingMemo") or
            std.mem.startsWith(u8, name, "memo");
        if (!skipped) {
            hashValue(h, @field(value, name));
        }
    }
}

fn hashValue(h: *std.hash.Wyhash, value: anytype) void {
    const T = @TypeOf(value);
    switch (@typeInfo(T)) {
        .int, .bool => h.update(std.mem.asBytes(&value)),
        .optional => h.update(&.{@intFromBool(value != null)}),
        .pointer => |ptr| if (ptr.size == .slice) {
            h.update(std.mem.asBytes(&value.len));
            if (@typeInfo(ptr.child) == .int) {
                h.update(std.mem.sliceAsBytes(value));
            }
        } else {
            h.update(std.mem.asBytes(&@intFromPtr(value)));
        },
        .@"struct" => if (@hasField(T, "directory")) {
            h.update(std.mem.asBytes(&value.len));
            var i: u32 = 0;
            while (i < value.len) : (i += 1) {
                hashValue(h, value.get(i));
            }
        } else {
            hashFields(h, value);
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
    try testing.expectEqual(-1, try dom.underscoredName(lone));
    // A sequence cut short at the end decodes to nothing; a lone surrogate stays one, in WTF-8.
    const underscore = try dom.internString("_");
    const a = try dom.internString("_a");
    const kept = try dom.internString("_\xed\xa0\x80b");
    const c = try dom.internString("_c");
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
                else => try compile.domainDrop(1),
            }
        }
    };
    for (0..11) |step| {
        const dom = try compile.domain();
        const before = fingerprint(dom);
        steps.run(@intCast(step)) catch |err| {
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
                4 => try domain_.changed(d, a, Domain.addFound, .{ 1, 0, "", "A", 0, true }),
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
