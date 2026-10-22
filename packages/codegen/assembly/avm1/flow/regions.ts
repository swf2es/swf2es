// A block's regions and, in each, its blocks: what the dispatcher writes as
// a case each (docs/avm1.md, "Compiling").
//
// A region is code Flash runs as an activation of its own: the block, or a
// function's body. Flash runs a region from its start until the program
// counter is at or past its end: a jump past the end, or code running off
// it, leaves the region, and a jump back before its start stays in it,
// running whatever bytes are there. So a region's code is every action
// reachable from its start by offsets below its end, which may include
// actions outside its bytes, and an offset two regions reach is in both.
// A DefineFunction's body is a region of its own, one for each
// DefineFunction action, since its header (DefineFunction2's registers and
// preloads) shapes its code: a body that jumps back before its
// DefineFunction defines itself again, with the same region, so regions
// form a graph, cycles included, which the emitter writes a region at a
// time. A target before the block's start (a negative offset) runs the
// preceding SWF bytes, down to the start of the file.
//
// A region's code is compiled within its home: a block's own bytes, or a
// unit's (docs/avm1.md, "Units"). Control that stays in the region but
// leaves its home, as an obfuscated block's jumps back into other tags'
// bytes do, goes on in a unit: the code from that offset within its own
// home, compiled once for the SWF however many regions reach it, and as
// it first runs. Without homes, each block would hold every byte of the
// SWF its jumps back reach, again and again. A region keeps all it
// reaches, as before, where control leaves its home from a With's or a
// Try's bytes, which hold while it stays in them, or where it has
// registers of its own, which a unit could not see. Anywhere else nothing
// is held as control leaves, so a unit takes over where a jump to a new
// block would.
//
// With and Try bodies are not regions: in adl, their code runs in the
// activation that reached them, the With's scope and the Try's handlers
// held while the program counter stays in their bytes. A jump out of a
// body, back or forward, drops them and goes on at its target; code
// running off a try body goes on into the catch's bytes. So With and Try
// branch, as the emitter sees them: a With to its body and, for undefined
// or null, past it; a Try to its try body and, as a throw lands, to its
// catch's and finally's bytes. Their bodies' bounds start blocks, where
// the emitter drops what is no longer held.

import { Action, Actions, ERROR_None } from "../actions/decode";
import { Offsets } from "../actions/offsets";
import * as ops from "../actions/opcodes";

export const REGION_Block: u8 = 0;
export const REGION_Function: u8 = 1;
/** Code a region goes on to outside its home: it returns where control goes next. */
export const REGION_Unit: u8 = 2;

/**
 * How many actions all of a block's regions may hold together. Each region
 * holds what it reaches, so functions that jump back over a large block
 * hold it each; past this, the block is too large to compile.
 */
export const MAX_VISITS: i32 = 1 << 21;

/**
 * How many bytes decoding a block may read, per byte of it and besides:
 * each action is decoded once, so a block reads about its size unless it
 * is crafted to read the same bytes from many offsets.
 */
