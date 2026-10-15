// How codegen writes values: arithmetic, as JavaScript's own operators
// where the types make them AS3's and the runtime's otherwise, int
// multiplication as avmplus' JIT wraps it, comparisons and conditional
// branches, and the conversions, as avmplus' coercions.
import * as ops from "../abc/opcodes";
import { IR_Coerce } from "../ir/ir";
import {
  BUILTIN_Any,
  BUILTIN_Boolean,
  BUILTIN_Int,
  BUILTIN_Number,
  BUILTIN_Object,
  BUILTIN_String,
  BUILTIN_Uint,
  TYPE_Any,
} from "../link/traits";
import { MethodEmitter } from "./method";
import { isClassRef, typeRef } from "./refs";

/** No type: a conversion, convert_s or convert_o, that always calls the runtime. */
const CONVERTS: i32 = -2;

/**
 * The comparison `op` of instruction i's two operands, negated if `not`:
 * JavaScript's own operator where the types make it AS3's, else the
 * runtime's. For numbers and Booleans the relational operators and ==
 * are the same in both, NaN included; === is for any two primitives; and
 * == for two Strings, null included. A String compared otherwise would
 * convert as JavaScript does, which differs from AS3 for "0b1".
 */
export function compare(em: MethodEmitter, i: u32, op: u16, not: bool): void {
  const out = em.out;
  const a = em.src(i, 0);
  const b = em.src(i, 1);
  const numeric = isNumeric(em, a) && isNumeric(em, b);
  const strings = em.builtinOf(a) === BUILTIN_String && em.builtinOf(b) === BUILTIN_String;
  let js = "";
  let runtime = "";
  switch (op) {
    case ops.OP_equals:
      js = numeric || strings ? " == " : "";
      runtime = "rt.equals(";
      break;
    case ops.OP_strictequals:
      js = isPrimitive(em, a) && isPrimitive(em, b) ? " === " : "";
      runtime = "rt.strictEquals(";
      break;
    case ops.OP_lessthan:
      js = numeric ? " < " : "";
      runtime = "rt.lessThan(";
      break;
    case ops.OP_lessequals:
      js = numeric ? " <= " : "";
      runtime = "rt.lessEquals(";
      break;
    case ops.OP_greaterthan:
      js = numeric ? " > " : "";
      runtime = "rt.greaterThan(";
      break;
    default:
      js = numeric ? " >= " : "";
      runtime = "rt.greaterEquals(";
      break;
  }

  if (js.length === 0) {
    if (not) {
      out.text("!");
    }

    call2(em, runtime, i);
    return;
  }

  out.text(not ? "!(" : "(");
  em.reg(a);
  out.text(js);
  em.reg(b);
  out.text(")");
}

/** Whether register r holds an int, uint, Number or Boolean now. */
export function isNumeric(em: MethodEmitter, r: i32): bool {
  return isNumber(em, r) || em.builtinOf(r) === BUILTIN_Boolean;
}

/** Whether register r holds a value of one of the primitive types now. */
function isPrimitive(em: MethodEmitter, r: i32): bool {
  return isNumeric(em, r) || em.builtinOf(r) === BUILTIN_String;
}

/**
 * Whether add i is JavaScript's own `+`: a String and a String, int, uint
 * or Boolean, whose strings are JavaScript's. null, the one String that
 * is not a string, adds as a number in both, and Numbers' strings differ.
 */
export function concatenates(em: MethodEmitter, i: u32): bool {
  const a = em.builtinOf(em.src(i, 0));
  const b = em.builtinOf(em.src(i, 1));
  return (a === BUILTIN_String || b === BUILTIN_String) && primitive(a) && primitive(b);
}

function primitive(bt: u8): bool {
  return (
    bt === BUILTIN_String || bt === BUILTIN_Int || bt === BUILTIN_Uint || bt === BUILTIN_Boolean
  );
}

/**
 * Whether multiply i is an int multiplication that wraps, as avmplus' JIT
 * makes one (CodegenLIR::coerceNumberToInt): two ints or uints, which
 * the verifier makes Numbers just before, whose product is converted to
 * an int or uint next, in the same block. Its interpreter, which runs
 * the initializers, multiplies doubles. A product converted after a
 * merge, or later in the block, stays a double product here, where
 * avmshell's JIT may still wrap it.
 */
