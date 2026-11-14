// The frame's advance walk (Player.tick): the clips on the display list and
// among the orphans whose advance does something, found before any of them
// advances, in tree order, the stage's first, then the orphans' newest
// first. Most clips do nothing as they advance, stopped or of one frame, so
// the walk goes only where a mark (DisplayObject.advanceDue) says such a
// clip may be, as the rounds of frame scripts go by theirs (scriptsDue).
// Its list is the walk of every clip less those whose advance would do
// nothing as it walks. One of those matters only if it comes to do
// something before its turn, which a script among the advances may make
// it: a listener of a child the timeline took off, say. Each way a clip
// comes to advance tells the advances (AdvanceWatch.changed), which, for
// one made before the walk and not listed, find every clip again as the
// walk of all found them, from a log of what changed since, and advance
// all those after the one advancing. Scripts that make no such clip
// advance cost nothing more.
import type { ButtonObject } from "./buttonobject.js";
import { Container } from "./container.js";
import {
  type AdvanceWatch,
  advancing,
  BUTTON,
  CLIP,
  type DisplayObject,
  OTHER,
  serials,
} from "./displayobject.js";
import type { MovieClip } from "./movieclip.js";
import { walkList } from "./walk.js";

/** The orphans, as Lifecycle walks them. */
export interface Orphans {
  eachOrphanRoot(f: (display: DisplayObject) => void, due?: boolean, advances?: boolean): void;
}

/**
 * Whether the frame's walks prove their shortcuts as they take them: the
 * checked build's tests set it (Scripting.checkRounds, SWF2ES_CHECKED).
 * `refound` counts the ticks whose advances found their clips again, which
 * tests read.
 */
export const walkChecks = { on: false, refound: 0 };

/** The walks so far, each one's number its AdvanceWatch.pass. */
let passes = 0;

/** What a clip's advance reads and changes, to tell one that did nothing (AdvanceWalk.checked). */
function advanceState(clip: MovieClip): string {
  return `${clip.currentFrame} ${clip.playing} ${clip.fresh} ${clip.stream !== null}`;
}

export class AdvanceWalk {
  /** The list a tick fills, kept for the next; null while one runs. */
  private kept: (MovieClip | null)[] | null = [];
  /** The advances' watch, kept for the next tick; null while one runs, as one inside it makes its own. */
  private idle: AdvancePhase | null = new AdvancePhase();
  private clips: (MovieClip | null)[] = [];
  private count = 0;
  private pass = 0;
  /** Scripting.frames, which a clip that sits out a frame was stamped with (MovieClip.skipsAfter). */
  private frames = -1;
  /** The clips open around the item a list's walk is at, where each ends, and whether one is due under each. */
  private readonly openClip: (DisplayObject | null)[] = [];
  private readonly openEnd: number[] = [];
  private readonly openDue: boolean[] = [];
  private open = 0;

  /**
   * Advance every clip under `root`, then among `orphans`, as the frame
   * does: those whose advance does something, found first. `frames` is
   * Scripting.frames, or -1 without one. `checked`, as the checked build's
   * tests have it (Scripting.checkRounds), proves the list: it walks all
   * too, which must find the same clips in the same order but for those
   * whose advance would do nothing, advances all, and throws if one of
   * those did something with no clip left out told of as coming to advance.
   */
  run(root: DisplayObject, orphans: Orphans | null, frames: number, checked: boolean): void {
    const clips = this.kept ?? [];
    this.kept = null;
    const phase = this.idle ?? new AdvancePhase();
    this.idle = null;
    this.frames = frames;
    this.pass = ++passes;

    try {
      if (checked) {
        this.checked(root, orphans, clips, phase);
      } else {
        this.listed(root, orphans, clips, phase);
      }
    } finally {
      this.kept = clips;
      this.idle = phase;
    }
  }

