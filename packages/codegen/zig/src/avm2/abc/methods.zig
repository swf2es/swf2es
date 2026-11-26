// method_info and metadata_info, checked like avmplus' parseMethodInfos and
// parseMetadataInfos.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const abc_ = @import("abc.zig");
const Abc = abc_.Abc;
const Lists = abc_.Lists;
const Diagnostics = abc_.Diagnostics;
const Error = abc_.Error;
const C = @import("constants.zig");
const Reader = @import("reader.zig").Reader;

pub fn readMethods(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader, diag: *Diagnostics) Error!void {
    const count = r.u30_();
    if (@max(count, 1) > r.end - r.pos) {
        return diag.fail(C.kCorruptABCError);
    }

    abc.methodReturnType = try lists.zeroed(u32, gpa, abc.methodReturnType, count);
    abc.methodName = try lists.zeroed(u32, gpa, abc.methodName, count);
    abc.methodFlags = try lists.zeroed(u8, gpa, abc.methodFlags, count);
    abc.methodParamStart = try lists.zeroed(u32, gpa, abc.methodParamStart, count + 1);
    abc.methodOptionalStart = try lists.zeroed(u32, gpa, abc.methodOptionalStart, count + 1);
    abc.methodOwner = try lists.zeroed(i32, gpa, abc.methodOwner, count);

    for (0..count) |i| {
        abc.methodOwner[i] = -1;

        const paramCount = r.u30_();
        abc.methodReturnType[i] = r.u30_();
        abc.methodParamStart[i] = lists.len("paramTypes");
        var j: u32 = 0;
        while (j < paramCount and !r.failed) : (j += 1) {
            lists.push("paramTypes", r.u30_());
        }

        abc.methodName[i] = r.u30_();
        const flags: u8 = @truncate(r.u8_());
        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }

        if (flags & C.METHOD_Native != 0 and !abc.builtin) {
            return diag.fail(C.kIllegalNativeMethodError);
        }

        abc.methodFlags[i] = flags;
        abc.methodOptionalStart[i] = lists.len("optionalValue");
        if (flags & C.METHOD_HasOptional != 0) {
            const optionalCount = r.u30_();
            j = 0;
            while (j < optionalCount and !r.failed) : (j += 1) {
                lists.push("optionalValue", r.u30_());
                lists.push("optionalKind", @truncate(r.u8_()));
            }

            if (optionalCount == 0 or optionalCount > paramCount) {
                return diag.fail(C.kCorruptABCError);
            }
        }

        // Parameter names are debug information; skip them.
        if (flags & C.METHOD_HasParamNames != 0) {
            j = 0;
            while (j < paramCount and !r.failed) : (j += 1) {
                _ = r.u30_();
            }
        }

        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }
    }

    abc.methodParamStart[count] = lists.len("paramTypes");
    abc.methodOptionalStart[count] = lists.len("optionalValue");
}

pub fn readMetadata(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader, diag: *Diagnostics) Error!void {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return diag.fail(C.kCorruptABCError);
    }

    abc.metadataName = try lists.zeroed(u32, gpa, abc.metadataName, count);
    abc.metadataItemStart = try lists.zeroed(u32, gpa, abc.metadataItemStart, count + 1);

    for (0..count) |i| {
        const name = r.u30_();
        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }

        if (name == 0 or name >= abc.pool.stringCount()) {
            return diag.fail(C.kCpoolIndexRangeError);
        }

        abc.metadataName[i] = name;
        abc.metadataItemStart[i] = lists.len("metadataKey");

        // Keys and values are string indices that avmplus does not check: all
        // the keys, then all the values, as avmplus' describeMetadataInfo reads
        // them, not the pairs the specification shows.
        const itemCount = r.u30_();
        var j: u32 = 0;
        while (j < itemCount and !r.failed) : (j += 1) {
            lists.push("metadataKey", r.u30_());
        }

        j = 0;
        while (j < itemCount and !r.failed) : (j += 1) {
            lists.push("metadataValue", r.u30_());
        }

        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }
    }

    abc.metadataItemStart[count] = lists.len("metadataKey");
}
