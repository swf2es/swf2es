// The rebuild (assembly/avm2/link/lifetime.ts, stage 6): a domain built
// again from its live ABCs and its log, into a new Domain, a part at a
// time; what lifetime.zig finds worth it, and what saved.zig loads.
const std = @import("std");
const options = @import("options");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const domain_ = @import("domain.zig");
const DomainState = domain_.DomainState;
const Domain = domain_.Domain;
const traits_ = @import("traits.zig");
const TraitsKind = traits_.TraitsKind;
const code = @import("../abc/code.zig");
const lifetime = @import("lifetime.zig");

/// What a rebuild's step did, for the test builds to time each kind of work
/// (testing/measure.zig): with `phase_steps` set, a step stops before work
/// of another kind than its first, so that each step is one kind.
pub const Phase = enum(u8) { none = 0, link = 1, verify = 2, replay = 3 };
pub var phase_steps = false;
pub const StepWork = struct {
    phase: Phase = .none,
    abcs: u32 = 0,
    bytes: u64 = 0,
    verify_cost: u64 = 0,
    replays: u32 = 0,
    kept: u32 = 0,
};
/// The last step's work.
pub var last_step: StepWork = .{};

/// Whether work of `phase` ends the step under way, which counts it if not.
fn stops(work: *StepWork, phase: Phase) bool {
    if (!options.checks) {
        return false;
    }

    if (work.phase == .none) {
        work.phase = phase;
        return false;
    }

    return phase_steps and work.phase != phase;
}

/// What keeping a log entry of a domain not live weighs, in bytes.
const KEPT_Weight: u64 = 36;

/// Take the place of an ABC of an application domain not live, with
/// nothing in it, so that the ABCs after it keep their indices.
fn vacate(dom: *Domain, domain: u32) Allocator.Error!void {
    const gpa = dom.gpa;
    try dom.abcs.push(gpa, &lifetime.no_abc);
    try dom.abcDomain.push(gpa, domain);
    try dom.abcBase.push(gpa, &no_bytes);
    try dom.abcBuffer.push(gpa, &no_bytes);
    try dom.abcVerified.push(gpa, 0);
    try dom.abcWeight.push(gpa, 0);
    dom.loads += 1;
    try dom.abcOwner.push(gpa, dom.loads);
    try dom.methodStart.push(gpa, dom.traits.methodTraits.len);
    try dom.abcString.push(gpa, &.{});
    try dom.abcNs.push(gpa, &.{});
    try dom.abcNsVersion.push(gpa, &.{});
    try dom.classStart.push(gpa, dom.classAbc.len);
    try dom.scriptTraits.push(gpa, &.{});
    try dom.bodyTraits.push(gpa, &.{});
}

pub const no_bytes = [_]u8{};

/// A new Domain's application domains, its root, taken out for another's.
pub fn truncateDomains(dom: *Domain) void {
    dom.domainParent.truncate(0);
    dom.domainDepth.truncate(0);
    dom.domainState.truncate(0);
    dom.domainEvicted.truncate(0);
}

