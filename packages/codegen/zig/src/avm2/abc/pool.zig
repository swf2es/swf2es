// The constant pool (AVM2 overview 4.3), checked like avmplus'
// AbcParser::parseCpool so the same ABC is accepted or rejected.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const C = @import("constants.zig");
const Reader = @import("reader.zig").Reader;
const errors = @import("errors.zig");
const Diagnostics = errors.Diagnostics;
const Error = errors.Error;

/// Bytes `len` long from `start` in the ABC: a string's, a body's code.
pub const Range = struct {
    start: u32 = 0,
    len: u32 = 0,

    /// The bytes in `data`, the ABC block these offsets are from.
    pub fn of(self: Range, data: []const u8) []const u8 {
        return data[self.start..][0..self.len];
    }
};

/// A multiname as its kind lays out its operands (AVM2 overview 4.4.4);
/// `attribute` marks the kinds that name an XML attribute. The pool keeps
/// multinames as three flat tables (mnKind, mnA, mnB), which this reads.
pub const Multiname = union(enum) {
    /// Entry 0, the any name.
    none,
    qname: struct { ns: u32, name: u32, attribute: bool },
    /// The namespace from the stack.
    rtqname: struct { name: u32, attribute: bool },
    /// The namespace and the name from the stack.
    rtqname_late: struct { attribute: bool },
    multiname: struct { set: u32, name: u32, attribute: bool },
    /// The name from the stack.
    multiname_late: struct { set: u32, attribute: bool },
    /// A parameterized type, Vector.<param>; param 0 is *.
    type_name: struct { base: u32, param: u32 },

    /// Whether it names an XML attribute.
    pub fn isAttribute(self: Multiname) bool {
        return switch (self) {
            .qname => |q| q.attribute,
            .rtqname => |q| q.attribute,
            .rtqname_late => |q| q.attribute,
            .multiname => |m| m.attribute,
            .multiname_late => |m| m.attribute,
            .none, .type_name => false,
        };
    }
};

/// A default value, of a slot or an optional parameter (AVM2 overview
/// 4.5.1). The ABC keeps each as its kind and index (traitValueKind and
/// traitValue, optionalKind and optionalValue), which ConstantPool.value
/// reads.
pub const Value = union(enum) {
    int: i32,
    uint: u32,
    double: f64,
    float: f32,
    /// A string's index in the pool.
    string: u32,
    boolean: bool,
    null,
    /// A namespace's index in the pool.
    namespace: u32,
};

/// Why ConstantPool.value reads no default value: a kind no default may
/// be, or an index past its table.
pub const ValueError = error{ IllegalKind, OutOfRange };

