// Writes the method's blocks, an instruction at a time, from each one's
// entry state: the copies an instruction's write would change written
// first, a value the next instruction only moves to a local assigned to
// it there, and before a branch, the copies its target needs and does
// not know (see copies.ts).

import * as ops from "../abc/opcodes";
import {
  IR_CallInterface,
  IR_CallSetter,
  IR_CallSuper,
  IR_CheckNull,
  IR_Coerce,
  IR_Nip,
} from "../ir/ir";
import { BUILTIN_Boolean, BUILTIN_Int, BUILTIN_Number, BUILTIN_Uint } from "../link/traits";
import { getsLocal, NONE, pushesConstant, setsLocal } from "./copies";
import { regionOf } from "./handlers";
import { instruction } from "./instructions";
import { MethodEmitter } from "./method";
import { conditional, enclosed, terminates } from "./structure";
import { conversionType, isNumeric, keeps } from "./values";

/** Write block k: its case label, then its instructions, following register types. */
export function block(em: MethodEmitter, k: u32): void {
  const out = em.out;
  out.text("case ");
  out.uint(k);
  out.text(":\n");
  blockBody(em, k);
}

/** Block k's instructions, following register types from its entry state. */
export function blockBody(em: MethodEmitter, k: u32): void {
  const out = em.out;
  const ir = em.ir;
  const entry = k * ir.frameSize;
  em.clearRaw(0);
  em.resetEnd = -1;
  for (let r: u32 = 0; r < ir.frameSize; r++) {
    em.regType[r] = ir.entryType[entry + r];
  }

  em.scopeDepth = ir.blockScope[k];
  for (let d: u32 = 0; d < em.scopeDepth; d++) {
    em.scopeWith[d] = (ir.entryFlags[entry + ir.localCount + d] & 2) >> 1;
  }

  // A block may be entered from any region, so it sets its own first.
  const handled = ir.handlerCount > 0;
  em.region = -1;
  const last = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
  const stack = <i32>(ir.localCount + ir.maxScope);
  // Every way in wrote the copies the block does not know. A block written
  // in place has one way in, the code before it, and keeps what that
  // checked; avmplus' JIT knows no value as it was made from there, a
  // block in place or not.
  const base = <i32>ir.localCount;
  const slots = <i32>ir.frameSize - base;
  const row = <i32>k * slots;
  for (let s = 0; s < slots; s++) {
    em.copyOf[base + s] = em.copyIn[row + s];
  }

  em.recount();

  for (let r: u32 = 0; r < ir.frameSize; r++) {
    em.promoted[r] = 0;
  }

  if (!em.inPlace) {
    for (let r: u32 = 0; r < ir.frameSize; r++) {
      em.checked[r] = 0;
    }
  }

  em.inPlace = false;
  em.drop(0);
  em.pendingNull = -1;
  em.file = em.blockFile[k];
  em.line = em.blockLine[k];
  em.mark();
  for (let i = ir.blockFirst[k]; i < last; i++) {
    const op = ir.op[i];
    const dst = ir.dst[i];
    // A branch's code written in place is another block's: em one's end, for each instruction.
    em.blockLast = last;
    const promotes = em.promotes(i);
    // What the instruction writes, other than stack registers, is copied
    // first by the stack registers copying it, but for those it takes:
    // it reads them before it writes. And what a branch leaves on the
    // stack is written, for the block it goes to.
    const frame = <i32>ir.frameSize;
    const pops = stackDiscipline(op) && ir.srcCount[i] > 0 && ir.src[i] >= stack;
    if (dst >= 0 && !keptAt(em, i, em.regType[dst])) {
      // Above a push nothing is live to copy it.
      const push = dst >= stack && stackDiscipline(op);
      copyAll(em, dst, pops ? ir.src[i] : push ? dst : frame);
    }

    if (op === ops.OP_hasnext2) {
      copyAll(em, <i32>ir.a[i], frame);
      copyAll(em, <i32>ir.b[i], frame);
    } else if (op === ops.OP_popscope || op === ops.OP_swap) {
      copyAll(em, ir.src[i], frame);
    } else if (conditional(op)) {
      boxRaw(em, ir.src[i]);
      copyFor(em, ir.a[i], ir.src[i]);
    } else if (op === ops.OP_lookupswitch) {
      boxRaw(em, ir.src[i]);
      copyFor(em, ir.a[i], ir.src[i]);
      for (let c: u32 = 0; c <= <u32>ir.c[i]; c++) {
        copyFor(em, ir.cases[ir.b[i] + c], ir.src[i]);
      }
    } else if (op === ops.OP_jump) {
      boxRaw(em, frame);
      copyFor(em, ir.a[i], frame);
    }

    // A value the next instruction only moves to a local or scope goes
    // there straight, if the instruction assigns it; one it duplicates to
    // set a local goes to the local, and stays on the stack as its copy.
    // Conversions between that change nothing write nothing either.
    em.target = -1;
    let moves: u32 = 0;
    let duplicated = false;
    if (dst >= stack && op !== ops.OP_hasnext2) {
      let n = i + 1;
      let type = ir.type[i];
      while (n < last) {
        if (em.domain.floatType >= 0 && type === em.domain.floatType && debugRecord(ir.op[n])) {
          n++;
        } else if (ir.dst[n] === dst && keptAt(em, n, type)) {
          type = ir.type[n++];
        } else {
          break;
        }
      }

      if (n < last && ir.src[n] === dst) {
        const next = ir.op[n];
        if (setsLocal(next) || next === ops.OP_pushscope) {
          moves = n - i;
        } else if (next === ops.OP_dup) {
          let set = n + 1;
          while (set < last && em.domain.floatType >= 0 && type === em.domain.floatType) {
            if (debugRecord(ir.op[set])) {
              set++;
            } else if (ir.dst[set] === dst + 1 && keptAt(em, set, type)) {
              type = ir.type[set++];
            } else {
              break;
            }
          }

          if (
            set < last &&
            setsLocal(ir.op[set]) &&
            ir.src[set] === dst + 1 &&
            (set === n + 1 || em.unboxedLocal(ir.dst[set]))
          ) {
            moves = set - i;
            duplicated = true;
          }
        }
      }
    }

    if (moves) {
      // After them, the stack is as far as dst: what is there on, the
      // instruction takes.
      em.target = ir.dst[i + moves];
      copyAll(em, em.target, dst);
    }

    if (handled) {
      const region = regionOf(em, ir.pc[i]);
      if (region !== em.region) {
        out.text("t = ");
        out.int(region);
        out.text(";\n");
        em.region = region;
        if (em.structured && !enclosed(em, region)) {
          em.unenclosed = true;
        }
      }
    }

    if (em.heldCount) {
      releaseFor(em, i);
    }

    // A pure value on the stack is held, not written, for what reads it:
    // not a float, which may stay raw (MethodEmitter.rawFloat).
    const holds =
      dst >= stack &&
      em.target < 0 &&
      em.pendingNull < 0 &&
      ir.type[i] !== em.domain.floatType &&
      pureValue(em, i);
    const start = out.length;
    const marks = em.map.count;
    em.readLow = i32.MAX_VALUE;
    em.readHigh = -1;

    // A branch's own target, written in place, sinks its own values: only
    // an instruction given a local here can have assigned it.
    const sinking = em.target;
    em.kept = false;
    em.sunk = false;
    instruction(em, i);
    if (!em.kept && dst >= stack) {
      if (
        holds &&
        !em.rawResult &&
        !em.unboxResult &&
        em.map.count === marks &&
        em.pendingNull < 0 &&
        em.hold(dst, start)
      ) {
        // Held: written nowhere.
      } else {
        // A value nothing read, overwritten.
        em.forget(dst);
      }
    }
    if (em.pendingNull >= 0 && i >= em.pendingUntil) {
      em.unpend();
    }

    unchecks(em, i);
    em.target = -1;
    if (conditional(op) || op === ops.OP_jump || op === ops.OP_lookupswitch) {
      em.clearRaw(0);
    } else if (op === ops.OP_swap) {
      em.rawFloat[ir.src[i]] = 0;
      em.rawFloat[ir.src[i] + 1] = 0;
    } else if (dst >= stack && !em.kept) {
      em.rawFloat[dst] = em.rawResult ? 1 : 0;
      if (em.rawResult) {
        em.rawTop = max(em.rawTop, dst + 1);
      }
    }

    if (op === ops.OP_swap) {
      // Its one destination is the new top, whose type the IR gives; the
      // register below it now holds what the top did, and its type.
      const x = ir.src[i];
      em.regType[x] = em.regType[x + 1];
    }

    if (dst >= 0) {
      em.regType[dst] = ir.type[i];
      em.promoted[dst] = promotes ? 1 : 0;
    }

    if (op === ops.OP_swap) {
      em.promoted[ir.src[i]] = 0;
      em.promoted[ir.src[i] + 1] = 0;
    } else if (op === ops.OP_hasnext2) {
      em.promoted[ir.a[i]] = 0;
      em.promoted[ir.b[i]] = 0;
    }

    if (em.target >= 0) {
      em.promoted[em.target] = 0;
    }

    if (sinking >= 0 && em.sunk) {
      // The setlocal or pushscope is written: its stack register was
      // never set, and the stack is as far as it, or as far as the copy.
      for (let j = i + 1; j <= i + moves; j++) {
        const to = ir.dst[j];
        if (to >= 0) {
          em.promoted[to] = em.promotes(j) ? 1 : 0;
          em.regType[to] = ir.type[j];
        } else if (ir.op[j] === ops.OP_debugfile) {
          em.file = <i32>ir.a[j];
        } else if (ir.op[j] === ops.OP_debugline) {
          em.line = ir.a[j];
          em.mark();
        }
      }

      i += moves;
      em.setCopy(sinking, NONE);
      if (ir.op[i] === ops.OP_pushscope) {
        em.scopeWith[em.scopeDepth++] = 0;
      }

      if (duplicated) {
        em.setCopy(dst, sinking);
        em.uncopy(dst + 1);
      } else {
        em.uncopy(dst);
      }

      continue;
    }

    if (conditional(op) || op === ops.OP_lookupswitch) {
      // What the branch took is gone.
      em.uncopy(ir.src[i]);
    } else if (op === ops.OP_swap) {
      em.setCopy(ir.src[i], NONE);
      em.setCopy(ir.src[i] + 1, NONE);
    } else if (op === ops.OP_popscope) {
      em.setCopy(ir.src[i], NONE);
    } else {
      if (dst >= 0 && !em.kept) {
        em.setCopy(dst, NONE);
      }

      // What is above the stack now is gone.
      if (stackDiscipline(op)) {
        if (dst >= stack) {
          em.uncopy(dst + 1);
        } else if (pops) {
          em.uncopy(ir.src[i]);
        }
      }
    }
  }

  if (!terminates(em, k) && k + 1 < ir.blockCount) {
    em.releaseAll(-1, -1);
    boxRaw(em, <i32>ir.frameSize);
    copyFor(em, k + 1, <i32>ir.frameSize);
  }

  // What is held after a return or throw, nothing reads.
  em.drop(0);
}

