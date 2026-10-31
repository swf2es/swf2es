// The method emitter's instructions: constants, locals and the stack,
// arithmetic, comparisons and conversions, branches, returns and throws,
// each as a JavaScript statement; those of the object model are in
// objects.ts. A null check is made where the instruction after it first
// reads the register, if it reads it first.

import * as ops from "../abc/opcodes";
import { opcodeNames } from "../abc/opcodes";
import {
  IR_CallGetter,
  IR_CallInterface,
  IR_CallSetter,
  IR_CheckNull,
  IR_Coerce,
  IR_ConstructSlot,
} from "../ir/ir";
import { TYPE_Any } from "../link/traits";
import { CONSTANT, getsLocal, NONE, pushesConstant } from "./copies";
import { floatOperation } from "./floats";
import { MethodEmitter } from "./method";
import { object } from "./objects";
import { poolString } from "./refs";
import { conditional } from "./structure";
import {
  binary,
  binaryInt,
  branch,
  call2,
  compare,
  concatenates,
  conversion,
  conversionType,
  convert,
  isNumeric,
  keeps,
  wraps,
} from "./values";

function floatArithmetic(em: MethodEmitter, i: u32): bool {
  const type = em.ir.type[i];
  return em.abc.hasFloatSupport && (type === TYPE_Any || type === em.domain.floatType);
}

function move(em: MethodEmitter, i: u32, src: i32): void {
  em.assign(i, true);
  if (em.unboxedTarget(i)) {
    em.numberReg(src);
  } else {
    em.reg(src);
  }
}

