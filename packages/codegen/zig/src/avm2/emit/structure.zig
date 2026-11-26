// Structured control flow for a method's blocks (assembly/avm2/emit/
// structure.ts; method.ts tells the translation): the graph's analysis,
// dominators and loops, and the code written along the dominator tree.
// The translation recurses along that tree as AssemblyScript's does; its
// depth is bounded, by MAX_NESTING, which analyze holds every block to.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const ops = @import("../abc/opcodes.zig");
const ir_ = @import("../ir/ir.zig");
const blocks = @import("blocks.zig");
const method_ = @import("method.zig");
const MethodEmitter = method_.MethodEmitter;
const refs = @import("refs.zig");
const IrOp = @import("../ir/ir.zig").Op;

/// The index after block k's last instruction.
fn blockEnd(em: *const MethodEmitter, k: u32) u32 {
    const ir = em.ir;
    return if (k + 1 < ir.blockCount) ir.blockFirst[k + 1] else ir.count;
}

/// Whether block k ends in a branch, return or throw, not falling through.
pub fn terminates(em: *const MethodEmitter, k: u32) bool {
    const ir = em.ir;
    const end = blockEnd(em, k);
    if (end == ir.blockFirst[k]) {
        return false;
    }

    const op = ir.op[end - 1];
    return op == .jump or op == .lookupswitch or op == .returnvoid or op == .returnvalue or op == .throw;
}

/// Whether op branches on a condition.
pub fn conditional(op: IrOp) bool {
    return ir_.opcodeIs(op, ops.Op.isConditional);
}

/// Block k's successors: the handlers covering any of it, the table's last
/// first; then every conditional branch in it, then what its last
/// instruction does, or its fall-through.
fn successors(em: *MethodEmitter, k: u32) Error!void {
    const ir = em.ir;
    const gpa = em.gpa;
    const first = ir.blockFirst[k];
    const end = blockEnd(em, k);
    const next = k + 1 < ir.blockCount;
    if (end > first) {
        const from = ir.pc[first];
        const to = ir.pc[end - 1];
        var h: i32 = @as(i32, @intCast(ir.handlerCount)) - 1;
        while (h >= 0) : (h -= 1) {
            const hu: u32 = @intCast(h);
            if (ir.handlerFrom[hu] <= to and ir.handlerTo[hu] > from) {
                try em.succ.append(gpa, ir.handlerBlock[hu]);
            }
        }
    }

    em.normalStart[k] = @intCast(em.succ.items.len);
    var i = first;
    while (i < end) : (i += 1) {
        if (conditional(ir.op[i])) {
            try em.succ.append(gpa, ir.a[i]);
        }
    }

    if (end == first) {
        if (next) {
            try em.succ.append(gpa, k + 1);
        }

        return;
    }

    const last = end - 1;
    switch (ir.op[last]) {
        .jump => try em.succ.append(gpa, ir.a[last]),
        .lookupswitch => {
            try em.succ.append(gpa, ir.a[last]);
            var c: u32 = 0;
            while (c <= @as(u32, @bitCast(ir.c[last]))) : (c += 1) {
                try em.succ.append(gpa, ir.cases[ir.b[last] + c]);
            }
        },
        // No successor.
        .returnvoid, .returnvalue, .throw => {},
        else => if (next) {
            try em.succ.append(gpa, k + 1);
        },
    }
}