export function wraps(em: MethodEmitter, i: u32): bool {
  const ir = em.ir;
  const next = i + 1;
  if (
    em.staticInit ||
    !em.promoted[em.src(i, 0)] ||
    !em.promoted[em.src(i, 1)] ||
    next >= em.blockLast ||
    ir.src[next] !== ir.dst[i]
  ) {
    return false;
  }

  switch (ir.op[next]) {
    case ops.OP_convert_i:
    case ops.OP_coerce_i:
    case ops.OP_convert_u:
    case ops.OP_coerce_u:
      return true;
    case IR_Coerce: {
      const bt = em.domain.builtin(ir.c[next]);
      return bt === BUILTIN_Int || bt === BUILTIN_Uint;
    }
    default:
      return false;
  }
}

/** Whether method m initializes a script or a class, as avmplus' setStaticInit marks it. */
export function isStaticInit(em: MethodEmitter, m: u32): bool {
  const abc = em.abc;
  for (let s = 0; s < abc.scriptInit.length; s++) {
    if (abc.scriptInit[s] === m) {
      return true;
    }
  }

  for (let c = 0; c < abc.classInit.length; c++) {
    if (abc.classInit[c] === m) {
      return true;
    }
  }

  return false;
}

export function isNumber(em: MethodEmitter, r: i32): bool {
  const bt = em.builtinOf(r);
  return bt === BUILTIN_Int || bt === BUILTIN_Uint || bt === BUILTIN_Number;
}

export function binary(em: MethodEmitter, i: u32, operator: string): void {
  em.reg(em.src(i, 0));
  em.out.text(operator);
  em.reg(em.src(i, 1));
}

export function binaryInt(em: MethodEmitter, i: u32, operator: string): void {
  binary(em, i, operator);
  em.out.text(" | 0");
}

export function call2(em: MethodEmitter, fn: string, i: u32): void {
  em.out.text(fn);
  em.reg(em.src(i, 0));
  em.out.text(", ");
  em.reg(em.src(i, 1));
  em.out.text(")");
}

/** A conditional branch comparing two values; the `n` forms are true when the comparison is not. */
export function branch(em: MethodEmitter, i: u32, op: u8): void {
  const out = em.out;
  out.text("if (");
  switch (op) {
    case ops.OP_ifeq:
      compare(em, i, ops.OP_equals, false);
      break;
    case ops.OP_ifne:
      compare(em, i, ops.OP_equals, true);
      break;
    case ops.OP_ifstricteq:
      compare(em, i, ops.OP_strictequals, false);
      break;
    case ops.OP_ifstrictne:
      compare(em, i, ops.OP_strictequals, true);
      break;
    case ops.OP_iflt:
      compare(em, i, ops.OP_lessthan, false);
      break;
    case ops.OP_ifle:
      compare(em, i, ops.OP_lessequals, false);
      break;
    case ops.OP_ifgt:
      compare(em, i, ops.OP_greaterthan, false);
      break;
    case ops.OP_ifge:
      compare(em, i, ops.OP_greaterequals, false);
      break;
    case ops.OP_ifnlt:
      compare(em, i, ops.OP_lessthan, true);
      break;
    case ops.OP_ifnle:
      compare(em, i, ops.OP_lessequals, true);
      break;
    case ops.OP_ifngt:
      compare(em, i, ops.OP_greaterthan, true);
      break;
    default:
      compare(em, i, ops.OP_greaterequals, true);
      break;
  }

  out.text(") { ");
  em.goto(em.ir.a[i]);
  em.space();
  out.text("}");
}

/** The type a conversion instruction gives, or CONVERTS for one that always calls the runtime. */
export function conversionType(em: MethodEmitter, op: u8, i: u32): i32 {
  const domain = em.domain;
  switch (op) {
    case ops.OP_convert_i:
    case ops.OP_coerce_i:
      return domain.intType;
    case ops.OP_convert_u:
    case ops.OP_coerce_u:
      return domain.uintType;
    case ops.OP_convert_d:
    case ops.OP_coerce_d:
      return domain.numberType;
    case ops.OP_convert_b:
    case ops.OP_coerce_b:
      return domain.booleanType;
    case ops.OP_coerce_s:
      return domain.stringType;
    case ops.OP_coerce_o:
      return domain.objectType();
    case ops.OP_coerce:
      return em.ir.c[i];
    case ops.OP_coerce_a:
      return TYPE_Any;
    default:
      return CONVERTS;
  }
}

/** Whether converting a value of type `from` to `type` gives the value itself, as convert writes no code for. */
export function keeps(em: MethodEmitter, type: i32, from: i32): bool {
  if (type === CONVERTS) {
    return false;
  }

  const domain = em.domain;
  const bt = domain.builtin(type);
  const fromBt = domain.builtin(from);
  return (
    type === from ||
    bt === BUILTIN_Any ||
    (bt === BUILTIN_Number &&
      (fromBt === BUILTIN_Int || fromBt === BUILTIN_Uint || fromBt === BUILTIN_Number)) ||
    upcast(em, type, from)
  );
}

