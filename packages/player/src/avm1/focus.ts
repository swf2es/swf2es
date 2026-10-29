// An AVM1 movie's focus, as Ruffle's FocusTracker keeps it: what has it,
// whether its highlight shows, and the events a move of it sends. Its
// tab order, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/focus_tracker.rs and display_object/container.rs fill it: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// The display list is walked as it is drawn, each object before what is in
// it; a hidden object is left out with what is in it, and so is what is in
// a clip whose tabChildren is false. Once any object has a tabIndex, the
// order is by tabIndex, objects of equal ones as walked, and those without
// one are left out; otherwise it is by place, 6 × y + x of each object's
// top left corner on the stage in twips, of which only the first walked at
// a place is kept, as Ruffle keeps it.
import { ClipEvent } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import { boundsIn } from "../display/bounds.js";
import {
  ButtonObject,
  CONTENT,
  Container,
  type DisplayObject,
  MovieClip,
  TextObject,
} from "../display/display.js";
import type { Avm1 } from "./avm1.js";
import { nativeOf } from "./globals/MovieClip.js";
import { stateOf } from "./globals/TextField.js";

/** What the tab order reads of the movie's objects, their AS2 properties as code reads them. */
export interface TabHost {
  /** A tabEnabled set, or undefined where none is. */
  tabEnabled(d: DisplayObject): boolean | undefined;
  /** tabChildren, true where it is not set. */
  tabChildren(d: DisplayObject): boolean;
  /** A tabIndex set, as an int, or undefined where none is. */
  tabIndex(d: DisplayObject): number | undefined;
  buttonMode(clip: MovieClip): boolean;
}

interface Tabbed {
  d: DisplayObject;
  index: number | undefined;
}

/** The objects Tab moves the focus through, in order, from `root`, on `stage`. */
function tabOrder(root: MovieClip, stage: Container, host: TabHost): DisplayObject[] {
  const found: Tabbed[] = [];
  let custom = false;
  const walk = (d: DisplayObject) => {
    if (!d.visible) {
      return;
    }

    if (d !== root && tabbable(d, host)) {
      const index = host.tabIndex(d);
      custom ||= index !== undefined;
      found.push({ d, index });
    }

    // A button's states are no part of the order.
    if (d instanceof Container && !(d instanceof ButtonObject) && host.tabChildren(d)) {
      for (const child of d.children) {
        walk(child);
      }
    }
  };
  walk(root);

  if (custom) {
    // Array.prototype.sort is stable: equal indices keep the walk's order.
    return found
      .filter((t) => t.index !== undefined)
      .sort((a, b) => (a.index as number) - (b.index as number))
      .map((t) => t.d);
  }

  const placed = found.map((t) => ({ d: t.d, key: placeKey(t.d, stage) }));
  placed.sort((a, b) => a.key - b.key);
  return placed.filter((p, i) => i === 0 || p.key !== placed[i - 1].key).map((p) => p.d);
}

/**
 * Whether Tab reaches `d`: a button, or an input field, unless its
 * tabEnabled is false; a clip whose tabEnabled is true, or, where it is not
 * set, one in button mode or with a tabIndex.
 */
function tabbable(d: DisplayObject, host: TabHost): boolean {
  if (d instanceof TextObject) {
    return d.type === "input" && (host.tabEnabled(d) ?? true);
  }

  if (d instanceof ButtonObject) {
    return host.tabEnabled(d) ?? true;
  }

  if (d instanceof MovieClip) {
    return host.tabEnabled(d) ?? (host.buttonMode(d) || host.tabIndex(d) !== undefined);
  }

  return false;
}

/** 6 × y + x of `d`'s top left corner on the stage, in twips: a button's hit area's. */
function placeKey(d: DisplayObject, stage: Container): number {
  const area = d instanceof ButtonObject ? d.hitTestState : null;
  const parent = area?.parent ?? null;
  if (area) {
    area.parent = d as ButtonObject;
  }

  try {
    const r = boundsIn(area ?? d, stage, stage, true);
    return 6 * Math.round(r.yMin * 20) + Math.round(r.xMin * 20);
  } finally {
    if (area) {
      area.parent = parent;
    }
  }
}

/** The movie's focus: the object that has it, its highlight, and Tab's and Enter's moves of it. */
export class FocusTracker implements TabHost {
  /** `_global.Selection`, whose listeners hear the focus move. */
  selectionFace: avm1.Avm1Object | null = null;
  /** The button or clip with the focus. */
  focusedObject: DisplayObject | null = null;
  /**
   * Whether keyboard navigation shows the focus (Ruffle's highlight): a
   * focused object's onKeyDown and onKeyUp fire while it is not inactive,
   * and Enter and Space press it while it is visible.
   */
  highlight: "inactive" | "visible" | "hidden" = "inactive";

  constructor(private readonly movie: Avm1) {}

  get focused(): DisplayObject | null {
    return this.focusedObject;
  }