/// The analysis the translation needs (structure.ts tells each part).
/// False if the graph is irreducible, or nests deeper than MAX_NESTING.
pub fn analyze(em: *MethodEmitter) Error!bool {
    const ir = em.ir;
    const gpa = em.gpa;
    const n = ir.blockCount;
    if (em.rpo.len < n) {
        const size = @max(n, 64);
        em.succStart = try gpa.alloc(u32, size + 1);
        em.predStart = try gpa.alloc(u32, size + 1);
        em.childStart = try gpa.alloc(u32, size + 1);
        em.rpo = try gpa.alloc(i32, size);
        em.order = try gpa.alloc(u32, size);
        em.idom = try gpa.alloc(i32, size);
        em.forwardIn = try gpa.alloc(u32, size);
        em.loopHeader = try gpa.alloc(u8, size);
        em.fill = try gpa.alloc(u32, size);
        em.handlerOf = try gpa.alloc(i32, size);
        em.normalStart = try gpa.alloc(u32, size);
    }

    em.succ.clearRetainingCapacity();
    for (0..n) |k_| {
        const k: u32 = @intCast(k_);
        em.succStart[k] = @intCast(em.succ.items.len);
        try successors(em, k);
        em.rpo[k] = -1;
        em.idom[k] = -1;
        em.forwardIn[k] = 0;
        em.loopHeader[k] = 0;
        em.handlerOf[k] = -1;
    }

    // Each handler's own block, one block to a handler.
    for (0..ir.handlerCount) |h| {
        const b = ir.handlerBlock[h];
        if (em.handlerOf[b] >= 0) {
            return false;
        }

        em.handlerOf[b] = @intCast(h);
    }

    em.succStart[n] = @intCast(em.succ.items.len);

    // A depth-first walk from the entry: postorder, reversed. -2 marks a block on the way.
    const stack = &em.dfsStack;
    const edge = &em.dfsEdge;
    stack.clearRetainingCapacity();
    edge.clearRetainingCapacity();
    try stack.append(gpa, 0);
    try edge.append(gpa, 0);
    em.rpo[0] = -2;
    var post = n;
    while (stack.items.len > 0) {
        const top = stack.items.len - 1;
        const k = stack.items[top];
        const e = edge.items[top];
        if (em.succStart[k] + e < em.succStart[k + 1]) {
            edge.items[top] = e + 1;
            const s = em.succ.items[em.succStart[k] + e];
            if (em.rpo[s] == -1) {
                em.rpo[s] = -2;
                try stack.append(gpa, s);
                try edge.append(gpa, 0);
            }
        } else {
            _ = stack.pop();
            _ = edge.pop();
            post -= 1;
            em.rpo[k] = @intCast(post);
        }
    }

    // Reachable blocks, numbered from 0 in reverse postorder.
    const reachable = n - post;
    em.reachable = reachable;
    for (0..n) |k| {
        if (em.rpo[k] >= 0) {
            em.rpo[k] -= @intCast(post);
            em.order[@intCast(em.rpo[k])] = @intCast(k);
        }
    }

    // Predecessors, by counting then filling.
    @memset(em.predStart[0 .. n + 1], 0);
    for (em.succ.items) |s| {
        em.predStart[s + 1] += 1;
    }

    for (0..n) |k| {
        em.predStart[k + 1] += em.predStart[k];
        em.fill[k] = em.predStart[k];
    }

    try em.pred.resize(gpa, em.succ.items.len);
    for (0..n) |p| {
        var e = em.succStart[p];
        while (e < em.succStart[p + 1]) : (e += 1) {
            const s = em.succ.items[e];
            em.pred.items[em.fill[s]] = @intCast(p);
            em.fill[s] += 1;
        }
    }

    // Dominators, iterated to a fixed point in reverse postorder.
    em.idom[0] = 0;
    var changed = true;
    while (changed) {
        changed = false;
        var r: u32 = 1;
        while (r < reachable) : (r += 1) {
            const b = em.order[r];
            var dom: i32 = -1;
            var e = em.predStart[b];
            while (e < em.predStart[b + 1]) : (e += 1) {
                const p = em.pred.items[e];
                if (em.rpo[p] >= 0 and em.idom[p] >= 0) {
                    dom = if (dom < 0) @intCast(p) else @intCast(intersect(em, @intCast(dom), p));
                }
            }

            if (dom != em.idom[b]) {
                em.idom[b] = dom;
                changed = true;
            }
        }
    }

    // Edges: forward ones counted, retreating ones back edges to a
    // dominator, or irreducible. A handler's are forward, and its only ones.
    for (0..reachable) |r| {
        const p = em.order[r];
        var e = em.succStart[p];
        while (e < em.succStart[p + 1]) : (e += 1) {
            const s = em.succ.items[e];
            if (e < em.normalStart[p]) {
                if (em.rpo[s] <= em.rpo[p]) {
                    return false;
                }

                continue;
            }

            if (em.handlerOf[s] >= 0) {
                return false;
            }

            if (em.rpo[s] > em.rpo[p]) {
                em.forwardIn[s] += 1;
            } else if (dominates(em, s, p)) {
                em.loopHeader[s] = 1;
            } else {
                return false;
            }
        }
    }

    // The dominator tree's children, each block's in reverse postorder.
    @memset(em.childStart[0 .. n + 1], 0);
    var r: u32 = 1;
    while (r < reachable) : (r += 1) {
        em.childStart[@as(u32, @intCast(em.idom[em.order[r]])) + 1] += 1;
    }

    for (0..n) |k| {
        em.childStart[k + 1] += em.childStart[k];
        em.fill[k] = em.childStart[k];
    }

    try em.child.resize(gpa, if (reachable > 0) reachable - 1 else 0);
    r = 1;
    while (r < reachable) : (r += 1) {
        const y = em.order[r];
        const d: u32 = @intCast(em.idom[y]);
        em.child.items[em.fill[d]] = y;
        em.fill[d] += 1;
    }

    // The translation recurses, and its code nests, along the dominator
    // tree (structure.ts tells how deep): deeper keeps the dispatcher.
    em.fill[0] = em.loopHeader[0];
    r = 1;
    while (r < reachable) : (r += 1) {
        const b = em.order[r];
        const d: u32 = @intCast(em.idom[b]);
        var merges: u32 = 0;
        var c = em.childStart[d];
        while (c < em.childStart[d + 1]) : (c += 1) {
            const y = em.child.items[c];
            merges += if (em.handlerOf[y] >= 0) 2 else if (em.forwardIn[y] >= 2) 1 else 0;
        }

        const nesting = em.fill[d] + merges + em.loopHeader[b] + 1;
        if (nesting > method_.MAX_NESTING) {
            return false;
        }

        em.fill[b] = nesting;
    }

    return true;
}

