// Sprite.startDrag's drags: the dragged object moved with the pointer, and
// the dropTarget it is over.
import { hitsOwnPoint, toStage } from "../display/bounds.js";
import { Container, type DisplayObject } from "../display/display.js";
import { apply, invert, type Rect } from "../display/geometry.js";

/** What each sprite dragged was last over, which Sprite.dropTarget reads. */
export const dropTargets = new WeakMap<DisplayObject, DisplayObject | null>();

/** A drag in progress: what follows the pointer, how, and where the pointer was last. */
export interface Drag {
  target: DisplayObject;
  lockCenter: boolean;
  bounds: Rect | null;
  lastX: number;
  lastY: number;
  /** The touch point that moves it, as Sprite.startTouchDrag's; the mouse where there is none. */
  touchPointID?: number;
}

/**
 * The drag's target moved with the pointer to (x, y) on the stage, in its
 * parent's space: its registration point there where it locks its centre,
 * else on by as much as the pointer moved, kept within its bounds and at
 * whole twips, as Flash keeps a translation. Whether it moved.
 */
export function dragTo(stage: Container, drag: Drag, x: number, y: number): boolean {
  const d = drag.target;
  const parent = d.parent;
  const inverse = parent ? invert(toStage(parent, stage)) : null;
  const [atX, atY] = inverse ? apply(inverse, x, y) : [x, y];
  const [lastX, lastY] = inverse
    ? apply(inverse, drag.lastX, drag.lastY)
    : [drag.lastX, drag.lastY];
  let nextX = drag.lockCenter ? atX : d.matrix.tx + atX - lastX;
  let nextY = drag.lockCenter ? atY : d.matrix.ty + atY - lastY;
  if (drag.bounds) {
    nextX = Math.max(drag.bounds.xMin, Math.min(nextX, drag.bounds.xMax));
    nextY = Math.max(drag.bounds.yMin, Math.min(nextY, drag.bounds.yMax));
  }

  nextX = Math.round(nextX * 20) / 20;
  nextY = Math.round(nextY * 20) / 20;
  drag.lastX = x;
  drag.lastY = y;
  if (nextX === d.matrix.tx && nextY === d.matrix.ty) {
    return false;
  }

  d.setMatrix({ ...d.matrix, tx: nextX, ty: nextY });
  d.touch();
  return true;
}

export function dropTargetOf(d: DisplayObject): DisplayObject | null {
  return dropTargets.get(d) ?? null;
}

/**
 * The topmost object drawing under a point, outside `dragged`, as Flash's
 * dropTarget names it: the shape itself, not the sprite that would take
 * the pointer, whatever its mouseEnabled (Flash's trace of the corpus's
 * `sprite_dropTarget` names the unnamed shapes in its sprites, where
 * Ruffle's names the sprites), and null over nothing, not the stage.
 */
export function objectUnder(
  stage: Container,
  x: number,
  y: number,
  dragged: DisplayObject,
): DisplayObject | null {
  const visit = (d: DisplayObject): DisplayObject | null => {
    if (d === dragged || !d.visible || d.clipDepth > 0 || d.maskOf) {
      return null;
    }

    if (d instanceof Container) {
      for (let i = d.children.length - 1; i >= 0; i--) {
        const found = visit(d.children[i]);
        if (found) {
          return found;
        }
      }
    }

    return d !== stage && hitsOwnPoint(d, x, y, stage, true) ? d : null;
  };

  return visit(stage);
}
