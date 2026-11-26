// How a method or module names what it refers to (assembly/avm2/emit/refs.ts):
// types, as the runtime knows them across modules or through the module's
// table T; namespaces and qualified names; and the constants a slot or
// parameter starts as.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const output = @import("../../output.zig");
const Output = output.Output;
const C = @import("../abc/constants.zig");
const ir_ = @import("../ir/ir.zig");
const Value = @import("../abc/pool.zig").Value;
const domain_ = @import("../link/domain.zig");
const Domain = domain_.Domain;
const traits_ = @import("../link/traits.zig");
const TraitsTable = traits_.TraitsTable;
const TypeId = traits_.TypeId;
const MethodEmitter = @import("method.zig").MethodEmitter;

/// The first slot an object keeps in its array `$S` rather than in a
/// property of its own, as the runtime's SPILL_SLOTS (refs.ts tells why).
pub const SPILL_SLOTS: u32 = 900;

/// Slot `slot`'s member, `.$n`, or `.$S[n - SPILL_SLOTS]` past them.
pub fn slotMember(out: *Output, slot: u32) Error!void {
    if (slot < SPILL_SLOTS) {
        try out.text(".$");
        try out.uint(slot);
        return;
    }

    try out.text(".$S[");
    try out.uint(slot - SPILL_SLOTS);
    try out.text("]");
}

/// Whether typeRef writes type t as T[k], a class's instances; else a literal.
pub fn isClassRef(e: *MethodEmitter, t: TypeId) bool {
    const ty = t;
    // What typeExpr writes as a literal stays one.
    const bt = if (!ty.isTraits()) .any else e.domain.builtin(ty);
    return ty.isTraits() and
        (bt == .other or bt == .namespace) and
        ty != e.domain.voidType and
        e.domain.traits.kind.get(ty.index()) == .instance;
}

/// Type t in a method: an entry of the module's table T for a class or
/// Vector; the builtin types, and * as null, as they are.
pub fn typeRef(e: *MethodEmitter, t: TypeId) Error!void {
    if (!isClassRef(e, t)) {
        return typeExpr(e, t);
    }

    try e.out.text("T[");
    try e.out.uint(try e.typeSlot(t));
    try e.out.text("]");
}

/// A reference to type t for the runtime, by name, as types are known
/// across modules: null for *, a string for the builtin primitive types,
/// cls(namespace, "Name") for a class, rt.vector(type) for Vector.<T>.
/// AssemblyScript recurses into a Vector's element type, as deep as the
/// input's TypeNames nest; this counts the levels.
pub fn typeExpr(e: *MethodEmitter, type_: TypeId) Error!void {
    const out = &e.out;
    const domain = e.domain;
    const traits = &domain.traits;
    var t = type_;
    var vectors: u32 = 0;
    while (true) {
        if (!t.isTraits()) {
            try out.text("null");
            break;
        }

        const literal: ?[]const u8 = switch (domain.builtin(t)) {
            .int => "\"int\"",
            .uint => "\"uint\"",
            .float => "\"float\"",
            .number => "\"Number\"",
            .boolean => "\"Boolean\"",
            .string => "\"String\"",
            .object => "\"Object\"",
            else => null,
        };
        if (literal) |l| {
            try out.text(l);
            break;
        }

        const u = t.index();
        if (t == domain.voidType) {
            try out.text("\"void\"");
        } else if (traits.kind.get(u) != .instance) {
            try out.text("null");
        } else if (traits.param.get(u) != .any) {
            try out.text("rt.vector(");
            vectors += 1;
            t = traits.param.get(u);
            continue;
        } else {
            try className_(e, u);
        }

        break;
    }

    for (0..vectors) |_| {
        try out.text(")");
    }
}

/// cls(namespace, "Name") for class traits t.
fn className_(e: *MethodEmitter, t: u32) Error!void {
    const out = &e.out;
    const domain = e.domain;
    const traits = &domain.traits;
    const index = traits.abc.get(t);
    const abc = domain.abcs.get(index);
    const pool = &abc.pool;
    var mn = abc.instanceName[traits.owner.get(t)];
    if (pool.mnKind[mn] == .type_name) {
        mn = pool.mnA[mn];
    }

    var ns = pool.mnA[mn];
    if (pool.mnKind[mn] == .multiname) {
        ns = domain_.firstMember(pool, ns);
    }

    const name = domain.abcString.get(index)[pool.mnB[mn]];
    try out.text("cls(");
    const id = domain.abcNs.get(index)[ns];
    if (domain.nsType.get(id) == .private and index == e.index) {
        // A private namespace is its module's own object, N[k].
        try out.text("N[");
        try out.uint(ns);
        try out.text("]");
    } else {
        try namespace(e, id);
    }

    try out.text(", ");
    try out.string(domain.stringOf(name));
    try out.text(")");
}

/// A non-private namespace by its interned id, as ns(type, uri).
pub fn namespace(e: *MethodEmitter, id: u32) Error!void {
    const out = &e.out;
    try out.text("ns(");
    try out.uint(@backingInt(e.domain.nsType.get(id)));
    try out.text(", ");
    try uri(e, e.domain.nsUri.get(id));
    try out.text(")");
}

pub fn uri(e: *MethodEmitter, id: u32) Error!void {
    if (id == domain_.URI_None) {
        return e.out.text("null");
    }

    try e.out.string(e.domain.stringOf(id));
}

