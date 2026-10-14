// A block's regions and, in each, its blocks: what the dispatcher writes as
// a case each (docs/avm1.md, "Compiling").
//
// A region is code Flash runs as an activation of its own: the block, a
// function's body, a With's, a Try's try, catch and finally bodies. Flash
// runs a region from its start until the program counter is at or past its
// end: a jump past the end, or code running off it, leaves the region, and
// a jump back before its start stays in it, running whatever bytes are
// there. So a region's code is every action reachable from its start by
// offsets below its end, which may include actions outside its bytes, and
// an offset two regions reach is in both.
//
// Regions are found as the actions opening them are reached, and are the
// same for every action opening the same bytes as the same kind: a body that
// jumps back before its opener opens itself again, so regions form a graph,
// cycles included, which the emitter writes a region at a time. A target
// before the block's start (a negative offset) is not in the block's bytes
// at all; it is taken as an exit.

import { Action, Actions, ERROR_None } from "../actions/decode";
import * as ops from "../actions/opcodes";

export const REGION_Block: u8 = 0;
export const REGION_Function: u8 = 1;
export const REGION_With: u8 = 2;
export const REGION_Try: u8 = 3;
export const REGION_Catch: u8 = 4;
export const REGION_Finally: u8 = 5;
const REGION_Kinds: i32 = 6;

/**
 * How many actions all of a block's regions may hold together. Each region
 * holds what it reaches, so regions that jump back over a large block hold
 * it each; past this, the block is too large to compile.
 */
export const MAX_VISITS: i32 = 1 << 21;

@final
export class Region {
  /** Its actions' indices in `Actions.actions`, by offset. */
  actions: i32[] = [];
  /** Its blocks' first offsets, ascending. */
  blocks: i32[] = [];
  /**
   * Block k's actions are `order[blockFirst[k]]` to `order[blockFirst[k + 1]]`,
   * excluded, each falling through to the next.
   */
  blockFirst: i32[] = [];
  order: i32[] = [];

  constructor(
    public kind: u8,
    public start: i32,
    public end: i32,
    /** The region it was first reached from, -1 for the block. */
    public parent: i32,
    /** The index of the action that first opened it, -1 for the block. */
    public opener: i32,
  ) {}

  /** Whether control at `offset` is still in the region. */
  @inline
  runs(offset: i32): bool {
    return offset >= 0 && offset < this.end;
  }
}

/** Whether control goes on to the action's `next`. */
export function fallsThrough(action: Action): bool {
  if (action.error !== ERROR_None) {
    return false;
  }

  switch (action.opcode) {
    case ops.OP_End:
    case ops.OP_Return:
    case ops.OP_Throw:
    case ops.OP_Jump:
      return false;
    default:
      return true;
  }
}

/** Whether the action may go to its `target`. */
export function branches(action: Action): bool {
  if (action.error !== ERROR_None) {
    return false;
  }

  switch (action.opcode) {
    case ops.OP_Jump:
    case ops.OP_If:
    case ops.OP_WaitForFrame:
    case ops.OP_WaitForFrame2:
      return true;
    default:
      return false;
  }
}

@final
export class Flow {
  regions: Region[] = [];
  /** Sticky: the regions would hold more than MAX_VISITS actions. */
  tooLarge: bool = false;
  private visits: i32 = 0;
  private keys: StaticArray<Map<u64, i32>> = new StaticArray<Map<u64, i32>>(REGION_Kinds);
  // Per offset, the region (plus one) that last visited it, made it a block
  // start, or counted its fall-through predecessors, which `preds` holds.
  private visited: StaticArray<i32>;
  private started: StaticArray<i32>;
  private counted: StaticArray<i32>;
  private preds: StaticArray<i32>;
  private work: i32[] = [];

  constructor(public actions: Actions) {
    const n = actions.length;
    this.visited = new StaticArray<i32>(n);
    this.started = new StaticArray<i32>(n);
    this.counted = new StaticArray<i32>(n);
    this.preds = new StaticArray<i32>(n);
    for (let k = 0; k < REGION_Kinds; k++) {
      this.keys[k] = new Map<u64, i32>();
    }

    this.regions.push(new Region(REGION_Block, 0, n, -1, -1));
    // Regions found while walking are walked in turn.
    for (let r = 0; r < this.regions.length && !this.tooLarge; r++) {
      this.walk(r);
    }
  }

