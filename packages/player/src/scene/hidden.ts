import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";
import { ShapeObject } from "../display/shapeobject.js";

/**
 * Finish a subtree that draws nothing, including children of a reused filter output.
 * Hidden morphs still take their new ratio, which bounds and hit tests observe. A
 * BitmapData snapshot leaves the stage's dirty flags alone, as the normal walk does.
 */
export function syncHidden(o: DisplayObject, snapshotting: boolean): void {
  // Nothing in it invalidated since it was last finished, which marks every
  // ancestor's descendants dirty: its morphs have their ratios' blends, and
  // its flags are clear. A hidden subtree, as a reused filter output's
  // content mostly is, is then passed over whole rather than walked again.
  if (o.dirty === CLEAN && !(o instanceof Container && o.descendantsDirty)) {
    return;
  }

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
