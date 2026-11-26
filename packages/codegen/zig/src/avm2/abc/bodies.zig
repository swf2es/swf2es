// method_body_info, checked like avmplus' parseMethodBodies
// (assembly/avm2/abc/bodies.ts). Stack, local and scope sizes, exception
// ranges and catch types are checked when the method is verified.
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const abc_ = @import("abc.zig");
const Abc = abc_.Abc;
const Lists = abc_.Lists;
const C = @import("constants.zig");
const Reader = @import("reader.zig").Reader;
const readTraits = @import("traits.zig").readTraits;

pub fn readMethodBodies(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader) Allocator.Error!bool {
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

        const exceptionStart = abc_.len(lists.exceptionFrom);
        const exceptionCount = r.u30_();
        for (0..exceptionCount) |_| {
            try lists.exceptionFrom.append(lists.scratch, r.u30_());
            try lists.exceptionTo.append(lists.scratch, r.u30_());
            try lists.exceptionTarget.append(lists.scratch, r.u30_());
            try lists.exceptionType.append(lists.scratch, r.u30_());
            const name = r.u30_();
            if (r.failed) {
                return abc.fail(C.kCorruptABCError);
            }

            if (name >= abc.pool.multinameCount()) {
                return abc.fail(C.kCpoolIndexRangeError);
            }

            try lists.exceptionName.append(lists.scratch, name);
        }

        const owner = abc.methodOwner[method];
        if (owner >= 0 and @as(u32, @intCast(owner)) < abc.classCount() and abc.instanceFlags[@intCast(owner)] & C.INSTANCE_Interface != 0) {
            return abc.fail(C.kIllegalInterfaceMethodBodyError);
        }

        if (abc.methodBody[method] != -1) {
            return abc.fail(C.kDuplicateMethodBodyError);
        }

        abc.methodBody[method] = @intCast(abc_.len(lists.bodyMethod));
        try lists.bodyMethod.append(lists.scratch, method);
        try lists.bodyMaxStack.append(lists.scratch, maxStack);
        try lists.bodyLocalCount.append(lists.scratch, localCount);
        try lists.bodyInitScopeDepth.append(lists.scratch, initScopeDepth);
        try lists.bodyMaxScopeDepth.append(lists.scratch, maxScopeDepth);
        try lists.bodyCodeStart.append(lists.scratch, codeStart);
        try lists.bodyCodeLength.append(lists.scratch, codeLength);
        try lists.bodyExceptionStart.append(lists.scratch, exceptionStart);
        try lists.bodyTraitStart.append(lists.scratch, abc_.len(lists.traitName));

        // Every body has a traits list, empty unless the method needs an activation.
        if (!try readTraits(abc, lists, r, abc.activationOwner(method), abc.classCount())) {
            return false;
        }
    }

    try lists.bodyExceptionStart.append(lists.scratch, abc_.len(lists.exceptionFrom));
    try lists.bodyTraitStart.append(lists.scratch, abc_.len(lists.traitName));
    return true;
}