/// The member of interface traits `ifc` that dispatch id `disp` of its
/// layout binds a method to; -1 where there is none to call by, a private
/// namespace's member among them.
pub fn aliasedMember(domain: *const Domain, ifc: u32, disp: u32) i32 {
    const traits = &domain.traits;
    const last = traits.memberEnd.get(ifc);
    var m = traits.memberStart.get(ifc);
    while (m < last) : (m += 1) {
        const b = traits.memberBinding.get(m);
        if (b.kind == .method and b.index() == disp) {
            return if (domain.nsType.get(traits.memberNs.get(m)) == .private) -1 else @intCast(m);
        }
    }

    return -1;
}

/// The name, as a string literal, under which every class that implements
/// an interface has the entry for bound calls of the method it binds the
/// interface's member `name` in `ns` to (refs.ts tells its parts).
pub fn interfaceAlias(out: *Output, domain: *const Domain, ns: u32, name: u32) Error!void {
    try out.text("\"$i");
    try out.uint(@backingInt(domain.nsType.get(ns)));
    const id = domain.nsUri.get(ns);
    if (id == domain_.URI_None) {
        try out.text("n:");
    } else {
        try out.text(".");
        try out.uint(domain.stringLength.get(id));
        try out.text(":");
        try out.chars(domain.stringOf(id));
        try out.text(":");
    }

    try out.chars(domain.stringOf(name));
    try out.text("\"");
}

/// "uri::name", or just the name in a public namespace with an empty URI,
/// as the UTF-16 units of AssemblyScript's string of it (refs.ts decodes
/// each part, and tests the URI's emptiness decoded).
pub fn qualified(e: *MethodEmitter, ns: u32, name: u32) Error![]u16 {
    const gpa = e.gpa;
    const domain = e.domain;
    const nameText = try output.decodeUnits(gpa, domain.stringOf(name));
    const id = domain.nsUri.get(ns);
    if (id == domain_.URI_None) {
        return nameText;
    }

    const uriText = try output.decodeUnits(gpa, domain.stringOf(id));
    if (uriText.len == 0) {
        return nameText;
    }

    const separator = [_]u16{ ':', ':' };
    return std.mem.concat(gpa, u16, &.{ uriText, &separator, nameText });
}

/// The qualified name of the class traits t belong to.
pub fn className(e: *MethodEmitter, traits: *const TraitsTable, t: u32) Error![]u16 {
    const domain = e.domain;
    const index = traits.abc.get(t);
    const abc = domain.abcs.get(index);
    const pool = &abc.pool;
    var mn = abc.instanceName[traits.owner.get(t)];
    if (pool.mnKind[mn] == .type_name) {
        mn = pool.mnA[mn];
    }

    var ns = pool.mnA[mn];
    if (pool.mnKind[mn] == .multiname) {
        ns = domain_.firstMember(pool, ns);
    }

    return qualified(e, domain.abcNs.get(index)[ns], domain.abcString.get(index)[pool.mnB[mn]]);
}

/// Pool string `index` as a JavaScript string literal.
pub fn poolString(e: *MethodEmitter, index: u32) Error!void {
    const pool = &e.abc.pool;
    try e.out.string(pool.string(e.data, index));
}

/// A constant of default-value kind `kind`, index `value`, for a slot or
/// parameter of `type`; value 0 is the type's own default.
pub fn constant(e: *MethodEmitter, value: u32, kind: C.Constant, type_: TypeId) Error!void {
    const out = &e.out;
    const pool = &e.abc.pool;
    if (kind == .float and e.abc.hasFloatSupport()) {
        const bt = e.domain.builtin(type_);
        const numeric = bt == .int or bt == .uint or bt == .number;
        if (!numeric) {
            try out.text("rt.float(");
        }

        try out.double(pool.floats[value]);
        if (!numeric) {
            try out.text(")");
        }

        return;
    }

    if (value == 0) {
        return defaultOf(e, type_);
    }

    if (type_.isBuiltin(e.domain.floatType) and kind != .float) {
        try out.text("rt.float(");
        try constant(e, value, kind, .any);
        try out.text(")");
        return;
    }

    // Linking checked the value (Domain.checkDefault); one it did not
    // check is written as a namespace, never a trap.
    switch (pool.value(kind, value) catch Value{ .namespace = value }) {
        .int => |n| try out.int(n),
        .uint => |n| try out.uint(n),
        .double => |n| try out.double(n),
        // Taken above: only an ABC with float support has floats past entry 0.
        .float => |n| try out.double(n),
        .string => |i| try poolString(e, i),
        .boolean => |b| try out.text(if (b) "true" else "false"),
        .null => try out.text("null"),
        .namespace => |i| {
            // As the Namespace object it is to AS3.
            try out.text("rt.namespace(N[");
            try out.uint(i);
            try out.text("])");
        },
    }
}

/// The value a slot or parameter of `type` has before anything is stored.
fn defaultOf(e: *MethodEmitter, type_: TypeId) Error!void {
    const out = &e.out;
    try out.text(switch (e.domain.builtin(type_)) {
        .any => "void 0",
        .int, .uint => "0",
        .float => "rt.float(NaN)",
        .number => "NaN",
        .boolean => "false",
        else => "null",
    });
}
