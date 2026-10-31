// Where control goes in an AVM1 region: to a block through the dispatcher,
// through V.leave out of what a With or a Try holds, by the ranges of
// blocks they hold over, out of the region, or on in the unit of a SWF's
// bytes past it (V.far); and a Try's catch taking its value into a register.

import { Actions, ERROR_None } from "../actions/decode";
import * as ops from "../actions/opcodes";
import { branches, Region } from "../flow/regions";
import { BlockEmitter } from "./block";

/**
 * The ranges of blocks the region's Withs and Trys hold over. The blocks
 * are in order of their offsets, and a body's bounds start blocks, so
 * each body is the blocks from the first at or after its start to the
 * first at or after its end.
 */
export function heldRanges(em: BlockEmitter, actions: Actions, region: Region): void {
  const handled = em.handled;
  const scoped = em.scoped;
  const finallies = em.finallies;
  const returns = em.returns;
  const late = em.late;
  handled.length = 0;
  scoped.length = 0;
  finallies.length = 0;
  returns.length = 0;
  late.length = 0;
  em.catchRegisters.length = 0;
  em.tries = false;
  em.holds = false;
  for (let i = 0; i < region.actions.length; i++) {
    const action = actions.actions[region.actions[i]];
    if (action.error !== ERROR_None) {
      continue;
    }

    if (action.opcode === ops.OP_With) {
      em.holds = true;
      scoped.push(firstFrom(region, action.s0));
      scoped.push(firstFrom(region, action.s1));
    } else if (action.opcode === ops.OP_Try) {
      em.holds = true;
      em.tries = true;
      const flags = <u32>action.a;
      const from = firstFrom(region, action.s0);
      const catchFrom = firstFrom(region, action.s1);
      const finallyFrom = firstFrom(region, action.s2);
      const finallyTo = flags & ops.TRY_Finally ? firstFrom(region, action.s3) : finallyFrom;
      handled.push(from);
      handled.push(finallyFrom);
      if (flags & ops.TRY_Catch) {
        // A throw's scopes and the catch's variable hold over the catch body.
        scoped.push(catchFrom);
        scoped.push(finallyFrom);
        if (flags & ops.TRY_CatchInRegister && !em.catchRegisters.includes(action.b)) {
          em.catchRegisters.push(action.b);
        }
      }

      if (finallyFrom < finallyTo) {
        handled.push(finallyFrom);
        handled.push(finallyTo);
        finallies.push(finallyFrom);
        finallies.push(finallyTo);
        returns.push(from);
        returns.push(finallyFrom);
      }
    }
  }

  if (!em.holds) {
    return;
  }

  // The block past each scope's body, whose first action runs in it.
  const n = region.blocks.length;
  for (let k = 0; k < n; k++) {
    late.push(false);
  }

  for (let i = 1; i < scoped.length; i += 2) {
    if (scoped[i] < n) {
      late[scoped[i]] = true;
    }
  }
}

/** The catch handler's part that sets a register a catch took a value into. */
export function catchInto(em: BlockEmitter): void {
  const out = em.out;
  const registers = em.catchRegisters;
  if (registers.length === 0) {
    return;
  }

  out.text("switch (cx.into) {\n");
  for (let i = 0; i < registers.length; i++) {
    const r = registers[i];
    if (r >= em.registers && r >= 4) {
      continue;
    }

    out.text("case ");
    out.uint(r);
    out.text(": ");
    em.register(r);
    out.text(" = cx.thrown; break;\n");
  }
  out.text("}\n");
}

/** The branch of an If or a WaitForFrame to `target`: there, or the region's exit. */
export function branch(em: BlockEmitter, region: Region, target: i32): void {
  const out = em.out;
  if (region.runs(target) || within(em.finallies, em.k) || transfers(em, region, target)) {
    out.text("{ ");
    goto(em, region, target);
    out.text(" }\n");
  } else {
    end(em);
  }
}

/**
 * Control from the block being written to `offset`, its block or out of
 * the region, without a line's end: through V.leave where it leaves
 * what a With or a Try holds.
 */
