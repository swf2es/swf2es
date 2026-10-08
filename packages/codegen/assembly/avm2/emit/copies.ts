// Which scope and stack registers hold, where each block starts, a copy of
// another register or a constant on every way in: a forward dataflow over
// the IR, so that a block reads the original and the copy is never written.
//
// A fact r -> x says r's value is x's now, x being a local, a scope or stack
// register that is not itself a copy, or a constant (CONSTANT - the
// instruction that pushed it). Locals are never copies: they are always
// written, so a handler, entered from anywhere in its range, finds them as
// they are. Writing x ends every fact on it, writing r its own; a join keeps
// what all its ways in agree on. A handler starts with none, its stack its
// exception and its scope stack empty.
//
// The emitter keeps the same facts while it writes a block, and before a
// branch writes each copy the target does not know (see copyFor), but only
// of the registers live there. It may know more copies than this pass, as
// through a conversion that writes nothing, which this pass takes for a
// write: a register x the pass takes for written may still be a copy the
// emitter never wrote. So a fact r -> x enters a block only if x is live
// there too, where the emitter writes x if the block does not know it a copy.
import * as ops from "../abc/opcodes";
import { IR_GetGlobalScope, IR_Nip } from "../ir/ir";
import { MethodEmitter } from "./method";
import { conditional, terminates } from "./structure";

/** A fact's constant: CONSTANT - the instruction that pushed it. */
export const CONSTANT: i32 = -2;
/** No fact. */
export const NONE: i32 = -1;
/** A block no way in has reached yet: what a join takes the other side of. */
const UNSEEN: i32 = i32.MIN_VALUE;

/** Whether op pushes a constant, which a stack register can be a copy of. */
export function pushesConstant(op: u16): bool {
  switch (op) {
    case ops.OP_pushbyte:
    case ops.OP_pushshort:
    case ops.OP_pushint:
    case ops.OP_pushuint:
    case ops.OP_pushdouble:
    case ops.OP_pushnan:
    case ops.OP_pushstring:
    case ops.OP_pushtrue:
    case ops.OP_pushfalse:
    case ops.OP_pushnull:
    case ops.OP_pushundefined:
      return true;
    default:
      return false;
  }
}

/** Whether op is a getlocal, which makes its stack register a copy. */
export function getsLocal(op: u16): bool {
  return op === ops.OP_getlocal || (op >= ops.OP_getlocal0 && op < ops.OP_getlocal0 + 4);
}

/** Whether op is a setlocal, which takes its stack register. */
export function setsLocal(op: u16): bool {
  return op === ops.OP_setlocal || (op >= ops.OP_setlocal0 && op < ops.OP_setlocal0 + 4);
}

/**
 * Each block's facts on entry into em.copyIn, a row of frameSize -
 * localCount from the first scope register: the copy each register is,
 * or NONE.
 */
export function flowCopies(em: MethodEmitter): void {
  const ir = em.ir;
  const n = ir.blockCount;
  const slots = ir.frameSize - ir.localCount;
  if (slots === 0 || n === 0) {
    return;
  }

  const size = n * slots;
  if (<u32>em.copyIn.length < size) {
    em.copyIn = new StaticArray<i32>(max(size, em.copyIn.length * 2));
  }

  const copyIn = em.copyIn;
  // One block is entered only at the start, with no copies, or from itself.
  if (n === 1) {
    for (let s: u32 = 0; s < slots; s++) {
      copyIn[s] = NONE;
    }

    return;
  }

  if (<u32>em.dirty.length < n) {
    em.dirty = new StaticArray<u8>(max(n, em.dirty.length * 2));
  }

  if (<u32>em.flow.length < slots) {
    em.flow = new StaticArray<i32>(max(slots, em.flow.length * 2));
  }

  for (let s: u32 = 0; s < size; s++) {
    copyIn[s] = UNSEEN;
  }

  for (let k: u32 = 0; k < n; k++) {
    em.dirty[k] = 0;
  }

  // The entry and the handlers start with no copies, whatever else leads there.
  for (let s: u32 = 0; s < slots; s++) {
    copyIn[s] = NONE;
  }

  em.dirty[0] = 1;
  for (let h: u32 = 0; h < ir.handlerCount; h++) {
    const block = ir.handlerBlock[h];
    const at = block * slots;
    for (let s: u32 = 0; s < slots; s++) {
      copyIn[at + s] = NONE;
    }

    em.dirty[block] = 1;
  }

  // In code order until nothing changes: a fact only goes from UNSEEN to
  // a copy to NONE, so each block's row changes at most twice per register.
  // A block nothing reaches is written still, with no copies, and what it
  // leads to then knows only what it agrees on too.
  let unseen = true;
  while (unseen) {
    let again = true;
    while (again) {
      again = false;
      for (let k: u32 = 0; k < n; k++) {
        if (em.dirty[k]) {
          em.dirty[k] = 0;
          if (walk(em, k)) {
            again = true;
          }
        }
      }
    }

    unseen = false;
    for (let k: u32 = 0; k < n; k++) {
      const at = k * slots;
      if (copyIn[at] === UNSEEN) {
        for (let s: u32 = 0; s < slots; s++) {
          copyIn[at + s] = NONE;
        }

        em.dirty[k] = 1;
        unseen = true;
      }
    }
  }
}

