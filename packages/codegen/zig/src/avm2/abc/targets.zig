// Where a body's control flow goes, as Verifier::checkTarget and mergeState
// follow it (assembly/avm2/abc/targets.ts): branch, fall-through and handler
// targets, each the frame state it is entered with, every path into it of
// the same depths and its values merged, and the targets whose entry state
// changed walked again.
//
// AssemblyScript's target and throwsAt call each other: a backward edge
// makes its target a loop header, whose handlers are reached from it, and
// a handler's target before the instruction is a backward edge again, as
// deep as the input's handlers make it. Here the two are one loop over a
// stack of frames in the call's arena, which does what the recursion did
// in its order, the saved values of the block being walked kept in the one
// buffer AssemblyScript's recursion shares too.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const code_ = @import("code.zig");
const BodyDecoder = code_.BodyDecoder;
const NOT_NULL = code_.NOT_NULL;
const START = code_.START;
const C = @import("constants.zig");
const ops = @import("opcodes.zig");

/// Save the current state as known target t's entry state.
pub fn saveEntry(bd: *BodyDecoder, t: u32) Error!void {
    const size = bd.frameSize;
    if (bd.entryUsed + size > bd.entryType.len) {
        const capacity = @max(bd.entryUsed + size, bd.entryType.len * 2);
        const types = try bd.gpa.alloc(i32, capacity);
        const flags = try bd.gpa.alloc(u8, capacity);
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
    header: struct { t: u32, stack: u32, scope: u32 },
};

/// As Verifier::checkTarget and mergeState: stay in the code, back edges need
/// a label or known target, and every path into a block has the same stack
/// and scope depths, whose values merge.
pub fn target(bd: *BodyDecoder, from: i64, to: i64, stack: u32, scope: u32) Error!bool {
    return switch (try head(bd, from, to, stack, scope)) {
        .failed => false,
        .done => true,
        .header => |h| run(bd, .{ .header = .{ .t = h.t, .stack = h.stack, .scope = h.scope } }),
    };
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
    if (to <= from and isNew and bd.byteAt(t) != ops.OP_label) {
        bd.code.fail(C.kInvalidBranchTargetError);
        return .failed;
    }

    if (isNew) {
        // Code decoded as part of another block must have been reached with the
        // same state. avmplus walks the code in order: the walk's state at t is
        // the one arriving, this edge's the target's it recorded.
        const walked = bd.cover[t] == START;
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
        return .{ .header = .{ .t = t, .stack = stack, .scope = scope } };
    }

    return .done;
}

/// Edges from `pc` to every handler covering it. A handler starts with the
/// locals as they are, no scopes, and just the exception on the stack.
pub fn throwsAt(bd: *BodyDecoder, pc: u32) Error!bool {
    return run(bd, .{ .throws = .{ .pc = pc } });
}

/// What a frame waits for: a loop header's handlers reached from its
/// entry state, after which the block's own state comes back; or the
/// handlers covering `pc`, one at a time from `next`, one target edge
/// out at a time, with what that edge changed to put back.
const Frame = union(enum) {
    header: struct {
        t: u32,
        stack: u32,
        scope: u32,
        stack_now: u32 = 0,
        scope_now: u32 = 0,
        started: bool = false,
    },
    throws: struct {
        pc: u32,
        next: u32 = 0,
        /// The handler whose edge a child frame is following, and what to put back.
        waiting: ?Waiting = null,
    },
};

const Waiting = struct {
    handler: u32,
    typed: bool,
    stack: u32 = 0,
    scope: u32 = 0,
    first_type: i32 = 0,
    first_flags: u8 = 0,
    first_origin: i32 = 0,
};

/// The frames from `first` until it returns, as the recursion would.
fn run(bd: *BodyDecoder, first: Frame) Error!bool {
    var frames: std.ArrayList(Frame) = .empty;
    try frames.append(bd.gpa, first);
    // What the frame just ended returned to the one under it.
    var returned: ?bool = null;
    while (frames.items.len > 0) {
        const frame = &frames.items[frames.items.len - 1];
        switch (frame.*) {
            .header => |*h| {
                if (!h.started) {
                    h.started = true;
                    if (bd.typed) {
                        // Its handlers are reached with the state it is entered with.
                        try saveCurrent(bd);
                        loadEntry(bd, h.t);
                        h.stack_now = bd.stack;
                        h.scope_now = bd.scope;
                        bd.stack = h.stack;
                        bd.scope = h.scope;
                    }

                    try frames.append(bd.gpa, .{ .throws = .{ .pc = h.t } });
                    continue;
                }

                const reached = returned.?;
                if (bd.typed) {
                    bd.stack = h.stack_now;
                    bd.scope = h.scope_now;
                    restoreCurrent(bd);
                }

                _ = frames.pop();
                returned = reached;
            },
            .throws => |*f| {
                if (f.waiting) |w| {
                    // The edge to handler w's target came back.
                    f.waiting = null;
                    const reached = returned.?;
                    if (w.typed) {
                        bd.stack = w.stack;
                        bd.scope = w.scope;
                        const base = bd.stackBase();
                        bd.setValue(base, w.first_type, w.first_flags);
                        bd.origin[base] = w.first_origin;
                        if (!reached) {
                            _ = frames.pop();
                            returned = false;
                            continue;
                        }

                        bd.handlerMerged[w.handler] = bd.localsVersion;
                    } else if (!reached) {
                        _ = frames.pop();
                        returned = false;
                        continue;
                    }
                }

                const result = try throwsStep(bd, f, &frames);
                if (result) |value| {
                    _ = frames.pop();
                    returned = value;
                }
            },
        }
    }

    return returned.?;
}

/// The handlers covering the frame's pc from `next` on, until one's edge
/// is a new loop header (a frame pushed for it: null) or they are done
/// (true) or one failed (false).
fn throwsStep(bd: *BodyDecoder, f: anytype, frames: *std.ArrayList(Frame)) Error!?bool {
    const pc = f.pc;
    if (bd.emitPass or pc < bd.tryFrom or pc >= bd.tryTo) {
        return true;
    }

    const abc = bd.abc;
    while (f.next < bd.handlerCount) {
        const i = f.next;
        f.next += 1;
        const h = bd.handlerFirst + i;
        if (pc < abc.exceptionFrom.get(h) or pc >= abc.exceptionTo.get(h)) {
            continue;
        }

        if (bd.maxStack < 1) {
            bd.code.fail(C.kStackOverflowError);
            return false;
        }

        const to = abc.exceptionTarget.get(h);
        if (!bd.typed) {
            switch (try head(bd, pc, to, 1, 0)) {
                .failed => return false,
                .done => continue,
                .header => |hd| {
                    f.waiting = .{ .handler = i, .typed = false };
                    try frames.append(bd.gpa, .{ .header = .{ .t = hd.t, .stack = hd.stack, .scope = hd.scope } });
                    return null;
                },
            }
        }

        // The same locals as when last merged into the handler change
        // nothing there, once a backward edge has made it a loop header.
        if (bd.handlerMerged[i] == bd.localsVersion and (to > pc or bd.loopHeader[to] != 0)) {
            continue;
        }

        const base = bd.stackBase();
        const waiting: Waiting = .{
            .handler = i,
            .typed = true,
            .stack = bd.stack,
            .scope = bd.scope,
            .first_type = bd.valueType[base],
            .first_flags = bd.valueFlags[base],
            .first_origin = bd.origin[base],
        };
        const ty = bd.handlerType.items[i];
        bd.setValue(base, ty, if (bd.domain.typeNotNull(ty)) NOT_NULL else 0);
        bd.stack = 1;
        bd.scope = 0;
        const edge = try head(bd, pc, to, 1, 0);
        if (edge == .header) {
            f.waiting = waiting;
            try frames.append(bd.gpa, .{ .header = .{ .t = edge.header.t, .stack = edge.header.stack, .scope = edge.header.scope } });
            return null;
        }

        bd.stack = waiting.stack;
        bd.scope = waiting.scope;
        bd.setValue(base, waiting.first_type, waiting.first_flags);
        bd.origin[base] = waiting.first_origin;
        if (edge == .failed) {
            return false;
        }

        bd.handlerMerged[i] = bd.localsVersion;
    }

    return true;
}

fn saveCurrent(bd: *BodyDecoder) Error!void {
    if (bd.savedType.len < bd.frameSize) {
        bd.savedType = try bd.gpa.alloc(i32, bd.frameSize);
        bd.savedFlags = try bd.gpa.alloc(u8, bd.frameSize);
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
