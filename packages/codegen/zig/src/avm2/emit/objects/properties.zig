// Names and properties, as the method emitter writes them (objects.zig's
// object, and assembly/avm2/emit/objects.ts, whose comments tell each
// case's why): a multiname's runtime name, getting and setting a property,
// and the Vectors, strings, keys and receivers they read fast.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const domain_ = @import("../../link/domain.zig");
const Domain = domain_.Domain;
const traits_ = @import("../../link/traits.zig");
const TypeId = traits_.TypeId;
const method_ = @import("../method.zig");
const MethodEmitter = method_.MethodEmitter;
const refs = @import("../refs.zig");
const values = @import("../values.zig");
const objects = @import("../objects.zig");
const u = objects.u;
const Kind = objects.Kind;
const AS3_URI = objects.AS3_URI;

pub fn getProperty(em: *MethodEmitter, i: u32, a: u32, src: i32) Error!void {
    const out = &em.out;
    if (interpretedKey(em, a, src + 1)) {
        try em.assign(i, false);
        try out.text("rt.getInterpreted(");
        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(")");
        return;
    }

    if (indexed(em, a, src + 1)) {
        // As avmplus' getUintProperty: an element by its number, of a
        // Vector by the kind of its elements where the IR knows it.
        const kind = try vectorKind(em, em.regType[u(src)]);
        const float = kind == .Float;
        try em.assign(i, float);
        const box = float and !em.unboxedTarget(i);
        if (box) {
            try out.text("rt.float(");
        }

        // An Array's element, or a Vector's, read in place, so that each
        // site keeps its own feedback in the engine (objects.ts tells what
        // goes to the helper).
        if (try arrayElements(em, a, src) or vectorElements(em, a, kind)) {
            try receiver(em, src);
            try out.text(".$a[");
            try em.reg(src + 1);
            try out.text("] ?? ");
        }

        if (kind != .none) {
            try out.text("rt.vectorGet");
            try out.text(@tagName(kind));
            try out.text("(");
        } else {
            try out.text("rt.getIndexed(");
        }

        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(")");
        if (box) {
            try out.text(")");
        }

        return;
    }

    const guarded = maybeStringLength(em, a, src);
    if (guarded) {
        // Read twice, so from its register, not from a text held for it.
        const from = em.copyOf[u(src)].orRegister(src);
        if (from.isRegister()) {
            try em.release(from.register());
        }
    }

    try em.assign(i, false);
    if (keyed(em, a, src + 1)) {
        try out.text("rt.getKeyed(");
        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(")");
        return;
    }

    if (guarded) {
        try out.text("typeof ");
        try em.read(src);
        try out.text(" === \"string\" ? ");
        try em.read(src);
        try out.text(".length : ");
    }

    try out.text("rt.getProperty(");
    try em.reg(src);
    try out.text(", ");
    try name(em, a, src + 1);
    try out.text(")");
}

pub fn setProperty(em: *MethodEmitter, i: u32, a: u32, src: i32) Error!void {
    const out = &em.out;
    const ir = em.ir;
    if (interpretedKey(em, a, src + 1)) {
        try out.text("rt.setInterpreted(");
        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(", ");
        try em.reg(src + 2);
        try out.text(")");
        return;
    }

    if (indexed(em, a, src + 1)) {
        const kind = try vectorKind(em, em.regType[u(src)]);
        // An Array's element below its length, or a Vector's converted to
        // its element type where that runs no AS3, written in place; the
        // rest goes to the helper (objects.ts tells why).
        const array = try arrayElements(em, a, src);
        const element: ?TypeId = if (array or !vectorElements(em, a, kind)) null else try storedType(em, kind, src);
        if (array or element != null) {
            const index = em.builtinOf(src + 1);
            try out.text("if (");
            try receiver(em, src);
            try out.text(".$a.length > ");
            try em.reg(src + 1);
            if (index == .int) {
                try out.text(" && ");
                try em.reg(src + 1);
                try out.text(" >= 0");
            } else if (index != .uint) {
                try out.text(" && ");
                try em.reg(src + 1);
                try out.text(" >>> 0 === ");
                try em.reg(src + 1);
            }

            try out.text(") ");
            try em.reg(src);
            try out.text(".$a[");
            try em.reg(src + 1);
            try out.text("] = ");
            if (array) {
                try em.reg(src + 2);
            } else {
                try values.convert(em, "", src + 2, element.?, em.regType[u(src + 2)], false);
            }

            try out.text("; else ");
        }

        if (kind != .none) {
            try out.text("rt.vectorSet");
            try out.text(@tagName(kind));
            try out.text("(");
        } else {
            try out.text("rt.setIndexed(");
        }

        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(", ");
        if (kind == .Float) {
            try em.numberReg(src + 2);
        } else {
            try em.reg(src + 2);
        }

        try out.text(")");
        return;
    }

    if (keyed(em, a, src + 1)) {
        try out.text("rt.setKeyed(");
        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(", ");
        try em.reg(src + 2);
        try out.text(")");
        return;
    }

    try out.text("rt.setProperty(");
    try em.reg(src);
    try out.text(", ");
    try name(em, a, src + 1);
    try out.text(", ");
    try em.reg(src + @as(i32, @intCast(ir.srcCount[i])) - 1);
    try out.text(")");
}