  private walk(r: i32): void {
    const region = this.regions[r];
    const actions = this.actions;
    const tag = r + 1;
    const work = this.work;
    const offsets: i32[] = [];
    work.length = 0;
    this.follow(region, tag, region.start);

    while (work.length > 0) {
      const p = work.pop();
      if (this.visited[p] === tag) {
        continue;
      }

      if (++this.visits > MAX_VISITS) {
        this.tooLarge = true;
        return;
      }

      this.visited[p] = tag;
      offsets.push(p);
      const action = actions.decode(p);
      if (action.error !== ERROR_None) {
        continue;
      }

      if (action.region0 < 0) {
        this.opens(action, r, actions.at[p] - 1);
      }

      if (branches(action)) {
        this.follow(region, tag, action.target);
      }

      if (fallsThrough(action)) {
        this.follow(region, tag, action.next);
      }
    }

    offsets.sort();
    for (let i = 0; i < offsets.length; i++) {
      region.actions.push(actions.at[offsets[i]] - 1);
    }

    this.blocks(region, tag, offsets);
  }

  /**
   * Skips' targets and the regions an action opens, the first time a region
   * reaches it: the same bytes open the same regions from any other.
   */
  private opens(action: Action, r: i32, index: i32): void {
    switch (action.opcode) {
      case ops.OP_WaitForFrame:
      case ops.OP_WaitForFrame2:
        this.actions.skip(action);
        break;
      case ops.OP_DefineFunction:
      case ops.OP_DefineFunction2:
        action.region0 = this.open(REGION_Function, action.s0, action.s1, r, index);
        break;
      case ops.OP_With:
        action.region0 = this.open(REGION_With, action.s0, action.s1, r, index);
        break;
      case ops.OP_Try:
        action.region0 = this.open(REGION_Try, action.s0, action.s1, r, index);
        if (action.a & ops.TRY_Catch) {
          action.region1 = this.open(REGION_Catch, action.s1, action.s2, r, index);
        }
        if (action.a & ops.TRY_Finally) {
          action.region2 = this.open(REGION_Finally, action.s2, action.s3, r, index);
        }
        break;
      default:
        break;
    }
  }

  private follow(region: Region, tag: i32, offset: i32): void {
    if (region.runs(offset) && this.visited[offset] !== tag) {
      this.work.push(offset);
    }
  }

  /** The region of `kind` over `start` to `end`, made if it is new. */
  private open(kind: u8, start: i32, end: i32, parent: i32, opener: i32): i32 {
    const keys = this.keys[kind];
    const key = ((<u64>start) << 32) | <u64>end;
    if (keys.has(key)) {
      return keys.get(key);
    }

    const r = this.regions.length;
    keys.set(key, r);
    this.regions.push(new Region(kind, start, end, parent, opener));
    return r;
  }

  /**
   * A block starts at the region's start, at a branch's target, after a
   * conditional branch, and where code from two actions falls through, as
   * actions that overlap can; every other action follows the one before it.
   */
  private blocks(region: Region, tag: i32, offsets: i32[]): void {
    const actions = this.actions;
    if (region.start < region.end) {
      this.started[region.start] = tag;
    }

    for (let i = 0; i < offsets.length; i++) {
      const action = actions.decode(offsets[i]);
      if (branches(action) && region.runs(action.target)) {
        this.started[action.target] = tag;
      }

      if (!fallsThrough(action) || !region.runs(action.next)) {
        continue;
      }

      const next = action.next;
      if (branches(action)) {
        this.started[next] = tag;
      } else if (this.counted[next] !== tag) {
        this.counted[next] = tag;
        this.preds[next] = 1;
      } else if (++this.preds[next] > 1) {
        this.started[next] = tag;
      }
    }

    for (let i = 0; i < offsets.length; i++) {
      const first = offsets[i];
      if (this.started[first] !== tag) {
        continue;
      }

      region.blocks.push(first);
      region.blockFirst.push(region.order.length);
      let p = first;
      for (;;) {
        region.order.push(actions.at[p] - 1);
        const action = actions.decode(p);
        if (!fallsThrough(action) || !region.runs(action.next)) {
          break;
        }

        p = action.next;
        if (this.started[p] === tag) {
          break;
        }
      }
    }

    region.blockFirst.push(region.order.length);
  }
}
