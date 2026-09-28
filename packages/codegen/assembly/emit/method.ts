// Writes one method's IR as a JavaScript function whose blocks run in a
// dispatcher: `for (;;) switch (b) { case 0: ... }`. Registers are `let`
// variables named as the IR names them (l0, sc0, s0), and the runtime is
// `rt` in the enclosing module.
//
// Typed lowering starts simple: what the IR's types make certain is plain
// JavaScript (int arithmetic ends in `| 0`), anything else calls the
// runtime, which does what avmplus does at run time.
import { Abc } from "../abc/abc";
import {
  CONSTANT_Multiname,
  CONSTANT_MultinameL,
  CONSTANT_MultinameLA,
  CONSTANT_RTQname,
  CONSTANT_RTQnameA,
  CONSTANT_RTQnameL,
  CONSTANT_RTQnameLA,
  CONSTANT_TypeName,
  METHOD_NeedArguments,
  METHOD_NeedRest,
} from "../abc/constants";
import * as ops from "../abc/opcodes";
import { opcodeNames } from "../abc/opcodes";
import {
  IR_CallGetter,
  IR_CallInterface,
  IR_CallSetter,
  IR_CheckNull,
  IR_Coerce,
  IR_FindPropGlobal,
  IR_FindPropGlobalStrict,
  IR_GetGlobalScope,
  IR_Nip,
  Ir,
} from "../ir/ir";
import { Domain, URI_None } from "../link/domain";
import {
  BUILTIN_Any,
  BUILTIN_Boolean,
  BUILTIN_Int,
  BUILTIN_Number,
  BUILTIN_Object,
  BUILTIN_String,
  BUILTIN_Uint,
  TRAITS_Instance,
  TraitsTable,
  TYPE_Any,
} from "../link/traits";
import { Output } from "./output";

@final
export class MethodEmitter {
  out: Output = new Output();
  /** Each register's type as the instruction being written reads it. */
  regType: StaticArray<i32> = new StaticArray<i32>(0);
  /** Which local scope registers hold with scopes, and how many are pushed. */
  scopeWith: StaticArray<u8> = new StaticArray<u8>(0);
  scopeDepth: u32 = 0;
  /** The method being written: its ABC index and body. */
  current: u32 = 0;
  body: i32 = -1;
  /**
   * The ABC offsets where the set of handlers covering an instruction can
   * change, sorted; region r is from bounds[r - 1] up to bounds[r]. `t` in
   * the generated code is the region of the instruction running.
   */
  bounds: StaticArray<u32> = new StaticArray<u32>(0);
  /** Whether a handler covers region r + 1; a region none covers is region 0. */
  covered: StaticArray<u8> = new StaticArray<u8>(0);
  boundCount: u32 = 0;
  region: i32 = -1;

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
    this.current = method;
    this.body = this.abc.methodBody[method];
    if (<u32>this.regType.length < ir.frameSize) {
      this.regType = new StaticArray<i32>(ir.frameSize);
    }

    if (<u32>this.scopeWith.length < ir.maxScope) {
      this.scopeWith = new StaticArray<u8>(ir.maxScope);
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
    const handled = ir.handlerCount > 0;
    if (handled) {
      this.regions();
      out.text("  let b = 0, t = 0;\n  for (;;) try { switch (b) {\n");
    } else {
      out.text("  let b = 0;\n  for (;;) switch (b) {\n");
    }

    for (let k: u32 = 0; k < ir.blockCount; k++) {
      this.block(k);
    }

    // The verifier proved every block ends; a dispatcher still needs an end.
    out.text("  default: throw rt.unreachable();\n  }");
    if (handled) {
      out.text(" } catch (e) {\n");
      this.handlers();
      out.text("  }");
    }

    out.text("\n}");
  }

