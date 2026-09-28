// Writes one method's IR as a JavaScript function whose blocks run in a
// dispatcher: `for (;;) switch (b) { case 0: ... }`. Registers are `let`
// variables named as the IR names them (l0, sc0, s0), and the runtime is
// `rt` in the enclosing module.
//
// Typed lowering starts simple: what the IR's types make certain is plain
// JavaScript (int arithmetic ends in `| 0`), anything else calls the
// runtime, which does what avmplus does at run time.
import { Abc } from "../abc/abc";
import { METHOD_NeedArguments, METHOD_NeedRest } from "../abc/constants";
import {
  OP_add,
  OP_add_i,
  OP_bitand,
  OP_bitnot,
  OP_bitor,
  OP_bitxor,
  OP_coerce,
  OP_coerce_a,
  OP_coerce_b,
  OP_coerce_d,
  OP_coerce_i,
  OP_coerce_o,
  OP_coerce_s,
  OP_coerce_u,
  OP_convert_b,
  OP_convert_d,
  OP_convert_i,
  OP_convert_o,
  OP_convert_s,
  OP_convert_u,
  OP_debug,
  OP_debugfile,
  OP_debugline,
  OP_declocal,
  OP_declocal_i,
  OP_decrement,
  OP_decrement_i,
  OP_divide,
  OP_dup,
  OP_equals,
  OP_getlocal,
  OP_getlocal0,
  OP_greaterequals,
  OP_greaterthan,
  OP_ifeq,
  OP_iffalse,
  OP_ifge,
  OP_ifgt,
  OP_ifle,
  OP_iflt,
  OP_ifne,
  OP_ifnge,
  OP_ifngt,
  OP_ifnle,
  OP_ifnlt,
  OP_ifstricteq,
  OP_ifstrictne,
  OP_iftrue,
  OP_inclocal,
  OP_inclocal_i,
  OP_increment,
  OP_increment_i,
  OP_jump,
  OP_kill,
  OP_lessequals,
  OP_lessthan,
  OP_lookupswitch,
  OP_lshift,
  OP_modulo,
  OP_multiply,
  OP_multiply_i,
  OP_negate,
  OP_negate_i,
  OP_not,
  OP_pop,
  OP_pushbyte,
  OP_pushdouble,
  OP_pushfalse,
  OP_pushint,
  OP_pushnan,
  OP_pushnull,
  OP_pushshort,
  OP_pushstring,
  OP_pushtrue,
  OP_pushuint,
  OP_pushundefined,
  OP_returnvalue,
  OP_returnvoid,
  OP_rshift,
  OP_setlocal,
  OP_setlocal0,
  OP_strictequals,
  OP_subtract,
  OP_subtract_i,
  OP_swap,
  OP_throw,
  OP_typeof,
  OP_urshift,
  opcodeNames,
} from "../abc/opcodes";
import { IR_CheckNull, IR_Coerce, Ir } from "../ir/ir";
import { Domain } from "../link/domain";
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
import { Output } from "./output";

@final
export class MethodEmitter {
  out: Output = new Output();
  /** Each register's type as the instruction being written reads it. */
  regType: StaticArray<i32> = new StaticArray<i32>(0);

  domain: Domain;
  index: u32 = 0;
  abc: Abc;
  base: usize = 0;
  ir: Ir = new Ir();

  constructor(domain: Domain, index: u32) {
    this.domain = domain;
    this.index = index;
    this.abc = domain.abcs[index];
    this.base = domain.abcBase[index];
  }