  /** The tick: the clips listed advanced, or, from where one left out comes to advance, all after. */
  private listed(
    root: DisplayObject,
    orphans: Orphans | null,
    clips: (MovieClip | null)[],
    phase: AdvancePhase,
  ): void {
    const count = this.collect(root, orphans, clips);
    phase.arm(this.pass, root, orphans, this.frames);

    try {
      for (let i = 0; i < count; i++) {
        const clip = clips[i] as MovieClip;
        clip.advance();
        if (!phase.late || phase.refound) {
          continue;
        }

        // The rest as the walk of all would have them; the list's own, failing that.
        const rest = phase.after(clip, occurrence(clips, i));
        if (rest !== null) {
          for (let k = 0; k < rest.length; k++) {
            rest[k].advance();
          }

          break;
        }
      }
    } finally {
      phase.disarm();
      // Let go of once advanced, so that the kept list holds none past the tick.
      clips.fill(null, 0, count);
    }
  }

  /** The checked tick (run). */
  private checked(
    root: DisplayObject,
    orphans: Orphans | null,
    clips: (MovieClip | null)[],
    phase: AdvancePhase,
  ): void {
    // The marks first, as the walk of all makes lists again that this one would walk without.
    const count = this.collect(root, orphans, clips);
    const all: (MovieClip | null)[] = [];
    const total = this.collectAll(root, orphans, all);
    const acts: boolean[] = [];
    let j = 0;
    for (let i = 0; i < total; i++) {
      acts[i] = (all[i] as MovieClip).advances;
      if (acts[i] && clips[j++] !== all[i]) {
        throw new Error(`the advance walk listed clips out of order at ${j - 1}`);
      }
    }

    clips.fill(null, 0, count);
    if (j !== count) {
      throw new Error(`the advance walk listed ${count} clips that advance, not ${j}`);
    }

    phase.arm(this.pass, root, orphans, this.frames);

    try {
      for (let i = 0; i < total; i++) {
        const clip = all[i] as MovieClip;
        if (acts[i] || phase.refound) {
          clip.advance();
        } else {
          // Left out: nothing to do, as no clip left out was told of as coming to advance.
          const before = advanceState(clip);
          if (clip.advances) {
            throw new Error("a clip the advance walk left out advances");
          }

          clip.advance();
          if (!phase.late && advanceState(clip) !== before) {
            throw new Error("a clip the advance walk left out changed as it advanced");
          }
        }

        // Found again where unchecked it would be, they must be the walk of all.
        if (phase.late && !phase.refound) {
          const found = phase.foundAgain();
          for (let k = 0; k < found.length || k < total; k++) {
            if (found[k] !== all[k]) {
              throw new Error(`the advance walk found its clips again out of order at ${k}`);
            }
          }
        }
      }
    } finally {
      phase.disarm();
    }
  }

  /** The clips whose advance does something at and under `root`, then among `orphans`, into `clips`: their count. */
  private collect(
    root: DisplayObject,
    orphans: Orphans | null,
    clips: (MovieClip | null)[],
  ): number {
    this.clips = clips;
    this.count = 0;
    this.visit(root);
    orphans?.eachOrphanRoot(this.visitOrphan, false, true);
    return this.count;
  }

  /** `clip` on the list, marked as on this walk's (MovieClip.listedFor). */
  private list(clip: MovieClip): void {
    clip.listedFor = this.pass;
    this.clips[this.count++] = clip;
  }

  private readonly visitOrphan = (o: DisplayObject): void => {
    if (!this.visit(o) && o.orphanEntry !== null) {
      o.orphanEntry.advances = false;
    }
  };

  /** One a goto made sit this frame out, with all in it (MovieClip.skipsAfter). */
  private sitsOut(clip: MovieClip): boolean {
    return clip.skipsAfter >= 0 && clip.skipsAfter === this.frames;
  }

  /**
   * Whether a clip whose advance does something is at or under `o`, which
   * keeps its mark so: walked where it is marked. One that sits out keeps
   * its marks, all in it unwalked; an AVM1 movie's root keeps its own, its
   * VM playing what it holds, so that marks from inside stop at it.
   */
  private visit(o: DisplayObject): boolean {
    if (!o.advanceDue || o.avm1Root) {
      return false;
    }

    let due = false;
    if (o.kind === BUTTON) {
      const states = (o as ButtonObject).playingStates();
      for (let i = 0; i < states.length; i++) {
        const child = states[i];
        if ((child.kind !== OTHER || child.frameChildren.length !== 0) && this.visit(child)) {
          due = true;
        }
      }

      // Or one under a state it passed by, one that holds it.
      due ||= (o as ButtonObject).statesAdvance;
    } else if (o.kind === CLIP && this.sitsOut(o as MovieClip)) {
      return true;
    } else if (o instanceof Container) {
      due = this.under(o);
    }

    settle(o, due);
    return due;
  }

