// How codegen writes values (assembly/avm2/emit/values.ts): arithmetic, as
// JavaScript's own operators where the types make them AS3's and the
// runtime's otherwise, int multiplication as avmplus' JIT wraps it,
// comparisons and conditional branches, and the conversions, as avmplus'
// coercions.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const ops = @import("../abc/opcodes.zig");
const ir_ = @import("../ir/ir.zig");
const traits_ = @import("../link/traits.zig");
const TYPE_Any = traits_.TYPE_Any;
const MethodEmitter = @import("method.zig").MethodEmitter;
const refs = @import("refs.zig");

/// No type: a conversion, convert_s or convert_o, that always calls the runtime.
pub const CONVERTS: i32 = -2;

/// The comparison `op` of instruction i's two operands, negated if `not`:
/// JavaScript's own operator where the types make it AS3's, else the
/// runtime's (values.ts tells which are).
pub fn compare(em: *MethodEmitter, i: u32, op: u16, not: bool) Error!void {
    const out = &em.out;
    const a = em.src(i, 0);
    const b = em.src(i, 1);
    const af = em.builtinOf(a) == traits_.BUILTIN_Float;
    const bf = em.builtinOf(b) == traits_.BUILTIN_Float;
    const numeric = (af or isNumeric(em, a)) and (bf or isNumeric(em, b));
    if (op == ops.OP_strictequals and numeric and af != bf) {
        return out.text(if (not) "true" else "false");
    }

    const strings = em.builtinOf(a) == traits_.BUILTIN_String and em.builtinOf(b) == traits_.BUILTIN_String;
    const objects = byIdentity(em, a) and byIdentity(em, b);
    var js: []const u8 = "";
    var runtime: []const u8 = "";
    switch (op) {
        ops.OP_equals => {
            js = if (numeric or strings or objects) " == " else "";
            runtime = "rt.equals(";
        },
        ops.OP_strictequals => {
            js = if ((af and bf) or (isPrimitive(em, a) and isPrimitive(em, b)) or objects) " === " else "";
            runtime = "rt.strictEquals(";
        },
        ops.OP_lessthan => {
            js = if (numeric) " < " else "";
            runtime = "rt.lessThan(";
        },
        ops.OP_lessequals => {
            js = if (numeric) " <= " else "";
            runtime = "rt.lessEquals(";
        },
        ops.OP_greaterthan => {
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
    if (ty < 0) {
        return false;
    }

    if (ty == domain.nullType) {
        return true;
    }

    if (domain.builtin(ty) != traits_.BUILTIN_Other or ty == domain.xmlType or ty == domain.xmlListType or ty == domain.qnameType) {
        return false;
    }

    const kind = domain.traits.kind.get(@intCast(ty));
    return kind == traits_.TRAITS_Instance or kind == traits_.TRAITS_Class;
}

/// Whether register r holds an int, uint, Number or Boolean now.
pub fn isNumeric(em: *MethodEmitter, r: i32) bool {
    return isNumber(em, r) or em.builtinOf(r) == traits_.BUILTIN_Boolean;
}

/// Whether register r holds a value of one of the primitive types now.
fn isPrimitive(em: *MethodEmitter, r: i32) bool {
    return isNumeric(em, r) or em.builtinOf(r) == traits_.BUILTIN_String;
}

/// Whether add i is JavaScript's own `+` (values.ts tells when).
pub fn concatenates(em: *MethodEmitter, i: u32) bool {
    const a = em.builtinOf(em.src(i, 0));
    const b = em.builtinOf(em.src(i, 1));
    return (a == traits_.BUILTIN_String or b == traits_.BUILTIN_String) and primitive(a) and primitive(b);
}

fn primitive(bt: u8) bool {
    return bt == traits_.BUILTIN_String or bt == traits_.BUILTIN_Int or bt == traits_.BUILTIN_Uint or bt == traits_.BUILTIN_Boolean;
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
        ops.OP_convert_i, ops.OP_coerce_i, ops.OP_convert_u, ops.OP_coerce_u => true,
        ir_.IR_Coerce => blk: {
            const bt = em.domain.builtin(ir.c[next]);
            break :blk bt == traits_.BUILTIN_Int or bt == traits_.BUILTIN_Uint;
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
    return bt == traits_.BUILTIN_Int or bt == traits_.BUILTIN_Uint or bt == traits_.BUILTIN_Number;
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
pub fn branch(em: *MethodEmitter, i: u32, op: u8) Error!void {
    const out = &em.out;
    try out.text("if (");
    switch (op) {
        ops.OP_ifeq => try compare(em, i, ops.OP_equals, false),
        ops.OP_ifne => try compare(em, i, ops.OP_equals, true),
        ops.OP_ifstricteq => try compare(em, i, ops.OP_strictequals, false),
        ops.OP_ifstrictne => try compare(em, i, ops.OP_strictequals, true),
        ops.OP_iflt => try compare(em, i, ops.OP_lessthan, false),
        ops.OP_ifle => try compare(em, i, ops.OP_lessequals, false),
        ops.OP_ifgt => try compare(em, i, ops.OP_greaterthan, false),
        ops.OP_ifge => try compare(em, i, ops.OP_greaterequals, false),
        ops.OP_ifnlt => try compare(em, i, ops.OP_lessthan, true),
        ops.OP_ifnle => try compare(em, i, ops.OP_lessequals, true),
        ops.OP_ifngt => try compare(em, i, ops.OP_greaterthan, true),
        else => try compare(em, i, ops.OP_greaterequals, true),
    }

    try out.text(") { ");
    try em.goto(em.ir.a[i]);
    try em.space();
    try out.text("}");
}

/// The type a conversion instruction gives, or CONVERTS for one that always calls the runtime.
pub fn conversionType(em: *MethodEmitter, op: u8, i: u32) i32 {
    const domain = em.domain;
    return switch (op) {
        ops.OP_convert_i, ops.OP_coerce_i => domain.intType,
        ops.OP_convert_u, ops.OP_coerce_u => domain.uintType,
        ops.OP_convert_f => domain.floatType,
        ops.OP_convert_d, ops.OP_coerce_d => domain.numberType,
        ops.OP_convert_b, ops.OP_coerce_b => domain.booleanType,
        ops.OP_coerce_s => domain.stringType,
        ops.OP_coerce_o => domain.objectType(),
        ops.OP_coerce => em.ir.c[i],
        ops.OP_coerce_a => TYPE_Any,
        else => CONVERTS,
    };
}

/// Whether converting a value of type `from` to `type` gives the value itself, as convert writes no code for.
pub fn keeps(em: *MethodEmitter, ty: i32, from: i32) Error!bool {
    if (ty == CONVERTS) {
        return false;
    }

    const domain = em.domain;
    const bt = domain.builtin(ty);
    const fromBt = domain.builtin(from);
    return ty == from or
        bt == traits_.BUILTIN_Any or
        (bt == traits_.BUILTIN_Number and (fromBt == traits_.BUILTIN_Int or fromBt == traits_.BUILTIN_Uint or fromBt == traits_.BUILTIN_Number)) or
        try upcast(em, ty, from) or
        nullStays(em, ty, from);
}

/// Whether a value of class type `from` is one of class `type` already, as
/// CodegenLIR::coerceToType writes no code for.
fn upcast(em: *MethodEmitter, ty: i32, from: i32) Error!bool {
    return refs.isClassRef(em, ty) and refs.isClassRef(em, from) and
        try em.domain.traits.subtypeOf(em.gpa, @intCast(from), @intCast(ty));
}

/// Whether a value of type `from` is null, which converting to `type` keeps.
fn nullStays(em: *MethodEmitter, ty: i32, from: i32) bool {
    if (from < 0 or from != em.domain.nullType) {
        return false;
    }

    const bt = em.domain.builtin(ty);
    return bt == traits_.BUILTIN_String or bt == traits_.BUILTIN_Object or refs.isClassRef(em, ty);
}

/// The conversion instructions: the value of src as the type they give.
pub fn conversion(em: *MethodEmitter, i: u32, op: u8, unboxed: bool) Error!void {
    const domain = em.domain;
    const s = em.ir.src[i];
    const from = em.regType[@intCast(s)];
    switch (op) {
        ops.OP_convert_i, ops.OP_coerce_i => try convert(em, "", s, domain.intType, from, false),
        ops.OP_convert_u, ops.OP_coerce_u => try convert(em, "", s, domain.uintType, from, false),
        ops.OP_convert_f => try convert(em, "", s, domain.floatType, from, unboxed),
        ops.OP_convert_d, ops.OP_coerce_d => try convert(em, "", s, domain.numberType, from, false),
        ops.OP_convert_b, ops.OP_coerce_b => try convert(em, "", s, domain.booleanType, from, false),
        ops.OP_convert_s => {
            // Unlike coerce_s, null and undefined become "null" and "undefined".
            try em.out.text("rt.toString(");
            try em.reg(s);
            try em.out.text(")");
        },
        ops.OP_coerce_s => try convert(em, "", s, domain.stringType, from, false),
        ops.OP_convert_o => {
            try em.out.text("rt.toObject(");
            try em.reg(s);
            try em.out.text(")");
        },
        ops.OP_coerce_o => try convert(em, "", s, domain.objectType(), from, false),
        ops.OP_coerce => try convert(em, "", s, em.ir.c[i], from, unboxed),
        else => try em.reg(s),
    }
}

/// Register r (or `prefix` + r, for a parameter) converted to `type` from
/// `from`, as avmplus' coercions: nothing when it is that type already,
/// plain JavaScript for numbers and booleans, the runtime otherwise.
pub fn convert(em: *MethodEmitter, prefix: []const u8, r: i32, ty: i32, from: i32, unboxed: bool) Error!void {
    const out = &em.out;
    const domain = em.domain;
    const bt = domain.builtin(ty);
    const fromBt = domain.builtin(from);
    if (prefix.len == 0 and fromBt == traits_.BUILTIN_Float) {
        switch (bt) {
            traits_.BUILTIN_Float => if (unboxed) {
                return em.numberReg(r);
            },
            traits_.BUILTIN_Int, traits_.BUILTIN_Uint => {
                try em.numberReg(r);
                return out.text(if (bt == traits_.BUILTIN_Int) " | 0" else " >>> 0");
            },
            traits_.BUILTIN_Number => return em.numberReg(r),
            traits_.BUILTIN_Boolean => {
                try out.text("!!");
                return em.numberReg(r);
            },
            else => {},
        }
    }

    if (ty == from or bt == traits_.BUILTIN_Any or nullStays(em, ty, from)) {
        return operand(em, prefix, r);
    }

    const numeric = fromBt == traits_.BUILTIN_Int or fromBt == traits_.BUILTIN_Uint or fromBt == traits_.BUILTIN_Number;
    switch (bt) {
        traits_.BUILTIN_Float => {
            try out.text(if (unboxed) "Math.fround(" else "rt.float(");
            if (unboxed and !numeric and fromBt != traits_.BUILTIN_Boolean) {
                try out.text("rt.toNumber(");
                try operand(em, prefix, r);
                try out.text(")");
            } else {
                try operand(em, prefix, r);
            }

            try out.text(")");
        },
        traits_.BUILTIN_Int => if (numeric or fromBt == traits_.BUILTIN_Boolean) {
            try operand(em, prefix, r);
            try out.text(" | 0");
        } else {
            try out.text("rt.toInt(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        traits_.BUILTIN_Uint => if (numeric or fromBt == traits_.BUILTIN_Boolean) {
            try operand(em, prefix, r);
            try out.text(" >>> 0");
        } else {
            try out.text("rt.toUint(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        traits_.BUILTIN_Number => if (numeric) {
            try operand(em, prefix, r);
        } else {
            try out.text("rt.toNumber(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        traits_.BUILTIN_Boolean => if (fromBt == traits_.BUILTIN_Float or fromBt == traits_.BUILTIN_Any or fromBt == traits_.BUILTIN_Object) {
            try out.text("rt.toBoolean(");
            try operand(em, prefix, r);
            try out.text(")");
        } else {
            try out.text("!!");
            try operand(em, prefix, r);
        },
        traits_.BUILTIN_String => {
            try out.text("rt.coerceString(");
            try operand(em, prefix, r);
            try out.text(")");
        },
        traits_.BUILTIN_Object => {
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
fn classParameter(em: *MethodEmitter, prefix: []const u8, r: i32, ty: i32) Error!void {
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