  /**
   * Write method `method` (domain-wide id `global`) of the ABC, whose body's
   * IR is `ir`, as `function (p1, ..., pn) { ... }`.
   */
  method(method: u32, global: u32, ir: Ir): void {
    const out = this.out;
    const traits = this.domain.traits;
    this.ir = ir;
    if (<u32>this.regType.length < ir.frameSize) {
      this.regType = new StaticArray<i32>(ir.frameSize);
    }

    const count = traits.paramCount[global];
    out.text("function (");
    for (let p: u32 = 1; p <= count; p++) {
      out.text(p > 1 ? ", p" : "p");
      out.uint(p);
    }

    const flags = this.abc.methodFlags[method];
    if (flags & METHOD_NeedRest) {
      out.text(count ? ", ...rest" : "...rest");
    }

    out.text(") {\n");
    this.prologue(method, global, flags);
    out.text("  let b = 0;\n  for (;;) switch (b) {\n");
    for (let k: u32 = 0; k < ir.blockCount; k++) {
      this.block(k);
    }

    // The verifier proved every block ends; a dispatcher still needs an end.
    out.text("  default: throw rt.unreachable();\n  }\n}");
  }

  /** Declare the registers: `this`, the parameters, coerced, with defaults, then the rest. */
  prologue(method: u32, global: u32, flags: u8): void {
    const out = this.out;
    const ir = this.ir;
    const traits = this.domain.traits;
    const abc = this.abc;
    const count = traits.paramCount[global];
    const optional = traits.optionalCount[global];
    out.text("  let l0 = this");
    for (let p: u32 = 1; p <= count; p++) {
      out.text(", l");
      out.uint(p);
      out.text(" = ");
      const type = traits.paramType[traits.paramStart[global] + p - 1];
      const first = count - optional;
      if (p > first) {
        // A missing optional argument takes its default.
        out.text("arguments.length < ");
        out.uint(p);
        out.text(" ? ");
        const o = abc.methodOptionalStart[method] + p - first - 1;
        this.constant(abc.optionalValue[o], abc.optionalKind[o], type);
        out.text(" : ");
      }

      this.convert("p", <i32>p, type, TYPE_Any);
    }

    let local = count + 1;
    if (flags & METHOD_NeedRest) {
      out.text(", l");
      out.uint(local++);
      out.text(" = rt.array(rest)");
    } else if (flags & METHOD_NeedArguments) {
      out.text(", l");
      out.uint(local++);
      out.text(" = rt.arguments(arguments, ");
      out.uint(count);
      out.text(")");
    }

    for (let r = local; r < ir.frameSize; r++) {
      out.text(", ");
      this.reg(<i32>r);
    }

    out.text(";\n");
  }

  /** Write block k: its case label, then its instructions, following register types. */
  block(k: u32): void {
    const out = this.out;
    const ir = this.ir;
    out.text("  case ");
    out.uint(k);
    out.text(":\n");
    const entry = k * ir.frameSize;
    for (let r: u32 = 0; r < ir.frameSize; r++) {
      this.regType[r] = ir.entryType[entry + r];
    }

    const last = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
    for (let i = ir.blockFirst[k]; i < last; i++) {
      this.instruction(i);
      if (ir.dst[i] >= 0) {
        this.regType[ir.dst[i]] = ir.type[i];
      }
    }
  }

  /** The builtin type of register r's value now. */
  builtinOf(r: i32): u8 {
    return this.domain.builtin(this.regType[r]);
  }

  reg(r: i32): void {
    const ir = this.ir;
    const out = this.out;
    const local = <i32>ir.localCount;
    if (r < local) {
      out.byte(0x6c); // l
      out.uint(<u64>r);
    } else if (r < local + <i32>ir.maxScope) {
      out.text("sc");
      out.uint(<u64>(r - local));
    } else {
      out.byte(0x73); // s
      out.uint(<u64>(r - local - <i32>ir.maxScope));
    }
  }

  /** `dst = ` for instruction i. */
  assign(i: u32): void {
    this.out.text("    ");
    this.reg(this.ir.dst[i]);
    this.out.text(" = ");
  }

  src(i: u32, k: u32): i32 {
    return this.ir.src[i] + <i32>k;
  }