fn intersect(em: *const MethodEmitter, a: u32, b: u32) u32 {
    var x = a;
    var y = b;
    while (x != y) {
        while (em.rpo[x] > em.rpo[y]) {
            x = @intCast(em.idom[x]);
        }

        while (em.rpo[y] > em.rpo[x]) {
            y = @intCast(em.idom[y]);
        }
    }

    return x;
}

/// Whether block a dominates block b.
fn dominates(em: *const MethodEmitter, a: u32, b: u32) bool {
    var x = b;
    while (x != a) {
        if (x == 0) {
            return false;
        }

        x = @intCast(em.idom[x]);
    }

    return true;
}

/// Block x and what it dominates: in a loop if it heads one.
pub fn node(em: *MethodEmitter, x: u32) Error!void {
    const out = &em.out;
    // Its children in the dominator tree that are merge nodes or handlers, the latest first.
    var merges: std.ArrayList(u32) = .empty;
    var c = em.childStart[x + 1];
    while (c > em.childStart[x]) : (c -= 1) {
        const y = em.child.items[c - 1];
        if (em.forwardIn[y] >= 2 or em.handlerOf[y] >= 0) {
            try merges.append(em.gpa, y);
        }
    }

    if (em.loopHeader[x] != 0) {
        try out.text("L");
        try out.uint(x);
        try out.text(": for (;;) {\n");
        try within(em, x, merges.items, 0);
        try out.text("}\n");
    } else {
        try within(em, x, merges.items, 0);
    }
}

/// Block x's code inside a labelled block for each merge node from j, each followed by its code.
fn within(em: *MethodEmitter, x: u32, merges: []const u32, j: usize) Error!void {
    const out = &em.out;
    if (j == merges.len) {
        return structuredBlock(em, x);
    }

    const y = merges[j];
    try out.text("L");
    try out.uint(y);
    try out.text(": {\n");
    const h = em.handlerOf[y];
    if (h >= 0) {
        try out.text("try {\n");
        try em.tryStack.append(em.gpa, @intCast(h));
        try within(em, x, merges, j + 1);
        _ = em.tryStack.pop();
        try out.text("} catch (e) {\n");
        try catchClause(em, @intCast(h), y);
        try out.text("}\n");
    } else {
        try within(em, x, merges, j + 1);
    }

    try out.text("}\n");
    try node(em, y);
}

/// Handler h's catch, around the code before its block y: the exception
/// if it came from one of h's regions and has its type, else on.
fn catchClause(em: *MethodEmitter, h: u32, y: u32) Error!void {
    const out = &em.out;
    const ir = em.ir;
    var low: u32 = 0;
    var high: u32 = 0;
    var r: u32 = 1;
    while (r < em.boundCount) : (r += 1) {
        const start = em.bounds[r - 1];
        if (em.covered[r - 1] != 0 and start >= ir.handlerFrom[h] and start < ir.handlerTo[h]) {
            low = if (low != 0) low else r;
            high = r;
        }
    }

    try out.text("const x = rt.caught(e);\nif (");
    if (low == high) {
        try out.text("t === ");
        try out.uint(low);
    } else {
        try out.text("t >= ");
        try out.uint(low);
        try out.text(" && t <= ");
        try out.uint(high);
    }

    const ty = ir.handlerType[h];
    if (ty.isTraits()) {
        try out.text(" && rt.catches(x, ");
        try refs.typeRef(em, ty);
        try out.text(")");
    }

    try out.text(") { ");
    try em.regName(@intCast(ir.localCount + ir.maxScope));
    try out.text(" = x; break L");
    try out.uint(y);
    try out.text("; }\nthrow e;\n");
}

