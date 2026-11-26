// method_info and metadata_info, checked like avmplus' parseMethodInfos and
// parseMetadataInfos (assembly/avm2/abc/methods.ts).
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const abc_ = @import("abc.zig");
const Abc = abc_.Abc;
const Lists = abc_.Lists;
const C = @import("constants.zig");
const Reader = @import("reader.zig").Reader;

pub fn readMethods(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader) Allocator.Error!bool {
    const count = r.u30_();
    if (@max(count, 1) > r.end - r.pos) {
        return abc.fail(C.kCorruptABCError);
    }

    abc.methodReturnType = try memory.allocZeroed(gpa, u32, count);
    abc.methodName = try memory.allocZeroed(gpa, u32, count);
    abc.methodFlags = try memory.allocZeroed(gpa, u8, count);
    abc.methodParamStart = try memory.allocZeroed(gpa, u32, count + 1);
    abc.methodOptionalStart = try memory.allocZeroed(gpa, u32, count + 1);
    abc.methodOwner = try memory.allocZeroed(gpa, i32, count);

    for (0..count) |i| {
        abc.methodOwner[i] = -1;

        const paramCount = r.u30_();
        abc.methodReturnType[i] = r.u30_();
        abc.methodParamStart[i] = abc_.len(lists.paramTypes);
        var j: u32 = 0;
        while (j < paramCount and !r.failed) : (j += 1) {
            try lists.paramTypes.append(lists.scratch, r.u30_());
        }

        abc.methodName[i] = r.u30_();
        const flags: u8 = @truncate(r.u8_());
        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }

        if (flags & C.METHOD_Native != 0 and !abc.builtin) {
            return abc.fail(C.kIllegalNativeMethodError);
        }

        abc.methodFlags[i] = flags;
        abc.methodOptionalStart[i] = abc_.len(lists.optionalValue);
        if (flags & C.METHOD_HasOptional != 0) {
            const optionalCount = r.u30_();
            j = 0;
            while (j < optionalCount and !r.failed) : (j += 1) {
                try lists.optionalValue.append(lists.scratch, r.u30_());
                try lists.optionalKind.append(lists.scratch, @truncate(r.u8_()));
            }

            if (optionalCount == 0 or optionalCount > paramCount) {
                return abc.fail(C.kCorruptABCError);
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
            return abc.fail(C.kCorruptABCError);
        }
    }

    abc.methodParamStart[count] = abc_.len(lists.paramTypes);
    abc.methodOptionalStart[count] = abc_.len(lists.optionalValue);
    return true;
}

pub fn readMetadata(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader) Allocator.Error!bool {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return abc.fail(C.kCorruptABCError);
    }

    abc.metadataName = try memory.allocZeroed(gpa, u32, count);
    abc.metadataItemStart = try memory.allocZeroed(gpa, u32, count + 1);

    for (0..count) |i| {
        const name = r.u30_();
        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }

        if (name == 0 or name >= abc.pool.stringCount()) {
            return abc.fail(C.kCpoolIndexRangeError);
        }

        abc.metadataName[i] = name;
        abc.metadataItemStart[i] = abc_.len(lists.metadataKey);

        // Keys and values are string indices that avmplus does not check: all
        // the keys, then all the values, as avmplus' describeMetadataInfo reads
        // them, not the pairs the specification shows.
        const itemCount = r.u30_();
        var j: u32 = 0;
        while (j < itemCount and !r.failed) : (j += 1) {
            try lists.metadataKey.append(lists.scratch, r.u30_());
        }

        j = 0;
        while (j < itemCount and !r.failed) : (j += 1) {
            try lists.metadataValue.append(lists.scratch, r.u30_());
        }

        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }
    }

    abc.metadataItemStart[count] = abc_.len(lists.metadataKey);
    return true;
}
