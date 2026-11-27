// A ModuleEmitter's (module.zig) traits: each layout as the compiler
// computed it, its slots filled, signatures, metadata, and the pool's
// strings they name. Its methods, written here and named in it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const Diagnostics = @import("../../abc/errors.zig").Diagnostics;
const SlotIds = @import("../../link/bindings.zig").SlotIds;
const refs = @import("../refs.zig");
const C = @import("../../abc/constants.zig");
const module_ = @import("../module.zig");
const ModuleEmitter = module_.ModuleEmitter;

/// The most slots a traits' fill sets (module.ts tells why).
const FILL_SLOTS: u32 = 1 << 16;

/// Traits t as { slots, defaults, types, bindings, methods }, resolved
/// here; or the VerifyError resolving them gives (module.ts tells why).
pub fn traits(self: *ModuleEmitter, t: u32) Error!void {
    const o = self.out();
    const domain = self.domain;
    const table = &domain.traits;
    const abc = domain.abcs.get(self.index);
    var diag: Diagnostics = .{};
    table.resolve(domain, t, &diag) catch |err| switch (err) {
        error.Verify => {
            try o.text("{ error: ");
            try o.uint(@as(u32, @bitCast(diag.code.number())));
            try o.text(", slots: 0, defaults: [], bindings: [], methods: [] }");
            return;
        },
        error.OutOfMemory => return error.OutOfMemory,
    };

    const count = table.slotCount.get(t);
    try o.text("{ slots: ");
    try o.uint(count);
    try o.text(", defaults: [");
    var first = true;
    const slotStart = table.slotStart.get(t);
    const base = table.base.get(t);
    var slots = SlotIds.init(table, t);
    var i = table.first.get(t);
    while (i < table.end.get(t)) : (i += 1) {
        const kind = abc.traitTag[i].kind;
        if (!kind.bindsSlot()) {
            continue;
        }

        // In range once t has resolved, as fill's are.
        const slot = slots.next(abc.traitId[i]);
        if (slot >= count) {
            continue;
        }

        try o.text(if (first) "[" else ", [");
        first = false;
        try o.uint(slot);
        try o.text(", ");
        const ty = table.slotType.get(slotStart + slot);
        if (kind == .class) {
            try o.text("null");
        } else {
            try refs.constant(&self.methods, abc.traitValue[i], abc.traitValueKind[i], ty);
        }

        try o.text(", ");
        try refs.typeExpr(&self.methods, ty);
        try o.text("]");
    }

    try o.text("], bindings: [");
    first = true;
    var m = table.memberStart.get(t);
    while (m < table.memberEnd.get(t)) : (m += 1) {
        try o.text(if (first) "[" else ", [");
        first = false;
        const ns = table.memberNs.get(m);
        if (domain.nsType.get(ns) == .private) {
            try o.text("N[");
            try o.uint(self.poolIndexOf(ns));
            try o.text("]");
        } else {
            try refs.namespace(&self.methods, ns);
        }

        try o.text(", ");
        try o.uint(table.memberVersion.get(m));
        try o.text(", ");
        try o.string(domain.stringOf(table.memberName.get(m)));
        try o.text(", ");
        try o.uint(@as(u32, @bitCast(table.memberBinding.get(m))));
        try o.text("]");
    }

    try o.text("], methods: [");
    first = true;
    const dispatch = table.dispatchStart.get(t);
    const baseDispatch = if (base != .none) table.dispatchStart.get(base.index()) else 0;
    const baseMethods: u32 = if (base != .none) table.methodCount.get(base.index()) else 0;
    const start = domain.methodStart.get(self.index);
    for (0..table.methodCount.get(t)) |d_| {
        const d: u32 = @intCast(d_);
        const method = table.dispatch.get(dispatch + d);
        if (method < 0 or (d < baseMethods and table.dispatch.get(baseDispatch + d) == method)) {
            continue;
        }

        try o.text(if (first) "[" else ", [");
        first = false;
        // Its dispatch id, factory, and method id, as avmplus writes a function [object Function-id].
        const id = @as(u32, @intCast(method)) -% start;
        try o.uint(d);
        try o.text(", F[");
        try o.uint(id);
        try o.text("], ");
        try o.uint(id);
        try o.text(", ");
        try self.signature(@intCast(method), true);
        try o.text("]");
    }

    try o.text("]");
    try self.meta(t);
    try self.fill(t);
    try o.text(" }");
}

