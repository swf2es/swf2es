// The constant pool along a region's flow: which ConstantPool a Push of a
// constant reads, where one is known.
//
// A ConstantPool sets the pool of the activation running it. A frame's
// block starts with the pool the frame's last block left, and a function
// with the pool it was defined under, as adl has them (docs/avm1.md, "The
// constant pool"). A call runs in an activation of its own, so it never
// changes the caller's; a With's and a Try's bodies run in the caller's,
// as adl runs them, and are flow like any other. A constant past the
// pool's end pushes undefined.
//
// A region starts with a pool it cannot know, the activation's, and so
// does a Try's catch or finally, which a throw reaches from anywhere in
// the try body. Where one ConstantPool reaches a block on every path, its
// strings are the pushes' literals; where none or several may, a push
// reads the activation's pool at run time.

import { Actions, ERROR_None } from "../actions/decode";
import * as ops from "../actions/opcodes";
import { branches, fallsThrough, fallsTo, Region } from "./regions";

/** The activation's pool, read at run time. */
export const POOL_Unknown: i32 = -1;
const POOL_Unreached: i32 = -2;

/**
 * The pool after action `index`, given the one before it: a known pool is
 * the index of the ConstantPool that set it.
 */
export function poolAfter(actions: Actions, index: i32, pool: i32): i32 {
  const action = actions.actions[index];
  if (action.error !== ERROR_None) {
    return pool;
  }

  return action.opcode === ops.OP_ConstantPool ? index : pool;
}

/** The pool at the start of each of the region's blocks. */
export function poolsOf(actions: Actions, region: Region): StaticArray<i32> {
  const n = region.blocks.length;
  const pools = new StaticArray<i32>(n);
  if (n === 0) {
    return pools;
  }

  for (let k = 0; k < n; k++) {
    pools[k] = POOL_Unreached;
  }

  // Each block's pool changes at most twice, from unreached to one pool to
  // unknown, so the work list ends.
  const work: i32[] = [];
  const entry = region.blockAt(region.start);
  pools[entry] = POOL_Unknown;
  work.push(entry);
  while (work.length > 0) {
    const k = work.pop();
    let pool = pools[k];
    const last = region.blockFirst[k + 1] - 1;
    for (let i = region.blockFirst[k]; i <= last; i++) {
      pool = poolAfter(actions, region.order[i], pool);
    }

    const action = actions.actions[region.order[last]];
    if (branches(action)) {
      merge(region, pools, work, action.target, pool);
    }

    if (fallsThrough(action)) {
      merge(region, pools, work, fallsTo(action), pool);
    }

    if (action.error !== ERROR_None) {
      continue;
    }

    if (action.opcode === ops.OP_With) {
      // undefined or null skips the body.
      merge(region, pools, work, action.next, pool);
    } else if (action.opcode === ops.OP_Try) {
      if (action.a & ops.TRY_Catch) {
        merge(region, pools, work, action.s1, POOL_Unknown);
      }
      if (action.a & ops.TRY_Finally) {
        merge(region, pools, work, action.s2, POOL_Unknown);
      }
    }
  }

  return pools;
}

/** `pool` into the block at `offset`, if the region runs it. */
function merge(region: Region, pools: StaticArray<i32>, work: i32[], offset: i32, pool: i32): void {
  if (!region.runs(offset)) {
    return;
  }

  const k = region.blockAt(offset);
  const old = pools[k];
  const merged = old === POOL_Unreached || old === pool ? pool : POOL_Unknown;
  if (merged !== old) {
    pools[k] = merged;
    work.push(k);
  }
}
