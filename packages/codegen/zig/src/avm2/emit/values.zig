// How codegen writes values (assembly/avm2/emit/values.ts): arithmetic, as
// JavaScript's own operators where the types make them AS3's and the
// runtime's otherwise, int multiplication as avmplus' JIT wraps it,
// comparisons and conditional branches, and the conversions, as avmplus'
// coercions.
const std = @import("std");
const options = @import("options");
const Error = std.mem.Allocator.Error;
const traits_ = @import("../link/traits.zig");
const TypeId = traits_.TypeId;
const MethodEmitter = @import("method.zig").MethodEmitter;
const refs = @import("refs.zig");
const ir_ = @import("../ir/ir.zig");
const IrOp = ir_.Op;

/// The comparison `op` of instruction i's two operands, negated if `not`:
/// JavaScript's own operator where the types make it AS3's, else the
/// runtime's (values.ts tells which are).
pub fn compare(em: *MethodEmitter, i: u32, op: IrOp, not: bool) Error!void {
    const out = &em.out;
    const a = em.src(i, 0);
    const b = em.src(i, 1);
    const af = em.builtinOf(a) == .float;
    const bf = em.builtinOf(b) == .float;
    const numeric = (af or isNumeric(em, a)) and (bf or isNumeric(em, b));
    if (op == .strictequals and numeric and af != bf) {
        return out.text(if (not) "true" else "false");
    }

    const strings = em.builtinOf(a) == .string and em.builtinOf(b) == .string;
    const objects = byIdentity(em, a) and byIdentity(em, b);
    var js: []const u8 = "";
    var runtime: []const u8 = "";
    switch (op) {
        .equals => {
            js = if (numeric or strings or objects) " == " else "";
            runtime = "rt.equals(";
        },
        .strictequals => {
            js = if ((af and bf) or (isPrimitive(em, a) and isPrimitive(em, b)) or objects) " === " else "";
            runtime = "rt.strictEquals(";
        },
        .lessthan => {
            js = if (numeric) " < " else "";
            runtime = "rt.lessThan(";
        },
        .lessequals => {
            js = if (numeric) " <= " else "";
            runtime = "rt.lessEquals(";
        },
        .greaterthan => {
            js = if (numeric) " > " else "";
            runtime = "rt.greaterThan(";
        },
        else => {
            js = if (numeric) " >= " else "";
            runtime = "rt.greaterEquals(";
        },
    }

    if (js.len == 0) {
        if (not) {
            try out.text("!");
        }

        return call2(em, runtime, i);
    }

    try out.text(if (not) "!(" else "(");
    try em.numberReg(a);
    try out.text(js);
    try em.numberReg(b);
    try out.text(")");
}

/// Whether register r holds null or an object that AS3's == compares by
/// identity (AvmCore::equals; values.ts tells which).
fn byIdentity(em: *MethodEmitter, r: i32) bool {
    const ty = em.regType[@intCast(r)];
    const domain = em.domain;
    if (!ty.isTraits()) {
        return false;
    }

    if (ty == domain.nullType) {
        return true;
    }

    if (domain.builtin(ty) != .other or ty == domain.xmlType or ty == domain.xmlListType or ty == domain.qnameType) {
        return false;
    }

    const kind = domain.traits.kind.get(ty.index());
    return kind == .instance or kind == .class;
}

/// Whether register r holds an int, uint, Number or Boolean now.
pub fn isNumeric(em: *MethodEmitter, r: i32) bool {
    return isNumber(em, r) or em.builtinOf(r) == .boolean;
}

/// Whether register r holds a value of one of the primitive types now.
fn isPrimitive(em: *MethodEmitter, r: i32) bool {
    return isNumeric(em, r) or em.builtinOf(r) == .string;
}

/// Whether add i is JavaScript's own `+` (values.ts tells when).
pub fn concatenates(em: *MethodEmitter, i: u32) bool {
    const a = em.builtinOf(em.src(i, 0));
    const b = em.builtinOf(em.src(i, 1));
    return (a == .string or b == .string) and primitive(a) and primitive(b);
}

fn primitive(bt: traits_.Builtin) bool {
    return bt == .string or bt == .int or bt == .uint or bt == .boolean;
}

/// Whether multiply i is an int multiplication that wraps, as avmplus' JIT
/// makes one (values.ts tells when).
pub fn wraps(em: *MethodEmitter, i: u32) bool {
    const ir = em.ir;
    const next = i + 1;
    if (em.staticInit or
        em.promoted[@intCast(em.src(i, 0))] == 0 or
        em.promoted[@intCast(em.src(i, 1))] == 0 or
        next >= em.blockLast or
        ir.src[next] != ir.dst[i])
    {
        return false;
    }

    return switch (ir.op[next]) {
        .convert_i, .coerce_i, .convert_u, .coerce_u => true,
        .ir_coerce => blk: {
            const bt = em.domain.builtin(ir.cType(next));
            break :blk bt == .int or bt == .uint;
        },
        else => false,
    };
}

