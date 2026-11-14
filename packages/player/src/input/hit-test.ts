// Hit testing: the object under a point as Flash picks it from its display
// list, Sprite.hitArea, and the bounds a pick passes over what misses by.
import type { Matrix } from "@swf2es/format";
import {
  hidden3D,
  hitsOwnLocal,
  hitsPoint,
  ownBounds,
  type Probe,
  toStage,
} from "../display/bounds.js";
import {
  BitmapObject,
  ButtonObject,
  Container,
  type DisplayObject,
  type MovieClip,
  pickWork,
  ShapeObject,
  StaticTextObject,
} from "../display/display.js";
import { concat, invert, isProjective, type Projective, type Rect } from "../display/geometry.js";

/**
 * What a pick finds: an interactive object hit, a hit that goes up to the
 * first ancestor with mouseEnabled, or nothing.
 */
const PROPAGATE = "propagate";
type Pick = DisplayObject | typeof PROPAGATE | null;

/**
 * An InteractiveObject's kind: what picks for itself, rather than through
 * its parent. An AVM1 movie's root is an AVM1Movie, no InteractiveObject:
 * a hit on it goes to its Loader, as Flash has it (the corpus's
 * `mouse_pick_loader_avm1`).
 */
const isInteractive = (d: DisplayObject): boolean =>
  !(
    d instanceof ShapeObject ||
    d instanceof BitmapObject ||
    d instanceof StaticTextObject ||
    d.avm1Root
  );

const mouseEnabled = (d: DisplayObject): boolean =>
  !!d.object && !d.avm1Root && d.object.$mouseEnabled !== false;

/**
 * Whether `d` is the main SWF's root, the stage's child that is a SWF's
 * root: Flash Player 32 never makes it the target. What would, its own
 * artwork, a hit passed up from a child whose mouseEnabled is false, all
 * of it with its mouseChildren false, goes to the stage, as the stage's
 * own empty space does, and it is only ever over as an ancestor. A sprite
 * a script puts on the stage beside it takes its hits as any other.
 */
const isMainRoot = (d: DisplayObject): boolean => !!d.loaderInfo && !!d.parent && !d.parent.parent;

/** `d` itself where it takes the pointer, else the hit goes on to its parent. */
const own = (d: DisplayObject): Pick => (mouseEnabled(d) && !isMainRoot(d) ? d : PROPAGATE);

/** Each sprite's hitArea. */
const hitAreas = new WeakMap<DisplayObject, DisplayObject>();

/** Sprite.hitArea: `area` picks for `sprite` in place of its own drawing. */
export function setHitArea(sprite: DisplayObject, area: DisplayObject | null): void {
  pickWork.changes++;
  if (area) {
    hitAreas.set(sprite, area);
  } else {
    hitAreas.delete(sprite);
  }
}

export function hitAreaOf(sprite: DisplayObject): DisplayObject | null {
  return hitAreas.get(sprite) ?? null;
}

/**
 * The object under a point, in stage coordinates, as Flash picks it
 * (Ruffle's `mouse_pick_avm2`): within a container, its interactive
 * children first, topmost first, then the rest. A hit on artwork, or on
 * a child whose mouseEnabled is false, goes to the nearest ancestor that
 * takes the pointer, short of the main root (isMainRoot): the stage takes
 * it there. One that goes up is kept while the search goes on, so a
 * disabled field over a button leaves the button its clicks.
 *
 * A sprite with a hitArea is hit where the area draws, wherever the area
 * is on the display list and whether or not it is visible, and its own
 * drawing counts for nothing; its interactive children still pick, unless
 * its mouseChildren is false. An area off the display list hits nothing.
 * The area itself is left as it was, mouseEnabled and all, as adl leaves
 * it: shown and enabled, it takes the pointer itself where it is on top,
 * as Flash's documentation warns. Ruffle reads AVM2's hitArea for nothing.
 * With `avm1`, a loaded movie may stand in for an AVM1 button: the host
 * routes that hit to its VM rather than dispatching an AS3 mouse event.
 */