/// Flat tables indexed like the ABC's pools; entry 0 of each is the
/// implicit default. Strings stay byte ranges into the ABC, so only the
/// names codegen uses get decoded. A table the parse did not reach keeps
/// its default, one zero entry (two for nsSetStart): each pool's own
/// (`init`), never shared, so a write to one cannot reach another.
pub const ConstantPool = struct {
    ints: []i32 = &.{},
    uints: []u32 = &.{},
    doubles: []f64 = &.{},
    floats: []f32 = &.{},

    /// Each string's bytes in the ABC.
    strings: []Range = &.{},

    nsKind: []C.Constant = &.{},
    /// String index of the namespace URI; 0 if it has none.
    nsName: []u32 = &.{},

    /// Set i is nsSetMembers[nsSetStart[i] .. nsSetStart[i + 1]].
    nsSetStart: []u32 = &.{},
    nsSetMembers: []u32 = &.{},

    mnKind: []C.Constant = &.{},
    /// Namespace (QName), namespace set (Multiname) or base type (TypeName).
    mnA: []u32 = &.{},
    /// Name string (QName, RTQName, Multiname) or type parameter (TypeName).
    mnB: []u32 = &.{},

    /// A pool of defaults only, in `gpa`.
    pub fn init(gpa: Allocator) Allocator.Error!ConstantPool {
        return .{
            .ints = try memory.allocZeroed(gpa, i32, 1),
            .uints = try memory.allocZeroed(gpa, u32, 1),
            .doubles = try memory.allocZeroed(gpa, f64, 1),
            .floats = try memory.allocZeroed(gpa, f32, 1),
            .strings = try memory.allocZeroed(gpa, Range, 1),
            .nsKind = try memory.allocZeroed(gpa, C.Constant, 1),
            .nsName = try memory.allocZeroed(gpa, u32, 1),
            .nsSetStart = try memory.allocZeroed(gpa, u32, 2),
            .mnKind = try memory.allocZeroed(gpa, C.Constant, 1),
            .mnA = try memory.allocZeroed(gpa, u32, 1),
            .mnB = try memory.allocZeroed(gpa, u32, 1),
        };
    }

    /// Multiname `i`, as its kind lays it out.
    pub fn multiname(self: *const ConstantPool, i: u32) Multiname {
        const kind = self.mnKind[i];
        const a = self.mnA[i];
        const b = self.mnB[i];
        return switch (kind) {
            .qname, .qname_a => .{ .qname = .{ .ns = a, .name = b, .attribute = kind == .qname_a } },
            .rtqname, .rtqname_a => .{ .rtqname = .{ .name = b, .attribute = kind == .rtqname_a } },
            .rtqname_l, .rtqname_la => .{ .rtqname_late = .{ .attribute = kind == .rtqname_la } },
            .multiname, .multiname_a => .{ .multiname = .{ .set = a, .name = b, .attribute = kind == .multiname_a } },
            .multiname_l, .multiname_la => .{ .multiname_late = .{ .set = a, .attribute = kind == .multiname_la } },
            .type_name => .{ .type_name = .{ .base = a, .param = b } },
            else => .none,
        };
    }

    /// Multiname `i`, or the base it parameterizes where it is a TypeName,
    /// which stands for its base wherever a name is read.
    pub fn baseName(self: *const ConstantPool, i: u32) Multiname {
        return switch (self.multiname(i)) {
            .type_name => |t| self.multiname(t.base),
            else => |m| m,
        };
    }

    /// The default value of kind `kind` at `index`: IllegalKind where no
    /// default value may be of that kind, OutOfRange where `index` is past
    /// its table. True, false and null are their kind alone; their index
    /// is not read.
    pub fn value(self: *const ConstantPool, kind: C.Constant, index: u32) ValueError!Value {
        const count: usize = switch (kind) {
            .int => self.ints.len,
            .uint => self.uints.len,
            .double => self.doubles.len,
            .float => self.floats.len,
            .utf8 => self.strings.len,
            .true, .false, .null => std.math.maxInt(usize),
            .namespace,
            .package_namespace,
            .package_internal_ns,
            .protected_namespace,
            .explicit_namespace,
            .static_protected_ns,
            .private_ns,
            => self.nsKind.len,
            else => return error.IllegalKind,
        };
        if (index >= count) {
            return error.OutOfRange;
        }

        return switch (kind) {
            .int => .{ .int = self.ints[index] },
            .uint => .{ .uint = self.uints[index] },
            .double => .{ .double = self.doubles[index] },
            .float => .{ .float = self.floats[index] },
            .utf8 => .{ .string = index },
            .true => .{ .boolean = true },
            .false => .{ .boolean = false },
            .null => .null,
            else => .{ .namespace = index },
        };
    }

    /// String `i`'s bytes in `data`, the ABC block.
    pub fn string(self: *const ConstantPool, data: []const u8, i: u32) []const u8 {
        return self.strings[i].of(data);
    }

    pub inline fn stringCount(self: *const ConstantPool) u32 {
        return @intCast(self.strings.len);
    }

    pub inline fn nsCount(self: *const ConstantPool) u32 {
        return @intCast(self.nsKind.len);
    }

    pub inline fn nsSetCount(self: *const ConstantPool) u32 {
        return @intCast(self.nsSetStart.len - 1);
    }

    /// Namespace set `set`'s members, as namespace indices.
    pub inline fn nsSet(self: *const ConstantPool, set: u32) []const u32 {
        return self.nsSetMembers[self.nsSetStart[set]..self.nsSetStart[set + 1]];
    }

    pub inline fn multinameCount(self: *const ConstantPool) u32 {
        return @intCast(self.mnKind.len);
    }
};

