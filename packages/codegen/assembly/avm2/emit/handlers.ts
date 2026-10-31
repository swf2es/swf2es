// A method's exception handlers: the regions of its code each set of
// handlers covers, which `t` names as the code runs, and the dispatcher's
// catch, which finds the handler for the region that threw.

import { MethodEmitter } from "./method";
import { typeRef } from "./refs";

/** The bounds of the method's handler regions: every handler's from and to, sorted, once each. */
export function regions(em: MethodEmitter): void {
  const ir = em.ir;
  const count = ir.handlerCount * 2;
  if (<u32>em.bounds.length < count) {
    em.bounds = new StaticArray<u32>(count);
  }

  const bounds = em.bounds;
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

  em.boundCount = n;
  if (<u32>em.covered.length < n) {
    em.covered = new StaticArray<u8>(n);
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

    em.covered[r - 1] = covered;
  }
}

/** The handler region of ABC offset `pc`: how many bounds are at or before it, or 0 if none covers it. */
export function regionOf(em: MethodEmitter, pc: u32): i32 {
  let lo: u32 = 0;
  let hi = em.boundCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (em.bounds[mid] <= pc) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo > 0 && lo < em.boundCount && em.covered[lo - 1] ? <i32>lo : 0;
}

/**
 * The catch of the dispatcher: the handlers covering the region that
 * threw, in the order of the ABC's table, as avmplus finds them; the first
 * whose type the exception has gets it as its only stack value. With none,
 * the exception goes on to the caller.
 */
export function handlers(em: MethodEmitter): void {
  const out = em.out;
  const ir = em.ir;
  const bounds = em.bounds;
  const exception = <i32>(ir.localCount + ir.maxScope);
  out.text("const x = rt.caught(e);\nswitch (t) {\n");
  for (let r: u32 = 1; r < em.boundCount; r++) {
    if (!em.covered[r - 1]) {
      continue;
    }

    const start = bounds[r - 1];
    let first = true;
    for (let h: u32 = 0; h < ir.handlerCount; h++) {
      if (start < ir.handlerFrom[h] || start >= ir.handlerTo[h]) {
        continue;
      }

      if (first) {
        out.text("case ");
        out.uint(r);
        out.text(":\n");
        first = false;
      }

      const type = ir.handlerType[h];
      if (type >= 0) {
        out.text("if (rt.catches(x, ");
        typeRef(em, type);
        out.text(")) ");
      }

      out.text("{ ");
      em.regName(exception);
      out.text(" = x; ");
      em.goto(ir.handlerBlock[h]);
      out.text(" }\n");
    }

    if (!first) {
      out.text("break;\n");
    }
  }

  out.text("}\nthrow e;\n");
}