/// The domain built again from its live ABCs and its log (lifetime.ts
/// tells how, and why a part at a time): step until it returns true, with
/// nothing else changing the domain or decoding in between, each step in a
/// Change of `fresh`. `failed` once done means an ABC did not link again
/// or an answer came out an error, which would be a bug; running out of
/// memory in a step leaves `fresh` to be let go of as well. `dom` is not
/// changed.
pub const Rebuild = struct {
    dom: *Domain,
    fresh: *Domain,
    arena: *memory.Arena,
    parsed_in_fresh: bool,
    entry: u32 = 0,
    next: u32 = 0,
    verifier: ?code.Verifier = null,
    verifier_arena: memory.Arena,
    done: bool = false,
    failed: bool = false,

    /// A rebuild of `dom` into `fresh`, a new Domain in an arena of its own.
    pub fn init(dom: *Domain, fresh: *Domain, arena: *memory.Arena, parsed_in_fresh: bool) Allocator.Error!Rebuild {
        const gpa = fresh.gpa;
        fresh.apiVersion = dom.apiVersion;
        fresh.generation = dom.generation +% 1;
        // AssemblyScript's shares these arrays with the old domain, whose
        // tree a rebuild under way never sees grow (leaveRebuild); the new
        // domain's own root goes for the old one's.
        truncateDomains(fresh);
        for (0..dom.domainParent.len) |d_| {
            const d: u32 = @intCast(d_);
            try fresh.domainParent.push(gpa, dom.domainParent.get(d));
            try fresh.domainDepth.push(gpa, dom.domainDepth.get(d));
            try fresh.domainState.push(gpa, dom.domainState.get(d));
            try fresh.domainEvicted.push(gpa, dom.domainEvicted.get(d));
        }

        return .{ .dom = dom, .fresh = fresh, .arena = arena, .parsed_in_fresh = parsed_in_fresh, .verifier_arena = .init(arena.source) };
    }

    /// Go on until this call has made about `budget` bytes of garbage, as
    /// AssemblyScript's counts it, and at least one step: whether done.
    pub fn step(self: *Rebuild, budget: u64) Allocator.Error!bool {
        var work: StepWork = .{};
        defer if (options.checks) {
            last_step = work;
        };
        const dom = self.dom;
        const fresh = self.fresh;
        if (self.done) {
            return true;
        }

        const count = dom.abcs.len;
        var spent: u64 = 0;
        while (self.entry <= dom.logKind.len) : (self.entry += 1) {
            const e = self.entry;
            const at = if (e < dom.logKind.len) dom.logAt.get(e) else count;
            while (self.next < at) : (self.next += 1) {
                if (spent >= budget or stops(&work, .link)) {
                    return false;
                }

                if (!try reattach(self, self.next)) {
                    return self.fail();
                }

                spent += dom.abcs.get(self.next).length;
                if (options.checks) {
                    work.abcs += 1;
                    work.bytes += dom.abcs.get(self.next).length;
                }
            }

            if (e == dom.logKind.len) {
                break;
            }

            if (self.verifier) |*verifier| {
                // A verification under way, from the step before.
                if (stops(&work, .verify)) {
                    return false;
                }

                const done = try verifier.run(@max((budget - @min(spent, budget)) / code.VERIFY_COST, 1));
                if (options.checks) {
                    work.verify_cost += verifier.spent * code.VERIFY_COST;
                }

                if (!done) {
                    return false;
                }

                spent += verifier.spent * code.VERIFY_COST;
                self.verifier = null;
                self.verifier_arena.reset();
                continue;
            }

            if (spent >= budget) {
                return false;
            }

            const kind = dom.logKind.get(e);
            const abc = dom.logAbc.get(e);
            const state = if (kind == .found)
                DomainState.furthest(dom.domainState.get(dom.foundDomain.get(dom.logA.get(e))), dom.domainState.get(dom.abcDomain.get(abc)))
            else
                dom.domainState.get(dom.abcDomain.get(abc));
            if (kind == .none or state == .dropped) {
                continue;
            }

            if (state == .evicted or dom.abcs.get(abc) == &lifetime.no_abc) {
                if (stops(&work, .replay)) {
                    return false;
                }

                try keepEntry(fresh, dom, e);
                if (options.checks) {
                    work.kept += 1;
                }

                continue;
            }

            if (kind == .verify) {
                if (stops(&work, .verify)) {
                    return false;
                }

                self.verifier = try code.Verifier.init(fresh, self.verifier_arena.allocator(), abc);
                const done = try self.verifier.?.run(@max((budget - spent) / code.VERIFY_COST, 1));
                if (options.checks) {
                    work.verify_cost += self.verifier.?.spent * code.VERIFY_COST;
                }

                if (!done) {
                    return false;
                }

                spent += self.verifier.?.spent * code.VERIFY_COST;
                self.verifier = null;
                self.verifier_arena.reset();
                continue;
            }

            if (stops(&work, .replay)) {
                return false;
            }

            if (!try replay(fresh, dom, e)) {
                return self.fail();
            }

            if (options.checks) {
                work.replays += 1;
            }
        }

        self.done = true;
        return true;
    }

    fn fail(self: *Rebuild) bool {
        self.failed = true;
        self.verifier = null;
        self.done = true;
        return true;
    }
};

