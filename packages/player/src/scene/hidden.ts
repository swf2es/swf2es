import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";
import { ShapeObject } from "../display/shapeobject.js";

/**
 * Finish a subtree that draws nothing, including children of a reused filter output.
 * Hidden morphs still take their new ratio, which bounds and hit tests observe. A
 * BitmapData snapshot leaves the stage's dirty flags alone, as the normal walk does.
 */
export function syncHidden(o: DisplayObject, snapshotting: boolean): void {
  if (o instanceof ShapeObject) {
    o.drawn();
  }

  if (o instanceof Container) {
    const children = o.children;
    for (let i = 0; i < children.length; i++) {
      syncHidden(children[i], snapshotting);
    }

    if (!snapshotting) {
      o.descendantsDirty = false;
    }
  }

  if (!snapshotting) {
    o.dirty = CLEAN;
  }
}