export function pointerTarget(
  stage: Container,
  x: number,
  y: number,
  width: number,
  height: number,
  avm1?: (root: MovieClip, x: number, y: number) => boolean,
  left = 0,
  top = 0,
): DisplayObject | null {
  if (x < left || y < top || x >= left + width || y >= top + height) {
    return null;
  }

  // Flash samples half a pixel to the left of the point (bounds.ts,
  // hitsOwnPoint); the masks over an object are asked of it in the stage's
  // space, the object's own drawing of it in its own, which the pick
  // carries down the list from parent to child, making no matrix per object.
  const probe: Probe = { x: x - 0.5, y, root: stage };
  const picks = pickWork.picks++;

  // Whether `d`'s artwork is under (lx, ly), in its parent's space, its children's included.
  const drawn = (d: DisplayObject, px: number, py: number): boolean => {
    if (!d.visible || d.clipDepth > 0 || d.maskOf || !toLocal(d, px, py)) {
      return false;
    }

    if (d.space && hidden3D(d)) {
      return false;
    }

    const lx = at.x;
    const ly = at.y;
    if (missesShape(d, lx, ly)) {
      return false;
    }

    if (d instanceof Container) {
      for (const child of d.children) {
        if (drawn(child, lx, ly)) {
          return true;
        }
      }
    }

    return hitsOwnLocal(d, lx, ly, probe, true);
  };

  // What `d` picks for the point (px, py) in its parent's space; the stage's is its own.
  const pick = (d: DisplayObject, px: number, py: number): Pick => {
    if (!d.visible || d.clipDepth > 0 || d.maskOf) {
      return null;
    }

    if (d !== stage && (!toLocal(d, px, py) || (d.space && hidden3D(d)))) {
      return null;
    }

    const lx = d === stage ? px : at.x;
    const ly = d === stage ? py : at.y;
    if (d.avm1Root && avm1) {
      return avm1(d as MovieClip, x, y) ? d : drawn(d, px, py) ? PROPAGATE : null;
    }

    // A button is hit where its hit test state is, whatever state it shows,
    // and is the target itself, its states' objects never. The hit test
    // state is in no container: it is tested as the button's child.
    if (d instanceof ButtonObject) {
      const area = d.hitTestState;
      if (!area) {
        return null;
      }

      const parent = area.parent;
      area.parent = d;
      // A disabled button is missed, not passed up: what is under it gets the hit (Ruffle).
      try {
        return mouseEnabled(d) && drawn(area, lx, ly) ? d : null;
      } finally {
        area.parent = parent;
      }
    }

    if (!(d instanceof Container)) {
      return !missesShape(d, lx, ly) && hitsOwnLocal(d, lx, ly, probe, true) ? own(d) : null;
    }

    // Nothing under it reaches the point: most of a crowded list is passed
    // over so. Bounds are worked out only for what stood still over the
    // last two picks: what changes on most frames costs less gone through.
    if ((!d.pickStale || d.pickChangedAt < picks - 1) && !nearRect(pickBounds(d), lx, ly)) {
      return null;
    }

    const area = hitAreas.get(d);
    const areaHit = area && area !== d ? () => hitsPoint(area, x, y, true, stage) : null;
    if (areaHit && d.object?.$mouseChildren === false) {
      return areaHit() ? own(d) : null;
    }

    // Two passes rather than a sorted copy: this runs on every pointer move.
    const children = d.children;
    let propagated = false;

    for (let i = children.length - 1; i >= 0; i--) {
      if (!isInteractive(children[i]) && !(avm1 && children[i].avm1Root)) {
        continue;
      }

      const found = pick(children[i], lx, ly);
      if (found === PROPAGATE) {
        propagated = true;
      } else if (found) {
        // A container whose mouseChildren is false takes its children's hits itself.
        return d.object?.$mouseChildren === false ? own(d) : found;
      }
    }

    if (areaHit) {
      return areaHit() ? own(d) : null;
    }

    if (propagated) {
      return own(d);
    }

    for (let i = children.length - 1; i >= 0; i--) {
      if (!isInteractive(children[i]) && drawn(children[i], lx, ly)) {
        return own(d);
      }
    }

    return hitsOwnLocal(d, lx, ly, probe, true) ? own(d) : null;
  };

  const found = pick(stage, probe.x, probe.y);
  if (found && found !== PROPAGATE) {
    return found;
  }

  return stage.object ? stage : null;
}

/** Where toLocal puts a point. */
const at = { x: 0, y: 0 };

/** (x, y) of `d`'s parent's space in `d`'s own, put in `at`: false where its matrix flattens the plane. */
function toLocal(d: DisplayObject, x: number, y: number): boolean {
  const m = d.placed;
  if (isProjective(m)) {
    return toPlane(m, x, y);
  }

  const det = m.a * m.d - m.b * m.c;
  if (det === 0) {
    return false;
  }

  const dx = x - m.tx;
  const dy = y - m.ty;
  at.x = (m.d * dx - m.c * dy) / det;
  at.y = (m.a * dy - m.b * dx) / det;
  return true;
}

/** toLocal through a 3D object's plane in perspective: false where the point is behind the eye. */
function toPlane(m: Projective, x: number, y: number): boolean {
  const inverse = invert(m) as Projective | null;
  if (!inverse) {
    return false;
  }

  // The plane's w at the point found is 1 / q: behind the eye where it is not positive.
  const q = inverse.u * x + inverse.v * y + inverse.w;
  if (!(q > 0)) {
    return false;
  }

  at.x = (inverse.a * x + inverse.c * y + inverse.tx) / q;
  at.y = (inverse.b * x + inverse.d * y + inverse.ty) / q;
  return true;
}