/// Multiname `a`: M[a], or with its runtime namespace and name taken from
/// the registers from `from`.
pub fn name(em: *MethodEmitter, a: u32, from: i32) Error!void {
    const out = &em.out;
    const kind = em.abc.pool.mnKind[a];
    const parts: i32 = switch (kind) {
        .rtqname_l, .rtqname_la => 2,
        .rtqname, .rtqname_a, .multiname_l, .multiname_la => 1,
        else => 0,
    };
    if (parts == 0) {
        try out.text("M[");
        try out.uint(a);
        try out.text("]");
        return;
    }

    // The name of a string the code holds is the same each time: made once, in T.
    const copy = em.copyOf[u(from)];
    if ((kind == .multiname_l or kind == .multiname_la) and
        from != em.pendingNull and
        copy.isConstant() and
        em.ir.op[copy.instruction()] == .pushstring)
    {
        try out.text("T[");
        try out.uint(try em.literalSlot(a, em.ir.a[copy.instruction()]));
        try out.text("]");
        return;
    }

    try out.text("rt.runtimeName(M[");
    try out.uint(a);
    try out.text("]");
    var k: i32 = 0;
    while (k < parts) : (k += 1) {
        try out.text(", ");
        try em.reg(from + k);
    }

    try out.text(")");
}

/// The kind of Vector type t's elements.
fn vectorKind(em: *MethodEmitter, t: TypeId) Error!Kind {
    const domain = em.domain;
    if (!t.isTraits()) {
        return .none;
    }

    if (t == domain.vectorIntType) {
        return .Int;
    }

    if (t == domain.vectorUintType) {
        return .Uint;
    }

    if (t == domain.vectorDoubleType) {
        return .Double;
    }

    if (domain.traits.param.get(t.index()).isBuiltin(domain.floatType)) {
        return .Float;
    }

    const object_ = domain.vectorObjectType != .any and
        try domain.traits.subtypeOf(em.gpa, t.index(), domain.vectorObjectType.index());
    return if (object_) .Object else .none;
}

/// Whether `getter` on register r reads a Vector's length, which is its
/// elements': the Vector classes are final, and of their getters, length
/// alone gives a uint (fixed a Boolean).
pub fn vectorLength(em: *MethodEmitter, r: i32, getter: i32) Error!bool {
    return getter >= 0 and
        try vectorKind(em, em.regType[u(r)]) != .none and
        em.domain.traits.returnType.get(@intCast(getter)) == em.domain.uintType;
}

/// Whether the domain's string `id` is `text`, which is ASCII.
fn stringIs(domain: *const Domain, id: u32, text: []const u8) bool {
    return domain.stringLength.get(id) == text.len and std.mem.eql(u8, domain.stringOf(id), text);
}

/// The string's own method, `.charAt(` or `.charCodeAt(`, where the call by
/// dispatch id `disp` on the String in register `src` is of AS3::charAt or
/// AS3::charCodeAt with no argument or a number; else "" (objects.ts tells why).
pub fn stringMethod(em: *MethodEmitter, ty: TypeId, disp: u32, src: i32, argc: u32) []const u8 {
    const domain = em.domain;
    if (ty != domain.stringType or argc > 1 or (argc == 1 and !values.isNumber(em, src + 1))) {
        return "";
    }

    const m = refs.aliasedMember(domain, ty.index(), disp);
    if (m < 0) {
        return "";
    }

    const traits = &domain.traits;
    const uri = domain.nsUri.get(traits.memberNs.get(@intCast(m)));
    if (uri == domain_.URI_None or !stringIs(domain, uri, AS3_URI)) {
        return "";
    }

    const member = traits.memberName.get(@intCast(m));
    if (stringIs(domain, member, "charAt")) {
        return ".charAt(";
    }

    return if (stringIs(domain, member, "charCodeAt")) ".charCodeAt(" else "";
}

/// Whether `getter` on register r reads a String's length, which is its
/// string's: String is final and has no other getter.
pub fn stringLength(em: *MethodEmitter, r: i32, getter: i32) bool {
    return getter >= 0 and
        em.builtinOf(r) == .string and
        em.domain.traits.returnType.get(@intCast(getter)) == em.domain.intType;
}