export const MAX_READ_PER_BYTE: i64 = 8;
export const MAX_READ_BESIDES: i64 = 1 << 20;

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

  /** Its home, from `low` to `high`, excluded: the code it is compiled with. */
  low: i32 = 0;
  high: i32 = 0;
  /** Whether it keeps all it reaches though its home was less (Flow.walk). */
  kept: bool = false;

  constructor(
    public kind: u8,
    public start: i32,
    public end: i32,
    /** The region it was first reached from, -1 for the block. */
    public parent: i32,
    /** The index of the action that first opened it, -1 for the block. */
    public opener: i32,
    public minimum: i32 = 0,
  ) {}

  reset(kind: u8, start: i32, end: i32, parent: i32, opener: i32, minimum: i32): void {
    this.kind = kind;
    this.start = start;
    this.end = end;
    this.parent = parent;
    this.opener = opener;
    this.minimum = minimum;
    this.low = minimum;
    this.high = end;
    this.kept = false;

    this.actions.length = 0;
    this.blocks.length = 0;
    this.blockFirst.length = 0;
    this.order.length = 0;
  }

  /** Whether control at `offset` is in the region's home, its compiled code. */
  @inline
  runs(offset: i32): bool {
    return offset >= this.low && offset < this.high;
  }

  /** Whether control at `offset` is still in the region, home or not. */
  @inline
  continues(offset: i32): bool {
    return offset >= this.minimum && offset < this.end;
  }

  /** Its home is all it reaches: nothing goes on in a unit. */
  @inline
  get whole(): bool {
    return this.low === this.minimum && this.high === this.end;
  }

  /** The index of the first block at or after `offset`, the count of blocks past them all. */
  firstFrom(offset: i32): i32 {
    const blocks = this.blocks;
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

  /** The index of the block that starts at `offset`, which must start one. */
  blockAt(offset: i32): i32 {
    const blocks = this.blocks;
    let low = 0;
    let high = blocks.length - 1;
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
}

/** Whether control goes on to the action's `fallsTo`. */
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

/** Where control falls to from the action: a With's or Try's body, or its `next`. */
export function fallsTo(action: Action): i32 {
  switch (action.opcode) {
    case ops.OP_With:
    case ops.OP_Try:
      return action.s0;
    default:
      return action.next;
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
  /**
   * Sticky: the regions would hold more than MAX_VISITS actions, or
   * decoding them would read more than MAX_READ_PER_BYTE bytes per byte.
   */
  tooLarge: bool = false;
  /** Whether a region keeps all it reaches though its home is less (see `walk`). */
  widened: bool = false;
  private visits: i32 = 0;
  // Per offset, the region (plus one) that last visited it, made it a block
  // start, or counted its fall-through predecessors, which `preds` holds.
  private visited: Offsets = new Offsets(0);
  private started: Offsets = new Offsets(0);
  private counted: Offsets = new Offsets(0);
  private preds: Offsets = new Offsets(0);
  private work: i32[] = [];
  private maxRead: i64 = 0;
  private offsets: i32[] = [];
  private reusable: Region[] = [];
  // The home of the code being compiled, and what the region being walked reached outside it.
  private homeLow: i32 = 0;
  private homeHigh: i32 = 0;
  private far: bool = false;
  private ranges: i32[] = [];
  /** The offsets of the actions control leaves the home from. */
  private farFrom: i32[] = [];
  /** From each With and Try to the end of its last body, in pairs. */
  private held: i32[] = [];

  constructor(public actions: Actions) {
    this.reset();
  }

  /**
   * The regions of the code from `start`, a block's or a unit's (`kind`),
   * which runs until control is at or past `end`, compiled within its home,
   * `low` to `high`; a block's by default, its own bytes.
   */
  reset(
    kind: u8 = REGION_Block,
    start: i32 = 0,
    end: i32 = -1,
    low: i32 = 0,
    high: i32 = -1,
  ): void {
    const actions = this.actions;
    const n = actions.length;
    const dense = actions.dense;
    this.tooLarge = false;
    this.widened = false;
    this.visits = 0;
    this.regions.length = 0;
    this.homeLow = low;
    this.homeHigh = high < 0 ? n : high;
    this.maxRead = <i64>n * MAX_READ_PER_BYTE + MAX_READ_BESIDES;
    this.visited.reset(dense);
    this.started.reset(dense);
    this.counted.reset(dense);
    this.preds.reset(dense);
    this.region(kind, start, end < 0 ? n : end, -1, -1);
    // Regions found while walking are walked in turn.
    for (let r = 0; r < this.regions.length && !this.tooLarge; r++) {
      this.walk(r);
    }
  }

  private walk(r: i32): void {
    const region = this.regions[r];
    const tag = r + 1;
    this.reach(region, tag);
    if (this.tooLarge) {
      return;
    }

    this.settle(region, tag);
    // A unit hands on even what is past its region's end: one whose home is all of it may
    // widen too.
    const whole = region.whole && region.kind !== REGION_Unit;
    if (!this.far || whole || !(this.locals(region) || this.leavesHeld(region))) {
      return;
    }

    // What a unit cannot run, the region keeps, reaching all it reaches as before.
    const offsets = this.offsets;
    for (let i = 0; i < offsets.length; i++) {
      const p = offsets[i];
      this.visited.set(p, 0);
      this.started.set(p, 0);
      this.counted.set(p, 0);
    }

    region.actions.length = 0;
    region.blocks.length = 0;
    region.blockFirst.length = 0;
    region.order.length = 0;
    region.low = region.minimum;
    region.high = region.end;
    region.kept = true;
    this.widened = true;
    this.reach(region, tag);
    if (!this.tooLarge) {
      this.settle(region, tag);
    }
  }

  /** The region's actions and blocks, of the offsets it reaches. */
  private settle(region: Region, tag: i32): void {
    const actions = this.actions;
    const offsets = this.offsets;
    offsets.sort();
    for (let i = 0; i < offsets.length; i++) {
      region.actions.push(actions.at.get(offsets[i]) - 1);
    }

    this.blocks(region, tag, offsets);
  }

  /**
   * Whether control may leave the home while a With or a Try holds: from
   * the With or the Try, or from a block of its bodies or the first past
   * them, which a With's scope holds over too, as the emitter's ranges
   * have them (docs/avm1.md, "With and Try").
   */
  private leavesHeld(region: Region): bool {
    const held = this.held;
    if (held.length === 0) {
      return false;
    }

    const actions = this.actions;
    const from = this.farFrom;
    from.sort();
    const ranges = this.ranges;
    ranges.length = 0;
    for (let i = 0; i < held.length; i += 2) {
      if (includes(from, held[i])) {
        return true;
      }

      ranges.push(region.firstFrom(actions.decode(held[i]).s0));
      ranges.push(region.firstFrom(held[i + 1]));
    }

    for (let k = 0; k + 1 < region.blockFirst.length; k++) {
      let leaves = false;
      for (let i = region.blockFirst[k]; i < region.blockFirst[k + 1]; i++) {
        if (includes(from, actions.actions[region.order[i]].offset)) {
          leaves = true;
          break;
        }
      }

      if (!leaves) {
        continue;
      }

      for (let i = 0; i < ranges.length; i += 2) {
        if (ranges[i] <= k && k <= ranges[i + 1]) {
          return true;
        }
      }
    }

    return false;
  }

  /** Whether the region is a DefineFunction2's body with registers of its own. */
  private locals(region: Region): bool {
    if (region.kind !== REGION_Function) {
      return false;
    }

    const opener = this.actions.actions[region.opener];
    return opener.opcode === ops.OP_DefineFunction2 && opener.a > 0;
  }

  /** The offsets the region reaches in its home, in `offsets`. */
  private reach(region: Region, tag: i32): void {
    const actions = this.actions;
    const work = this.work;
    const offsets = this.offsets;
    const r = tag - 1;
    offsets.length = 0;
    work.length = 0;
    this.far = false;
    this.farFrom.length = 0;
    this.held.length = 0;
    this.follow(region, tag, region.start, region.start);

    while (work.length > 0) {
      const p = work.pop();
      if (this.visited.get(p) === tag) {
        continue;
      }

      if (++this.visits > MAX_VISITS) {
        this.tooLarge = true;
        return;
      }

      this.visited.set(p, tag);
      offsets.push(p);
      const action = actions.decode(p);
      if (actions.read > this.maxRead) {
        this.tooLarge = true;
        return;
      }

      if (action.error !== ERROR_None) {
        continue;
      }

      switch (action.opcode) {
        case ops.OP_WaitForFrame:
        case ops.OP_WaitForFrame2:
          actions.skip(action);
          break;
        case ops.OP_DefineFunction:
        case ops.OP_DefineFunction2:
          if (action.region < 0) {
            action.region = this.function(action, r, actions.at.get(p) - 1);
          }
          break;
        case ops.OP_With:
          this.held.push(p);
          this.held.push(max(action.s1, action.next));
          // undefined or null skips the body.
          this.follow(region, tag, action.next, p);
          break;
        case ops.OP_Try:
          this.held.push(p);
          this.held.push(max(max(action.s1, action.s2), max(action.s3, action.next)));
          // Where a throw lands: the catch's bytes, else the finally's.
          if (action.a & ops.TRY_Catch) {
            this.follow(region, tag, action.s1, p);
          }
          if (action.a & ops.TRY_Finally) {
            this.follow(region, tag, action.s2, p);
          }
          break;
        default:
          break;
      }

      if (branches(action)) {
        this.follow(region, tag, action.target, p);
      }

      if (fallsThrough(action)) {
        this.follow(region, tag, fallsTo(action), p);
      }
    }
  }

  /**
   * Control to `offset` from the action at `from`. A unit's own code hands
   * every offset in the SWF to V.far, which knows where the region ends, so
   * for a unit each goes on elsewhere.
   */
  private follow(region: Region, tag: i32, offset: i32, from: i32): void {
    if (!region.runs(offset)) {
      if (region.kind === REGION_Unit ? offset >= region.minimum : region.continues(offset)) {
        this.far = true;
        this.farFrom.push(from);
      }
    } else if (this.visited.get(offset) !== tag) {
      this.work.push(offset);
    }
  }

  /** The region of a DefineFunction's body, which the action, decoded once, makes once. */
  private function(action: Action, parent: i32, opener: i32): i32 {
    return this.region(REGION_Function, action.s0, action.s1, parent, opener);
  }

  private region(kind: u8, start: i32, end: i32, parent: i32, opener: i32): i32 {
    const index = this.regions.length;
    let region: Region;
    if (index < this.reusable.length) {
      region = this.reusable[index];
      region.reset(kind, start, end, parent, opener, this.actions.minimum);
    } else {
      region = new Region(kind, start, end, parent, opener, this.actions.minimum);
      region.low = region.minimum;
      region.high = end;
      this.reusable.push(region);
    }

    // A body that starts outside the home, as one past a unit's may, keeps all it reaches.
    if (start >= this.homeLow && start < this.homeHigh) {
      region.low = max(region.low, this.homeLow);
      region.high = min(region.high, this.homeHigh);
    }

    this.regions.push(region);
    return index;
  }

  /** Makes `offset` a block start, if the region holds it. */
  private start(region: Region, tag: i32, offset: i32): void {
    if (region.runs(offset) && this.visited.get(offset) === tag) {
      this.started.set(offset, tag);
    }
  }

  /**
   * A block starts at the region's start, at a branch's target, after a
   * conditional branch, at a With's or Try's bodies' bounds, and where code
   * from two actions falls through, as actions that overlap can; every
   * other action follows the one before it.
   */
  private blocks(region: Region, tag: i32, offsets: i32[]): void {
    const actions = this.actions;
    this.start(region, tag, region.start);
    for (let i = 0; i < offsets.length; i++) {
      const action = actions.decode(offsets[i]);
      if (action.error !== ERROR_None) {
        continue;
      }

      const opcode = action.opcode;
      if (opcode === ops.OP_With || opcode === ops.OP_Try) {
        this.start(region, tag, action.s0);
        this.start(region, tag, action.s1);
        this.start(region, tag, action.next);
        if (opcode === ops.OP_Try) {
          this.start(region, tag, action.s2);
          this.start(region, tag, action.s3);
        }
        continue;
      }

      if (branches(action)) {
        this.start(region, tag, action.target);
      }

      if (!fallsThrough(action) || !region.runs(action.next)) {
        continue;
      }

      const next = action.next;
      if (branches(action)) {
        this.started.set(next, tag);
      } else if (this.counted.get(next) !== tag) {
        this.counted.set(next, tag);
        this.preds.set(next, 1);
      } else {
        const count = this.preds.get(next) + 1;
        this.preds.set(next, count);
        if (count > 1) {
          this.started.set(next, tag);
        }
      }
    }

    for (let i = 0; i < offsets.length; i++) {
      const first = offsets[i];
      if (this.started.get(first) !== tag) {
        continue;
      }

      region.blocks.push(first);
      region.blockFirst.push(region.order.length);
      let p = first;
      for (;;) {
        region.order.push(actions.at.get(p) - 1);
        const action = actions.decode(p);
        if (!fallsThrough(action)) {
          break;
        }

        p = fallsTo(action);
        if (!region.runs(p) || this.started.get(p) === tag) {
          break;
        }
      }
    }

    region.blockFirst.push(region.order.length);
  }
}

/** Whether the ascending `values` hold `value`. */
function includes(values: i32[], value: i32): bool {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low < values.length && values[low] === value;
}
