// An AVM1 movie's tab order, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/focus_tracker.rs and display_object/container.rs fill it: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// The display list is walked as it is drawn, each object before what is in
// it; a hidden object is left out with what is in it, and so is what is in
// a clip whose tabChildren is false. Once any object has a tabIndex, the
// order is by tabIndex, objects of equal ones as walked, and those without
// one are left out; otherwise it is by place, 6 × y + x of each object's
// top left corner on the stage in twips, of which only the first walked at
// a place is kept, as Ruffle keeps it.
import { boundsIn } from "../display/bounds.js";
import {
  ButtonObject,
  Container,
  type DisplayObject,
  MovieClip,
  TextObject,
} from "../display/display.js";

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
export function tabOrder(root: MovieClip, stage: Container, host: TabHost): DisplayObject[] {
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