/**
 * Before instruction i: write the held texts it cannot read in place, its
 * own operands' but those it reads each once as a value (heldFrom); all
 * others too if it branches, as its target reads registers; else those
 * that read a register it writes.
 */
function releaseFor(em: MethodEmitter, i: u32): void {
  const ir = em.ir;
  const op = ir.op[i];
  const dst = ir.dst[i];
  const stack = <i32>(ir.localCount + ir.maxScope);
  const src = ir.src[i];
  const count = <i32>ir.srcCount[i];
  let from = -1;
  let to = -1;
  if (src >= 0 && count > 0) {
    from = heldFrom(em, i);
    to = src + count;
    for (let r = src; r < from; r++) {
      em.release(r);
    }
  }

  if (conditional(op) || op === ops.OP_jump || op === ops.OP_lookupswitch) {
    em.releaseAll(from, to);
    return;
  }

  if (dst >= 0 && !(dst >= stack && copiesOnly(op))) {
    em.clobber(dst, from, to);
  }

  if (em.target >= 0) {
    em.clobber(em.target, from, to);
  }

  if (op === ops.OP_hasnext2) {
    em.clobber(<i32>ir.a[i], from, to);
    em.clobber(<i32>ir.b[i], from, to);
  } else if (op === ops.OP_popscope) {
    em.clobber(src, from, to);
  }
}