/// Traits t's `fill`, when it has slots: `(o, v) => { o.$n = ...; ... }`,
/// which sets each slot of a new object, highest first (module.ts tells
/// why, and which values are literals).
pub fn fill(self: *ModuleEmitter, t: u32) Error!void {
    const domain = self.domain;
    const table = &domain.traits;
    const count = table.slotCount.get(t);
    if (count == 0 or count > FILL_SLOTS) {
        return;
    }

    // Each slot's declaring trait: its ABC (-1 for none) and its index there.
    const gpa = self.methods.gpa;
    self.fillAbc.clearRetainingCapacity();
    self.fillTrait.clearRetainingCapacity();
    try self.fillAbc.appendNTimes(gpa, -1, count);
    try self.fillTrait.appendNTimes(gpa, 0, count);

    // The bases' first, as the runtime lists the initial values, so that a
    // slot named twice has the value the runtime sets last.
    const chain = &self.fillChain;
    chain.clearRetainingCapacity();
    var it = table.bases(.of(t));
    while (it.next()) |u| {
        try chain.append(gpa, u);
    }

    var c = chain.items.len;
    while (c > 0) {
        c -= 1;
        const v = chain.items[c];
        const index = table.abc.get(v);
        const abc = domain.abcs.get(index);
        var slots = SlotIds.init(table, v);
        var i = table.first.get(v);
        while (i < table.end.get(v)) : (i += 1) {
            const kind = abc.traitTag[i].kind;
            if (!kind.bindsSlot()) {
                continue;
            }

            const slot = slots.next(abc.traitId[i]);
            if (slot < count) {
                self.fillAbc.items[slot] = @intCast(index);
                self.fillTrait.items[slot] = i;
            }
        }
    }

    const o = self.out();
    try o.text(", fill: (o, v) => {");
    // Those kept apart first, as an array literal, which V8 keeps packed.
    if (count > refs.SPILL_SLOTS) {
        try o.text(" o.$S = [");
        var s = refs.SPILL_SLOTS;
        while (s < count) : (s += 1) {
            if (s > refs.SPILL_SLOTS) {
                try o.text(", ");
            }

            try self.fillValue(t, s);
        }

        try o.text("];");
    }

    var s: u32 = @min(count, refs.SPILL_SLOTS);
    while (s > 0) {
        s -= 1;
        if (self.fillAbc.items[s] < 0) {
            continue;
        }

        try o.text(" o.$");
        try o.uint(s);
        try o.text(" = ");
        try self.fillValue(t, s);
        try o.text(";");
    }

    try o.text(" }");
}

/// Slot `s`'s initial value in traits t's fill: a literal where it is one
/// wherever the module is compiled, else the runtime's, `v[s]`; undefined
/// for a slot no trait declares.
pub fn fillValue(self: *ModuleEmitter, t: u32, s: u32) Error!void {
    const o = self.out();
    const index = self.fillAbc.items[s];
    if (index < 0) {
        return o.text("undefined");
    }

    const domain = self.domain;
    const table = &domain.traits;
    const abc = domain.abcs.get(@intCast(index));
    const i = self.fillTrait.items[s];
    const kind = abc.traitTag[i].kind;
    const value = abc.traitValue[i];
    const valueKind = abc.traitValueKind[i];
    if (kind == .class) {
        try o.text("null");
    } else if (value == 0 or (@as(u32, @intCast(index)) == self.index and literal(valueKind))) {
        try refs.constant(&self.methods, value, valueKind, table.slotType.get(table.slotStart.get(t) + s));
    } else {
        try o.text("v[");
        try o.uint(s);
        try o.text("]");
    }
}

/// Method m's signature for describeType: its return type (left out for
/// a constructor), its parameter types, and how many are required; `null,
/// [], 0` for one that does not resolve.
pub fn signature(self: *ModuleEmitter, m: u32, returns: bool) Error!void {
    const o = self.out();
    const table = &self.domain.traits;
    if (!try table.signs(self.domain, m)) {
        return o.text(if (returns) "null, [], 0" else "[], 0");
    }

    if (returns) {
        try refs.typeExpr(&self.methods, table.returnType.get(m));
        try o.text(", ");
    }

    try o.text("[");
    const start = table.paramStart.get(m);
    for (0..table.paramCount.get(m)) |p| {
        try o.text(if (p != 0) ", " else "");
        try refs.typeExpr(&self.methods, table.paramType.get(start + @as(u32, @intCast(p))));
    }

    try o.text("], ");
    try o.uint(table.paramCount.get(m) -% table.optionalCount.get(m));
}