/** Whether (x, y), in its own space, is more than a pixel off a timeline shape's recorded bounds. */
function missesShape(d: DisplayObject, x: number, y: number): boolean {
  const r = d instanceof ShapeObject && !d.drawing ? d.shape?.shape.bounds : null;
  return (
    !!r &&
    (x * 20 < r.xMin - 20 || x * 20 > r.xMax + 20 || y * 20 < r.yMin - 20 || y * 20 > r.yMax + 20)
  );
}

/**
 * Whether (x, y) is within a pixel of `r`: a hairline's half pixel, and
 * rounding, are in. Asked as what rules the point out, so that a NaN, in
 * the bounds or the point (a NaN or infinite matrix, a zero scale turned in
 * 3D, an infinite rectangle drawn), rules out nothing: a pick goes through
 * as it would without bounds, rather than missing all above it.
 */
function nearRect(r: Rect | null, x: number, y: number): boolean {
  return !(r === null || x < r.xMin - 1 || x > r.xMax + 1 || y < r.yMin - 1 || y > r.yMax + 1);
}

/**
 * Where anything under `d` may take the pointer, in its own space: what it
 * and its children draw, a scroll's rectangle in their place, and a
 * button's hit test state; masks are left out, which only take hits away.
 * Kept on `d` until a change in it or below it marks it stale
 * (invalidate), or its scroll changes. A
 * button's hit test state is in no container, so no change reaches its
 * button from it: a button, and all above it, are worked out each time.
 */
function pickBounds(d: DisplayObject): Rect | null {
  if (!d.pickStale && d.pickScroll === d.scroll) {
    return d.pickBounds;
  }

  // The extent so far, one per depth of this recursion: no closure or array a call.
  const depth = boundsDepth++;
  if (depth === boxes.length) {
    boxes.push(new Float64Array(4));
  }

  const box = boxes[depth];
  box.set(EMPTY);
  let stale = false;
  try {
    const scroll = d.scroll;
    // In its own space, which its placed matrix shifts by the scroll.
    extend(box, scroll ?? ownBounds(d, true), null);
    if (d instanceof ButtonObject) {
      const area = d.hitTestState;
      stale = true;
      if (area && !scroll) {
        extend(box, pickBounds(area), area.placed);
      }
    }

    // A hitArea, wherever it is on the list, through the stage to here; as
    // for a button's, no change to it reaches this sprite, measured each time.
    const area = hitAreas.get(d);
    if (area && area !== d) {
      stale = true;
      const up = invert(toStage(d, null));
      extend(box, up ? pickBounds(area) : UNKNOWN, up && concat(toStage(area, null), up));
    }

    if (d instanceof Container) {
      for (const child of d.children) {
        if (child.clipDepth > 0 || child.maskOf) {
          continue;
        }

        // A timeline shape's recorded bounds, read where they are: the
        // commonest leaf, and kept nowhere.
        const shape = child instanceof ShapeObject && !child.drawing ? child.shape : null;
        if (shape) {
          if (!scroll) {
            extend(box, shape.shape.bounds, child.placed, 1 / 20);
          }

          continue;
        }

        // Inside a scroll, only for whether it is to be worked out again.
        const r = pickBounds(child);
        if (!scroll) {
          extend(box, r, child.placed);
        }

        // A 3D child's plane moves with what is above this, which marks nothing here stale.
        stale ||= child.pickStale || child.space !== null;
      }
    }

    let r = d.pickBounds;
    if (box[0] > box[2]) {
      r = null;
    } else if (r) {
      r.xMin = box[0];
      r.yMin = box[1];
      r.xMax = box[2];
      r.yMax = box[3];
    } else {
      r = { xMin: box[0], yMin: box[1], xMax: box[2], yMax: box[3] };
    }

    d.pickBounds = r;
    d.pickStale = stale;
    d.pickScroll = scroll;
    return r;
  } finally {
    boundsDepth--;
  }
}

const EMPTY = [
  Number.POSITIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];
const boxes: Float64Array[] = [];
/** Bounds no point is ruled out of (nearRect). */
const UNKNOWN: Rect = { xMin: Number.NaN, yMin: Number.NaN, xMax: Number.NaN, yMax: Number.NaN };
let boundsDepth = 0;

/** `box` (xMin, yMin, xMax, yMax) grown to take in `r`'s corners, times `scale`, through `m`. */
function extend(box: Float64Array, r: Rect | null, m: Matrix | null, scale = 1): void {
  if (!r) {
    return;
  }

  for (let i = 0; i < 4; i++) {
    const px = (i & 1 ? r.xMax : r.xMin) * scale;
    const py = (i & 2 ? r.yMax : r.yMin) * scale;
    // Through a 3D object's plane; a corner behind the eye makes the box NaN, which rules nothing out.
    const q = m && isProjective(m) ? m.u * px + m.v * py + m.w : 1;
    const x = (m ? m.a * px + m.c * py + m.tx : px) / (q > 0 ? q : Number.NaN);
    const y = (m ? m.b * px + m.d * py + m.ty : py) / (q > 0 ? q : Number.NaN);
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
}