/** Whether op only makes its stack register a copy, which writes it only when a copy is written (writeCopy). */
function copiesOnly(op: u16): bool {
  return (
    pushesConstant(op) ||
    getsLocal(op) ||
    op === ops.OP_dup ||
    op === ops.OP_getscopeobject ||
    op === IR_Nip
  );
}

/**
 * The first of instruction i's operands from which it reads each once, as
 * a value (MethodEmitter.reg), before it writes anything, and never by a
 * null check: an operand held as text is read there in place. A call's
 * arguments, not its receiver, which it may read twice; past its last
 * operand for none.
 */
function heldFrom(em: MethodEmitter, i: u32): i32 {
  const ir = em.ir;
  const op = ir.op[i];
  const src = ir.src[i];
  const end = src + <i32>ir.srcCount[i];
  if (readsHeld(op)) {
    return src;
  }

  switch (op) {
    case ops.OP_newarray:
      return src;
    case ops.OP_callmethod:
    case IR_CallInterface:
    case IR_CallSetter:
    case IR_CallSuper:
    case ops.OP_callstatic:
    case ops.OP_construct:
    case ops.OP_constructsuper:
      return src + 1;
    case ops.OP_call:
      return src + 2;
    case ops.OP_callproperty:
    case ops.OP_callproplex:
    case ops.OP_callpropvoid:
    case ops.OP_constructprop:
      // The receiver and the name's run-time parts, then the arguments.
      return end - <i32>ir.b[i];
    default:
      return end;
  }
}

