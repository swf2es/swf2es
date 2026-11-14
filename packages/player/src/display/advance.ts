// The frame's advance walk (Player.tick): the clips on the display list and
// among the orphans whose advance does something, found before any of them
// advances, in tree order, the stage's first, then the orphans' newest
// first. Most clips do nothing as they advance, stopped or of one frame, so
// the walk goes only where a mark (DisplayObject.advanceDue) says such a
// clip may be, as the rounds of frame scripts go by theirs (scriptsDue).
// Its list is the walk of every clip less those whose advance would do
// nothing as it walks; one of those comes to do something before its turn
// only if a script makes it, and a script runs among the advances only by
// an event, a named child's property or a class's first script, of which
// Scripting tells the walk first: it then finds every clip as the walk of
// all would have found it, and advances them all from there.
import type { ButtonObject } from "./buttonobject.js";
import { type ChildChanges, Container, childChanges } from "./container.js";
import { BUTTON, CLIP, type DisplayObject, OTHER } from "./displayobject.js";
import type { MovieClip } from "./movieclip.js";
import { walkList } from "./walk.js";

/** What Scripting tells the advances of (Scripting.advancing). */
export interface AdvanceHooks {
  /** A script is about to run. */
  beforeScript(): void;
  /** `display` became an orphan. */
  orphaned(display: DisplayObject): void;
}

/** The orphans, as Lifecycle walks them. */
export interface Orphans {
  eachOrphanRoot(f: (display: DisplayObject) => void, due?: boolean, advances?: boolean): void;
}

/** Where the walk tells of scripts among the advances: a Scripting. */
interface ScriptHost {
  advancing: AdvanceHooks | null;
  readonly lifecycle: Orphans;
}

/**
 * Whether the frame's walks prove their shortcuts as they take them: the
 * checked build's tests set it (Scripting.checkRounds, SWF2ES_CHECKED).
 * `refound` counts the ticks whose advances found their clips again, for
 * a script among them, which tests read.
 */
export const walkChecks = { on: false, refound: 0 };

/** What a clip's advance reads and changes, to tell one that did nothing (AdvanceWalk.checked). */
function advanceState(clip: MovieClip): string {
  return `${clip.currentFrame} ${clip.playing} ${clip.fresh} ${clip.stream !== null}`;
}

export class AdvanceWalk {
  /** The list a tick fills, kept for the next; null while one runs. */
  private kept: (MovieClip | null)[] | null = [];
  private clips: (MovieClip | null)[] = [];
  private count = 0;
  /** Scripting.frames, which a clip that sits out a frame was stamped with (MovieClip.skipsAfter). */
  private frames = -1;
  /** The clips open around the item a list's walk is at, where each ends, and whether one is due under each. */
  private readonly openClip: (DisplayObject | null)[] = [];
  private readonly openEnd: number[] = [];
  private readonly openDue: boolean[] = [];
  private open = 0;
  private readonly phase = new AdvancePhase();