/// `table`, init's default, where it is the `count` entries long a
/// section needs; else a new zeroed table that long.
fn sized(gpa: Allocator, comptime T: type, table: []T, count: u32) Allocator.Error![]T {
    return if (table.len == count) table else memory.allocZeroed(gpa, T, count);
}

/// Read the constant pool at `r` into `pool`, its tables in `gpa` and what
/// only the read needs in `scratch` (the call's arena, so that a domain's
/// arena keeps the tables alone); the ABC starts at offset 0 of `r`'s data.
/// `pool` holds init's defaults, which a table of no entries past its
/// default keeps, and which the tables the read does not reach keep. A pool
/// rejected keeps what it read, for the tests' dumps.
pub fn readConstantPool(gpa: Allocator, scratch: Allocator, r: *Reader, hasFloats: bool, pool: *ConstantPool, diag: *Diagnostics) Error!void {
    const intCount = readCount(r);
    pool.ints = try sized(gpa, i32, pool.ints, @max(intCount, 1));
    for (1..@max(intCount, 1)) |i| {
        pool.ints[i] = r.s32();
    }

    const uintCount = readCount(r);
    pool.uints = try sized(gpa, u32, pool.uints, @max(uintCount, 1));
    for (1..@max(uintCount, 1)) |i| {
        pool.uints[i] = r.u32_();
    }

    const doubleCount = readCount(r);
    pool.doubles = try sized(gpa, f64, pool.doubles, @max(doubleCount, 1));
    pool.doubles[0] = std.math.nan(f64);
    for (1..@max(doubleCount, 1)) |i| {
        pool.doubles[i] = r.d64();
    }

    if (r.failed) {
        return diag.fail(.kCorruptABCError);
    }

    if (hasFloats) {
        const count = readCount(r);
        if (@as(u64, count) * 4 > @as(u64, r.end - r.pos) + 4) {
            return diag.fail(.kCorruptABCError);
        }

        pool.floats = try sized(gpa, f32, pool.floats, @max(count, 1));
        pool.floats[0] = std.math.nan(f32);
        for (1..@max(count, 1)) |i| {
            pool.floats[i] = r.f32_();
        }

        if (r.failed) {
            return diag.fail(.kCorruptABCError);
        }
    }

    const stringCount = @max(readCount(r), 1);
    pool.strings = try sized(gpa, Range, pool.strings, stringCount);
    for (1..stringCount) |i| {
        // As avmplus: a string may not end at the end of the ABC, and its
        // UTF-8 is not validated.
        const length = r.u32_();
        if (length & 0xc0000000 != 0 or @as(u64, r.pos) + length >= r.end) {
            return diag.fail(.kCorruptABCError);
        }

        pool.strings[i] = .{ .start = @intCast(r.pos), .len = length };
        r.pos += length;
    }

    const nsCount = @max(readCount(r), 1);
    pool.nsKind = try sized(gpa, C.Constant, pool.nsKind, nsCount);
    pool.nsName = try sized(gpa, u32, pool.nsName, nsCount);
    for (1..nsCount) |i| {
        const kind = r.byteAs(C.Constant);
        if (!kind.isNamespace()) {
            return diag.fail(if (r.failed) .kCorruptABCError else .kCpoolEntryWrongTypeError);
        }

        const name = r.u30_();
        if (name >= stringCount) {
            return diag.fail(.kCpoolIndexRangeError);
        }

        pool.nsKind[i] = kind;
        pool.nsName[i] = name;
    }

    const nsSetCount = @max(readCount(r), 1);
    pool.nsSetStart = try sized(gpa, u32, pool.nsSetStart, nsSetCount + 1);
    var members: std.ArrayList(u32) = .empty;
    for (1..nsSetCount) |i| {
        pool.nsSetStart[i] = @intCast(members.items.len);
        const count = readCount(r);
        for (0..count) |_| {
            const ns = r.u30_();
            if (ns == 0) {
                return diag.fail(if (r.failed) .kCorruptABCError else .kIllegalNamespaceError);
            }

            if (ns >= nsCount) {
                return diag.fail(.kCpoolIndexRangeError);
            }

            try members.append(scratch, ns);
        }
    }
    pool.nsSetStart[nsSetCount] = @intCast(members.items.len);
    pool.nsSetMembers = try gpa.dupe(u32, members.items);

    const mnCount = @max(readCount(r), 1);
    pool.mnKind = try sized(gpa, C.Constant, pool.mnKind, mnCount);
    pool.mnA = try sized(gpa, u32, pool.mnA, mnCount);
    pool.mnB = try sized(gpa, u32, pool.mnB, mnCount);
    for (1..mnCount) |i| {
        const kind = r.byteAs(C.Constant);
        var a: u32 = 0;
        var b: u32 = 0;
        switch (kind) {
            .qname, .qname_a => {
                a = r.u30_();
                b = r.u30_();
                if (a >= nsCount or b >= stringCount) {
                    return diag.fail(.kCpoolIndexRangeError);
                }
            },
            .rtqname, .rtqname_a => {
                b = r.u30_();
                if (b >= stringCount) {
                    return diag.fail(.kCpoolIndexRangeError);
                }
            },
            // No operands: both come from the stack.
            .rtqname_l, .rtqname_la => {},
            .multiname, .multiname_a => {
                b = r.u30_();
                if (b >= stringCount) {
                    return diag.fail(.kCpoolIndexRangeError);
                }

                a = r.u30_();
                if (a == 0 or a >= nsSetCount) {
                    return diag.fail(.kCpoolIndexRangeError);
                }
            },
            .multiname_l, .multiname_la => {
                a = r.u30_();
                if (a == 0 or a >= nsSetCount) {
                    return diag.fail(.kCpoolIndexRangeError);
                }
            },
            .type_name => {
                // Forward references are legal; the base kind is checked below.
                a = r.u30_();
                if (a == 0 or a >= mnCount) {
                    return diag.fail(.kCpoolIndexRangeError);
                }

                if (r.u30_() != 1) {
                    return diag.fail(.kCorruptABCError);
                }

                // Parameter 0 is Vector.<*>.
                b = r.u30_();
                if (b >= mnCount) {
                    return diag.fail(.kCpoolIndexRangeError);
                }
            },
            else => return diag.fail(if (r.failed) .kCorruptABCError else .kCpoolEntryWrongTypeError),
        }

        pool.mnKind[i] = kind;
        pool.mnA[i] = a;
        pool.mnB[i] = b;
    }

    if (r.failed) {
        return diag.fail(.kCorruptABCError);
    }

    if (!try typeNamesAreAcyclic(scratch, pool)) {
        return diag.fail(.kCorruptABCError);
    }
}

/// A pool count; more entries than bytes left is corrupt, which bounds allocations.
fn readCount(r: *Reader) u32 {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        r.failed = true;
        r.pos = r.end;
        return 0;
    }

    return count;
}

/// A TypeName may not parameterize another TypeName, and chains like
/// Vector.<Vector.<T>> may not loop. Stamping visited entries with the
/// TypeName being checked avoids clearing a set per TypeName.
fn typeNamesAreAcyclic(gpa: Allocator, pool: *const ConstantPool) Allocator.Error!bool {
    const count = pool.multinameCount();
    const stamp = try memory.allocZeroed(gpa, u32, count);
    for (1..@max(count, 1)) |i| {
        if (pool.mnKind[i] != .type_name) {
            continue;
        }

        if (pool.mnKind[pool.mnA[i]] == .type_name) {
            return false;
        }

        var param = pool.mnB[i];
        while (param != 0) {
            stamp[param] = @intCast(i);
            if (pool.mnKind[param] != .type_name) {
                break;
            }

            param = pool.mnB[param];
            if (stamp[param] == i) {
                return false;
            }
        }
    }

    return true;
}