/** Block k's instructions from its facts, joined into its targets'; whether one before it changed. */
function walk(em: MethodEmitter, k: u32): bool {
  const ir = em.ir;
  const base = <i32>ir.localCount;
  const slots = <u32>(ir.frameSize - ir.localCount);
  const flow = em.flow;
  const at = k * slots;
  for (let s: u32 = 0; s < slots; s++) {
    flow[s] = em.copyIn[at + s];
  }

  const last = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
  let back = false;
  for (let i = ir.blockFirst[k]; i < last; i++) {
    const op = ir.op[i];
    if (conditional(op) || op === ops.OP_jump) {
      back = join(em, ir.a[i], k) || back;
    } else if (op === ops.OP_lookupswitch) {
      back = join(em, ir.a[i], k) || back;
      for (let c: u32 = 0; c <= <u32>ir.c[i]; c++) {
        back = join(em, ir.cases[ir.b[i] + c], k) || back;
      }
    }

    const dst = ir.dst[i];
    const src = ir.src[i];
    switch (op) {
      case ops.OP_swap:
        kill(em, src);
        kill(em, src + 1);
        continue;
      case ops.OP_hasnext2:
        kill(em, <i32>ir.a[i]);
        kill(em, <i32>ir.b[i]);
        kill(em, dst);
        continue;
      case ops.OP_popscope:
        kill(em, src);
        continue;
    }

    if (dst < 0) {
      continue;
    }

    const from = sourceOf(em, i);
    if (from === dst) {
      // Its own value again, as a nip of a dup: nothing changes.
      continue;
    }

    // A value set to a local is that local's, as the register it came from
    // is, when that one is not a copy itself: `dup; setlocal`.
    const moved = setsLocal(op) ? root(em, src) : NONE;
    kill(em, dst);
    if (dst >= base) {
      flow[dst - base] = from;
    } else if (moved >= <i32>(base + ir.maxScope)) {
      flow[moved - base] = dst;
      for (let s: u32 = 0; s < slots; s++) {
        if (flow[s] === moved) {
          flow[s] = dst;
        }
      }
    }
  }

  if (!terminates(em, k) && k + 1 < ir.blockCount) {
    back = join(em, k + 1, k) || back;
  }

  return back;
}

/** What instruction i's destination is a copy of, from what the facts are before it; NONE if a value of its own. */
function sourceOf(em: MethodEmitter, i: u32): i32 {
  const ir = em.ir;
  const op = ir.op[i];
  const dst = ir.dst[i];
  const src = ir.src[i];
  const stack = <i32>(ir.localCount + ir.maxScope);
  if (dst >= stack && pushesConstant(op)) {
    return CONSTANT - <i32>i;
  }

  if (dst >= stack && (getsLocal(op) || op === ops.OP_dup || op === ops.OP_getscopeobject)) {
    return root(em, src);
  }

  if (op === IR_Nip) {
    return root(em, src + <i32>ir.srcCount[i] - 1);
  }

  // The global object, from no scope chain: the method's own first scope.
  if ((op === ops.OP_getglobalscope || op === IR_GetGlobalScope) && ir.outerSize === 0) {
    return root(em, <i32>ir.localCount);
  }

  // A scope stays as long as its block does: of a local or scope only, not
  // of a stack register written again soon after.
  if (op === ops.OP_pushscope || op === ops.OP_pushwith) {
    const from = root(em, src);
    return from >= 0 && from < stack ? from : NONE;
  }

  return NONE;
}

/** What register r's value is now: what it copies, or itself. */
function root(em: MethodEmitter, r: i32): i32 {
  const base = <i32>em.ir.localCount;
  if (r < base) {
    return r;
  }

  const copy = em.flow[r - base];
  return copy === NONE ? r : copy;
}

/** Register x is written: no longer a copy, nor the original of one. */
function kill(em: MethodEmitter, x: i32): void {
  const ir = em.ir;
  const base = <i32>ir.localCount;
  const slots = <i32>(ir.frameSize - ir.localCount);
  const flow = em.flow;
  if (x >= base) {
    flow[x - base] = NONE;
  }

  for (let s = 0; s < slots; s++) {
    if (flow[s] === x) {
      flow[s] = NONE;
    }
  }
}

/** The facts now joined into block t's; whether t changed and comes no later than k, to be walked again. */
function join(em: MethodEmitter, t: u32, k: u32): bool {
  const ir = em.ir;
  const slots = ir.frameSize - ir.localCount;
  const scopes = ir.blockScope[t];
  const stack = ir.maxScope + ir.blockStack[t];
  const flow = em.flow;
  const copyIn = em.copyIn;
  const at = t * slots;
  let changed = false;
  for (let s: u32 = 0; s < slots; s++) {
    // What is not on the stacks there is no one's copy.
    const live = s < ir.maxScope ? s < scopes : s < stack;
    let fact = live ? flow[s] : NONE;
    // Nor a copy of what is not, which the emitter may not have written.
    if (fact >= <i32>ir.localCount) {
      const f = <u32>fact - ir.localCount;
      if (!(f < ir.maxScope ? f < scopes : f < stack)) {
        fact = NONE;
      }
    }

    const was = copyIn[at + s];
    const now = was === UNSEEN || was === fact ? fact : NONE;
    if (now !== was) {
      copyIn[at + s] = now;
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  em.dirty[t] = 1;
  return t <= k;
}