  /**
   * Focus `d`, or none: where it changes, the one that had it hears
   * onKillFocus(new), `d` onSetFocus(old), then Selection's listeners
   * onSetFocus(old, new), at once, not queued (Ruffle's FocusTracker). The
   * highlight shows where `d` may show it.
   */
  focus(d: DisplayObject | null): void {
    const old = this.focusedObject;
    this.focusedObject = d;
    this.highlight =
      d === null
        ? "inactive"
        : !(d instanceof TextObject) && this.highlightable(d)
          ? "visible"
          : "hidden";
    if (d === old) {
      this.selectFocused();
      return;
    }

    // A field that loses the focus loses its selection.
    if (old instanceof TextObject) {
      old.focused = false;
      stateOf(old).selected = false;
      old.invalidate(CONTENT);
    }

    if (d instanceof TextObject) {
      d.focused = true;
      d.invalidate(CONTENT);
    }

    // Each object's method in an activation of its own, as its other event methods run.
    const version = this.movie.version;
    const oldFace = old?.avm1 ?? null;
    const newFace = d?.avm1 ?? null;
    this.movie.timers.begin();
    try {
      const oldCx = old === null ? null : this.movie.activationOf(old);
      if (oldFace !== null && oldCx !== null) {
        this.movie.rt.callMethod(oldCx, oldFace, "onKillFocus", [newFace], version);
      }

      const newCx = d === null ? null : this.movie.activationOf(d);
      if (newFace !== null && newCx !== null) {
        this.movie.rt.callMethod(newCx, newFace, "onSetFocus", [oldFace], version);
      }

      const selection = this.selectionFace;
      const cx = this.movie.root !== null ? this.movie.activationOf(this.movie.root) : null;
      if (selection !== null && cx !== null) {
        this.movie.rt.call(cx, () => {
          avm1.broadcastMessage(selection, "onSetFocus", [oldFace, newFace], version);
        });
      }
    } finally {
      this.movie.timers.end();
    }

    this.selectFocused();
  }

  /**
   * A field given the focus, again too, has all its text selected, after
   * the focus's events, which see none (Ruffle's update_edittext_selection;
   * the corpus's `selection` and `edittext_programmatic_focus`).
   */
  private selectFocused(): void {
    const d = this.focusedObject;
    if (d instanceof TextObject) {
      stateOf(d).selected = true;
      d.select(0, d.model.text.length);
    }
  }

  /** Whether a script may focus `d`: a button, or a clip below the root in button mode or with focusEnabled true. */
  focusable(d: DisplayObject): boolean {
    // A field, selectable or not, as a script may focus any (Ruffle).
    if (d instanceof ButtonObject || d instanceof TextObject) {
      return true;
    }

    return (
      d instanceof MovieClip &&
      d !== this.movie.root &&
      (this.movie.input.buttonMode(d) ||
        avm1.toBoolean(this.movie.input.read(d, "focusEnabled"), this.movie.version))
    );
  }

  /**
   * Whether the focus shows on `d`: not the root, something drawn, and its
   * `_focusrect`, from SWF 6 its own where it has one, else the stage's.
   */
  private highlightable(d: DisplayObject): boolean {
    if (d === this.movie.root || d.parent === null) {
      return false;
    }

    const own = this.movie.version >= 6 ? (nativeOf(d)?.focusRect ?? null) : null;
    if (!(own ?? this.movie.focusRect)) {
      return false;
    }

    // A button's by its hit area, which it is tested by whatever it shows.
    const area = d instanceof ButtonObject ? d.hitTestState : null;
    const parent = area?.parent ?? null;
    if (area) {
      area.parent = d as ButtonObject;
    }

    try {
      const r = boundsIn(area ?? d, d.parent, null, true);
      return r.xMax > r.xMin || r.yMax > r.yMin;
    } finally {
      if (area) {
        area.parent = parent;
      }
    }
  }

  tabEnabled(d: DisplayObject): boolean | undefined {
    const value = this.movie.input.read(d, "tabEnabled");
    return value === undefined ? undefined : avm1.toBoolean(value, this.movie.version);
  }

  tabChildren(d: DisplayObject): boolean {
    const value = this.movie.input.read(d, "tabChildren");
    return value === undefined || avm1.toBoolean(value, this.movie.version);
  }

  buttonMode(clip: MovieClip): boolean {
    return this.movie.input.buttonMode(clip);
  }

  /** A tabIndex as an int: a number's or a boolean's, any other value's the least; -1 is none (Ruffle). */
  tabIndex(d: DisplayObject): number | undefined {
    const value = this.movie.input.read(d, "tabIndex");
    if (value === undefined || value === null) {
      return undefined;
    }

    const index =
      typeof value === "number" || typeof value === "boolean"
        ? avm1.toNumber(value, this.movie.version) | 0
        : -2147483648;
    return index === -1 ? undefined : index;
  }

  /** Tab, or Shift+Tab: the focus to the next object in the tab order, or the one before, round. */
  tab(reverse: boolean): boolean {
    const root = this.movie.root;
    const stage = root?.parent;
    if (!(root instanceof MovieClip) || !stage) {
      return false;
    }

    const order = tabOrder(root, stage, this);
    if (order.length === 0) {
      return false;
    }

    const at = this.focusedObject === null ? -1 : order.indexOf(this.focusedObject);
    const step = reverse ? order.length - 1 : 1;
    const next = at < 0 ? (reverse ? order.length - 1 : 0) : (at + step) % order.length;
    this.focus(order[next]);
    return true;
  }

  /**
   * Enter or Space on what has the focus, where the highlight shows: a press
   * and a release of it. Whether it was pressed, the key then the SWF's.
   */
  activate(): boolean {
    const d = this.focusedObject;
    if (
      this.highlight !== "visible" ||
      d === null ||
      this.movie.removed(d) ||
      !this.movie.input.flag(d, "enabled")
    ) {
      return false;
    }

    this.movie.input.buttonDispatch(d, ClipEvent.press);
    this.movie.input.buttonDispatch(d, ClipEvent.release);
    return true;
  }

  /**
   * The pointer's input, which hides the focus's highlight until Tab moves
   * the focus again: a left press always, and, below SWF 9, any press,
   * release or move.
   */
  pointerInput(type: "move" | "down" | "up", button: number): void {
    const left = button === 0;
    if (
      (type === "down" && left) ||
      (this.movie.version < 9 && (left || button === 2 || type === "move"))
    ) {
      this.highlight = "inactive";
    }
  }
}
