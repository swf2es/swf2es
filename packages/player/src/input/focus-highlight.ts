// The yellow rectangle Flash draws around what the keyboard's focus is on
// (docs/architecture/input.md, "The focus's rectangle"): the frame of its
// bounds on the stage, a button's hit area's, three screen pixels wide
// inside them, over everything, margins and all.

import { boundsIn } from "../display/bounds.js";
import { ButtonObject, type DisplayObject, parentage } from "../display/display.js";
import type { Rect } from "../display/geometry.js";

/** What a view draws for the focus (RenderView.highlight): the frame's outer edges on the stage, in pixels. */
export type FocusHighlight = Rect;

/**
 * `d`'s bounds in `target`'s space, through `stage`, as the focus measures
 * them: a button's are its hit area's, whatever state it shows, as Flash
 * frames and orders it.
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

  // The hit area is no child of the button's: placed under it for the measure alone.
  const parent = area.parent;
  area.parent = d as ButtonObject;
  parentage.changes++;
  try {
    return boundsIn(area, target, stage, true);
  } finally {
    area.parent = parent;
    parentage.changes++;
  }
}

/** The highlight around `d` on `stage`; null where `d` is off it or has no size. */
export function highlightOf(d: DisplayObject, stage: DisplayObject): FocusHighlight | null {
  for (let p: DisplayObject | null = d; p !== stage; p = p.parent) {
    if (p === null) {
      return null;
    }
  }

  const frame = focusBounds(d, stage, stage);
  return frame.xMax > frame.xMin || frame.yMax > frame.yMin ? frame : null;
}