  /**
   * Advance every clip under `root`, and, with `host`, every orphan, as
   * the frame does: those whose advance does something, found first.
   * `frames` is Scripting.frames, or -1 without one. `checked`, as the
   * checked build's tests have it (Scripting.checkRounds), proves the
   * list: it walks all too, which must find the same clips in the same
   * order but for those whose advance would do nothing, advances all, and
   * throws if one of those did something before a script ran.
   */
  run(root: DisplayObject, host: ScriptHost | null, frames: number, checked: boolean): void {
    const clips = this.kept ?? [];
    this.kept = null;
    this.frames = frames;
    if (checked) {
      try {
        this.checked(root, host, clips);
      } finally {
        this.kept = clips;
      }

      return;
    }

    const orphans = host?.lifecycle ?? null;
    const count = this.collect(root, orphans, clips);
    const phase = this.phase;
    phase.arm(host, root, orphans, frames, null);
    try {
      for (let i = 0; i < count; i++) {
        const clip = clips[i] as MovieClip;
        phase.current = clip;
        clip.advance();
        // A script ran in it: the rest as the walk of all would have them.
        const rest = phase.rest;
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
      this.kept = clips;
    }
  }

  /** The checked tick (run). */
  private checked(root: DisplayObject, host: ScriptHost | null, clips: (MovieClip | null)[]): void {
    const orphans = host?.lifecycle ?? null;
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

    const phase = this.phase;
    phase.arm(host, root, orphans, this.frames, all);
    try {
      for (let i = 0; i < total; i++) {
        const clip = all[i] as MovieClip;
        phase.current = clip;
        const scripted = phase.scripted;
        if (acts[i] || scripted) {
          clip.advance();
          continue;
        }

        // Left out: nothing to do, unless a script has run since the walk.
        const before = advanceState(clip);
        if (clip.advances) {
          throw new Error("a clip the advance walk left out advances");
        }

        clip.advance();
        if (!phase.scripted && advanceState(clip) !== before) {
          throw new Error("a clip the advance walk left out changed as it advanced");
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
          this.clips[this.count++] = item as MovieClip;
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
      this.clips[this.count++] = c as MovieClip;
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

/**
 * A tick's advances, as they run: what changed the display list since the
 * walk (ChildChanges) and which orphans they made, till a script is about
 * to run among them. Then every clip the walk of all would have found is
 * found again from those, as it was, and `rest` is those after the one
 * advancing, which the tick advances in place of what is left of its list.
 */
class AdvancePhase implements AdvanceHooks, ChildChanges {
  /** The clip advancing. */
  current: MovieClip | null = null;
  /** The clips left to advance, from the walk of all, once a script has run; else null. */
  rest: MovieClip[] | null = null;
  /** Whether a script has run since the walk. */
  scripted = false;
  private host: ScriptHost | null = null;
  private root: DisplayObject | null = null;
  private orphans: Orphans | null = null;
  private frames = -1;
  /** The checked build's walk of all, to which the clips found again must be the same. */
  private all: (MovieClip | null)[] | null = null;
  // The changes to children (ChildChanges), in order.
  private readonly parents: Container[] = [];
  private readonly indexes: number[] = [];
  private readonly added: (DisplayObject | null)[] = [];
  private readonly removed: (DisplayObject | null)[] = [];
  private readonly made: DisplayObject[] = [];

  arm(
    host: ScriptHost | null,
    root: DisplayObject,
    orphans: Orphans | null,
    frames: number,
    all: (MovieClip | null)[] | null,
  ): void {
    this.rest = null;
    this.scripted = false;
    if (host === null) {
      return;
    }

    this.host = host;
    this.root = root;
    this.orphans = orphans;
    this.frames = frames;
    this.all = all;
    host.advancing = this;
    childChanges.log = this;
  }

  disarm(): void {
    if (this.host !== null && this.host.advancing === this) {
      this.host.advancing = null;
    }

    if (childChanges.log === this) {
      childChanges.log = null;
    }

    this.host = null;
    this.root = null;
    this.orphans = null;
    this.all = null;
    this.current = null;
    this.rest = null;
    this.parents.length = 0;
    this.indexes.length = 0;
    this.added.length = 0;
    this.removed.length = 0;
    this.made.length = 0;
  }

  changed(
    parent: Container,
    index: number,
    added: DisplayObject | null,
    removed: DisplayObject | null,
  ): void {
    this.parents.push(parent);
    this.indexes.push(index);
    this.added.push(added);
    this.removed.push(removed);
  }

  orphaned(display: DisplayObject): void {
    this.made.push(display);
  }

  beforeScript(): void {
    if (this.scripted) {
      return;
    }

    this.scripted = true;
    // Nothing more to keep: the clips are found again now, before the script.
    if (this.host?.advancing === this) {
      this.host.advancing = null;
    }

    if (childChanges.log === this) {
      childChanges.log = null;
    }

    walkChecks.refound++;
    const found = this.foundAgain();
    const all = this.all;
    if (all !== null) {
      for (let i = 0; i < found.length || i < all.length; i++) {
        if (found[i] !== all[i]) {
          throw new Error(`the advance walk found its clips again out of order at ${i}`);
        }
      }

      return;
    }

    const at = found.indexOf(this.current as MovieClip);
    if (at < 0) {
      throw new Error("the advance walk did not find the clip advancing again");
    }

    this.rest = found.slice(at + 1);
  }

  /**
   * Every clip the walk of all found, from the display list as it was then:
   * the changes to children since undone, the last first, on copies, and
   * the orphans made since left out.
   */
  private foundAgain(): MovieClip[] {
    const then = new Map<DisplayObject, DisplayObject[]>();
    const parentThen = new Map<DisplayObject, DisplayObject | null>();
    for (let k = this.parents.length - 1; k >= 0; k--) {
      const parent = this.parents[k];
      let children = then.get(parent);
      if (children === undefined) {
        children = [...parent.children];
        then.set(parent, children);
      }

      const index = this.indexes[k];
      const added = this.added[k];
      const removed = this.removed[k];
      if (added !== null && removed !== null) {
        children[index] = removed;
        parentThen.set(removed, parent);
        parentThen.set(added, parent);
      } else if (added !== null) {
        children.splice(index, 1);
        parentThen.set(added, null);
      } else if (removed !== null) {
        children.splice(index, 0, removed);
        parentThen.set(removed, parent);
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
        const skips = (o as MovieClip).skipsAfter;
        if (skips >= 0 && skips === frames) {
          return;
        }
      }

      if (o.kind === BUTTON) {
        // An AVM1 button's are its children, which may have changed.
        const states =
          o.frameChildren === (o as Container).children ? childrenOf(o) : o.frameChildren;
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
    const made = new Set(this.made);
    this.orphans?.eachOrphanRoot((o) => {
      if (!made.has(o)) {
        visit(o);
      }
    });
    return found;
  }
}