/** Whether op reads each of its operands once, as a value (see heldFrom). */
function readsHeld(op: u16): bool {
  switch (op) {
    case ops.OP_add:
    case ops.OP_subtract:
    case ops.OP_multiply:
    case ops.OP_divide:
    case ops.OP_modulo:
    case ops.OP_add_i:
    case ops.OP_subtract_i:
    case ops.OP_multiply_i:
    case ops.OP_bitand:
    case ops.OP_bitor:
    case ops.OP_bitxor:
    case ops.OP_lshift:
    case ops.OP_rshift:
    case ops.OP_urshift:
    case ops.OP_bitnot:
    case ops.OP_negate:
    case ops.OP_negate_i:
    case ops.OP_increment:
    case ops.OP_decrement:
    case ops.OP_increment_i:
    case ops.OP_decrement_i:
    case ops.OP_not:
    case ops.OP_typeof:
    case ops.OP_equals:
    case ops.OP_strictequals:
    case ops.OP_lessthan:
    case ops.OP_lessequals:
    case ops.OP_greaterthan:
    case ops.OP_greaterequals:
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
    case IR_Coerce:
    case ops.OP_setlocal:
    case ops.OP_setlocal0:
    case ops.OP_setlocal0 + 1:
    case ops.OP_setlocal0 + 2:
    case ops.OP_setlocal0 + 3:
    case ops.OP_iftrue:
    case ops.OP_iffalse:
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
    case ops.OP_lookupswitch:
    case ops.OP_returnvalue:
    case ops.OP_throw:
    case ops.OP_pop:
    case ops.OP_li8:
    case ops.OP_li16:
    case ops.OP_li32:
    case ops.OP_lf32:
    case ops.OP_lf64:
    case ops.OP_si8:
    case ops.OP_si16:
    case ops.OP_si32:
    case ops.OP_sf32:
    case ops.OP_sf64:
    case ops.OP_sxi1:
    case ops.OP_sxi8:
    case ops.OP_sxi16:
    case ops.OP_setslot:
    case ops.OP_setglobalslot:
      return true;
    default:
      return false;
  }
}

/**
 * Whether instruction i gives a value whose text can neither throw nor do
 * anything seen, and reads only registers: JavaScript's own arithmetic,
 * comparisons and conversions on numbers and Booleans, which call no
 * valueOf. Such a text may be read anywhere until a register it reads is
 * written.
 */
function pureValue(em: MethodEmitter, i: u32): bool {
  const ir = em.ir;
  const op = ir.op[i];
  const src = ir.src[i];
  switch (op) {
    case ops.OP_add:
    case ops.OP_subtract:
    case ops.OP_multiply:
    case ops.OP_divide:
    case ops.OP_modulo:
    case ops.OP_add_i:
    case ops.OP_subtract_i:
    case ops.OP_multiply_i:
    case ops.OP_bitand:
    case ops.OP_bitor:
    case ops.OP_bitxor:
    case ops.OP_lshift:
    case ops.OP_rshift:
    case ops.OP_urshift:
    case ops.OP_equals:
    case ops.OP_strictequals:
    case ops.OP_lessthan:
    case ops.OP_lessequals:
    case ops.OP_greaterthan:
    case ops.OP_greaterequals:
      return ir.srcCount[i] === 2 && isNumeric(em, src) && isNumeric(em, src + 1);
    case ops.OP_bitnot:
    case ops.OP_negate:
    case ops.OP_negate_i:
    case ops.OP_increment:
    case ops.OP_decrement:
    case ops.OP_increment_i:
    case ops.OP_decrement_i:
    case ops.OP_sxi1:
    case ops.OP_sxi8:
    case ops.OP_sxi16:
      return ir.srcCount[i] === 1 && isNumeric(em, src);
    case ops.OP_not:
      return ir.srcCount[i] === 1;
    case ops.OP_convert_i:
    case ops.OP_coerce_i:
    case ops.OP_convert_u:
    case ops.OP_coerce_u:
    case ops.OP_convert_d:
    case ops.OP_coerce_d:
    case ops.OP_convert_b:
    case ops.OP_coerce_b:
      return ir.srcCount[i] === 1 && converts(em, conversionType(em, <u8>op, i), src);
    case IR_Coerce:
      return ir.srcCount[i] === 1 && converts(em, ir.c[i], src);
    default:
      return false;
  }
}

