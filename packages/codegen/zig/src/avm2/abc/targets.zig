// Where a body's control flow goes, as Verifier::checkTarget and mergeState
// follow it: branch, fall-through and handler
// targets, each the frame state it is entered with, every path into it of
// the same depths and its values merged, and the targets whose entry state
// changed walked again.
//
// A backward edge makes its target a loop header, whose handlers are
// reached from it (throwsAt). A handler's target is past its range
// (checkHandlers rejects one before its end), so after the instruction
// that throws: never a backward edge, never a loop header. So the
// recursion is at most target, throwsAt, target, whatever the input.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const TypeId = @import("../link/traits.zig").TypeId;
const code_ = @import("code.zig");
const BodyDecoder = code_.BodyDecoder;
const Flags = code_.Flags;
const C = @import("constants.zig");

/// Save the current state as known target t's entry state.
pub fn saveEntry(bd: *BodyDecoder, t: u32) Error!void {
    const size = bd.frameSize;
    if (bd.entryUsed + size > bd.entryType.len) {
        const capacity = @max(bd.entryUsed + size, bd.entryType.len * 2);
        const types = try bd.gpa.alloc(TypeId, capacity);
        const flags = try bd.gpa.alloc(Flags, capacity);
        @memcpy(types[0..bd.entryUsed], bd.entryType[0..bd.entryUsed]);
        @memcpy(flags[0..bd.entryUsed], bd.entryFlags[0..bd.entryUsed]);
        bd.entryType = types;
        bd.entryFlags = flags;
    }

    const at = bd.entryUsed;
    bd.entryAt[t] = at;
    bd.entryUsed += size;
    @memcpy(bd.entryType[at..][0..size], bd.valueType[0..size]);
    @memcpy(bd.entryFlags[at..][0..size], bd.valueFlags[0..size]);
}

/// Make known target t's entry state the current one.
pub fn loadEntry(bd: *BodyDecoder, t: u32) void {
    if (!bd.typed) {
        return;
    }

    bd.localsVersion += 1;
    const at = bd.entryAt[t];
    const size = bd.frameSize;
    @memcpy(bd.valueType[0..size], bd.entryType[at..][0..size]);
    @memcpy(bd.valueFlags[0..size], bd.entryFlags[at..][0..size]);
}

/// Put known target t on the work list unless it is there already.
fn requeue(bd: *BodyDecoder, t: u32) void {
    if (bd.pending[t] == 0) {
        bd.pending[t] = 1;
        bd.work[bd.workCount] = t;
        bd.workCount += 1;
    }
}

/// What the head of target decided: failed, done, or a new loop header
/// whose handlers are to be reached from it.
const Head = union(enum) {
    failed,
    done,
    header: u32,
};

/// As Verifier::checkTarget and mergeState: stay in the code, back edges need
/// a label or known target, and every path into a block has the same stack
/// and scope depths, whose values merge.
pub fn target(bd: *BodyDecoder, from: i64, to: i64, stack: u32, scope: u32) Error!bool {
    const t = switch (try head(bd, from, to, stack, scope)) {
        .failed => return false,
        .done => return true,
        .header => |t| t,
    };

    if (!bd.typed) {
        return throwsAt(bd, t);
    }

    // Its handlers are reached with the state it is entered with.
    try saveCurrent(bd);
    loadEntry(bd, t);
    const stackNow = bd.stack;
    const scopeNow = bd.scope;
    bd.stack = stack;
    bd.scope = scope;
    const reached = try throwsAt(bd, t);
    bd.stack = stackNow;
    bd.scope = scopeNow;
    restoreCurrent(bd);
    return reached;
}