/// Whether method m initializes a script or a class, as avmplus' setStaticInit marks it.
pub fn isStaticInit(em: *MethodEmitter, m: u32) bool {
    const abc = em.abc;
    return std.mem.indexOfScalar(u32, abc.scriptInit, m) != null or std.mem.indexOfScalar(u32, abc.classInit, m) != null;
}

pub fn isNumber(em: *MethodEmitter, r: i32) bool {
    const bt = em.builtinOf(r);
    return bt == .int or bt == .uint or bt == .number;
}

pub fn binary(em: *MethodEmitter, i: u32, operator: []const u8) Error!void {
    try em.numberReg(em.src(i, 0));
    try em.out.text(operator);
    try em.numberReg(em.src(i, 1));
}

pub fn binaryInt(em: *MethodEmitter, i: u32, operator: []const u8) Error!void {
    try binary(em, i, operator);
    try em.out.text(" | 0");
}

pub fn call2(em: *MethodEmitter, function: []const u8, i: u32) Error!void {
    try em.out.text(function);
    try em.reg(em.src(i, 0));
    try em.out.text(", ");
    try em.reg(em.src(i, 1));
    try em.out.text(")");
}

/// A conditional branch comparing two values; the `n` forms are true when the comparison is not.
pub fn branch(em: *MethodEmitter, i: u32, op: IrOp) Error!void {
    const out = &em.out;
    try out.text("if (");
    switch (op) {
        .ifeq => try compare(em, i, .equals, false),
        .ifne => try compare(em, i, .equals, true),
        .ifstricteq => try compare(em, i, .strictequals, false),
        .ifstrictne => try compare(em, i, .strictequals, true),
        .iflt => try compare(em, i, .lessthan, false),
        .ifle => try compare(em, i, .lessequals, false),
        .ifgt => try compare(em, i, .greaterthan, false),
        .ifge => try compare(em, i, .greaterequals, false),
        .ifnlt => try compare(em, i, .lessthan, true),
        .ifnle => try compare(em, i, .lessequals, true),
        .ifngt => try compare(em, i, .greaterthan, true),
        else => try compare(em, i, .greaterequals, true),
    }

    try out.text(") { ");
    try em.goto(em.ir.a[i]);
    try em.space();
    try out.text("}");
}

/// Whether `op` is a conversion to a type of its own, conversionType's:
/// not convert_s or convert_o, which always call the runtime, nor any
/// other instruction.
pub fn isTypedConversion(op: IrOp) bool {
    return switch (op) {
        .convert_i, .coerce_i, .convert_u, .coerce_u, .convert_f, .convert_d, .coerce_d, .convert_b, .coerce_b, .coerce_s, .coerce_o, .coerce, .coerce_a => true,
        else => false,
    };
}

/// The type conversion instruction i, `op`, gives. Its callers test
/// isTypedConversion first: no other op gives a type of its own.
pub fn conversionType(em: *MethodEmitter, op: IrOp, i: u32) TypeId {
    if (options.checks) {
        std.debug.assert(isTypedConversion(op));
    }

    const domain = em.domain;
    return switch (op) {
        .convert_i, .coerce_i => domain.intType,
        .convert_u, .coerce_u => domain.uintType,
        .convert_f => domain.floatType,
        .convert_d, .coerce_d => domain.numberType,
        .convert_b, .coerce_b => domain.booleanType,
        .coerce_s => domain.stringType,
        .coerce_o => domain.objectType(),
        .coerce => em.ir.cType(i),
        .coerce_a => .any,
        else => @panic("conversionType of an op isTypedConversion rejects"),
    };
}

/// Whether converting a value of type `from` to `type` gives the value itself, as convert writes no code for.
pub fn keeps(em: *MethodEmitter, ty: TypeId, from: TypeId) Error!bool {
    const domain = em.domain;
    const bt = domain.builtin(ty);
    const fromBt = domain.builtin(from);
    return ty == from or
        bt == .any or
        (bt == .number and (fromBt == .int or fromBt == .uint or fromBt == .number)) or
        try upcast(em, ty, from) or
        nullStays(em, ty, from);
}

/// Whether a value of class type `from` is one of class `type` already, as
/// CodegenLIR::coerceToType writes no code for.
fn upcast(em: *MethodEmitter, ty: TypeId, from: TypeId) Error!bool {
    return refs.isClassRef(em, ty) and refs.isClassRef(em, from) and
        try em.domain.traits.subtypeOf(em.gpa, from.index(), ty.index());
}

/// Whether a value of type `from` is null, which converting to `type` keeps.
fn nullStays(em: *MethodEmitter, ty: TypeId, from: TypeId) bool {
    if (!from.isBuiltin(em.domain.nullType)) {
        return false;
    }

    const bt = em.domain.builtin(ty);
    return bt == .string or bt == .object or refs.isClassRef(em, ty);
}

