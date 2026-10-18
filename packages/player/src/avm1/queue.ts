// The AVM1 action queue: what a frame, an event or a script queues, run by
// priority, the most urgent first, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) ActionQueue has it (MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors),
// and the blocks each queued action runs (docs/avm1.md, "The frame").
import { avm1 } from "@swf2es/runtime";
import type { DisplayObject, MovieClip } from "../display/display.js";
import type { Avm1 } from "./avm1.js";
import { ClipNative, nativeOf } from "./globals/MovieClip.js";
import type { Avm1Swf } from "./swf.js";

type Value = avm1.Value;

// The queue's priorities, which it runs in order: initialize clip events
// first, then the root's DoInitAction blocks, then constructions, then the
// rest, frame actions, events and methods, each in the order queued
// (Ruffle's ActionPriority; adl has a frame's initialize events before its
// DoInitAction blocks, which Ruffle runs as the SWF loads).
export const INITIALIZE = 0;
export const INIT = 1;
export const CONSTRUCT = 2;
export const NORMAL = 3;

// What a queued action is.
/** A DoAction tag's blocks, `index` the tag's body's offset. */
export const FRAME = 0;
/** A block alone, a DoInitAction's or a clip event's, by its index. */
export const BLOCK = 1;
/** A timeline's clip's construction: its registered class's prototype and constructor, and its construct events. */
export const CONSTRUCTION = 2;
/** An AS2 event method, `name`, of the clip's object. */
export const METHOD = 3;
/** The SWF stopped, at a place whose clip actions Flash cannot read. */
export const HALT = 4;
/** A broadcaster's message, `name`, to its listeners: Key's and Mouse's, as the player sends them. */
export const NOTIFY = 5;
/** A method, `name`, of `object`, called with `args`, as a script would call it. */
export const CALL = 6;

/** An action waiting its turn in the frame. */
export class Queued {
  constructor(
    readonly kind: number,
    readonly clip: DisplayObject,
    /** The SWF whose blocks `index` and `blocks` are. */
    readonly swf: Avm1Swf | null = null,
    readonly index = 0,
    /** Which of the clip's frame entries queued a FRAME: blocks of one share their constant pool. */
    readonly entry = 0,
    /** Whether it is an unload's, which runs for a clip removed since. */
    readonly unload = false,
    readonly name = "",
    readonly blocks: number[] = NO_BLOCKS,
    /** A NOTIFY's broadcaster or a CALL's object, and the arguments. */
    readonly object: avm1.Avm1Object | null = null,
    readonly args: avm1.Value[] = NO_ARGS,
  ) {}
}

export const NO_BLOCKS: number[] = [];

/** How many queued actions of a priority run before those run are dropped from its queue. */
const COMPACT_AT = 4096;

export const NO_ARGS: Value[] = [];

/** The queue a movie's actions wait in, by priority, and what runs them. */
export class ActionQueue {
  /** The queue, by priority, and how far each has run. */
  private readonly queues: Queued[][] = [[], [], [], []];
  private readonly heads = [0, 0, 0, 0];
  /** Whether the queue is running, which a function's return runs the earlier passes of. */
  private running = false;
  /** The pass of the action the queue runs, and the pass `next` last took from. */
  priority = NORMAL;
  private taken = NORMAL;

  constructor(private readonly movie: Avm1) {}

  enqueue(priority: number, q: Queued): void {
    this.queues[priority].push(q);
  }

  /** The next action of priorities `from` to `to`, the most urgent first; null for none. */
  private next(from = INITIALIZE, to = NORMAL): Queued | null {
    for (let p = from; p <= to; p++) {
      const queue = this.queues[p];
      // Gotos that go back and forth queue each other's frames for as long
      // as they run, which is forever in a SWF that never stops them: what
      // has run goes, and so do the clips they removed, so that such a SWF
      // runs into the script timeout without its memory growing.
      if (this.heads[p] >= COMPACT_AT) {
        queue.splice(0, this.heads[p]);
        this.heads[p] = 0;
        const movie = this.movie;
        movie.clips = movie.clips.filter((clip) => !movie.removed(clip));
      }

      if (this.heads[p] < queue.length) {
        this.taken = p;
        return queue[this.heads[p]++];
      }
    }

    return null;
  }

  /**
   * Run what is queued, by priority, what it queues included: the actions
   * of a clip still on the display list but an unload's; a frame entry's
   * blocks sharing a constant pool, each starting with the one the block
   * before left.
   */
  run(): void {
    const movie = this.movie;
    if (!movie.loaded || this.running) {
      return;
    }

    this.running = true;
    let pool: avm1.Value[] = [];
    let last: Queued | null = null;
    try {
      for (let q = this.next(); q !== null; q = this.next()) {
        if (movie.halted || movie.rt.disabled) {
          continue;
        }

        // A goto that queues its own frame again and again loops here, as a jump back does.
        if (--movie.realm.budget < 0) {
          this.timeout();
        }

        this.priority = this.taken;
        if (q.kind === FRAME) {
          if (last === null || last.clip !== q.clip || last.entry !== q.entry) {
            pool = [];
          }

          last = q;
          if (!this.gone(q.clip)) {
            pool = this.runOne(q, pool);
          }
        } else {
          this.runOne(q, []);
        }
      }
    } finally {
      this.running = false;
      for (let p = 0; p < this.queues.length; p++) {
        this.queues[p].length = 0;
        this.heads[p] = 0;
      }
    }
  }