/// Whether the get of multiname `a` on register r may read a string's
/// length: a name `length` that is no attribute's, public or with a public
/// namespace in its set, on a value typed * or Object (objects.ts tells why).
fn maybeStringLength(em: *MethodEmitter, a: u32, r: i32) bool {
    const bt = em.builtinOf(r);
    if (bt != .any and bt != .object) {
        return false;
    }

    const domain = em.domain;
    const pool = &em.abc.pool;
    const kind = pool.mnKind[a];
    if (kind == .qname) {
        const ns = domain.abcNs.get(em.index)[pool.mnA[a]];
        const uri = domain.nsUri.get(ns);
        if (domain.nsType.get(ns) != .public or (uri != domain_.URI_None and domain.stringLength.get(uri) != 0)) {
            return false;
        }
    } else if (kind != .multiname or !domain.hasPublicNamespace(em.index, a)) {
        return false;
    }

    const length = domain.findText("length");
    return length >= 0 and domain.abcString.get(em.index)[pool.mnB[a]] == @as(u32, @intCast(length));
}

/// Whether the indexed access by multiname `a` on a Vector of `kind` reads
/// its elements, as the runtime's vectorGet and vectorSet do: a public
/// namespace in the set, and elements in an Array, which a float Vector's
/// are not.
fn vectorElements(em: *MethodEmitter, a: u32, kind: Kind) bool {
    return kind != .none and kind != .Float and em.domain.hasPublicNamespace(em.index, a);
}

/// The element type the value in register src + 2 converts to when it is
/// written into the Vector of `kind` in register `src`, where the
/// conversion runs no AS3; else null, the helper's (objects.ts tells why).
fn storedType(em: *MethodEmitter, kind: Kind, src: i32) Error!?TypeId {
    const domain = em.domain;
    const t = em.regType[u(src)];
    const ty: TypeId = switch (kind) {
        .Int => domain.intType,
        .Uint => domain.uintType,
        .Double => domain.numberType,
        .Object => if (t != domain.vectorObjectType) domain.traits.param.get(t.index()) else return null,
        else => return null,
    };

    const from = em.regType[u(src + 2)];
    const fromBt = domain.builtin(from);
    if (fromBt == .float) {
        return null;
    }

    const numeric = fromBt == .int or fromBt == .uint or fromBt == .number;
    const stores = switch (domain.builtin(ty)) {
        .int, .uint => numeric or fromBt == .boolean,
        .number => numeric,
        .boolean, .object => true,
        .string => try values.keeps(em, ty, from),
        // A class's instances: an instance check, which throws as the helper would.
        else => refs.isClassRef(em, ty),
    };
    return if (stores) ty else null;
}

/// Whether getproperty or setproperty by multiname `a`, a runtime name
/// alone, takes the key in register r as avmplus' interpreter does in a
/// script's or a class's initializer (rt.getInterpreted).
fn interpretedKey(em: *MethodEmitter, a: u32, r: i32) bool {
    const kind = em.abc.pool.mnKind[a];
    return em.staticInit and
        (kind == .multiname_la or
            (kind == .multiname_l and !em.domain.hasPublicNamespace(em.index, a))) and
        em.builtinOf(r) != .string;
}

/// Whether multiname `a` is a runtime name alone, not an attribute, whose
/// name in register r is a number: an element's index.
fn indexed(em: *MethodEmitter, a: u32, r: i32) bool {
    return em.abc.pool.mnKind[a] == .multiname_l and values.isNumber(em, r);
}

/// Whether multiname `a` is a runtime name alone, not an attribute, whose
/// name in register r is of a type that tells nothing of what it is at run
/// time, outside an initializer avmplus interprets (objects.ts tells why).
fn keyed(em: *MethodEmitter, a: u32, r: i32) bool {
    return !em.staticInit and
        em.abc.pool.mnKind[a] == .multiname_l and
        !values.isNumber(em, r) and
        em.builtinOf(r) != .string;
}

/// Whether the indexed access by multiname `a` on register r reads an
/// Array's elements, as getIndexed and setIndexed do: r an Array, or of a
/// class that extends it, and a public namespace in the set.
fn arrayElements(em: *MethodEmitter, a: u32, r: i32) Error!bool {
    const domain = em.domain;
    const t = em.regType[u(r)];
    return t.isTraits() and
        domain.arrayType != .any and
        try domain.traits.subtypeOf(em.gpa, t.index(), domain.arrayType.index()) and
        domain.hasPublicNamespace(em.index, a);
}

/// Register r read before a `.`, null checked unless it is known not to
/// be null here: `(r ?? nn(r))` or `r`.
pub fn receiver(em: *MethodEmitter, r: i32) Error!void {
    const checked = em.copyOf[u(r)].orRegister(r);
    if (r != em.pendingNull and checked.isRegister() and em.checked[u(checked.register())] != 0) {
        return em.read(r);
    }

    try em.out.byte('(');
    if (r == em.pendingNull) {
        try em.reg(r);
    } else {
        try em.checkedRead(r);
        if (checked.isRegister()) {
            em.checked[u(checked.register())] = 1;
        }
    }

    try em.out.byte(')');
}