  /**
   * Whether such a clip is at or under `c`: from the list it keeps where
   * that is current, else from its marked children, in the list's order,
   * so as not to make the list again, which visits all.
   */
  private under(c: Container): boolean {
    const list = c.walk;
    if (list?.current) {
      const { items, ends } = list;
      const openClip = this.openClip;
      const openEnd = this.openEnd;
      const openDue = this.openDue;
      const base = this.open;
      let any = false;
      for (let i = 0; i < items.length; i++) {
        while (this.open > base && openEnd[this.open - 1] <= i) {
          this.close(base);
        }

        const item = items[i];
        if (item.kind === BUTTON) {
          if (this.visit(item)) {
            any = true;
            if (this.open > base) {
              openDue[this.open - 1] = true;
            }
          }

          continue;
        }

        if (!item.advanceDue) {
          i = ends[i] - 1;
          continue;
        }

        if (this.sitsOut(item as MovieClip)) {
          any = true;
          if (this.open > base) {
            openDue[this.open - 1] = true;
          }

          i = ends[i] - 1;
          continue;
        }

        const acts = (item as MovieClip).advances;
        if (acts) {
          this.list(item as MovieClip);
          any = true;
        }

        const open = this.open++;
        openClip[open] = item;
        openEnd[open] = ends[i];
        openDue[open] = acts;
      }

      while (this.open > base) {
        this.close(base);
      }

      return any;
    }

    let any = false;
    if (c.kind === CLIP && (c as MovieClip).advances) {
      this.list(c as MovieClip);
      any = true;
    }

    const children = c.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (
        child.advanceDue &&
        (child.kind !== OTHER || child.frameChildren.length !== 0) &&
        this.visit(child)
      ) {
        any = true;
      }
    }

    return any;
  }

  /** The innermost clip open in a list ends: its mark settled, and the one around it told. */
  private close(base: number): void {
    const open = --this.open;
    const due = this.openDue[open];
    settle(this.openClip[open] as DisplayObject, due);
    this.openClip[open] = null;
    if (due && open > base) {
      this.openDue[open - 1] = true;
    }
  }

  /**
   * Every clip at and under `root`, then among `orphans`, into `clips`, as
   * the frame's walk found them all before the marks: their count. The
   * clips under a container from the list it keeps (walkList); a button's
   * states all play, whichever it shows, walked as they are.
   */
  private collectAll(
    root: DisplayObject,
    orphans: Orphans | null,
    clips: (MovieClip | null)[],
  ): number {
    let count = 0;
    const sitsOut = (clip: MovieClip) => this.sitsOut(clip);
    const collect = (o: DisplayObject) => {
      if (o.kind === CLIP && sitsOut(o as MovieClip)) {
        return;
      }

      if (o instanceof Container && o.kind !== BUTTON) {
        const { items, ends } = walkList(o);
        for (let i = 0; i < items.length; ) {
          const item = items[i];
          if (item.kind === BUTTON) {
            collect(item);
          } else if (sitsOut(item as MovieClip)) {
            i = ends[i];
            continue;
          } else {
            clips[count++] = item as MovieClip;
          }

          i++;
        }

        return;
      }

      if (o.kind === CLIP) {
        clips[count++] = o as MovieClip;
      }

      const children = o.kind === BUTTON ? (o as ButtonObject).playingStates() : o.frameChildren;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.kind !== OTHER || child.frameChildren.length !== 0) {
          collect(child);
        }
      }
    };
    collect(root);
    orphans?.eachOrphanRoot(collect);
    return count;
  }
}

/** `o`'s mark (advanceDue) as the walk found it, `due`: its orphan entry's too. */
function settle(o: DisplayObject, due: boolean): void {
  if (o.advanceDue !== due) {
    o.advanceDue = due;
    if (o.orphanEntry !== null) {
      o.orphanEntry.advances = due;
    }
  }
}