/// Link ABC `index` of `dom` again as `fresh`'s next, parsed again from its
/// bytes into `fresh`'s arena, or keep its place if it is not live: false
/// if it does not link.
fn reattach(r: *Rebuild, index: u32) Allocator.Error!bool {
    const dom = r.dom;
    const fresh = r.fresh;
    const abc = dom.abcs.get(index);
    if (abc == &lifetime.no_abc or !dom.isLive(index)) {
        try vacate(fresh, dom.abcDomain.get(index));
        return true;
    }

    // A move parsed the ABC directly into the destination; an in-place rebuild still owns it in the source.
    const old = dom.abcBuffer.get(index);
    var again = abc;
    var buffer = old;
    if (!r.parsed_in_fresh) {
        again, buffer = try domain_.parseOwned(r.arena, fresh.scratch, old[0..abc.length], abc.builtin);
    }
    if (again.@"error" != .none or !try fresh.attach(again, buffer, dom.abcDomain.get(index))) {
        return false;
    }

    // Its weight counts what compiling it added too.
    fresh.abcWeight.set(index, @max(fresh.abcWeight.get(index), dom.abcWeight.get(index)));
    return true;
}

/// Do entry `e` of `from`'s log again, a finding or a lazy answer, its ABC linked: false if it comes out an error.
fn replay(dom: *Domain, from: *const Domain, e: u32) Allocator.Error!bool {
    const kind = from.logKind.get(e);
    const abc = from.logAbc.get(e);
    if (kind == .found) {
        const f = from.logA.get(e);
        try dom.addFound(from.foundDomain.get(f), from.foundKind.get(f), from.foundUri.get(f), from.foundName.get(f), from.foundAbc.get(f), from.foundAsType.get(f) != 0);
        return true;
    }

    // A loaded domain's numbers are a save's, which may be malformed: each
    // checked against its ABC, as domainReplay checks a host's, so that a
    // bad save fails the rebuild rather than reading past a table.
    const a = from.logA.get(e);
    const b = from.logB.get(e);
    const info = dom.abcs.get(abc);
    if (info == &lifetime.no_abc) {
        return false;
    }

    if (kind == .resolve) {
        const owned = TraitsKind.owned(a) orelse return false;
        const owners: u32 = switch (owned) {
            .script => info.scriptCount(),
            .activation => @intCast(dom.bodyTraits.get(abc).len),
            else => info.classCount(),
        };
        const t = if (b < owners) lifetime.traitsOf(dom, abc, owned, b) else .none;
        return t != .none and try dom.traits.resolves(dom, t.index());
    }

    return kind == .sign and b < info.methodCount() and try dom.traits.signs(dom, dom.methodStart.get(abc) + b);
}

/// Keep entry `e` of `from`'s log, not done, for when its domain is revived.
fn keepEntry(dom: *Domain, from: *const Domain, e: u32) Allocator.Error!void {
    const gpa = dom.gpa;
    var a = from.logA.get(e);
    if (from.logKind.get(e) == .found) {
        const f = a;
        a = dom.foundDomain.len;
        try dom.foundEntry.push(gpa, dom.logKind.len);
        try dom.foundDomain.push(gpa, from.foundDomain.get(f));
        try dom.foundKind.push(gpa, from.foundKind.get(f));
        try dom.foundUri.push(gpa, try gpa.dupe(u8, from.foundUri.get(f)));
        try dom.foundName.push(gpa, try gpa.dupe(u8, from.foundName.get(f)));
        try dom.foundAbc.push(gpa, from.foundAbc.get(f));
        try dom.foundAsType.push(gpa, from.foundAsType.get(f));
    }

    dom.keptWeight += KEPT_Weight;
    try dom.logKind.push(gpa, from.logKind.get(e));
    try dom.logAt.push(gpa, from.logAt.get(e));
    try dom.logAbc.push(gpa, from.logAbc.get(e));
    try dom.logA.push(gpa, a);
    try dom.logB.push(gpa, from.logB.get(e));
}