/// Traits t's own metadata, when it has any, as `meta` (module.ts tells
/// the form).
pub fn meta(self: *ModuleEmitter, t: u32) Error!void {
    const o = self.out();
    const table = &self.domain.traits;
    const abc = self.domain.abcs.get(self.index);
    var count: u32 = 0;
    var slots = SlotIds.init(table, t);
    var i = table.first.get(t);
    while (i < table.end.get(t)) : (i += 1) {
        // Every slot trait takes its slot, with metadata or not.
        const kind = abc.traitTag[i].kind;
        const slot = if (kind.bindsSlot()) slots.next(abc.traitId[i]) else 0;
        if (abc.traitMetadataStart[i] == abc.traitMetadataStart[i + 1]) {
            continue;
        }

        // As avmplus' TraitsMetadata: a slot's by its slot, a method's by its binding.
        var id = slot;
        if (!kind.bindsSlot()) {
            table.readName(self.domain, self.index, i);
            const b = table.own(t, table.nameNs, table.nameId, table.nameVersion);
            id = b.index() + @as(u32, if (kind == .setter) 1 else 0);
        }

        try o.text(if (count != 0) ", [" else ", meta: [[");
        count += 1;
        try o.uint(@backingInt(kind));
        try o.text(", ");
        try o.uint(id);
        try o.text(", ");
        try self.metadataOf(i);
        try o.text("]");
    }

    if (count != 0) {
        try o.text("]");
    }
}

/// Trait i's metadata entries as [[name, [key, value, ...]], ...]; a
/// builtin's Version, native and API entries left out, as avmplus'
/// describeMetadataInfo leaves them.
pub fn metadataOf(self: *ModuleEmitter, i: u32) Error!void {
    const o = self.out();
    const domain = self.domain;
    const abc = domain.abcs.get(self.index);
    const strings = domain.abcString.get(self.index);
    try o.text("[");
    var count: u32 = 0;
    var j = abc.traitMetadataStart[i];
    while (j < abc.traitMetadataStart[i + 1]) : (j += 1) {
        const md = abc.traitMetadata[j];
        const name = strings[abc.metadataName[md]];
        if (abc.builtin and (name == domain.versionName or name == domain.nativeName or name == domain.apiName)) {
            continue;
        }

        try o.text(if (count != 0) ", [" else "[");
        count += 1;
        try o.string(domain.stringOf(name));
        try o.text(", [");
        var k = abc.metadataItemStart[md];
        while (k < abc.metadataItemStart[md + 1]) : (k += 1) {
            try o.text(if (k > abc.metadataItemStart[md]) ", " else "");
            try self.poolString(abc.metadataKey[k]);
            try o.text(", ");
            try self.poolString(abc.metadataValue[k]);
        }

        try o.text("]]");
    }

    try o.text("]");
}

/// Pool string `index` of this ABC as a literal, or "" past the pool's
/// end, as avmplus' poolstr reads an unchecked index.
pub fn poolString(self: *ModuleEmitter, index: u32) Error!void {
    const domain = self.domain;
    const abc = domain.abcs.get(self.index);
    const id = if (index < abc.pool.stringCount()) domain.abcString.get(self.index)[index] else try domain.internText("");
    try self.out().string(domain.stringOf(id));
}

/// The pool index of this ABC's namespace with interned id `id`.
pub fn poolIndexOf(self: *ModuleEmitter, id: u32) u32 {
    const ids = self.domain.abcNs.get(self.index);
    var i: u32 = 1;
    while (i < ids.len) : (i += 1) {
        if (ids[i] == id) {
            return i;
        }
    }

    return 0;
}

/// Whether constant() writes a value of `kind` as a literal, not a namespace the runtime makes.
fn literal(kind: C.Constant) bool {
    return switch (kind) {
        .utf8, .int, .uint, .double, .false, .true, .null => true,
        else => false,
    };
}