export function instruction(em: MethodEmitter, i: u32): void {
  const out = em.out;
  const ir = em.ir;
  const op = ir.op[i];
  const a = ir.a[i];
  em.unboxResult = false;
  em.rawResult = false;
  if (pushesConstant(op) && ir.dst[i] >= <i32>(ir.localCount + ir.maxScope)) {
    // Read as the literal until the register changes or a branch needs
    // it: V8 then gives the operation the constant in its own bytecode.
    em.setCopy(ir.dst[i], CONSTANT - <i32>i);
    em.kept = true;
    return;
  }

  if (floatOperation(em, i)) {
    out.text(";\n");
    return;
  }

  switch (op) {
    case ops.OP_pushbyte:
    case ops.OP_pushshort:
      em.assign(i);
      out.int(<i32>a);
      break;
    case ops.OP_pushint:
      em.assign(i);
      out.int(em.abc.pool.ints[a]);
      break;
    case ops.OP_pushuint:
      em.assign(i);
      out.uint(em.abc.pool.uints[a]);
      break;
    case ops.OP_pushfloat:
      em.assign(i);
      out.text("rt.float(");
      out.double(em.abc.pool.floats[a]);
      out.text(")");
      break;
    case ops.OP_pushdouble:
      em.assign(i);
      out.double(em.abc.pool.doubles[a]);
      break;
    case ops.OP_pushnan:
      em.assign(i);
      out.text("NaN");
      break;
    case ops.OP_pushstring:
      em.assign(i);
      poolString(em, a);
      break;
    case ops.OP_pushtrue:
      em.assign(i);
      out.text("true");
      break;
    case ops.OP_pushfalse:
      em.assign(i);
      out.text("false");
      break;
    case ops.OP_pushnull:
      em.assign(i);
      out.text("null");
      break;
    case ops.OP_pushnamespace:
      em.assign(i);
      out.text("rt.namespace(N[");
      out.uint(a);
      out.text("])");
      break;
    case ops.OP_pushundefined:
      em.assign(i);
      out.text("void 0");
      break;
    case ops.OP_getlocal:
    case ops.OP_setlocal:
    case ops.OP_dup:
      if (em.copies(i, ir.src[i])) {
        return;
      }

      move(em, i, ir.src[i]);
      break;
    case ops.OP_kill:
      em.reset(ir.dst[i]);
      break;
    case ops.OP_swap: {
      // Through a temporary, not [a, b] = [b, a]: destructuring is an
      // array and the iterator protocol, which V8 counts against inlining.
      const x = ir.src[i];
      out.text("{ const w = ");
      em.reg(x + 1);
      out.text("; ");
      em.regName(x + 1);
      out.text(" = ");
      em.reg(x);
      out.text("; ");
      em.regName(x);
      out.text(" = w; }");
      break;
    }
    case ops.OP_debugfile:
      em.file = <i32>a;
      return;
    case ops.OP_debugline:
      em.line = a;
      em.mark();
      return;
    case ops.OP_pop:
    case ops.OP_debug:
      return;
    case IR_Coerce:
      if (ir.dst[i] === ir.src[i] && keeps(em, ir.c[i], em.regType[ir.src[i]])) {
        em.kept = true;
        return;
      }

      em.assign(i, true);
      convert(em, "", ir.src[i], ir.c[i], em.regType[ir.src[i]], em.unboxedTarget(i));
      break;
    case IR_CheckNull: {
      // A register checked since it was last written is not null.
      const src = ir.src[i];
      const copy = em.copyOf[src];
      const r = copy === NONE ? src : copy;
      if (r >= 0) {
        if (em.checked[r]) {
          return;
        }

        em.checked[r] = 1;
      }

      // The instruction checked for reads it before it does anything,
      // and the check is there, as it reads it: `(r ?? nn(r)).$1`. Its
      // operands' conversions that change nothing may come between: each
      // of a register of its own, as the verifier coerces each operand
      // once, so the types they are kept by are the registers' now.
      let next = i + 1;
      while (
        next < em.blockLast &&
        ir.pc[next] === ir.pc[i] &&
        ir.op[next] === IR_Coerce &&
        ir.dst[next] === ir.src[next] &&
        keeps(em, ir.c[next], em.regType[ir.src[next]])
      ) {
        next++;
      }

      // Not a copy of a constant (copyOf below NONE), which has no name for unpend.
      if (
        copy >= NONE &&
        next < em.blockLast &&
        ir.pc[next] === ir.pc[i] &&
        readsFirst(ir.op[next])
      ) {
        em.pendingNull = src;
        em.pendingRead = copy === NONE ? src : copy;
        em.pendingUntil = next;
        em.pendingAt = out.length;
        em.pendingMarks = em.map.count;
        return;
      }

      em.checkedRead(src);
      break;
    }
    case ops.OP_add:
      em.assign(i);
      if ((isNumeric(em, em.src(i, 0)) && isNumeric(em, em.src(i, 1))) || concatenates(em, i)) {
        binary(em, i, " + ");
      } else {
        call2(em, "rt.add(", i);
      }
      break;
    case ops.OP_subtract:
      em.assign(i);
      if (floatArithmetic(em, i)) {
        call2(em, "rt.subtract(", i);
      } else {
        binary(em, i, " - ");
      }
      break;
    case ops.OP_multiply:
      em.assign(i);
      if (floatArithmetic(em, i)) {
        call2(em, "rt.multiply(", i);
      } else if (wraps(em, i)) {
        call2(em, "Math.imul(", i);
      } else {
        binary(em, i, " * ");
      }

      break;
    case ops.OP_divide:
      em.assign(i);
      if (floatArithmetic(em, i)) {
        call2(em, "rt.divide(", i);
      } else {
        binary(em, i, " / ");
      }
      break;
    case ops.OP_modulo:
      em.assign(i);
      if (floatArithmetic(em, i)) {
        call2(em, "rt.modulo(", i);
      } else {
        binary(em, i, " % ");
      }
      break;
    case ops.OP_add_i:
      em.assign(i);
      binaryInt(em, i, " + ");
      break;
    case ops.OP_subtract_i:
      em.assign(i);
      binaryInt(em, i, " - ");
      break;
    case ops.OP_multiply_i:
      // int multiplication wraps as Math.imul does, not as a double product.
      em.assign(i);
      call2(em, "Math.imul(", i);
      break;
    case ops.OP_bitand:
      em.assign(i);
      binary(em, i, " & ");
      break;
    case ops.OP_bitor:
      em.assign(i);
      binary(em, i, " | ");
      break;
    case ops.OP_bitxor:
      em.assign(i);
      binary(em, i, " ^ ");
      break;
    case ops.OP_lshift:
      em.assign(i);
      binary(em, i, " << ");
      break;
    case ops.OP_rshift:
      em.assign(i);
      binary(em, i, " >> ");
      break;
    case ops.OP_urshift:
      em.assign(i);
      binary(em, i, " >>> ");
      break;
    case ops.OP_bitnot:
      em.assign(i);
      out.text("~");
      em.reg(ir.src[i]);
      break;
    case ops.OP_unplus:
      em.assign(i);
      out.text("rt.toNumeric(");
      em.reg(ir.src[i]);
      out.text(")");
      break;
    case ops.OP_negate:
      em.assign(i);
      if (floatArithmetic(em, i)) {
        out.text("rt.negate(");
        em.reg(ir.src[i]);
        out.text(")");
        break;
      }
      out.text("-");
      em.reg(ir.src[i]);
      break;
    case ops.OP_negate_i:
      em.assign(i);
      out.text("-");
      em.reg(ir.src[i]);
      out.text(" | 0");
      break;
    case ops.OP_increment:
    case ops.OP_decrement:
      em.assign(i);
      if (floatArithmetic(em, i)) {
        out.text(op === ops.OP_increment ? "rt.increment(" : "rt.decrement(");
        em.reg(ir.src[i]);
        out.text(")");
        break;
      }
      em.reg(ir.src[i]);
      out.text(op === ops.OP_increment ? " + 1" : " - 1");
      break;
    case ops.OP_increment_i:
    case ops.OP_decrement_i:
      em.assign(i);
      em.reg(ir.src[i]);
      out.text(op === ops.OP_increment_i ? " + 1 | 0" : " - 1 | 0");
      break;
    case ops.OP_inclocal:
    case ops.OP_declocal:
      em.assign(i);
      if (floatArithmetic(em, i)) {
        out.text(op === ops.OP_inclocal ? "rt.increment(" : "rt.decrement(");
        em.reg(ir.src[i]);
        out.text(")");
        break;
      }
      em.reg(ir.src[i]);
      out.text(op === ops.OP_inclocal ? " + 1" : " - 1");
      break;
    case ops.OP_inclocal_i:
    case ops.OP_declocal_i:
      em.assign(i);
      em.reg(ir.src[i]);
      out.text(op === ops.OP_inclocal_i ? " + 1 | 0" : " - 1 | 0");
      break;
    case ops.OP_not:
      em.assign(i);
      out.text("!");
      em.reg(ir.src[i]);
      break;
    case ops.OP_typeof:
      em.assign(i);
      out.text("rt.typeOf(");
      em.reg(ir.src[i]);
      out.text(")");
      break;
    case ops.OP_equals:
    case ops.OP_strictequals:
    case ops.OP_lessthan:
    case ops.OP_lessequals:
    case ops.OP_greaterthan:
    case ops.OP_greaterequals:
      em.assign(i);
      compare(em, i, op, false);
      break;
    case ops.OP_convert_i:
    case ops.OP_coerce_i:
    case ops.OP_convert_u:
    case ops.OP_coerce_u:
    case ops.OP_convert_f:
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
      // A conversion that changes nothing, in place, is no code.
      if (
        ir.dst[i] === ir.src[i] &&
        keeps(em, conversionType(em, <u8>op, i), em.regType[ir.src[i]])
      ) {
        em.kept = true;
        return;
      }

      em.assign(i, true);
      conversion(em, i, <u8>op, em.unboxedTarget(i));
      break;
    case ops.OP_jump:
      em.goto(a);
      break;
    case ops.OP_iftrue:
    case ops.OP_iffalse:
      out.text(op === ops.OP_iftrue ? "if (" : "if (!");
      em.reg(ir.src[i]);
      out.text(") { ");
      em.goto(a);
      em.space();
      out.text("}");
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
      branch(em, i, <u8>op);
      break;
    case ops.OP_lookupswitch: {
      // An index out of range, or not an int, takes the default.
      out.text("switch (");
      em.reg(ir.src[i]);
      out.text(") {");
      const first = ir.b[i];
      for (let c: u32 = 0; c <= <u32>ir.c[i]; c++) {
        em.space();
        out.text("case ");
        out.uint(c);
        out.text(": ");
        em.goto(ir.cases[first + c]);
      }

      em.space();
      out.text("default: ");
      em.goto(a);
      em.space();
      out.text("}");
      break;
    }
    case ops.OP_returnvoid:
      out.text("return");
      break;
    case ops.OP_returnvalue:
      out.text("return ");
      em.reg(ir.src[i]);
      break;
    case ops.OP_throw:
      out.text("throw ");
      em.reg(ir.src[i]);
      break;
    default:
      if (object(em, i, op)) {
        // One that only made a copy wrote nothing.
        if (em.kept) {
          return;
        }

        break;
      }

      if (getsLocal(op)) {
        if (em.copies(i, ir.src[i])) {
          return;
        }

        move(em, i, ir.src[i]);
        break;
      }

      if (op >= ops.OP_setlocal0 && op < ops.OP_setlocal0 + 4) {
        move(em, i, ir.src[i]);
        break;
      }

      // An instruction not lowered yet fails where it runs.
      out.text('throw rt.unsupported("');
      out.text(op < 256 ? opcodeNames[op] : "ir");
      out.text('")');
      break;
  }

  if (em.unboxResult) {
    out.text(")");
  }

  // A branch, switch or swap ends in its own `}` or `;`, or in the code
  // of a block written in place: no empty statement after it.
  const last = out.bytes[out.length - 1];
  if (
    !(conditional(op) || op === ops.OP_jump || op === ops.OP_lookupswitch || op === ops.OP_swap)
  ) {
    out.text(";\n");
  } else if (last !== 0x0a) {
    out.text(last === 0x7d || last === 0x3b ? "\n" : ";\n"); // } ;
  }
  if (em.resets) {
    em.resets = false;
    em.resetEnd = <i32>out.length;
    em.resetMarks = em.map.count;
  }
}

/**
 * Whether instruction op reads the register it null checks before anything
 * it does that can throw or be seen: before it, only the runtime's
 * methods, the module's tables and other registers. The check can then be
 * made where it reads it.
 */
function readsFirst(op: u16): bool {
  switch (op) {
    case ops.OP_getslot:
    case ops.OP_setslot:
    case IR_CallGetter:
    case IR_CallSetter:
    case ops.OP_callmethod:
    case IR_CallInterface:
    case ops.OP_getproperty:
    case ops.OP_setproperty:
    case ops.OP_initproperty:
    case ops.OP_deleteproperty:
    case ops.OP_callproperty:
    case ops.OP_callproplex:
    case ops.OP_callpropvoid:
    case ops.OP_constructprop:
    case IR_ConstructSlot:
    case ops.OP_callsuper:
    case ops.OP_callsupervoid:
    case ops.OP_getsuper:
    case ops.OP_setsuper:
    case ops.OP_callstatic:
    case ops.OP_constructsuper:
    case ops.OP_getdescendants:
    case ops.OP_in:
    case ops.OP_checkfilter:
      return true;
    default:
      return false;
  }
}