/** Which time `clips[i]` is there from the first: a button's state shared with another is walked from each. */
function occurrence(clips: readonly (MovieClip | null)[], i: number): number {
  let n = 0;
  for (let k = 0; k <= i; k++) {
    if (clips[k] === clips[i]) {
      n++;
    }
  }

  return n;
}

// The log's entries (AdvancePhase).
const CHILDREN = 0;
const STATES = 1;
const PARENT = 2;
const SKIPS = 3;
const ORPHANED = 4;
const UNORPHANED = 5;

/**
 * A tick's advances, as they run: what changed since the walk that the
 * walk read, logged, till a clip made before it and not listed comes to
 * advance (`late`). Then every clip the walk of all found is found again,
 * from the display list as it was, and the tick advances those after the
 * one advancing in place of the rest of its list.
 */
class AdvancePhase implements AdvanceWatch {
  pass = 0;
  /** Whether a clip left out, made before the walk, came to advance. */
  late = false;
  /** Whether the clips have been found again since. */
  refound = false;
  /** The serial of the first display object made after the walk. */
  private madeAfter = 0;
  private previous: AdvanceWatch | null = null;
  private root: DisplayObject | null = null;
  private orphans: Orphans | null = null;
  private frames = -1;
  // The log, an entry at an index of each.
  private readonly kinds: number[] = [];
  private readonly subjects: DisplayObject[] = [];
  private readonly firsts: (DisplayObject | null)[] = [];
  private readonly seconds: (DisplayObject | null)[] = [];
  private readonly numbers: number[] = [];
  private readonly lists: (readonly DisplayObject[] | null)[] = [];

  arm(pass: number, root: DisplayObject, orphans: Orphans | null, frames: number): void {
    this.pass = pass;
    this.late = false;
    this.refound = false;
    this.madeAfter = serials();
    this.root = root;
    this.orphans = orphans;
    this.frames = frames;
    this.previous = advancing.watch;
    advancing.watch = this;
  }

  /** No longer watching: the watch around it back. */
  private unwatch(): void {
    if (advancing.watch === this) {
      advancing.watch = this.previous;
    }
  }

  disarm(): void {
    this.unwatch();
    this.previous = null;
    this.root = null;
    this.orphans = null;
    this.kinds.length = 0;
    this.subjects.length = 0;
    this.firsts.length = 0;
    this.seconds.length = 0;
    this.numbers.length = 0;
    this.lists.length = 0;
  }

  private log(
    kind: number,
    subject: DisplayObject,
    first: DisplayObject | null,
    second: DisplayObject | null,
    n: number,
    list: readonly DisplayObject[] | null,
  ): void {
    this.kinds.push(kind);
    this.subjects.push(subject);
    this.firsts.push(first);
    this.seconds.push(second);
    this.numbers.push(n);
    this.lists.push(list);
  }

  changed(clip: DisplayObject): void {
    if (!this.late && clip.serial < this.madeAfter && (clip as MovieClip).advances) {
      this.late = true;
    }
  }

  children(
    parent: DisplayObject,
    index: number,
    added: DisplayObject | null,
    removed: DisplayObject | null,
  ): void {
    this.log(CHILDREN, parent, added, removed, index, null);
  }

  states(button: DisplayObject, old: readonly DisplayObject[]): void {
    this.log(STATES, button, null, null, 0, old);
  }

  parent(o: DisplayObject, old: DisplayObject | null): void {
    this.log(PARENT, o, old, null, 0, null);
  }

  skips(clip: DisplayObject, old: number): void {
    this.log(SKIPS, clip, null, null, old, null);
  }

  orphaned(display: DisplayObject): void {
    this.log(ORPHANED, display, null, null, 0, null);
  }

  unorphaned(display: DisplayObject): void {
    this.log(UNORPHANED, display, null, null, 0, null);
  }

  /**
   * The clips the walk of all found after the `n`th time it found `clip`,
   * found again, which the tick advances in place of the rest of its list;
   * null where it is not there, which cannot be, and the list goes on.
   */
  after(clip: MovieClip, n: number): MovieClip[] | null {
    const found = this.foundAgain();
    for (let k = 0; k < found.length; k++) {
      if (found[k] === clip && --n === 0) {
        return found.slice(k + 1);
      }
    }

    return null;
  }