  /** The bounds of the method's handler regions: every handler's from and to, sorted, once each. */
  regions(): void {
    const ir = this.ir;
    const count = ir.handlerCount * 2;
    if (<u32>this.bounds.length < count) {
      this.bounds = new StaticArray<u32>(count);
    }

    const bounds = this.bounds;
    let n: u32 = 0;
    for (let h: u32 = 0; h < count; h++) {
      const pc = h & 1 ? ir.handlerTo[h >> 1] : ir.handlerFrom[h >> 1];
      // Insert in order, skipping one already there.
      let at = n;
      while (at > 0 && bounds[at - 1] > pc) {
        at--;
      }

      if (at > 0 && bounds[at - 1] === pc) {
        continue;
      }

      for (let k = n; k > at; k--) {
        bounds[k] = bounds[k - 1];
      }

      bounds[at] = pc;
      n++;
    }

    this.boundCount = n;
    if (<u32>this.covered.length < n) {
      this.covered = new StaticArray<u8>(n);
    }

    for (let r: u32 = 1; r < n; r++) {
      const start = bounds[r - 1];
      let covered: u8 = 0;
      for (let h: u32 = 0; h < ir.handlerCount; h++) {
        if (start >= ir.handlerFrom[h] && start < ir.handlerTo[h]) {
          covered = 1;
          break;
        }
      }

      this.covered[r - 1] = covered;
    }
  }