/// target up to where it reaches a new loop header's handlers.
fn head(bd: *BodyDecoder, from: i64, to: i64, stack: u32, scope: u32) Error!Head {
    // The second phase only visits what the first already checked.
    if (bd.emitPass) {
        return .done;
    }

    if (to < 0 or to >= bd.length) {
        bd.code.fail(C.kInvalidBranchTargetError);
        return .failed;
    }

    const t: u32 = @intCast(to);
    const isNew = bd.known[t] == 0;
    if (to <= from and isNew and bd.opAt(t) != .label) {
        bd.code.fail(C.kInvalidBranchTargetError);
        return .failed;
    }

    if (isNew) {
        // Code decoded as part of another block must have been reached with the
        // same state. avmplus walks the code in order: the walk's state at t is
        // the one arriving, this edge's the target's it recorded.
        const walked = bd.cover[t] == .start;
        if (walked and !sameDepths(bd, stack, scope, bd.stackAt[t], bd.scopeAt[t])) {
            return .failed;
        }

        bd.known[t] = 1;
        bd.entryStack[t] = stack;
        bd.entryScope[t] = scope;
        if (bd.typed) {
            try saveEntry(bd, t);
        }

        requeue(bd, t);

        // The block that walked through t must now end there and merge into it.
        if (walked and bd.typed and bd.walkOf[t] != t) {
            requeue(bd, bd.walkOf[t]);
        }
    } else {
        if (!sameDepths(bd, bd.entryStack[t], bd.entryScope[t], stack, scope)) {
            return .failed;
        }

        if (bd.typed) {
            const changed = bd.mergeEntry(t);
            if (changed < 0) {
                return .failed;
            }

            if (changed != 0) {
                requeue(bd, t);
            }
        }
    }

    // A loop header's implicit interrupt check can throw, so it reaches the
    // handlers covering it, even when the back edge is found after its block.
    if (to <= from and bd.loopHeader[t] == 0) {
        bd.loopHeader[t] = 1;
        return .{ .header = t };
    }

    return .done;
}

/// An edge to a handler's target: forward, so never a loop header.
fn handlerEdge(bd: *BodyDecoder, pc: u32, to: u32) Error!bool {
    return switch (try head(bd, pc, to, 1, 0)) {
        .failed => false,
        .done => true,
        .header => unreachable,
    };
}

/// Edges from `pc` to every handler covering it. A handler starts with the
/// locals as they are, no scopes, and just the exception on the stack.
pub fn throwsAt(bd: *BodyDecoder, pc: u32) Error!bool {
    if (bd.emitPass or pc < bd.tryFrom or pc >= bd.tryTo) {
        return true;
    }

    const abc = bd.abc;
    for (0..bd.handlerCount) |i_| {
        const i: u32 = @intCast(i_);
        const h = bd.handlerFirst + i;
        if (pc < abc.exceptionFrom[h] or pc >= abc.exceptionTo[h]) {
            continue;
        }

        if (bd.maxStack < 1) {
            bd.code.fail(C.kStackOverflowError);
            return false;
        }

        const to = abc.exceptionTarget[h];
        if (!bd.typed) {
            if (!try handlerEdge(bd, pc, to)) {
                return false;
            }

            continue;
        }

        // The same locals as when last merged into the handler change
        // nothing there, once a backward edge has made it a loop header.
        if (bd.handlerMerged[i] == bd.localsVersion and (to > pc or bd.loopHeader[to] != 0)) {
            continue;
        }

        const stack = bd.stack;
        const scope = bd.scope;
        const base = bd.stackBase();
        const firstType = bd.typeOf(base);
        const firstFlags = bd.valueFlags[base];
        const firstOrigin = bd.origin[base];
        const ty = bd.handlerType[i];
        bd.setValue(base, ty, .{ .not_null = bd.domain.typeNotNull(ty) });
        bd.stack = 1;
        bd.scope = 0;
        const reached = try handlerEdge(bd, pc, to);
        bd.stack = stack;
        bd.scope = scope;
        bd.setValue(base, firstType, firstFlags);
        bd.origin[base] = firstOrigin;
        if (!reached) {
            return false;
        }

        bd.handlerMerged[i] = bd.localsVersion;
    }

    return true;
}

fn saveCurrent(bd: *BodyDecoder) Error!void {
    if (bd.savedType.len < bd.frameSize) {
        bd.savedType = try bd.gpa.alloc(TypeId, bd.frameSize);
        bd.savedFlags = try bd.gpa.alloc(Flags, bd.frameSize);
    }

    @memcpy(bd.savedType[0..bd.frameSize], bd.valueType[0..bd.frameSize]);
    @memcpy(bd.savedFlags[0..bd.frameSize], bd.valueFlags[0..bd.frameSize]);
}

fn restoreCurrent(bd: *BodyDecoder) void {
    bd.localsVersion += 1;
    @memcpy(bd.valueType[0..bd.frameSize], bd.savedType[0..bd.frameSize]);
    @memcpy(bd.valueFlags[0..bd.frameSize], bd.savedFlags[0..bd.frameSize]);
}

/// Whether the depths arriving match the target's; avmplus' messages name the arriving first.
fn sameDepths(bd: *BodyDecoder, targetStack: u32, targetScope: u32, stack: u32, scope: u32) bool {
    if (stack != targetStack) {
        bd.code.failWith(C.kStackDepthUnbalancedError, stack, targetStack);
        return false;
    }

    if (scope != targetScope) {
        bd.code.failWith(C.kScopeDepthUnbalancedError, scope, targetScope);
        return false;
    }

    return true;
}