/// Whether the handlers covering region r have their trys open, innermost first in the table's order.
pub fn enclosed(em: *const MethodEmitter, r: i32) bool {
    if (r == 0) {
        return true;
    }

    const ir = em.ir;
    const start = em.bounds[@intCast(r - 1)];
    var below: i32 = @intCast(em.tryStack.items.len);
    for (0..ir.handlerCount) |h| {
        if (start < ir.handlerFrom[h] or start >= ir.handlerTo[h]) {
            continue;
        }

        var at = below - 1;
        while (at >= 0 and em.tryStack.items[@intCast(at)] != h) {
            at -= 1;
        }

        if (at < 0) {
            return false;
        }

        below = at;
    }

    return true;
}

fn lastByte(em: *const MethodEmitter) u8 {
    const written = em.out.written();
    return if (written.len == 0) 0 else written[written.len - 1];
}

/// Block k's instructions, and its fall-through as an explicit branch.
fn structuredBlock(em: *MethodEmitter, k: u32) Error!void {
    em.currentBlock = k;
    try blocks.blockBody(em, k);
    if (!terminates(em, k) and k + 1 < em.ir.blockCount) {
        em.currentBlock = k;
        try branchTo(em, k + 1);
        if (lastByte(em) != '\n') {
            try em.out.text("\n");
        }
    }
}

/// A branch from the current block to block t.
pub fn branchTo(em: *MethodEmitter, t: u32) Error!void {
    const out = &em.out;
    const from = em.currentBlock;
    if (em.loopHeader[t] != 0 and em.rpo[t] <= em.rpo[from]) {
        try out.text("continue L");
        try out.uint(t);
        try out.text(";");
    } else if (em.forwardIn[t] >= 2) {
        try out.text("break L");
        try out.uint(t);
        try out.text(";");
    } else {
        // Its only way in: its code here, on a line of its own.
        if (lastByte(em) == ' ') {
            out.shrink(out.len() - 1);
        }

        if (lastByte(em) != '\n') {
            try out.text("\n");
        }

        try save(em);
        // A loop's header is also entered from its end, with other checks.
        em.inPlace = em.loopHeader[t] == 0;
        try node(em, t);
        restore(em);
        try em.mark();
        em.currentBlock = from;
    }
}

/// Push what writing a block follows: its registers' types and copies, scopes and region.
fn save(em: *MethodEmitter) Error!void {
    const ir = em.ir;
    const gpa = em.gpa;
    const saved = &em.saved;
    // The stack holds words: the types as theirs.
    for (em.regType[0..ir.frameSize]) |t| {
        try saved.append(gpa, @backingInt(t));
    }

    for (em.scopeWith[0..ir.maxScope]) |w| {
        try saved.append(gpa, w);
    }

    for (0..ir.frameSize) |r| {
        try saved.append(gpa, em.checked[r]);
        try saved.append(gpa, em.promoted[r]);
    }

    try saved.appendSlice(gpa, em.copyOf[ir.localCount..ir.frameSize]);
    try saved.append(gpa, @intCast(em.scopeDepth));
    try saved.append(gpa, em.region);
    try saved.append(gpa, em.file);
    try saved.append(gpa, @bitCast(em.line));
}

/// Pop what save pushed.
fn restore(em: *MethodEmitter) void {
    const ir = em.ir;
    const saved = &em.saved;
    em.line = @bitCast(saved.pop().?);
    em.file = saved.pop().?;
    em.region = saved.pop().?;
    em.scopeDepth = @intCast(saved.pop().?);
    var r: i32 = @as(i32, @intCast(ir.frameSize)) - 1;
    while (r >= @as(i32, @intCast(ir.localCount))) : (r -= 1) {
        em.copyOf[@intCast(r)] = saved.pop().?;
    }

    em.recount();

    r = @as(i32, @intCast(ir.frameSize)) - 1;
    while (r >= 0) : (r -= 1) {
        em.promoted[@intCast(r)] = @intCast(saved.pop().?);
        em.checked[@intCast(r)] = @intCast(saved.pop().?);
    }

    var d: i32 = @as(i32, @intCast(ir.maxScope)) - 1;
    while (d >= 0) : (d -= 1) {
        em.scopeWith[@intCast(d)] = @intCast(saved.pop().?);
    }

    r = @as(i32, @intCast(ir.frameSize)) - 1;
    while (r >= 0) : (r -= 1) {
        em.regType[@intCast(r)] = @fromBackingInt(saved.pop().?);
    }
}
