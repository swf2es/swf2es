// What happens to a display object with an AS3 object as it comes and
// goes: ADDED and ADDED_TO_STAGE as it is put on the display list, REMOVED
// and REMOVED_FROM_STAGE as it is taken off, and, off it, its life as an
// orphan, which plays on as Flash's does, for a while (docs/architecture.md,
// "Scripts and the display list").
import { avm2 } from "@swf2es/runtime";
import { Container, type DisplayObject, frameChildren, MovieClip } from "../display/display.js";
import { stopTimelineSoundsUnder } from "../media/sounds.js";
import type { Scripting } from "../scripting.js";
import { dispatchEvent } from "./events.js";

type AsObject = avm2.AsObject;

export class Lifecycle {
  /**
   * Clips taken off the display list, which play on as Flash's do: held
   * weakly, as Ruffle holds them, so one nothing refers to stops as Flash's
   * does once collected, and for ORPHAN_FRAMES at most. One the timeline
   * took is kept for its frame only.
   */
  private readonly orphans = new Map<
    number,
    { ref: WeakRef<DisplayObject>; keep: boolean; since: number }
  >();
  /** Display objects scripts made with `new` this frame: their first frame's script runs after everything else's, and they are orphans after. */
  readonly fresh: DisplayObject[] = [];

  constructor(private readonly s: Scripting) {}

  /** Whether `d` is on the display list: under the stage. */
  onStage(d: DisplayObject): boolean {
    for (let o: DisplayObject | null = d; o; o = o.parent) {
      if (o === this.s.stage) {
        return true;
      }
    }

    return false;
  }

  /**
   * `display` has a parent now: ADDED to it, bubbling, and, if it is on
   * the display list, ADDED_TO_STAGE to it and each descendant, in tree
   * order, as Flash dispatches them.
   */
  added(display: DisplayObject): void {
    this.orphans.delete(display.serial);
    if (display.object) {
      dispatchEvent(this.s, display.object, this.s.event("added", true));
    }

    if (this.onStage(display)) {
      this.eachObject(display, (o) => dispatchEvent(this.s, o, this.s.event("addedToStage")));
    }
  }

  /**
   * `display` is about to lose its parent: REMOVED, bubbling, and
   * REMOVED_FROM_STAGE through the subtree if it was on the display list.
   * It then plays on as an orphan; the timeline's removal has it play its
   * removal frame only, and takes the parent's property of its name away.
   */
  removing(display: DisplayObject, byTimeline = false): void {
    if (display.object) {
      dispatchEvent(this.s, display.object, this.s.event("removed", true));
    }

    if (this.onStage(display)) {
      this.eachObject(display, (o) => dispatchEvent(this.s, o, this.s.event("removedFromStage")));
    }

    this.orphan(display, !byTimeline);
    const parent = display.parent?.object;
    if (byTimeline && parent && display.timelineNamed) {
      const name = avm2.qname(avm2.publicNs, display.name);
      if (this.s.rt.getProperty(parent, name) === display.object) {
        this.s.rt.setProperty(parent, name, null);
      }
    }
  }

  /**
   * `display` is off the display list with an AS3 object that may play
   * it, taken off by a script, or by the timeline, which keeps it for its
   * frame only, not `keep`.
   */
  orphan(display: DisplayObject, keep = true): void {
    if (display.object && !this.orphans.has(display.serial)) {
      this.orphans.set(display.serial, { ref: new WeakRef(display), keep, since: this.s.frames });
    }
  }

  /**
   * A script made `display` with `new`. Flash runs its first frame's
   * script at the end of this frame's, in the order made, has it sit out
   * the next frame's advance, and plays it on from there, on the display
   * list or as an orphan.
   */
  made(display: DisplayObject): void {
    this.fresh.push(display);
    if (display instanceof MovieClip) {
      display.fresh = true;
    }
  }

  /** The orphans still there, newest first, as Flash runs their frames. */
  orphanRoots(): DisplayObject[] {
    const roots: DisplayObject[] = [];
    for (const [serial, orphan] of this.orphans) {
      const display = orphan.ref.deref();
      if (!display) {
        this.orphans.delete(serial);
        continue;
      }

      roots.push(display);
    }

    return roots.sort((a, b) => b.serial - a.serial);
  }

  /** Whether `display` or anything under it listens for a frame's broadcast events. */
  private hearsFrames(display: DisplayObject): boolean {
    if (display.object) {
      for (const targets of this.s.broadcasts.values()) {
        if (targets.has(display.object)) {
          return true;
        }
      }
    }

    return frameChildren(display).some((child) => this.hearsFrames(child));
  }

  /**
   * Stop `display` and everything under it for good, as unloadAndStop
   * does: timelines stopped, frame broadcasts no longer heard, no orphan.
   */
  stopAll(display: DisplayObject): void {
    this.orphans.delete(display.serial);
    stopTimelineSoundsUnder(this.s, display);
    const stop = (o: DisplayObject) => {
      if (o instanceof MovieClip) {
        o.playing = false;
      }

      if (o.object) {
        for (const targets of this.s.broadcasts.values()) {
          targets.delete(o.object);
        }
      }

      if (o instanceof Container) {
        for (const child of o.children) {
          stop(child);
        }
      }
    };
    stop(display);
  }

  private eachObject(display: DisplayObject, f: (o: AsObject) => void): void {
    if (display.object) {
      f(display.object);
    }

    if (display instanceof Container) {
      for (const child of [...display.children]) {
        this.eachObject(child, f);
      }
    }
  }

  /**
   * The frame's scripts have run: the orphans whose time is up stop, and
   * what scripts made and left off the display list is an orphan now.
   */
  afterScripts(): void {
    // What the timeline took off this frame has had its frame; it stops here. So
    // does one that has played ORPHAN_FRAMES off the list, but for one that
    // listens for a frame's events, which hold it in Flash too.
    for (const [serial, orphan] of this.orphans) {
      if (!orphan.keep) {
        this.orphans.delete(serial);
        continue;
      }

      if (this.s.frames - orphan.since < ORPHAN_FRAMES) {
        continue;
      }

      const display = orphan.ref.deref();
      if (display && this.hearsFrames(display)) {
        orphan.since = this.s.frames;
        continue;
      }

      this.orphans.delete(serial);
      if (display) {
        stopTimelineSoundsUnder(this.s, display);
      }
    }
    // What scripts made this frame and left off the display list plays on as an orphan.
    for (const display of this.fresh.splice(0)) {
      if (!display.parent) {
        this.orphan(display);
      }
    }
  }
}

/**
 * How many frames an orphan plays before it stops. Flash frees one nothing
 * refers to almost at once, by reference counting; the browser's collector
 * may take minutes, through which a game's removed characters would play
 * on by the thousand, their scripts throwing for a stage they lack. The
 * player cannot see what a script holds, so one held stops too, unlike
 * Flash's, and plays on from there if put back; one that listens for a
 * frame's events, which hold it in Flash as well, plays on.
 */
const ORPHAN_FRAMES = 120;
