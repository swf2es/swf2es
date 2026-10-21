import * as ops from "../abc/opcodes";
import { MethodEmitter } from "./method";

/** Keep a local unboxed only when every read and write knows its float identity. */
export function floatLocals(em: MethodEmitter): void {
  const ir = em.ir;
  if (<u32>em.unboxed.length < ir.localCount) {
    em.unboxed = new StaticArray<u8>(ir.localCount);
  }

  for (let r: u32 = 0; r < ir.localCount; r++) {
    em.unboxed[r] = 0;
  }

  const type = em.domain.floatType;
  if (!em.abc.hasFloatSupport || type < 0) {
    return;
  }

  // Bit 2 stays set until a non-float use; bit 1 records a float value.
  for (let r: u32 = 0; r < ir.localCount; r++) {
    em.unboxed[r] = ir.entryType[r] === type ? 3 : 2;
  }

  for (let k: u32 = 0; k < ir.blockCount; k++) {
    const entry = k * ir.frameSize;
    for (let r: u32 = 0; r < ir.localCount; r++) {
      em.regType[r] = ir.entryType[entry + r];
    }

    const last = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
    for (let i = ir.blockFirst[k]; i < last; i++) {
      const src = ir.src[i];
      for (let n: u32 = 0; n < ir.srcCount[i]; n++) {
        const r = src + <i32>n;
        if (r >= 0 && r < <i32>ir.localCount) {
          if (em.regType[r] !== type) {
            em.unboxed[r] = 0;
          } else if (em.unboxed[r]) {
            em.unboxed[r] |= 1;
          }
        }
      }

      if (ir.op[i] === ops.OP_hasnext2) {
        em.unboxed[ir.a[i]] = 0;
        em.unboxed[ir.b[i]] = 0;
      }

      const dst = ir.dst[i];
      if (dst >= 0 && dst < <i32>ir.localCount) {
        em.regType[dst] = ir.type[i];
        if (ir.type[i] !== type) {
          em.unboxed[dst] = 0;
        } else if (em.unboxed[dst]) {
          em.unboxed[dst] |= 1;
        }
      }
    }
  }

  for (let r: u32 = 0; r < ir.localCount; r++) {
    em.unboxed[r] = em.unboxed[r] === 3 ? 1 : 0;
  }
}

/** Arithmetic whose operands and result are statically floats needs no runtime dispatch. */
export function floatOperation(em: MethodEmitter, i: u32): bool {
  if (em.domain.floatType < 0 || em.ir.type[i] !== em.domain.floatType) {
    return false;
  }

  const op = em.ir.op[i];
  let operator = "";
  switch (op) {
    case ops.OP_add:
      operator = " + ";
      break;
    case ops.OP_subtract:
      operator = " - ";
      break;
    case ops.OP_multiply:
      operator = " * ";
      break;
    case ops.OP_divide:
      operator = " / ";
      break;
    case ops.OP_modulo:
      operator = " % ";
      break;
    case ops.OP_negate:
    case ops.OP_increment:
    case ops.OP_decrement:
    case ops.OP_inclocal:
    case ops.OP_declocal:
    case ops.OP_unplus:
      break;
    default:
      return false;
  }

  const out = em.out;
  em.assign(i, true);
  const boxed = !em.unboxedTarget(i);
  if (boxed) {
    out.text("rt.float(");
  }

  out.text("Math.fround(");
  if (op === ops.OP_negate) {
    out.text("-");
  }

  em.numberReg(em.ir.src[i]);
  if (operator.length) {
    out.text(operator);
    em.numberReg(em.ir.src[i] + 1);
  } else {
    switch (op) {
      case ops.OP_increment:
      case ops.OP_inclocal:
        out.text(" + 1");
        break;
      case ops.OP_decrement:
      case ops.OP_declocal:
        out.text(" - 1");
        break;
    }
  }

  out.text(boxed ? "))" : ")");
  return true;
}
