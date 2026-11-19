// The yellow rectangle Flash draws around what the keyboard's focus is on
// (docs/architecture/input.md, "The focus's rectangle"): the frame of its
// bounds on the stage, a button's hit area's, three screen pixels wide
// inside them, over everything, margins and all.

import { bounds, boundsIn, toStage } from "../display/bounds.js";
import { ButtonObject, Container, type DisplayObject, parentage } from "../display/display.js";
import { CLEAN } from "../display/displayobject.js";
import { concat, type Rect, transformRect } from "../display/geometry.js";

/** What a view draws for the focus (RenderView.highlight): the frame's outer edges on the stage, in pixels. */
export type FocusHighlight = Rect;

/**
 * `d`'s bounds as the focus measures them, in its parent's space or, with
 * `target` the stage, on `stage`: a button's are its hit area's, whatever
 * state it shows, as Flash frames and orders it. The hit area, no child of
 * the button's, is taken through its place in it, not parented for it.
 */
export function focusBounds(
  d: DisplayObject,
  target: DisplayObject | null,
  stage: DisplayObject | null,
): Rect {
  const area = d instanceof ButtonObject ? d.hitTestState : null;
  if (!area) {
    return boundsIn(d, target, stage, true);
  }

  const own = bounds(area, true) ?? { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  const up = target === d.parent ? d.placed : toStage(d, stage);
  return transformRect(own, concat(area.placed, up));
}

/**
 * The frame measured, kept while neither what it frames nor anything above
 * that has changed since: their flags, which the view clears as it draws,
 * so a host asks before each render, and forgets it while none shows.
 */
export class Highlights {
  private framed: DisplayObject | null = null;
  private frame: Rect | null = null;
  private parentage = -1;

  /** The frame around `d` on `stage`: null where it, or what is above it, is hidden or off it, or it has no size. */
  around(d: DisplayObject, stage: DisplayObject): FocusHighlight | null {
    let changed = d !== this.framed || parentage.changes !== this.parentage;
    changed ||= d.dirty !== CLEAN || (d instanceof Container && d.descendantsDirty);
    for (let p: DisplayObject | null = d; p !== stage; p = p.parent) {
      if (p === null || !p.visible) {
        this.forget();
        return null;
      }

      changed ||= p.dirty !== CLEAN;
    }

    if (changed) {
      const frame = focusBounds(d, stage, stage);
      this.framed = d;
      this.parentage = parentage.changes;
      this.frame = frame.xMax > frame.xMin || frame.yMax > frame.yMin ? frame : null;
    }

    return this.frame;
  }

  /** None shows: what is drawn meanwhile clears flags this frame did not see. */
  forget(): void {
    this.framed = null;
  }
}