/// The conversion instructions: the value of src as the type they give.
pub fn conversion(em: *MethodEmitter, i: u32, op: IrOp, unboxed: bool) Error!void {
    const domain = em.domain;
    const s = em.ir.src[i];
    const from = em.regType[@intCast(s)];
    switch (op) {
        .convert_i, .coerce_i => try convert(em, "", s, domain.intType, from, false),
        .convert_u, .coerce_u => try convert(em, "", s, domain.uintType, from, false),
        .convert_f => try convert(em, "", s, domain.floatType, from, unboxed),
        .convert_d, .coerce_d => try convert(em, "", s, domain.numberType, from, false),
        .convert_b, .coerce_b => try convert(em, "", s, domain.booleanType, from, false),
        .convert_s => {
            // Unlike coerce_s, null and undefined become "null" and "undefined".
            try em.out.text("rt.toString(");
            try em.reg(s);
            try em.out.text(")");
        },
        .coerce_s => try convert(em, "", s, domain.stringType, from, false),
        .convert_o => {
            try em.out.text("rt.toObject(");
            try em.reg(s);
            try em.out.text(")");
        },
        .coerce_o => try convert(em, "", s, domain.objectType(), from, false),
        .coerce => try convert(em, "", s, em.ir.cType(i), from, unboxed),
        else => try em.reg(s),
    }
}

/// Register r (or `prefix` + r, for a parameter) converted to `type` from
/// `from`, as avmplus' coercions: nothing when it is that type already,
/// plain JavaScript for numbers and booleans, the runtime otherwise.
pub fn convert(em: *MethodEmitter, prefix: []const u8, r: i32, ty: TypeId, from: TypeId, unboxed: bool) Error!void {
    const out = &em.out;
    const domain = em.domain;
    const bt = domain.builtin(ty);
    const fromBt = domain.builtin(from);
    if (prefix.len == 0 and fromBt == .float) {
        switch (bt) {
            .float => if (unboxed) {
                return em.numberReg(r);
            },
            .int, .uint => {
                try em.numberReg(r);
                return out.text(if (bt == .int) " | 0" else " >>> 0");
            },
            .number => return em.numberReg(r),
            .boolean => {
                try out.text("!!");
                return em.numberReg(r);
            },
            else => {},
        }
    }

    if (ty == from or bt == .any or nullStays(em, ty, from)) {
        return operand(em, prefix, r);
    }

    const numeric = fromBt == .int or fromBt == .uint or fromBt == .number;
    switch (bt) {
        .float => {
            try out.text(if (unboxed) "Math.fround(" else "rt.float(");
            if (unboxed and !numeric and fromBt != .boolean) {
                try out.text("rt.toNumber(");
                try operand(em, prefix, r);
                try out.text(")");
            } else {
                try operand(em, prefix, r);
            }

            try out.text(")");
        },
        .int => if (numeric or fromBt == .boolean) {
            try operand(em, prefix, r);
            try out.text(" | 0");
        } else {
            try out.text("rt.toInt(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        .uint => if (numeric or fromBt == .boolean) {
            try operand(em, prefix, r);
            try out.text(" >>> 0");
        } else {
            try out.text("rt.toUint(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        .number => if (numeric) {
            try operand(em, prefix, r);
        } else {
            try out.text("rt.toNumber(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        .boolean => if (fromBt == .float or fromBt == .any or fromBt == .object) {
            try out.text("rt.toBoolean(");
            try operand(em, prefix, r);
            try out.text(")");
        } else {
            try out.text("!!");
            try operand(em, prefix, r);
        },
        .string => {
            try out.text("rt.coerceString(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        .object => {
            try out.text("rt.coerceObject(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        else => {
            if (try upcast(em, ty, from)) {
                return operand(em, prefix, r);
            }

            if (prefix.len > 0 and refs.isClassRef(em, ty)) {
                return classParameter(em, prefix, r, ty);
            }

            // A class's instances, by T: no builtin for the runtime to look for.
            try out.text(if (refs.isClassRef(em, ty)) "rt.coerceTo(" else "rt.coerce(");
            try operand(em, prefix, r);
            try out.text(", ");
            try refs.typeRef(em, ty);
            try out.text(")");
        },
    }
}

/// Parameter r (`prefix` + r) coerced to class type `type` on entry, its
/// own class's instances found inline (values.ts tells how).
fn classParameter(em: *MethodEmitter, prefix: []const u8, r: i32, ty: TypeId) Error!void {
    const out = &em.out;
    try out.text("(");
    try operand(em, prefix, r);
    try out.text(" != null && ");
    try operand(em, prefix, r);
    try out.text(".$traits === ");
    try refs.typeRef(em, ty);
    try out.text(".traits ? ");
    try operand(em, prefix, r);
    try out.text(" : rt.coerceTo(");
    try operand(em, prefix, r);
    try out.text(", ");
    try refs.typeRef(em, ty);
    try out.text("))");
}

fn operand(em: *MethodEmitter, prefix: []const u8, r: i32) Error!void {
    if (prefix.len > 0) {
        try em.out.text(prefix);
        try em.out.uint(@intCast(r));
    } else {
        try em.reg(r);
    }
}
