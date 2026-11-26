// The constant pool (AVM2 overview 4.3), checked like avmplus'
// AbcParser::parseCpool so the same ABC is accepted or rejected
// (assembly/avm2/abc/pool.ts).
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const C = @import("constants.zig");
const Reader = @import("reader.zig").Reader;
const abc_ = @import("abc.zig");
const Diagnostics = abc_.Diagnostics;
const Error = abc_.Error;

/// Flat tables indexed like the ABC's pools; entry 0 of each is the
/// implicit default. Strings stay byte ranges into the ABC, so only the
/// names codegen uses get decoded. A table the parse did not reach keeps
/// its default, one zero entry (two for nsSetStart), as AssemblyScript's
/// does: each pool's own (`init`), never shared, so a write to one cannot
/// reach another.
pub const ConstantPool = struct {
    ints: []i32 = &.{},
    uints: []u32 = &.{},
    doubles: []f64 = &.{},
    floats: []f32 = &.{},

    /// Offset from the start of the ABC, and byte length, of each string.
    stringStart: []u32 = &.{},
    stringLength: []u32 = &.{},

    nsKind: []u8 = &.{},
    /// String index of the namespace URI; 0 if it has none.
    nsName: []u32 = &.{},

    /// Set i is nsSetMembers[nsSetStart[i] .. nsSetStart[i + 1]].
    nsSetStart: []u32 = &.{},
    nsSetMembers: []u32 = &.{},

    mnKind: []u8 = &.{},
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
            .stringStart = try memory.allocZeroed(gpa, u32, 1),
            .stringLength = try memory.allocZeroed(gpa, u32, 1),
            .nsKind = try memory.allocZeroed(gpa, u8, 1),
            .nsName = try memory.allocZeroed(gpa, u32, 1),
            .nsSetStart = try memory.allocZeroed(gpa, u32, 2),
            .mnKind = try memory.allocZeroed(gpa, u8, 1),
            .mnA = try memory.allocZeroed(gpa, u32, 1),
            .mnB = try memory.allocZeroed(gpa, u32, 1),
        };
    }

    pub inline fn stringCount(self: *const ConstantPool) u32 {
        return @intCast(self.stringStart.len);
    }

    pub inline fn nsCount(self: *const ConstantPool) u32 {
        return @intCast(self.nsKind.len);
    }

    pub inline fn nsSetCount(self: *const ConstantPool) u32 {
        return @intCast(self.nsSetStart.len - 1);
    }

    pub inline fn multinameCount(self: *const ConstantPool) u32 {
        return @intCast(self.mnKind.len);
    }
};