export function goto(em: BlockEmitter, region: Region, offset: i32): void {
  const out = em.out;
  if (!region.runs(offset)) {
    if (transfers(em, region, offset)) {
      transfer(em, region, offset);
    } else {
      exit(em);
    }
    return;
  }

  const to = region.blockAt(offset);
  // A jump back may loop: it counts down to the script timeout's check (docs/avm1.md, "The frame").
  if (to <= em.k) {
    out.text("if (--V.budget < 0) V.timeout(cx); ");
  }

  if (leaves(em.handled, em.k, to) || crosses(em.scoped, em.k, to)) {
    out.text("b = V.leave(cx, ");
    out.uint(to);
    out.text("); continue;");
  } else {
    out.text("b = ");
    out.uint(to);
    out.text("; continue;");
  }
}

/** Control out of the region: through V.leave where a finally may hold a throw or a Return. */
export function exit(em: BlockEmitter): void {
  if (within(em.finallies, em.k)) {
    em.out.text("b = V.leave(cx, -1); continue;");
  } else {
    em.out.text(em.inUnit ? "return -1;" : "return;");
  }
}

/** The region's exit as a line of its own. */
export function end(em: BlockEmitter): void {
  em.out.text(em.inUnit ? "return -1;\n" : "return;\n");
}

/**
 * Whether control at `offset`, outside the region's home, goes on in a
 * unit. A unit's own code hands every offset in the SWF to V.far, which
 * knows where the region ends; another region's only those it runs.
 */
function transfers(em: BlockEmitter, region: Region, offset: i32): bool {
  if (region.runs(offset)) {
    return false;
  }

  // One that keeps all it reaches goes on nowhere else, and is its own region's alone.
  return em.inUnit && !region.kept ? offset >= region.minimum : region.continues(offset);
}

/** Control to `offset` in the unit there, without a line's end. */
function transfer(em: BlockEmitter, region: Region, offset: i32): void {
  const out = em.out;
  const actions = em.actions;
  const at = actions.start + offset;
  const end = actions.start + region.end;
  const bound = actions.start + actions.length;
  if (em.inUnit) {
    em.exits.push(at);
    out.text("return ");
    out.uint(at);
    out.byte(0x3b);
    return;
  }

  const units = em.units;
  units.push(at);
  units.push(end);
  units.push(bound);
  units.push(em.five ? 1 : 0);
  out.text("return V.far(cx, ");
  out.uint(at);
  out.text(", ");
  out.uint(end);
  out.text(", ");
  out.uint(bound);
  out.text(em.five ? ", true);" : ", false);");
}

/** V.scopes after the first action of the late block `k`. */
export function scopes(em: BlockEmitter, k: i32): void {
  const out = em.out;
  out.text("V.scopes(cx, ");
  out.uint(k);
  out.text(");\n");
}

/** The index of the region's first block at or after `offset`, its count past them all. */
export function firstFrom(region: Region, offset: i32): i32 {
  const blocks = region.blocks;
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (blocks[mid] < offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/** Whether control from block `from` to block `to` leaves one of `ranges`. */
export function leaves(ranges: i32[], from: i32, to: i32): bool {
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] <= from && from < ranges[i + 1] && !(ranges[i] <= to && to < ranges[i + 1])) {
      return true;
    }
  }

  return false;
}

/**
 * Whether control from block `from` to block `to` leaves one of the scopes'
 * `ranges`, which hold over the first block past them too, as it starts.
 */
function crosses(ranges: i32[], from: i32, to: i32): bool {
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] <= from && from <= ranges[i + 1] && !(ranges[i] <= to && to <= ranges[i + 1])) {
      return true;
    }
  }

  return false;
}

/** Whether block `k` is in one of `ranges`, `from` and `to` (excluded) in pairs. */
export function within(ranges: i32[], k: i32): bool {
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] <= k && k < ranges[i + 1]) {
      return true;
    }
  }

  return false;
}

/** Whether a branch of the region goes to one of its blocks, as a loop to its only one. */
export function jumpsWithin(actions: Actions, region: Region): bool {
  for (let i = 0; i < region.order.length; i++) {
    const action = actions.actions[region.order[i]];
    if (branches(action) && region.runs(action.target)) {
      return true;
    }

    if (
      action.error === ERROR_None &&
      (action.opcode === ops.OP_With || action.opcode === ops.OP_Try)
    ) {
      return true;
    }
  }

  return false;
}