  /** The queue's own check of the script timeout, which disables the movie's actions past it. */
  private timeout(): void {
    const cx = this.movie.activationOf(this.movie.root);
    if (cx !== null) {
      this.movie.rt.call(cx, () => this.movie.realm.timeout());
    }
  }

  /**
   * A function of the SWF's returned to code the queue runs: Flash runs
   * what was queued by then of the passes before that code's, a frame
   * action's initializations and constructions, a construction's
   * initializations (adl, and the corpus's register_and_init_order).
   */
  returned(): void {
    if (!this.running) {
      return;
    }

    const outer = this.priority;
    try {
      for (
        let q = this.next(INITIALIZE, outer - 1);
        q !== null;
        q = this.next(INITIALIZE, outer - 1)
      ) {
        if (!this.movie.halted && !this.movie.rt.disabled) {
          this.priority = this.taken;
          this.runOne(q, []);
        }
      }
    } finally {
      this.priority = outer;
    }
  }

  /**
   * Whether the clip of a queued action is gone: its actions do not run
   * but an unload's. One kept a frame for an unload handler is, where it
   * has clip actions of its own; one without, kept for an onUnload or for
   * a clip in it, runs what it queued before (adl; Ruffle skips them all).
   */
  private gone(d: DisplayObject): boolean {
    if (this.movie.removed(d)) {
      return true;
    }

    const native = nativeOf(d);
    return native?.pending === true && native.handlers !== null;
  }

  /** Run one queued action, from constant pool `pool` for a FRAME; the pool it leaves. */
  runOne(q: Queued, pool: avm1.Value[]): avm1.Value[] {
    const clip = q.clip;
    if (q.kind !== FRAME && !q.unload && this.gone(clip)) {
      return pool;
    }

    switch (q.kind) {
      case FRAME:
        // A clip a load has filled since runs none of what it queued before.
        if (q.swf !== this.movie.swfOf(clip)) {
          return pool;
        }

        for (const index of q.swf.list?.byTag.get(q.index) ?? NO_BLOCKS) {
          pool = this.runBlock(q.swf, index, pool, clip);
        }

        return pool;
      case BLOCK:
        this.runBlock(q.swf, q.index, [], clip);
        break;
      case CONSTRUCTION:
        this.construction(q);
        break;
      case METHOD: {
        const face = clip.avm1;
        const cx = this.movie.activationOf(clip);
        if (face !== null && cx !== null && !this.movie.removed(clip)) {
          this.movie.rt.callMethod(cx, face, q.name, NO_ARGS, this.movie.swfOf(clip).version);
        }
        break;
      }
      case HALT:
        this.movie.halted = true;
        break;
      case CALL: {
        const cx = this.movie.activationOf(clip);
        if (cx !== null && q.object !== null) {
          this.movie.rt.callMethod(cx, q.object, q.name, q.args, this.movie.version);
        }
        break;
      }
      case NOTIFY: {
        const cx = this.movie.activationOf(clip);
        const object = q.object;
        if (cx !== null && object !== null) {
          this.movie.rt.call(cx, () => {
            avm1.broadcastMessage(object, q.name, q.args, this.movie.version, (listener) => {
              const display = listener.display;
              return display instanceof ClipNative && this.movie.removed(display.target);
            });
          });
        }
        break;
      }
    }

    return pool;
  }

  /**
   * A timeline's clip constructed: its registered class's prototype, its
   * construct events, then the class's constructor on it.
   */
  private construction(q: Queued): void {
    const face = q.clip.avm1;
    if (face === null) {
      return;
    }

    const constr = this.movie.classes.classOf(q.clip);
    if (constr !== null) {
      face.define(
        "__proto__",
        avm1.get(constr, "prototype", this.movie.swfOf(q.clip).version),
        avm1.DONT_ENUM | avm1.DONT_DELETE,
      );
    }

    for (const block of q.blocks) {
      this.runBlock(q.swf, block, [], q.clip);
    }

    if (constr !== null) {
      this.movie.construct(q.clip, face, constr);
    }
  }

  /** CallFrame: the actions of `clip`'s frame `frame`, run now in order, each with a pool of its own. */
  callFrame(clip: MovieClip, frame: number): void {
    const swf = this.movie.swfOf(clip);
    for (const command of clip.timeline.frames[frame - 1] ?? []) {
      if (command.type === "actions") {
        for (const index of swf.list?.byTag.get(command.tag) ?? []) {
          this.runBlock(swf, index, [], clip);
        }
      }
    }
  }

  /**
   * Run `swf`'s block `index` with `clip` as its target, starting from
   * constant pool `pool`; the pool it leaves.
   */
  runBlock(
    swf: Avm1Swf | null,
    index: number,
    pool: avm1.Value[],
    clip: DisplayObject,
  ): avm1.Value[] {
    const regions = swf?.blocks[index];
    const cx = regions ? this.movie.activationOf(clip, pool) : null;
    if (!regions || cx === null) {
      return pool;
    }

    try {
      this.movie.rt.run(regions, cx);
    } catch (error) {
      if (!(error instanceof avm1.Halt)) {
        this.movie.onUncaught(error);
      }
    }

    return cx.pool;
  }
}