/** Whether converting register r to `type` is plain JavaScript on a number or Boolean: to int, uint, Number or Boolean. */
function converts(em: MethodEmitter, type: i32, r: i32): bool {
  const from = em.builtinOf(r);
  switch (em.domain.builtin(type)) {
    case BUILTIN_Int:
    case BUILTIN_Uint:
    case BUILTIN_Boolean:
      return isNumeric(em, r);
    case BUILTIN_Number:
      return from === BUILTIN_Int || from === BUILTIN_Uint || from === BUILTIN_Number;
    default:
      return false;
  }
}

function debugRecord(op: u16): bool {
  return op === ops.OP_debugfile || op === ops.OP_debugline || op === ops.OP_debug;
}

/** Whether instruction i is a conversion in place that writes nothing, its value of type `from` being one already. */
function keptAt(em: MethodEmitter, i: u32, from: i32): bool {
  const ir = em.ir;
  const op = ir.op[i];
  if (ir.dst[i] !== ir.src[i] || ir.srcCount[i] !== 1) {
    return false;
  }

  if (op === IR_Coerce) {
    return keeps(em, ir.c[i], from);
  }

  return op < 256 && keeps(em, conversionType(em, <u8>op, i), from);
}

/**
 * Before a branch to block t: write the copies below `limit` that t
 * needs and does not know, as flowCopies found its entry.
 */
function copyFor(em: MethodEmitter, t: u32, limit: i32): void {
  const ir = em.ir;
  const base = <i32>ir.localCount;
  const stack = base + <i32>ir.maxScope;
  const end = min(min(limit, <i32>ir.frameSize), em.copyTop);
  const row = <i32>t * (<i32>ir.frameSize - base) - base;
  const scopes = base + <i32>ir.blockScope[t];
  const depth = stack + <i32>ir.blockStack[t];
  for (let r = base; r < end; r++) {
    const copy = em.copyOf[r];
    if (copy === NONE || em.copyIn[row + r] === copy) {
      continue;
    }

    if (r < stack ? r < scopes : r < depth) {
      writeCopy(em, r);
    }
  }
}

/**
 * Whether op takes its stack operands from the top and pushes what it
 * gives there, as an instruction of a stack machine: all but a coercion
 * or null check in place, and swap.
 */
function stackDiscipline(op: u16): bool {
  return op !== IR_Coerce && op !== IR_CheckNull && op !== ops.OP_swap;
}

/** Write the scope and stack registers below `limit` that copy register w, before w changes. */
function copyAll(em: MethodEmitter, w: i32, limit: i32): void {
  if (em.copiedBy[w] === 0) {
    return;
  }

  const ir = em.ir;
  const end = min(min(limit, <i32>ir.frameSize), em.copyTop);
  for (let r = <i32>ir.localCount; r < end; r++) {
    if (em.copyOf[r] === w) {
      writeCopy(em, r);
    }
  }
}

/**
 * A copy written may be the register of a pending null check: the
 * instruction then reads the copy, as unpend would read what pendingRead
 * names, both the value when it was checked.
 */
function writeCopy(em: MethodEmitter, r: i32): void {
  const out = em.out;
  em.clobber(r, -1, -1);
  const from = em.copyOf[r];
  em.setCopy(r, NONE);
  em.checked[r] = 0;
  em.regName(r);
  out.text(" = ");
  em.copied(from);
  out.text(";\n");
  em.rawFloat[r] = 0;
}

/** Forget the null checks of what instruction i wrote. */
function unchecks(em: MethodEmitter, i: u32): void {
  const ir = em.ir;
  const op = ir.op[i];
  if (ir.dst[i] >= 0) {
    em.checked[ir.dst[i]] = 0;
  }

  if (em.target >= 0) {
    em.checked[em.target] = 0;
  }

  if (op === ops.OP_hasnext2) {
    em.checked[ir.a[i]] = 0;
    em.checked[ir.b[i]] = 0;
  } else if (op === ops.OP_swap) {
    em.checked[ir.src[i]] = 0;
    em.checked[ir.src[i] + 1] = 0;
  }
}

function boxRaw(em: MethodEmitter, limit: i32): void {
  for (let r = <i32>(em.ir.localCount + em.ir.maxScope); r < min(limit, em.rawTop); r++) {
    if (em.rawFloat[r]) {
      if (em.copyOf[r] === NONE) {
        em.regName(r);
        em.out.text(" = rt.float(");
        em.regName(r);
        em.out.text(");\n");
      }

      em.rawFloat[r] = 0;
    }
  }
}
