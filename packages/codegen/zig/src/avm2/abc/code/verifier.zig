// Verifying an ABC's methods (assembly/avm2/abc/code.ts's verifyMethods):
// each one its scripts can run, all at once or a part at a time, with
// BodyDecoder (code.zig), and the scopes functions are created in settled.
const std = @import("std");
const Allocator = std.mem.Allocator;
const domain_ = @import("../../link/domain.zig");
const Domain = domain_.Domain;
const traits_ = @import("../../link/traits.zig");
const Scope = traits_.Scope;
const TypeId = traits_.TypeId;
const code = @import("../code.zig");
const bodyDecoder = code.bodyDecoder;

/// Verify, with types, every method of ABC `index` that its scripts can
/// run: each script's initializer and methods, then each class's and
/// function's methods once creating them captured their scope chain, as
/// avmplus verifies each before it first runs. The result is each body's VerifyError, 0
/// if it verified, or -1 if nothing could run it.
pub fn verifyMethods(domain: *Domain, index: u32) Allocator.Error![]i32 {
    var verifier = try Verifier.init(domain, domain.scratch, index);
    _ = try verifier.run(std.math.maxInt(u64));
    return verifier.results;
}

/// verifyMethods a part at a time, so that the host gets control back
/// between parts of a large ABC: run until it returns true, with nothing
/// else decoding in between. The parts verify what verifyMethods does, in
/// its order, however they are cut. init counts the ABC as verified and
/// logs .verify at once, as verifyMethods does, so one left before it
/// is done leaves both, and what it resolved, in the domain
/// (compile/modules.zig's abandon).
pub const Verifier = struct {
    domain: *Domain,
    /// Where its results and queue are, which a module written a part at a
    /// time keeps from one call to the next, past the call's arena.
    gpa: Allocator,
    index: u32,
    /// Each body's VerifyError, 0 if it verified, -1 if nothing runs it; complete once run returns true.
    results: []i32 = &.{},
    first: bool,
    entry: u32,
    captures: u32,
    queue: std.ArrayList(u32) = .empty,
    at: usize = 0,
    pass: i32 = 0,
    done: bool = false,
    /// The bytes of code the last run verified, as its budget counts them.
    spent: u64 = 0,

    pub fn init(domain: *Domain, gpa: Allocator, index: u32) Allocator.Error!Verifier {
        // Logged before what it resolves, as what it captures is a function's
        // scope before its signature; kept if it is the ABC's first, or finds
        // a scope the first did not.
        var self: Verifier = .{
            .domain = domain,
            .gpa = gpa,
            .index = index,
            .first = domain.abcVerified.get(index) == 0,
            .entry = domain.logKind.len,
            .captures = domain.captures,
        };
        try domain.put(domain.abcVerified.at(index), 1);
        try domain.logged(.verify, index, 0, 0);
        try self.start();
        return self;
    }

    /// Verify until done, or until the bodies verified by this call hold
    /// `budget` bytes of code, counting at least BODY_COST a body: whether done.
    pub fn run(self: *Verifier, budget: u64) Allocator.Error!bool {
        if (self.done) {
            return true;
        }

        const domain = self.domain;
        const index = self.index;
        const abc = domain.abcs.get(index);
        const traits = &domain.traits;
        const methods = domain.methodStart.get(index);
        const decoder = try bodyDecoder(domain, index);
        self.spent = 0;
        while (true) {
            while (self.at < self.queue.items.len) {
                if (self.spent >= budget) {
                    return false;
                }

                const m = self.queue.items[self.at];
                self.at += 1;
                const body = abc.methodBody[m - methods];
                const scope = traits.scopeOf(m);
                if (body < 0 or scope == null or self.results[@intCast(body)] != -1) {
                    continue;
                }

                const b: u32 = @intCast(body);
                self.results[b] = (try decoder.decode(b, scope)).@"error".number();
                self.spent += @max(@as(u64, abc.bodyCode[b].len), BODY_COST);
                try self.queue.appendSlice(self.gpa, decoder.captured.items);
            }

            if (self.pass >= SETTLE_PASSES or !try settleContests(domain, index)) {
                break;
            }

            self.pass += 1;
            try self.start();
        }

        if (!self.first and domain.captures == self.captures) {
            const entry = self.entry;
            if (domain.logKind.len == entry + 1) {
                // The entry this verifier added, maybe in an earlier call,
                // when it runs a part at a time: kept for a rollback, which
                // puts the log's length back but not a row written over.
                domain.keepTruncated(entry);
                domain.logKind.truncate(entry);
                domain.logAt.truncate(entry);
                domain.logAbc.truncate(entry);
                domain.logA.truncate(entry);
                domain.logB.truncate(entry);
            } else {
                try domain.put(domain.logKind.at(entry), .none);
            }
        }

        self.done = true;
        return true;
    }

    /// A pass over the ABC from its scripts, as each settling of its contested functions starts again.
    fn start(self: *Verifier) Allocator.Error!void {
        const domain = self.domain;
        const index = self.index;
        const abc = domain.abcs.get(index);
        const results = try self.gpa.alloc(i32, abc.bodyCount());
        @memset(results, -1);
        var queue: std.ArrayList(u32) = .empty;
        const scripts = domain.scriptTraits.get(index);
        for (0..abc.scriptCount()) |s| {
            try domain.methodsOf(self.gpa, scripts[s], &queue);
        }

        self.results = results;
        self.queue = queue;
        self.at = 0;
    }
};

/// What verifying a byte of a body's code weighs against the budget of a
/// module written a part at a time: about the garbage, in bytes, it once
/// made, measured on large ABCs. Kept, so that the parts fall where they
/// always did.
pub const VERIFY_COST: u64 = 5;

/// What a body counts for in Verifier.run's budget at least.
const BODY_COST: u64 = 64;

/// Verifications of an ABC again as its contested functions' merged scope chains settle, at most.
const SETTLE_PASSES = 8;

/// After verifying ABC `index`: each contested function's scope chain merged
/// from those it was created in (Scope.merged). Where one changed, the ABC's
/// functions' chains are let go of, for verifying it again: true.
fn settleContests(domain: *Domain, index: u32) Allocator.Error!bool {
    const traits = &domain.traits;
    const start = domain.methodStart.get(index);
    const end = start + domain.abcs.get(index).methodCount();
    var changed = false;
    var g = start;
    while (g < end) : (g += 1) {
        const scopes = traits.functionScopes.get(g);
        if (traits.functionContested.get(g) == 0 or scopes == null) {
            continue;
        }

        // Made in the call's arena, and kept in the domain's only where it changed.
        const merged = try Scope.merged(domain.scratch, scopes.?.items);
        const before = traits.functionMerged.get(g);
        if (before == null or !before.?.equals(merged)) {
            const keep = try domain.gpa.create(Scope);
            keep.* = merged.*;
            keep.types = try domain.gpa.dupe(TypeId, merged.types);
            keep.withs = try domain.gpa.dupe(u8, merged.withs);
            try domain.put(traits.functionMerged.at(g), keep);
            changed = true;
        }
    }

    if (!changed) {
        return false;
    }

    g = start;
    while (g < end) : (g += 1) {
        if (traits.methodFunction.get(g) != 0) {
            try domain.put(traits.functionScope.at(g), null);
            try domain.put(traits.functionScopes.at(g), null);
        }
    }

    return true;
}
