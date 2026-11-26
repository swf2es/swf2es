// method_body_info, checked like avmplus' parseMethodBodies
// (assembly/avm2/abc/bodies.ts). Stack, local and scope sizes, exception
// ranges and catch types are checked when the method is verified.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const Abc = @import("abc.zig").Abc;
const C = @import("constants.zig");
const Reader = @import("reader.zig").Reader;
const readTraits = @import("traits.zig").readTraits;

pub fn readMethodBodies(gpa: Allocator, abc: *Abc, r: *Reader) Allocator.Error!bool {
    abc.methodBody = try gpa.alloc(i32, abc.methodCount());
    @memset(abc.methodBody, -1);

    // avmplus does not bound the count, so the tables grow body by body.
    const count = r.u30_();
    for (0..count) |_| {
        const method = r.u30_();
        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }

        if (method >= abc.methodCount()) {
            return abc.fail(C.kMethodInfoExceedsCountError);
        }

        const maxStack = r.u30_();
        const localCount = r.u30_();
        const initScopeDepth = r.u30_();
        const maxScopeDepth = r.u30_();
        const codeLength = r.u30_();
        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }

        if (codeLength == 0) {
            return abc.fail(C.kInvalidCodeLengthError);
        }

        if (@as(u64, r.pos) + codeLength >= r.end) {
            return abc.fail(C.kCorruptABCError);
        }

        const codeStart: u32 = @intCast(r.pos);
        r.pos += codeLength;

        const exceptionStart = abc.exceptionFrom.len;
        const exceptionCount = r.u30_();
        for (0..exceptionCount) |_| {
            _ = try abc.exceptionFrom.append(gpa, r.u30_());
            _ = try abc.exceptionTo.append(gpa, r.u30_());
            _ = try abc.exceptionTarget.append(gpa, r.u30_());
            _ = try abc.exceptionType.append(gpa, r.u30_());
            const name = r.u30_();
            if (r.failed) {
                return abc.fail(C.kCorruptABCError);
            }

            if (name >= abc.pool.multinameCount()) {
                return abc.fail(C.kCpoolIndexRangeError);
            }

            _ = try abc.exceptionName.append(gpa, name);
        }

        const owner = abc.methodOwner[method];
        if (owner >= 0 and @as(u32, @intCast(owner)) < abc.classCount() and abc.instanceFlags[@intCast(owner)] & C.INSTANCE_Interface != 0) {
            return abc.fail(C.kIllegalInterfaceMethodBodyError);
        }

        if (abc.methodBody[method] != -1) {
            return abc.fail(C.kDuplicateMethodBodyError);
        }

        abc.methodBody[method] = @intCast(abc.bodyMethod.len);
        _ = try abc.bodyMethod.append(gpa, method);
        _ = try abc.bodyMaxStack.append(gpa, maxStack);
        _ = try abc.bodyLocalCount.append(gpa, localCount);
        _ = try abc.bodyInitScopeDepth.append(gpa, initScopeDepth);
        _ = try abc.bodyMaxScopeDepth.append(gpa, maxScopeDepth);
        _ = try abc.bodyCodeStart.append(gpa, codeStart);
        _ = try abc.bodyCodeLength.append(gpa, codeLength);
        _ = try abc.bodyExceptionStart.append(gpa, exceptionStart);
        _ = try abc.bodyTraitStart.append(gpa, abc.traitName.len);

        // Every body has a traits list, empty unless the method needs an activation.
        if (!try readTraits(gpa, abc, r, abc.activationOwner(method), abc.classCount())) {
            return false;
        }
    }

    _ = try abc.bodyExceptionStart.append(gpa, abc.exceptionFrom.len);
    _ = try abc.bodyTraitStart.append(gpa, abc.traitName.len);
    return true;
}