  /** `b = n; continue;` to block n. */
  goto(block: u32): void {
    this.out.text("b = ");
    this.out.uint(block);
    this.out.text("; continue;");
  }

  instruction(i: u32): void {
    const out = this.out;
    const ir = this.ir;
    const op = ir.op[i];
    const a = ir.a[i];
    switch (op) {
      case OP_pushbyte:
      case OP_pushshort:
        this.assign(i);
        out.int(<i32>a);
        break;
      case OP_pushint:
        this.assign(i);
        out.int(this.abc.pool.ints[a]);
        break;
      case OP_pushuint:
        this.assign(i);
        out.uint(this.abc.pool.uints[a]);
        break;
      case OP_pushdouble:
        this.assign(i);
        out.double(this.abc.pool.doubles[a]);
        break;
      case OP_pushnan:
        this.assign(i);
        out.text("NaN");
        break;
      case OP_pushstring:
        this.assign(i);
        this.string(a);
        break;
      case OP_pushtrue:
        this.assign(i);
        out.text("true");
        break;
      case OP_pushfalse:
        this.assign(i);
        out.text("false");
        break;
      case OP_pushnull:
        this.assign(i);
        out.text("null");
        break;
      case OP_pushundefined:
        this.assign(i);
        out.text("undefined");
        break;
      case OP_getlocal:
      case OP_setlocal:
      case OP_dup:
        this.assign(i);
        this.reg(ir.src[i]);
        break;
      case OP_kill:
        this.assign(i);
        out.text("undefined");
        break;
      case OP_swap: {
        const x = ir.src[i];
        out.text("    [");
        this.reg(x);
        out.text(", ");
        this.reg(x + 1);
        out.text("] = [");
        this.reg(x + 1);
        out.text(", ");
        this.reg(x);
        out.text("]");
        break;
      }
      case OP_pop:
      case OP_debug:
      case OP_debugline:
      case OP_debugfile:
        return;
      case IR_Coerce:
        this.assign(i);
        this.convert("", ir.src[i], ir.c[i], this.regType[ir.src[i]]);
        break;
      case IR_CheckNull:
        out.text("    if (");
        this.reg(ir.src[i]);
        out.text(" == null) throw rt.nullError(");
        this.reg(ir.src[i]);
        out.text(")");
        break;
      case OP_add:
        this.assign(i);
        if (this.isNumber(this.src(i, 0)) && this.isNumber(this.src(i, 1))) {
          this.binary(i, " + ");
        } else {
          this.call2("rt.add(", i);
        }
        break;
      case OP_subtract:
        this.assign(i);
        this.binary(i, " - ");
        break;
      case OP_multiply:
        this.assign(i);
        this.binary(i, " * ");
        break;
      case OP_divide:
        this.assign(i);
        this.binary(i, " / ");
        break;
      case OP_modulo:
        this.assign(i);
        this.binary(i, " % ");
        break;
      case OP_add_i:
        this.assign(i);
        this.binaryInt(i, " + ");
        break;
      case OP_subtract_i:
        this.assign(i);
        this.binaryInt(i, " - ");
        break;
      case OP_multiply_i:
        // int multiplication wraps as Math.imul does, not as a double product.
        this.assign(i);
        this.call2("Math.imul(", i);
        break;
      case OP_bitand:
        this.assign(i);
        this.binary(i, " & ");
        break;
      case OP_bitor:
        this.assign(i);
        this.binary(i, " | ");
        break;
      case OP_bitxor:
        this.assign(i);
        this.binary(i, " ^ ");
        break;
      case OP_lshift:
        this.assign(i);
        this.binary(i, " << ");
        break;
      case OP_rshift:
        this.assign(i);
        this.binary(i, " >> ");
        break;
      case OP_urshift:
        this.assign(i);
        this.binary(i, " >>> ");
        break;
      case OP_bitnot:
        this.assign(i);
        out.text("~");
        this.reg(ir.src[i]);
        break;
      case OP_negate:
        this.assign(i);
        out.text("-");
        this.reg(ir.src[i]);
        break;
      case OP_negate_i:
        this.assign(i);
        out.text("-");
        this.reg(ir.src[i]);
        out.text(" | 0");
        break;
      case OP_increment:
      case OP_decrement:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === OP_increment ? " + 1" : " - 1");
        break;
      case OP_increment_i:
      case OP_decrement_i:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === OP_increment_i ? " + 1 | 0" : " - 1 | 0");
        break;
      case OP_inclocal:
      case OP_declocal:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === OP_inclocal ? " + 1" : " - 1");
        break;
      case OP_inclocal_i:
      case OP_declocal_i:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === OP_inclocal_i ? " + 1 | 0" : " - 1 | 0");
        break;
      case OP_not:
        this.assign(i);
        out.text("!");
        this.reg(ir.src[i]);
        break;
      case OP_typeof:
        this.assign(i);
        out.text("rt.typeOf(");
        this.reg(ir.src[i]);
        out.text(")");
        break;
      case OP_equals:
        this.assign(i);
        this.call2("rt.equals(", i);
        break;
      case OP_strictequals:
        this.assign(i);
        this.call2("rt.strictEquals(", i);
        break;
      case OP_lessthan:
        this.assign(i);
        this.call2("rt.lessThan(", i);
        break;
      case OP_lessequals:
        this.assign(i);
        this.call2("rt.lessEquals(", i);
        break;
      case OP_greaterthan:
        this.assign(i);
        this.call2("rt.greaterThan(", i);
        break;
      case OP_greaterequals:
        this.assign(i);
        this.call2("rt.greaterEquals(", i);
        break;
      case OP_convert_i:
      case OP_coerce_i:
      case OP_convert_u:
      case OP_coerce_u:
      case OP_convert_d:
      case OP_coerce_d:
      case OP_convert_b:
      case OP_coerce_b:
      case OP_convert_s:
      case OP_coerce_s:
      case OP_coerce_a:
      case OP_coerce_o:
      case OP_coerce:
      case OP_convert_o:
        this.assign(i);
        this.conversion(i, <u8>op);
        break;
      case OP_jump:
        out.text("    ");
        this.goto(a);
        break;
      case OP_iftrue:
      case OP_iffalse:
        out.text(op === OP_iftrue ? "    if (" : "    if (!");
        this.reg(ir.src[i]);
        out.text(") { ");
        this.goto(a);
        out.text(" }");
        break;
      case OP_ifeq:
      case OP_ifne:
      case OP_ifstricteq:
      case OP_ifstrictne:
      case OP_iflt:
      case OP_ifle:
      case OP_ifgt:
      case OP_ifge:
      case OP_ifnlt:
      case OP_ifnle:
      case OP_ifngt:
      case OP_ifnge:
        this.branch(i, <u8>op);
        break;
      case OP_lookupswitch: {
        // An index out of range, or not an int, takes the default.
        out.text("    switch (");
        this.reg(ir.src[i]);
        out.text(") {");
        const first = ir.b[i];
        for (let c: u32 = 0; c <= <u32>ir.c[i]; c++) {
          out.text(" case ");
          out.uint(c);
          out.text(": ");
          this.goto(ir.cases[first + c]);
        }

        out.text(" default: ");
        this.goto(a);
        out.text(" }");
        break;
      }
      case OP_returnvoid:
        out.text("    return undefined");
        break;
      case OP_returnvalue:
        out.text("    return ");
        this.reg(ir.src[i]);
        break;
      case OP_throw:
        out.text("    throw ");
        this.reg(ir.src[i]);
        break;
      default:
        if (op >= OP_getlocal0 && op < OP_getlocal0 + 4) {
          this.assign(i);
          this.reg(ir.src[i]);
          break;
        }

        if (op >= OP_setlocal0 && op < OP_setlocal0 + 4) {
          this.assign(i);
          this.reg(ir.src[i]);
          break;
        }

        out.text("    ");
        if (ir.dst[i] >= 0) {
          this.reg(ir.dst[i]);
          out.text(" = ");
        }

        out.text('rt.unsupported("');
        out.text(op < 256 ? opcodeNames[op] : "ir");
        out.text('")');
        break;
    }

    out.text(";\n");
  }

  isNumber(r: i32): bool {
    const bt = this.builtinOf(r);
    return bt === BUILTIN_Int || bt === BUILTIN_Uint || bt === BUILTIN_Number;
  }

  binary(i: u32, operator: string): void {
    this.reg(this.src(i, 0));
    this.out.text(operator);
    this.reg(this.src(i, 1));
  }

  binaryInt(i: u32, operator: string): void {
    this.binary(i, operator);
    this.out.text(" | 0");
  }

  call2(fn: string, i: u32): void {
    this.out.text(fn);
    this.reg(this.src(i, 0));
    this.out.text(", ");
    this.reg(this.src(i, 1));
    this.out.text(")");
  }

  /** A conditional branch comparing two values; the `n` forms are true when the comparison is not. */
  branch(i: u32, op: u8): void {
    const out = this.out;
    out.text("    if (");
    switch (op) {
      case OP_ifeq:
        this.call2("rt.equals(", i);
        break;
      case OP_ifne:
        this.call2("!rt.equals(", i);
        break;
      case OP_ifstricteq:
        this.call2("rt.strictEquals(", i);
        break;
      case OP_ifstrictne:
        this.call2("!rt.strictEquals(", i);
        break;
      case OP_iflt:
        this.call2("rt.lessThan(", i);
        break;
      case OP_ifle:
        this.call2("rt.lessEquals(", i);
        break;
      case OP_ifgt:
        this.call2("rt.greaterThan(", i);
        break;
      case OP_ifge:
        this.call2("rt.greaterEquals(", i);
        break;
      case OP_ifnlt:
        this.call2("!rt.lessThan(", i);
        break;
      case OP_ifnle:
        this.call2("!rt.lessEquals(", i);
        break;
      case OP_ifngt:
        this.call2("!rt.greaterThan(", i);
        break;
      default:
        this.call2("!rt.greaterEquals(", i);
        break;
    }

    out.text(") { ");
    this.goto(this.ir.a[i]);
    out.text(" }");
  }

  /** The conversion instructions: the value of src as the type they give. */
  conversion(i: u32, op: u8): void {
    const domain = this.domain;
    const src = this.ir.src[i];
    const from = this.regType[src];
    switch (op) {
      case OP_convert_i:
      case OP_coerce_i:
        this.convert("", src, domain.intType, from);
        break;
      case OP_convert_u:
      case OP_coerce_u:
        this.convert("", src, domain.uintType, from);
        break;
      case OP_convert_d:
      case OP_coerce_d:
        this.convert("", src, domain.numberType, from);
        break;
      case OP_convert_b:
      case OP_coerce_b:
        this.convert("", src, domain.booleanType, from);
        break;
      case OP_convert_s:
        // Unlike coerce_s, null and undefined become "null" and "undefined".
        this.out.text("rt.toString(");
        this.reg(src);
        this.out.text(")");
        break;
      case OP_coerce_s:
        this.convert("", src, domain.stringType, from);
        break;
      case OP_convert_o:
        this.out.text("rt.toObject(");
        this.reg(src);
        this.out.text(")");
        break;
      case OP_coerce_o:
        this.convert("", src, domain.objectType(), from);
        break;
      case OP_coerce:
        this.convert("", src, this.ir.c[i], from);
        break;
      default:
        this.reg(src);
        break;
    }
  }

  /**
   * Register r (or `prefix` + r, for a parameter) converted to `type` from
   * `from`, as avmplus' coercions: nothing when it is that type already,
   * plain JavaScript for numbers and booleans, the runtime otherwise.
   */
  convert(prefix: string, r: i32, type: i32, from: i32): void {
    const out = this.out;
    const domain = this.domain;
    const bt = domain.builtin(type);
    const fromBt = domain.builtin(from);
    if (type === from || bt === BUILTIN_Any) {
      this.operand(prefix, r);
      return;
    }

    const numeric = fromBt === BUILTIN_Int || fromBt === BUILTIN_Uint || fromBt === BUILTIN_Number;
    switch (bt) {
      case BUILTIN_Int:
        if (numeric || fromBt === BUILTIN_Boolean) {
          this.operand(prefix, r);
          out.text(" | 0");
        } else {
          out.text("rt.toInt(");
          this.operand(prefix, r);
          out.text(")");
        }
        return;
      case BUILTIN_Uint:
        if (numeric || fromBt === BUILTIN_Boolean) {
          this.operand(prefix, r);
          out.text(" >>> 0");
        } else {
          out.text("rt.toUint(");
          this.operand(prefix, r);
          out.text(")");
        }
        return;
      case BUILTIN_Number:
        if (numeric) {
          this.operand(prefix, r);
        } else {
          out.text("rt.toNumber(");
          this.operand(prefix, r);
          out.text(")");
        }
        return;
      case BUILTIN_Boolean:
        out.text("!!");
        this.operand(prefix, r);
        return;
      case BUILTIN_String:
        out.text("rt.coerceString(");
        this.operand(prefix, r);
        out.text(")");
        return;
      case BUILTIN_Object:
        out.text("rt.coerceObject(");
        this.operand(prefix, r);
        out.text(")");
        return;
      default:
        out.text("rt.coerce(");
        this.operand(prefix, r);
        out.text(", ");
        this.typeRef(type);
        out.text(")");
    }
  }

  operand(prefix: string, r: i32): void {
    if (prefix.length) {
      this.out.text(prefix);
      this.out.uint(<u64>r);
    } else {
      this.reg(r);
    }
  }

  /** A reference to type t for the runtime. */
  typeRef(t: i32): void {
    this.out.text("rt.type(");
    this.out.int(t);
    this.out.text(")");
  }

  /** Pool string `index` as a JavaScript string literal. */
  string(index: u32): void {
    const pool = this.abc.pool;
    this.out.string(this.base + pool.stringStart[index], pool.stringLength[index]);
  }

  /**
   * A constant of default-value kind `kind`, index `value`, for a slot or
   * parameter of `type`; value 0 is the type's own default.
   */
  constant(value: u32, kind: u8, type: i32): void {
    const out = this.out;
    const pool = this.abc.pool;
    if (value === 0) {
      this.defaultOf(type);
      return;
    }

    switch (kind) {
      case 0x03:
        out.int(pool.ints[value]);
        return;
      case 0x04:
        out.uint(pool.uints[value]);
        return;
      case 0x06:
        out.double(pool.doubles[value]);
        return;
      case 0x01:
        this.string(value);
        return;
      case 0x0a:
        out.text("false");
        return;
      case 0x0b:
        out.text("true");
        return;
      case 0x0c:
        out.text("null");
        return;
      default:
        out.text("rt.namespace(");
        out.uint(value);
        out.text(")");
        return;
    }
  }

  /** The value a slot or parameter of `type` has before anything is stored. */
  defaultOf(type: i32): void {
    const out = this.out;
    switch (this.domain.builtin(type)) {
      case BUILTIN_Any:
        out.text("undefined");
        return;
      case BUILTIN_Int:
      case BUILTIN_Uint:
        out.text("0");
        return;
      case BUILTIN_Number:
        out.text("NaN");
        return;
      case BUILTIN_Boolean:
        out.text("false");
        return;
      default:
        out.text("null");
        return;
    }
  }
}
