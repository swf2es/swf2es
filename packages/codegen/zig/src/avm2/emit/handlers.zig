// A method's exception handlers (assembly/avm2/emit/handlers.ts): the
// regions of its code each set of handlers covers, which `t` names as the
// code runs, and the dispatcher's catch, which finds the handler for the
// region that threw.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const MethodEmitter = @import("method.zig").MethodEmitter;
const refs = @import("refs.zig");

/// The bounds of the method's handler regions: every handler's from and to, sorted, once each.
pub fn regions(em: *MethodEmitter) Error!void {
    const ir = em.ir;
    const count = ir.handlerCount * 2;
    if (em.bounds.len < count) {
        em.bounds = try em.gpa.alloc(u32, count);
    }

    const bounds = em.bounds;
    var n: u32 = 0;
    for (0..count) |h| {
        const pc = if (h & 1 != 0) ir.handlerTo[h >> 1] else ir.handlerFrom[h >> 1];
        // Insert in order, skipping one already there.
        var at = n;
        while (at > 0 and bounds[at - 1] > pc) {
            at -= 1;
        }

        if (at > 0 and bounds[at - 1] == pc) {
            continue;
        }

        var k = n;
        while (k > at) : (k -= 1) {
            bounds[k] = bounds[k - 1];
        }

        bounds[at] = pc;
        n += 1;
    }

    em.boundCount = n;
    if (em.covered.len < n) {
        em.covered = try em.gpa.alloc(u8, n);
    }

    var r: u32 = 1;
    while (r < n) : (r += 1) {
        const start = bounds[r - 1];
        var covered: u8 = 0;
        for (0..ir.handlerCount) |h| {
            if (start >= ir.handlerFrom[h] and start < ir.handlerTo[h]) {
                covered = 1;
                break;
            }
        }

        em.covered[r - 1] = covered;
    }
}

/// The handler region of ABC offset `pc`: how many bounds are at or before it, or 0 if none covers it.
pub fn regionOf(em: *const MethodEmitter, pc: u32) i32 {
    var lo: u32 = 0;
    var hi = em.boundCount;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (em.bounds[mid] <= pc) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    return if (lo > 0 and lo < em.boundCount and em.covered[lo - 1] != 0) @intCast(lo) else 0;
}

/// The catch of the dispatcher: the handlers covering the region that
/// threw, in the order of the ABC's table, as avmplus finds them.
pub fn handlers(em: *MethodEmitter) Error!void {
    const out = &em.out;
    const ir = em.ir;
    const bounds = em.bounds;
    const exception: i32 = @intCast(ir.localCount + ir.maxScope);
    try out.text("const x = rt.caught(e);\nswitch (t) {\n");
    var r: u32 = 1;
    while (r < em.boundCount) : (r += 1) {
        if (em.covered[r - 1] == 0) {
            continue;
        }

        const start = bounds[r - 1];
        var first = true;
        for (0..ir.handlerCount) |h| {
            if (start < ir.handlerFrom[h] or start >= ir.handlerTo[h]) {
                continue;
            }

            if (first) {
                try out.text("case ");
                try out.uint(r);
                try out.text(":\n");
                first = false;
            }

            const ty = ir.handlerType[h];
            if (ty >= 0) {
                try out.text("if (rt.catches(x, ");
                try refs.typeRef(em, ty);
                try out.text(")) ");
            }

            try out.text("{ ");
            try em.regName(exception);
            try out.text(" = x; ");
            try em.goto(ir.handlerBlock[h]);
            try out.text(" }\n");
        }

        if (!first) {
            try out.text("break;\n");
        }
    }

    try out.text("}\nthrow e;\n");
}
