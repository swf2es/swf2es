// method_body_info, checked like avmplus' parseMethodBodies. Stack, local and scope sizes, exception
// ranges and catch types are checked when the method is verified.
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
const readTraits = @import("traits.zig").readTraits;

pub fn readMethodBodies(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader, diag: *Diagnostics) Error!void {
    abc.methodBody = try lists.zeroed(i32, gpa, abc.methodBody, abc.methodCount());
    @memset(abc.methodBody, -1);

    // avmplus does not bound the count, so the tables grow body by body.
    const count = r.u30_();
    for (0..count) |_| {
        const method = r.u30_();
        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }

        if (method >= abc.methodCount()) {
            return diag.fail(C.kMethodInfoExceedsCountError);
        }

        const maxStack = r.u30_();
        const localCount = r.u30_();
        const initScopeDepth = r.u30_();
        const maxScopeDepth = r.u30_();
        const codeLength = r.u30_();
        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }

        if (codeLength == 0) {
            return diag.fail(C.kInvalidCodeLengthError);
        }

        if (@as(u64, r.pos) + codeLength >= r.end) {
            return diag.fail(C.kCorruptABCError);
        }

        const codeStart: u32 = @intCast(r.pos);
        r.pos += codeLength;

        const exceptionStart = lists.len("exceptionFrom");
        const exceptionCount = r.u30_();
        for (0..exceptionCount) |_| {
            lists.push("exceptionFrom", r.u30_());
            lists.push("exceptionTo", r.u30_());
            lists.push("exceptionTarget", r.u30_());
            lists.push("exceptionType", r.u30_());
            const name = r.u30_();
            if (r.failed) {
                return diag.fail(C.kCorruptABCError);
            }

            if (name >= abc.pool.multinameCount()) {
                return diag.fail(C.kCpoolIndexRangeError);
            }

            lists.push("exceptionName", name);
        }

        const owner = abc.methodOwner[method];
        if (owner >= 0 and @as(u32, @intCast(owner)) < abc.classCount() and abc.instanceFlags[@intCast(owner)] & C.INSTANCE_Interface != 0) {
            return diag.fail(C.kIllegalInterfaceMethodBodyError);
        }

        if (abc.methodBody[method] != -1) {
            return diag.fail(C.kDuplicateMethodBodyError);
        }

        abc.methodBody[method] = @intCast(lists.len("bodyMethod"));
        lists.push("bodyMethod", method);
        lists.push("bodyMaxStack", maxStack);
        lists.push("bodyLocalCount", localCount);
        lists.push("bodyInitScopeDepth", initScopeDepth);
        lists.push("bodyMaxScopeDepth", maxScopeDepth);
        lists.push("bodyCode", .{ .start = codeStart, .len = codeLength });
        lists.push("bodyExceptionStart", exceptionStart);
        lists.push("bodyTraitStart", lists.len("traitName"));

        // Every body has a traits list, empty unless the method needs an activation.
        try readTraits(abc, lists, r, abc.activationOwner(method), abc.classCount(), diag);
    }

    lists.push("bodyExceptionStart", lists.len("exceptionFrom"));
    lists.push("bodyTraitStart", lists.len("traitName"));
}