  /** The handler region of ABC offset `pc`: how many bounds are at or before it, or 0 if none covers it. */
  regionOf(pc: u32): i32 {
    let lo: u32 = 0;
    let hi = this.boundCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.bounds[mid] <= pc) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    return lo > 0 && lo < this.boundCount && this.covered[lo - 1] ? <i32>lo : 0;
  }

  /**
   * The catch of the dispatcher: the handlers covering the region that
   * threw, in the order of the ABC's table, as avmplus finds them; the first
   * whose type the exception has gets it as its only stack value. With none,
   * the exception goes on to the caller.
   */
  handlers(): void {
    const out = this.out;
    const ir = this.ir;
    const bounds = this.bounds;
    const exception = <i32>(ir.localCount + ir.maxScope);
    out.text("    const x = rt.caught(e);\n    switch (t) {\n");
    for (let r: u32 = 1; r < this.boundCount; r++) {
      if (!this.covered[r - 1]) {
        continue;
      }

      const start = bounds[r - 1];
      let first = true;
      for (let h: u32 = 0; h < ir.handlerCount; h++) {
        if (start < ir.handlerFrom[h] || start >= ir.handlerTo[h]) {
          continue;
        }

        if (first) {
          out.text("    case ");
          out.uint(r);
          out.text(":\n");
          first = false;
        }

        const type = ir.handlerType[h];
        out.text("      ");
        if (type >= 0) {
          out.text("if (rt.catches(x, ");
          this.typeRef(type);
          out.text(")) ");
        }

        out.text("{ ");
        this.reg(exception);
        out.text(" = x; ");
        this.goto(ir.handlerBlock[h]);
        out.text(" }\n");
      }

      if (!first) {
        out.text("      break;\n");
      }
    }

    out.text("    }\n    throw e;\n");
  }

  /** Declare the registers: `this`, the parameters, coerced, with defaults, then the rest. */
  prologue(method: u32, global: u32, flags: u8): void {
    const out = this.out;
    const ir = this.ir;
    const traits = this.domain.traits;
    const abc = this.abc;
    const count = traits.paramCount[global];
    // The parameters with default values: an untyped function's others are
    // optional too, as avmplus' are, but a missing one is just undefined.
    const optional = abc.methodOptionalStart[method + 1] - abc.methodOptionalStart[method];
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
      out.text(" = rt.arguments(arguments)");
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

    this.scopeDepth = ir.blockScope[k];
    for (let d: u32 = 0; d < this.scopeDepth; d++) {
      this.scopeWith[d] = (ir.entryFlags[entry + ir.localCount + d] & 2) >> 1;
    }

    // A block may be entered from any region, so it sets its own first.
    const handled = ir.handlerCount > 0;
    this.region = -1;
    const last = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
    for (let i = ir.blockFirst[k]; i < last; i++) {
      if (handled) {
        const region = this.regionOf(ir.pc[i]);
        if (region !== this.region) {
          out.text("    t = ");
          out.int(region);
          out.text(";\n");
          this.region = region;
        }
      }

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
      case ops.OP_pushbyte:
      case ops.OP_pushshort:
        this.assign(i);
        out.int(<i32>a);
        break;
      case ops.OP_pushint:
        this.assign(i);
        out.int(this.abc.pool.ints[a]);
        break;
      case ops.OP_pushuint:
        this.assign(i);
        out.uint(this.abc.pool.uints[a]);
        break;
      case ops.OP_pushdouble:
        this.assign(i);
        out.double(this.abc.pool.doubles[a]);
        break;
      case ops.OP_pushnan:
        this.assign(i);
        out.text("NaN");
        break;
      case ops.OP_pushstring:
        this.assign(i);
        this.string(a);
        break;
      case ops.OP_pushtrue:
        this.assign(i);
        out.text("true");
        break;
      case ops.OP_pushfalse:
        this.assign(i);
        out.text("false");
        break;
      case ops.OP_pushnull:
        this.assign(i);
        out.text("null");
        break;
      case ops.OP_pushundefined:
        this.assign(i);
        out.text("undefined");
        break;
      case ops.OP_getlocal:
      case ops.OP_setlocal:
      case ops.OP_dup:
        this.assign(i);
        this.reg(ir.src[i]);
        break;
      case ops.OP_kill:
        this.assign(i);
        out.text("undefined");
        break;
      case ops.OP_swap: {
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
      case ops.OP_pop:
      case ops.OP_debug:
      case ops.OP_debugline:
      case ops.OP_debugfile:
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
      case ops.OP_add:
        this.assign(i);
        if (this.isNumber(this.src(i, 0)) && this.isNumber(this.src(i, 1))) {
          this.binary(i, " + ");
        } else {
          this.call2("rt.add(", i);
        }
        break;
      case ops.OP_subtract:
        this.assign(i);
        this.binary(i, " - ");
        break;
      case ops.OP_multiply:
        this.assign(i);
        this.binary(i, " * ");
        break;
      case ops.OP_divide:
        this.assign(i);
        this.binary(i, " / ");
        break;
      case ops.OP_modulo:
        this.assign(i);
        this.binary(i, " % ");
        break;
      case ops.OP_add_i:
        this.assign(i);
        this.binaryInt(i, " + ");
        break;
      case ops.OP_subtract_i:
        this.assign(i);
        this.binaryInt(i, " - ");
        break;
      case ops.OP_multiply_i:
        // int multiplication wraps as Math.imul does, not as a double product.
        this.assign(i);
        this.call2("Math.imul(", i);
        break;
      case ops.OP_bitand:
        this.assign(i);
        this.binary(i, " & ");
        break;
      case ops.OP_bitor:
        this.assign(i);
        this.binary(i, " | ");
        break;
      case ops.OP_bitxor:
        this.assign(i);
        this.binary(i, " ^ ");
        break;
      case ops.OP_lshift:
        this.assign(i);
        this.binary(i, " << ");
        break;
      case ops.OP_rshift:
        this.assign(i);
        this.binary(i, " >> ");
        break;
      case ops.OP_urshift:
        this.assign(i);
        this.binary(i, " >>> ");
        break;
      case ops.OP_bitnot:
        this.assign(i);
        out.text("~");
        this.reg(ir.src[i]);
        break;
      case ops.OP_negate:
        this.assign(i);
        out.text("-");
        this.reg(ir.src[i]);
        break;
      case ops.OP_negate_i:
        this.assign(i);
        out.text("-");
        this.reg(ir.src[i]);
        out.text(" | 0");
        break;
      case ops.OP_increment:
      case ops.OP_decrement:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === ops.OP_increment ? " + 1" : " - 1");
        break;
      case ops.OP_increment_i:
      case ops.OP_decrement_i:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === ops.OP_increment_i ? " + 1 | 0" : " - 1 | 0");
        break;
      case ops.OP_inclocal:
      case ops.OP_declocal:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === ops.OP_inclocal ? " + 1" : " - 1");
        break;
      case ops.OP_inclocal_i:
      case ops.OP_declocal_i:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === ops.OP_inclocal_i ? " + 1 | 0" : " - 1 | 0");
        break;
      case ops.OP_not:
        this.assign(i);
        out.text("!");
        this.reg(ir.src[i]);
        break;
      case ops.OP_typeof:
        this.assign(i);
        out.text("rt.typeOf(");
        this.reg(ir.src[i]);
        out.text(")");
        break;
      case ops.OP_equals:
        this.assign(i);
        this.call2("rt.equals(", i);
        break;
      case ops.OP_strictequals:
        this.assign(i);
        this.call2("rt.strictEquals(", i);
        break;
      case ops.OP_lessthan:
        this.assign(i);
        this.call2("rt.lessThan(", i);
        break;
      case ops.OP_lessequals:
        this.assign(i);
        this.call2("rt.lessEquals(", i);
        break;
      case ops.OP_greaterthan:
        this.assign(i);
        this.call2("rt.greaterThan(", i);
        break;
      case ops.OP_greaterequals:
        this.assign(i);
        this.call2("rt.greaterEquals(", i);
        break;
      case ops.OP_convert_i:
      case ops.OP_coerce_i:
      case ops.OP_convert_u:
      case ops.OP_coerce_u:
      case ops.OP_convert_d:
      case ops.OP_coerce_d:
      case ops.OP_convert_b:
      case ops.OP_coerce_b:
      case ops.OP_convert_s:
      case ops.OP_coerce_s:
      case ops.OP_coerce_a:
      case ops.OP_coerce_o:
      case ops.OP_coerce:
      case ops.OP_convert_o:
        this.assign(i);
        this.conversion(i, <u8>op);
        break;
      case ops.OP_jump:
        out.text("    ");
        this.goto(a);
        break;
      case ops.OP_iftrue:
      case ops.OP_iffalse:
        out.text(op === ops.OP_iftrue ? "    if (" : "    if (!");
        this.reg(ir.src[i]);
        out.text(") { ");
        this.goto(a);
        out.text(" }");
        break;
      case ops.OP_ifeq:
      case ops.OP_ifne:
      case ops.OP_ifstricteq:
      case ops.OP_ifstrictne:
      case ops.OP_iflt:
      case ops.OP_ifle:
      case ops.OP_ifgt:
      case ops.OP_ifge:
      case ops.OP_ifnlt:
      case ops.OP_ifnle:
      case ops.OP_ifngt:
      case ops.OP_ifnge:
        this.branch(i, <u8>op);
        break;
      case ops.OP_lookupswitch: {
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
      case ops.OP_returnvoid:
        out.text("    return undefined");
        break;
      case ops.OP_returnvalue:
        out.text("    return ");
        this.reg(ir.src[i]);
        break;
      case ops.OP_throw:
        out.text("    throw ");
        this.reg(ir.src[i]);
        break;
      default:
        if (this.object(i, op)) {
          break;
        }

        if (op >= ops.OP_getlocal0 && op < ops.OP_getlocal0 + 4) {
          this.assign(i);
          this.reg(ir.src[i]);
          break;
        }

        if (op >= ops.OP_setlocal0 && op < ops.OP_setlocal0 + 4) {
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

  /**
   * The instructions of the object model: scopes, names, properties, calls,
   * and creating objects, functions and classes; false for one it does not
   * know, which then calls rt.unsupported.
   */
  object(i: u32, op: u16): bool {
    const out = this.out;
    const ir = this.ir;
    const a = ir.a[i];
    const src = ir.src[i];
    switch (op) {
      case ops.OP_pushscope:
      case ops.OP_pushwith:
        this.scopeWith[this.scopeDepth++] = op === ops.OP_pushwith ? 1 : 0;
        this.assign(i);
        this.reg(src);
        return true;
      case ops.OP_popscope:
        this.scopeDepth--;
        out.text("    ");
        this.reg(src);
        out.text(" = undefined");
        return true;
      case ops.OP_getscopeobject:
        this.assign(i);
        this.reg(src);
        return true;
      case ops.OP_getouterscope:
        this.assign(i);
        out.text("scope[");
        out.uint(a);
        out.text("]");
        return true;
      case ops.OP_getglobalscope:
      case IR_GetGlobalScope:
        this.assign(i);
        this.globalScope();
        return true;
      case ops.OP_finddef:
        this.assign(i);
        out.text("rt.findDef(M[");
        out.uint(a);
        out.text("])");
        return true;
      case IR_FindPropGlobal:
      case IR_FindPropGlobalStrict:
        this.assign(i);
        // Not found statically: a script's name, or else the global object's.
        out.text(op === IR_FindPropGlobalStrict ? "rt.findGlobalStrict(M[" : "rt.findGlobal(M[");
        out.uint(a);
        out.text("], ");
        this.globalScope();
        out.text(")");
        return true;
      case ops.OP_findproperty:
      case ops.OP_findpropstrict:
        this.assign(i);
        out.text(op === ops.OP_findpropstrict ? "rt.findPropertyStrict(" : "rt.findProperty(");
        this.name(a, src);
        out.text(", scope, ");
        this.localScopes();
        out.text(")");
        return true;
      case ops.OP_getslot:
        this.assign(i);
        this.reg(src);
        out.text(".$");
        out.uint(a);
        return true;
      case ops.OP_setslot:
        out.text("    ");
        this.reg(src);
        out.text(".$");
        out.uint(a);
        out.text(" = ");
        this.reg(src + 1);
        return true;
      case ops.OP_getglobalslot:
        this.assign(i);
        this.globalScope();
        out.text(".$");
        out.uint(a);
        return true;
      case ops.OP_setglobalslot:
        out.text("    ");
        this.globalScope();
        out.text(".$");
        out.uint(a);
        out.text(" = ");
        this.reg(src);
        return true;
      case IR_CallGetter:
        this.assign(i);
        this.virtual(a, src, 0);
        return true;
      case IR_CallSetter:
        out.text("    ");
        this.virtual(a, src, 1);
        return true;
      case ops.OP_callmethod:
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        this.virtual(a, src, ir.b[i]);
        return true;
      case IR_CallInterface:
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        // By the interface's dispatch id, which its layout maps to a name.
        out.text("rt.callInterface(");
        this.typeRef(this.regType[src]);
        out.text(", ");
        out.uint(a);
        out.text(", ");
        this.reg(src);
        this.args(src + 1, ir.b[i]);
        out.text(")");
        return true;
      case IR_Nip:
        this.assign(i);
        this.reg(src + <i32>ir.srcCount[i] - 1);
        return true;
      case ops.OP_getproperty:
        this.assign(i);
        out.text("rt.getProperty(");
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        out.text(")");
        return true;
      case ops.OP_setproperty:
      case ops.OP_initproperty: {
        out.text(op === ops.OP_initproperty ? "    rt.initProperty(" : "    rt.setProperty(");
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        out.text(", ");
        this.reg(src + <i32>ir.srcCount[i] - 1);
        out.text(")");
        return true;
      }
      case ops.OP_deleteproperty:
        this.assign(i);
        out.text("rt.deleteProperty(");
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        out.text(")");
        return true;
      case ops.OP_in:
        this.assign(i);
        // `name in object`.
        this.call2("rt.in(", i);
        return true;
      case ops.OP_callproperty:
      case ops.OP_callproplex:
      case ops.OP_callpropvoid:
      case ops.OP_constructprop: {
        const argc = ir.b[i];
        const parts = ir.srcCount[i] - 1 - argc;
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        out.text(
          op === ops.OP_constructprop
            ? "rt.constructProperty("
            : op === ops.OP_callproplex
              ? "rt.callPropLex("
              : "rt.callProperty(",
        );
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        this.args(src + 1 + <i32>parts, argc);
        out.text(")");
        return true;
      }
      case ops.OP_callsuper:
      case ops.OP_callsupervoid:
      case ops.OP_getsuper:
      case ops.OP_setsuper: {
        const argc = op === ops.OP_getsuper ? 0 : op === ops.OP_setsuper ? 1 : ir.b[i];
        const parts = ir.srcCount[i] - 1 - argc;
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        out.text(
          op === ops.OP_getsuper
            ? "rt.getSuper(sup, "
            : op === ops.OP_setsuper
              ? "rt.setSuper(sup, "
              : "rt.callSuper(sup, ",
        );
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        this.args(src + 1 + <i32>parts, argc);
        out.text(")");
        return true;
      }
      case ops.OP_constructsuper:
        out.text("    rt.constructSuper(sup, ");
        this.reg(src);
        this.args(src + 1, a);
        out.text(")");
        return true;
      case ops.OP_construct:
        this.assign(i);
        out.text("rt.construct(");
        this.reg(src);
        this.args(src + 1, a);
        out.text(")");
        return true;
      case ops.OP_call:
        this.assign(i);
        out.text("rt.call(");
        this.reg(src);
        out.text(", ");
        this.reg(src + 1);
        this.args(src + 2, a);
        out.text(")");
        return true;
      case ops.OP_callstatic:
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        out.text("rt.callStatic(A, ");
        out.uint(a);
        out.text(", ");
        this.reg(src);
        this.args(src + 1, ir.b[i]);
        out.text(")");
        return true;
      case ops.OP_newfunction:
        this.assign(i);
        out.text("rt.newFunction(F[");
        out.uint(a);
        out.text("], ");
        this.scopeHere();
        out.text(")");
        return true;
      case ops.OP_newclass:
        this.assign(i);
        out.text("rt.newClass(A.classes[");
        out.uint(a);
        out.text("], ");
        this.reg(src);
        out.text(", ");
        this.scopeHere();
        out.text(")");
        return true;
      case ops.OP_newactivation:
        this.assign(i);
        out.text("rt.newActivation(A.activations[");
        out.int(this.body);
        out.text("])");
        return true;
      case ops.OP_newcatch: {
        const abc = this.abc;
        const h = abc.bodyExceptionStart[this.body] + a;
        this.assign(i);
        out.text("rt.newCatch(M[");
        out.uint(abc.exceptionName[h]);
        out.text("])");
        return true;
      }
      case ops.OP_newobject:
        this.assign(i);
        out.text("rt.newObject([");
        this.list(src, ir.srcCount[i]);
        out.text("])");
        return true;
      case ops.OP_newarray:
        this.assign(i);
        out.text("rt.newArray([");
        this.list(src, ir.srcCount[i]);
        out.text("])");
        return true;
      case ops.OP_applytype:
        this.assign(i);
        out.text("rt.applyType(");
        this.reg(src);
        out.text(", [");
        this.list(src + 1, a);
        out.text("])");
        return true;
      case ops.OP_hasnext:
        this.assign(i);
        this.call2("rt.hasNext(", i);
        return true;
      case ops.OP_hasnext2: {
        // hasnext2 updates its two locals: the object and the index.
        const b = ir.b[i];
        out.text("    [");
        this.reg(ir.dst[i]);
        out.text(", ");
        this.reg(<i32>a);
        out.text(", ");
        this.reg(<i32>b);
        out.text("] = rt.hasNext2(");
        this.reg(<i32>a);
        out.text(", ");
        this.reg(<i32>b);
        out.text(")");
        return true;
      }
      case ops.OP_nextname:
        this.assign(i);
        this.call2("rt.nextName(", i);
        return true;
      case ops.OP_nextvalue:
        this.assign(i);
        this.call2("rt.nextValue(", i);
        return true;
      case ops.OP_instanceof:
        this.assign(i);
        this.call2("rt.instanceOf(", i);
        return true;
      case ops.OP_istypelate:
        this.assign(i);
        this.call2("rt.isTypeLate(", i);
        return true;
      case ops.OP_astypelate:
        this.assign(i);
        this.call2("rt.asTypeLate(", i);
        return true;
      case ops.OP_istype:
      case ops.OP_astype:
        this.assign(i);
        out.text(op === ops.OP_istype ? "rt.isType(" : "rt.asType(");
        this.reg(src);
        out.text(", M[");
        out.uint(a);
        out.text("])");
        return true;
      case ops.OP_checkfilter:
        out.text("    rt.checkFilter(");
        this.reg(src);
        out.text(")");
        return true;
      case ops.OP_esc_xelem:
      case ops.OP_esc_xattr:
        this.assign(i);
        out.text(op === ops.OP_esc_xelem ? "rt.escapeElement(" : "rt.escapeAttribute(");
        this.reg(src);
        out.text(")");
        return true;
      default:
        return false;
    }
  }

  /** The method's global object: its scope chain's first, else its own first scope. */
  globalScope(): void {
    if (this.ir.outerSize > 0) {
      this.out.text("scope[0]");
    } else {
      this.reg(<i32>this.ir.localCount);
    }
  }

  /** The scopes pushed so far, innermost last: [sc0, ...], with their with flags. */
  localScopes(): void {
    const out = this.out;
    out.text("[");
    let withs: u32 = 0;
    for (let d: u32 = 0; d < this.scopeDepth; d++) {
      if (d) {
        out.text(", ");
      }

      this.reg(<i32>(this.ir.localCount + d));
      withs |= (<u32>this.scopeWith[d]) << d;
    }

    out.text("], ");
    out.uint(withs);
  }

  /** The scope chain a function or class created here runs in. */
  scopeHere(): void {
    this.out.text("rt.scope(scope, ");
    this.localScopes();
    this.out.text(")");
  }

  /**
   * Multiname `a`: M[a], or with its runtime namespace and
   * name taken from the registers from `from`.
   */
  name(a: u32, from: i32): void {
    const out = this.out;
    const kind = this.abc.pool.mnKind[a];
    const parts =
      kind === CONSTANT_RTQnameL || kind === CONSTANT_RTQnameLA
        ? 2
        : kind === CONSTANT_RTQname ||
            kind === CONSTANT_RTQnameA ||
            kind === CONSTANT_MultinameL ||
            kind === CONSTANT_MultinameLA
          ? 1
          : 0;
    if (parts === 0) {
      out.text("M[");
      out.uint(a);
      out.text("]");
      return;
    }

    out.text("rt.runtimeName(M[");
    out.uint(a);
    out.text("]");
    for (let k: i32 = 0; k < parts; k++) {
      out.text(", ");
      this.reg(from + k);
    }

    out.text(")");
  }

  /** `, r, r+1, ...` for `count` arguments from register `from`. */
  args(from: i32, count: u32): void {
    for (let k: u32 = 0; k < count; k++) {
      this.out.text(", ");
      this.reg(from + <i32>k);
    }
  }

  list(from: i32, count: u32): void {
    for (let k: u32 = 0; k < count; k++) {
      if (k) {
        this.out.text(", ");
      }

      this.reg(from + <i32>k);
    }
  }

  /**
   * A call by dispatch id `disp` on the receiver in `src`, with `argc`
   * arguments after it: a method of the receiver's prototype, or for a
   * primitive receiver, of its class's.
   */
  virtual(disp: u32, src: i32, argc: u32): void {
    const out = this.out;
    const type = this.regType[src];
    const bt = this.builtinOf(src);
    const primitive =
      bt === BUILTIN_Int ||
      bt === BUILTIN_Uint ||
      bt === BUILTIN_Number ||
      bt === BUILTIN_Boolean ||
      bt === BUILTIN_String;
    if (primitive) {
      out.text("rt.prototypeOf(");
      this.typeRef(type);
      out.text(").$m");
      out.uint(disp);
      out.text(".call(");
      this.reg(src);
      this.args(src + 1, argc);
      out.text(")");
      return;
    }

    this.reg(src);
    out.text(".$m");
    out.uint(disp);
    out.text("(");
    this.list(src + 1, argc);
    out.text(")");
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
      case ops.OP_ifeq:
        this.call2("rt.equals(", i);
        break;
      case ops.OP_ifne:
        this.call2("!rt.equals(", i);
        break;
      case ops.OP_ifstricteq:
        this.call2("rt.strictEquals(", i);
        break;
      case ops.OP_ifstrictne:
        this.call2("!rt.strictEquals(", i);
        break;
      case ops.OP_iflt:
        this.call2("rt.lessThan(", i);
        break;
      case ops.OP_ifle:
        this.call2("rt.lessEquals(", i);
        break;
      case ops.OP_ifgt:
        this.call2("rt.greaterThan(", i);
        break;
      case ops.OP_ifge:
        this.call2("rt.greaterEquals(", i);
        break;
      case ops.OP_ifnlt:
        this.call2("!rt.lessThan(", i);
        break;
      case ops.OP_ifnle:
        this.call2("!rt.lessEquals(", i);
        break;
      case ops.OP_ifngt:
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
      case ops.OP_convert_i:
      case ops.OP_coerce_i:
        this.convert("", src, domain.intType, from);
        break;
      case ops.OP_convert_u:
      case ops.OP_coerce_u:
        this.convert("", src, domain.uintType, from);
        break;
      case ops.OP_convert_d:
      case ops.OP_coerce_d:
        this.convert("", src, domain.numberType, from);
        break;
      case ops.OP_convert_b:
      case ops.OP_coerce_b:
        this.convert("", src, domain.booleanType, from);
        break;
      case ops.OP_convert_s:
        // Unlike coerce_s, null and undefined become "null" and "undefined".
        this.out.text("rt.toString(");
        this.reg(src);
        this.out.text(")");
        break;
      case ops.OP_coerce_s:
        this.convert("", src, domain.stringType, from);
        break;
      case ops.OP_convert_o:
        this.out.text("rt.toObject(");
        this.reg(src);
        this.out.text(")");
        break;
      case ops.OP_coerce_o:
        this.convert("", src, domain.objectType(), from);
        break;
      case ops.OP_coerce:
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

  /**
   * A reference to type t for the runtime, by name, as types are known
   * across modules: null for *, a string for the builtin primitive types,
   * rt.cls(namespace, "Name") for a class, rt.vector(type) for Vector.<T>.
   */
  typeRef(t: i32): void {
    const out = this.out;
    const domain = this.domain;
    const traits = domain.traits;
    if (t < 0) {
      out.text("null");
      return;
    }

    switch (domain.builtin(t)) {
      case BUILTIN_Int:
        out.text('"int"');
        return;
      case BUILTIN_Uint:
        out.text('"uint"');
        return;
      case BUILTIN_Number:
        out.text('"Number"');
        return;
      case BUILTIN_Boolean:
        out.text('"Boolean"');
        return;
      case BUILTIN_String:
        out.text('"String"');
        return;
      case BUILTIN_Object:
        out.text('"Object"');
        return;
      default:
        break;
    }

    if (t === domain.voidType) {
      out.text('"void"');
    } else if (traits.kind[t] !== TRAITS_Instance) {
      out.text("null");
    } else if (traits.param[t] !== TYPE_Any) {
      out.text("rt.vector(");
      this.typeRef(traits.param[t]);
      out.text(")");
    } else {
      const index = traits.abc[t];
      const abc = domain.abcs[index];
      const pool = abc.pool;
      let mn = abc.instanceName[traits.owner[t]];
      if (pool.mnKind[mn] === CONSTANT_TypeName) {
        mn = pool.mnA[mn];
      }

      let ns = pool.mnA[mn];
      if (pool.mnKind[mn] === CONSTANT_Multiname) {
        ns = pool.nsSetMembers[pool.nsSetStart[ns]];
      }

      const name = domain.abcString[index][pool.mnB[mn]];
      out.text("rt.cls(");
      this.namespace(domain.abcNs[index][ns]);
      out.text(", ");
      out.string(domain.stringPtr[name], domain.stringLength[name]);
      out.text(")");
    }
  }

  /** A non-private namespace by its interned id, as rt.ns(type, uri). */
  namespace(id: u32): void {
    const out = this.out;
    out.text("rt.ns(");
    out.uint(this.domain.nsType[id]);
    out.text(", ");
    this.uri(this.domain.nsUri[id]);
    out.text(")");
  }

  uri(id: u32): void {
    if (id === URI_None) {
      this.out.text("null");
      return;
    }

    const domain = this.domain;
    this.out.string(domain.stringPtr[id], domain.stringLength[id]);
  }

  /** "uri::name", or just the name in a public namespace with an empty URI. */
  qualified(ns: u32, name: u32): string {
    const domain = this.domain;
    const nameText = String.UTF8.decodeUnsafe(domain.stringPtr[name], domain.stringLength[name]);
    const uri = domain.nsUri[ns];
    if (uri === URI_None) {
      return nameText;
    }

    const uriText = String.UTF8.decodeUnsafe(domain.stringPtr[uri], domain.stringLength[uri]);
    return uriText.length ? `${uriText}::${nameText}` : nameText;
  }

  /** The qualified name of the class traits t belong to. */
  className(traits: TraitsTable, t: u32): string {
    const domain = this.domain;
    const index = traits.abc[t];
    const abc = domain.abcs[index];
    const pool = abc.pool;
    let mn = abc.instanceName[traits.owner[t]];
    if (pool.mnKind[mn] === CONSTANT_TypeName) {
      mn = pool.mnA[mn];
    }

    let ns = pool.mnA[mn];
    if (pool.mnKind[mn] === CONSTANT_Multiname) {
      ns = pool.nsSetMembers[pool.nsSetStart[ns]];
    }

    return this.qualified(domain.abcNs[index][ns], domain.abcString[index][pool.mnB[mn]]);
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
        // A namespace, as the Namespace object it is to AS3.
        out.text("rt.namespace(N[");
        out.uint(value);
        out.text("])");
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