/**
 * Whether a value of class type `from` is one of class `type` already, as
 * CodegenLIR::coerceToType writes no code for: instances of a subtype
 * are, and null stays null.
 */
function upcast(em: MethodEmitter, type: i32, from: i32): bool {
  return (
    isClassRef(em, type) && isClassRef(em, from) && em.domain.traits.subtypeOf(<u32>from, <u32>type)
  );
}

/** The conversion instructions: the value of src as the type they give. */
export function conversion(em: MethodEmitter, i: u32, op: u8): void {
  const domain = em.domain;
  const src = em.ir.src[i];
  const from = em.regType[src];
  switch (op) {
    case ops.OP_convert_i:
    case ops.OP_coerce_i:
      convert(em, "", src, domain.intType, from);
      break;
    case ops.OP_convert_u:
    case ops.OP_coerce_u:
      convert(em, "", src, domain.uintType, from);
      break;
    case ops.OP_convert_d:
    case ops.OP_coerce_d:
      convert(em, "", src, domain.numberType, from);
      break;
    case ops.OP_convert_b:
    case ops.OP_coerce_b:
      convert(em, "", src, domain.booleanType, from);
      break;
    case ops.OP_convert_s:
      // Unlike coerce_s, null and undefined become "null" and "undefined".
      em.out.text("rt.toString(");
      em.reg(src);
      em.out.text(")");
      break;
    case ops.OP_coerce_s:
      convert(em, "", src, domain.stringType, from);
      break;
    case ops.OP_convert_o:
      em.out.text("rt.toObject(");
      em.reg(src);
      em.out.text(")");
      break;
    case ops.OP_coerce_o:
      convert(em, "", src, domain.objectType(), from);
      break;
    case ops.OP_coerce:
      convert(em, "", src, em.ir.c[i], from);
      break;
    default:
      em.reg(src);
      break;
  }
}

/**
 * Register r (or `prefix` + r, for a parameter) converted to `type` from
 * `from`, as avmplus' coercions: nothing when it is that type already,
 * plain JavaScript for numbers and booleans, the runtime otherwise.
 */
export function convert(em: MethodEmitter, prefix: string, r: i32, type: i32, from: i32): void {
  const out = em.out;
  const domain = em.domain;
  const bt = domain.builtin(type);
  const fromBt = domain.builtin(from);
  if (type === from || bt === BUILTIN_Any) {
    operand(em, prefix, r);
    return;
  }

  const numeric = fromBt === BUILTIN_Int || fromBt === BUILTIN_Uint || fromBt === BUILTIN_Number;
  switch (bt) {
    case BUILTIN_Int:
      if (numeric || fromBt === BUILTIN_Boolean) {
        operand(em, prefix, r);
        out.text(" | 0");
      } else {
        out.text("rt.toInt(");
        operand(em, prefix, r);
        out.text(")");
      }
      return;
    case BUILTIN_Uint:
      if (numeric || fromBt === BUILTIN_Boolean) {
        operand(em, prefix, r);
        out.text(" >>> 0");
      } else {
        out.text("rt.toUint(");
        operand(em, prefix, r);
        out.text(")");
      }
      return;
    case BUILTIN_Number:
      if (numeric) {
        operand(em, prefix, r);
      } else {
        out.text("rt.toNumber(");
        operand(em, prefix, r);
        out.text(")");
      }
      return;
    case BUILTIN_Boolean:
      out.text("!!");
      operand(em, prefix, r);
      return;
    case BUILTIN_String:
      out.text("rt.coerceString(");
      operand(em, prefix, r);
      out.text(")");
      return;
    case BUILTIN_Object:
      out.text("rt.coerceObject(");
      operand(em, prefix, r);
      out.text(")");
      return;
    default:
      if (upcast(em, type, from)) {
        operand(em, prefix, r);
        return;
      }

      // A class's instances, by T: no builtin for the runtime to look for.
      out.text(isClassRef(em, type) ? "rt.coerceTo(" : "rt.coerce(");
      operand(em, prefix, r);
      out.text(", ");
      typeRef(em, type);
      out.text(")");
  }
}

function operand(em: MethodEmitter, prefix: string, r: i32): void {
  if (prefix.length) {
    em.out.text(prefix);
    em.out.uint(<u64>r);
  } else {
    em.reg(r);
  }
}