/// Read the constant pool at `r` into `pool`, its tables in `gpa` and what
/// only the read needs in `scratch` (the call's arena, so that a domain's
/// arena keeps the tables alone); the ABC starts at offset 0 of `r`'s data.
/// A pool rejected keeps what it read, for the tests' dumps.
pub fn readConstantPool(gpa: Allocator, scratch: Allocator, r: *Reader, hasFloats: bool, pool: *ConstantPool, diag: *Diagnostics) Error!void {
    pool.* = try .init(gpa);

    const intCount = readCount(r);
    pool.ints = try memory.allocZeroed(gpa, i32, @max(intCount, 1));
    for (1..@max(intCount, 1)) |i| {
        pool.ints[i] = r.s32();
    }

    const uintCount = readCount(r);
    pool.uints = try memory.allocZeroed(gpa, u32, @max(uintCount, 1));
    for (1..@max(uintCount, 1)) |i| {
        pool.uints[i] = r.u32_();
    }

    const doubleCount = readCount(r);
    pool.doubles = try memory.allocZeroed(gpa, f64, @max(doubleCount, 1));
    pool.doubles[0] = std.math.nan(f64);
    for (1..@max(doubleCount, 1)) |i| {
        pool.doubles[i] = r.d64();
    }

    if (r.failed) {
        return diag.fail(C.kCorruptABCError);
    }

    if (hasFloats) {
        const count = readCount(r);
        if (@as(u64, count) * 4 > @as(u64, r.end - r.pos) + 4) {
            return diag.fail(C.kCorruptABCError);
        }

        pool.floats = try memory.allocZeroed(gpa, f32, @max(count, 1));
        pool.floats[0] = std.math.nan(f32);
        for (1..@max(count, 1)) |i| {
            pool.floats[i] = r.f32_();
        }

        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }
    }

    const stringCount = @max(readCount(r), 1);
    pool.stringStart = try memory.allocZeroed(gpa, u32, stringCount);
    pool.stringLength = try memory.allocZeroed(gpa, u32, stringCount);
    for (1..stringCount) |i| {
        // As avmplus: a string may not end at the end of the ABC, and its
        // UTF-8 is not validated.
        const length = r.u32_();
        if (length & 0xc0000000 != 0 or @as(u64, r.pos) + length >= r.end) {
            return diag.fail(C.kCorruptABCError);
        }

        pool.stringStart[i] = @intCast(r.pos);
        pool.stringLength[i] = length;
        r.pos += length;
    }

    const nsCount = @max(readCount(r), 1);
    pool.nsKind = try memory.allocZeroed(gpa, u8, nsCount);
    pool.nsName = try memory.allocZeroed(gpa, u32, nsCount);
    for (1..nsCount) |i| {
        const kind: u8 = @truncate(r.u8_());
        if (!isNamespaceKind(kind)) {
            return diag.fail(if (r.failed) C.kCorruptABCError else C.kCpoolEntryWrongTypeError);
        }

        const name = r.u30_();
        if (name >= stringCount) {
            return diag.fail(C.kCpoolIndexRangeError);
        }

        pool.nsKind[i] = kind;
        pool.nsName[i] = name;
    }

    const nsSetCount = @max(readCount(r), 1);
    pool.nsSetStart = try memory.allocZeroed(gpa, u32, nsSetCount + 1);
    var members: std.ArrayList(u32) = .empty;
    for (1..nsSetCount) |i| {
        pool.nsSetStart[i] = @intCast(members.items.len);
        const count = readCount(r);
        for (0..count) |_| {
            const ns = r.u30_();
            if (ns == 0) {
                return diag.fail(if (r.failed) C.kCorruptABCError else C.kIllegalNamespaceError);
            }

            if (ns >= nsCount) {
                return diag.fail(C.kCpoolIndexRangeError);
            }

            try members.append(scratch, ns);
        }
    }
    pool.nsSetStart[nsSetCount] = @intCast(members.items.len);
    pool.nsSetMembers = try gpa.dupe(u32, members.items);

    const mnCount = @max(readCount(r), 1);
    pool.mnKind = try memory.allocZeroed(gpa, u8, mnCount);
    pool.mnA = try memory.allocZeroed(gpa, u32, mnCount);
    pool.mnB = try memory.allocZeroed(gpa, u32, mnCount);
    for (1..mnCount) |i| {
        const kind: u8 = @truncate(r.u8_());
        var a: u32 = 0;
        var b: u32 = 0;
        switch (kind) {
            C.CONSTANT_Qname, C.CONSTANT_QnameA => {
                a = r.u30_();
                b = r.u30_();
                if (a >= nsCount or b >= stringCount) {
                    return diag.fail(C.kCpoolIndexRangeError);
                }
            },
            C.CONSTANT_RTQname, C.CONSTANT_RTQnameA => {
                b = r.u30_();
                if (b >= stringCount) {
                    return diag.fail(C.kCpoolIndexRangeError);
                }
            },
            // No operands: both come from the stack.
            C.CONSTANT_RTQnameL, C.CONSTANT_RTQnameLA => {},
            C.CONSTANT_Multiname, C.CONSTANT_MultinameA => {
                b = r.u30_();
                if (b >= stringCount) {
                    return diag.fail(C.kCpoolIndexRangeError);
                }

                a = r.u30_();
                if (a == 0 or a >= nsSetCount) {
                    return diag.fail(C.kCpoolIndexRangeError);
                }
            },
            C.CONSTANT_MultinameL, C.CONSTANT_MultinameLA => {
                a = r.u30_();
                if (a == 0 or a >= nsSetCount) {
                    return diag.fail(C.kCpoolIndexRangeError);
                }
            },
            C.CONSTANT_TypeName => {
                // Forward references are legal; the base kind is checked below.
                a = r.u30_();
                if (a == 0 or a >= mnCount) {
                    return diag.fail(C.kCpoolIndexRangeError);
                }

                if (r.u30_() != 1) {
                    return diag.fail(C.kCorruptABCError);
                }

                // Parameter 0 is Vector.<*>.
                b = r.u30_();
                if (b >= mnCount) {
                    return diag.fail(C.kCpoolIndexRangeError);
                }
            },
            else => return diag.fail(if (r.failed) C.kCorruptABCError else C.kCpoolEntryWrongTypeError),
        }

        pool.mnKind[i] = kind;
        pool.mnA[i] = a;
        pool.mnB[i] = b;
    }

    if (r.failed) {
        return diag.fail(C.kCorruptABCError);
    }

    if (!try typeNamesAreAcyclic(scratch, pool)) {
        return diag.fail(C.kCorruptABCError);
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

fn isNamespaceKind(kind: u8) bool {
    return switch (kind) {
        C.CONSTANT_Namespace,
        C.CONSTANT_PackageNamespace,
        C.CONSTANT_PackageInternalNs,
        C.CONSTANT_ProtectedNamespace,
        C.CONSTANT_ExplicitNamespace,
        C.CONSTANT_StaticProtectedNs,
        C.CONSTANT_PrivateNs,
        => true,
        else => false,
    };
}

/// A TypeName may not parameterize another TypeName, and chains like
/// Vector.<Vector.<T>> may not loop. Stamping visited entries with the
/// TypeName being checked avoids clearing a set per TypeName.
fn typeNamesAreAcyclic(gpa: Allocator, pool: *const ConstantPool) Allocator.Error!bool {
    const count = pool.multinameCount();
    const stamp = try memory.allocZeroed(gpa, u32, count);
    for (1..@max(count, 1)) |i| {
        if (pool.mnKind[i] != C.CONSTANT_TypeName) {
            continue;
        }

        if (pool.mnKind[pool.mnA[i]] == C.CONSTANT_TypeName) {
            return false;
        }

        var param = pool.mnB[i];
        while (param != 0) {
            stamp[param] = @intCast(i);
            if (pool.mnKind[param] != C.CONSTANT_TypeName) {
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