  /**
   * Every clip the walk of all found, from the display list as it was then:
   * what the log tells of undone, the last first, on copies, and the
   * orphans as they were. It watches no more.
   */
  foundAgain(): MovieClip[] {
    this.unwatch();
    this.refound = true;
    walkChecks.refound++;
    const then = new Map<DisplayObject, DisplayObject[]>();
    const statesThen = new Map<DisplayObject, readonly DisplayObject[]>();
    const parentThen = new Map<DisplayObject, DisplayObject | null>();
    const skipsThen = new Map<DisplayObject, number>();
    // Whether each orphan the log tells of was one at the walk: as its first entry has it.
    const orphanThen = new Map<DisplayObject, boolean>();
    for (let k = this.kinds.length - 1; k >= 0; k--) {
      const subject = this.subjects[k];
      switch (this.kinds[k]) {
        case CHILDREN: {
          let children = then.get(subject);
          if (children === undefined) {
            children = [...(subject as Container).children];
            then.set(subject, children);
          }

          const index = this.numbers[k];
          const added = this.firsts[k];
          const removed = this.seconds[k];
          if (added !== null && removed !== null) {
            children[index] = removed;
          } else if (added !== null) {
            children.splice(index, 1);
          } else if (removed !== null) {
            children.splice(index, 0, removed);
          }

          break;
        }
        case STATES:
          statesThen.set(subject, this.lists[k] as readonly DisplayObject[]);
          break;
        case PARENT:
          parentThen.set(subject, this.firsts[k]);
          break;
        case SKIPS:
          skipsThen.set(subject, this.numbers[k]);
          break;
        case ORPHANED:
          orphanThen.set(subject, false);
          break;
        case UNORPHANED:
          orphanThen.set(subject, true);
          break;
      }
    }

    const childrenOf = (o: DisplayObject): readonly DisplayObject[] =>
      then.get(o) ?? o.frameChildren;
    const parentOf = (o: DisplayObject): DisplayObject | null =>
      parentThen.has(o) ? (parentThen.get(o) as DisplayObject | null) : o.parent;
    // ButtonObject.playingStates's test, with the parents as they were.
    const encloses = (state: DisplayObject, button: DisplayObject) => {
      for (let p: DisplayObject | null = button; p !== null; p = parentOf(p)) {
        if (p === state) {
          return true;
        }
      }

      return false;
    };
    const frames = this.frames;
    const found: MovieClip[] = [];
    const visit = (o: DisplayObject) => {
      if (o.kind === CLIP) {
        const clip = o as MovieClip;
        const skips = skipsThen.has(clip) ? (skipsThen.get(clip) as number) : clip.skipsAfter;
        if (skips >= 0 && skips === frames) {
          return;
        }
      }

      if (o.kind === BUTTON) {
        let states = statesThen.get(o) ?? o.frameChildren;
        // An AVM1 button's are its children, which may have changed.
        if (states === (o as Container).children) {
          states = childrenOf(o);
        }

        for (let i = 0; i < states.length; i++) {
          const state = states[i];
          if (!encloses(state, o) && (state.kind !== OTHER || childrenOf(state).length !== 0)) {
            visit(state);
          }
        }

        return;
      }

      if (!(o instanceof Container) || o.avm1Root) {
        return;
      }

      if (o.kind === CLIP) {
        found.push(o as MovieClip);
      }

      const children = childrenOf(o);
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.kind !== OTHER || childrenOf(child).length !== 0) {
          visit(child);
        }
      }
    };
    visit(this.root as DisplayObject);

    const roots: DisplayObject[] = [];
    this.orphans?.eachOrphanRoot((o) => {
      if (!orphanThen.has(o)) {
        roots.push(o);
      }
    });
    for (const [o, was] of orphanThen) {
      if (was) {
        roots.push(o);
      }
    }

    roots.sort((a, b) => b.serial - a.serial);
    for (let i = 0; i < roots.length; i++) {
      visit(roots[i]);
    }

    return found;
  }
}
