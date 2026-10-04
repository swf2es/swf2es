// A display object's bounds and hit tests (docs/architecture.md, "Bounds
// and hit tests"): a SWF shape's recorded rectangles, a drawing's true
// extent, a container's children's through their matrices.
import type { Matrix } from "@swf2es/format";
import {
  BitmapObject,
  Container,
  type DisplayObject,
  ShapeObject,
  StaticTextObject,
  TextObject,
} from "./display.js";
import {
  apply,
  concat,
  contains,
  invert,
  overlaps,
  type Rect,
  transformRect,
  union,
} from "./geometry.js";
import { flatten, inside, orientation, type Path, type ShapeLayer } from "./shapes.js";
import { hitsGlyph } from "./static-text.js";

const TWIPS = 20;
const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** The matrix from `d`'s space to the stage's (`stage` itself excluded), through every parent, scroll shifts and all. */
export function toStage(d: DisplayObject, stage: DisplayObject | null): Matrix {
  let m = d.placed;
  for (let p = d.parent; p && p !== stage; p = p.parent) {
    m = concat(m, p.placed);
  }

  return m;
}

/** What `d` itself draws, in its own space: null for nothing. `lines` counts the lines' widths. */
function ownBounds(d: DisplayObject, lines: boolean): Rect | null {
  if (d.drawing) {
    return d.drawing.bounds(lines);
  }

  if (d instanceof BitmapObject) {
    const store = d.store;
    return store && !store.disposed
      ? { xMin: 0, yMin: 0, xMax: store.width, yMax: store.height }
      : null;
  }

  if (d instanceof TextObject) {
    return { xMin: d.left, yMin: d.top, xMax: d.left + d.width, yMax: d.top + d.height };
  }

  if (d instanceof StaticTextObject) {
    const r = d.definition.definition.bounds;
    return {
      xMin: r.xMin / TWIPS,
      yMin: r.yMin / TWIPS,
      xMax: r.xMax / TWIPS,
      yMax: r.yMax / TWIPS,
    };
  }

  if (d instanceof ShapeObject && d.shape) {
    const r = (lines ? null : d.shape.shape.edgeBounds) ?? d.shape.shape.bounds;
    return {
      xMin: r.xMin / TWIPS,
      yMin: r.yMin / TWIPS,
      xMax: r.xMax / TWIPS,
      yMax: r.yMax / TWIPS,
    };
  }

  return null;
}

/**
 * `d`'s bounds in its own space, its children's included: null for an
 * object with nothing in it. A scrolled object's are its scroll's size at
 * (0, 0), whatever it draws, as Flash reports them; masks clip none.
 */
export function bounds(d: DisplayObject, lines: boolean): Rect | null {
  const scroll = d.scroll;
  if (scroll) {
    return { xMin: 0, yMin: 0, xMax: scroll.xMax - scroll.xMin, yMax: scroll.yMax - scroll.yMin };
  }

  let r = ownBounds(d, lines);
  if (d instanceof Container) {
    for (const child of d.children) {
      const b = bounds(child, lines);
      if (b) {
        r = union(r, transformRect(b, child.placed));
      }
    }
  }

  return r;
}

/** `d`'s bounds in `target`'s space (its own for null), through the stage. */
export function boundsIn(
  d: DisplayObject,
  target: DisplayObject | null,
  stage: DisplayObject | null,
  lines: boolean,
): Rect {
  const own = bounds(d, lines) ?? { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  if (!target || target === d) {
    return own;
  }

  const up = toStage(d, stage);
  const down = target === stage ? IDENTITY : (invert(toStage(target, stage)) ?? IDENTITY);
  return transformRect(own, concat(up, down));
}

/**
 * Whether the point (x, y) is within `d`'s bounds, or, for `shape`, on what
 * it or its children draw. The point is in the main root's space, as Flash
 * has it (the corpus's `displayobject_hittestpoint_root`): moving the root
 * moves nothing under the point, moving a loaded SWF's root does. The
 * shape test asks for a root above `d`, the bounds test does not.
 */
export function hitsPoint(
  d: DisplayObject,
  x: number,
  y: number,
  shape: boolean,
  root: DisplayObject | null,
): boolean {
  const toLocal = invert(toStage(d, root));
  if (!toLocal) {
    return false;
  }

  if (!shape) {
    const [lx, ly] = apply(toLocal, x, y);
    const r = bounds(d, true);
    return r !== null && contains(r, lx, ly);
  }

  // A mask is not drawn, and adl hits nothing of it.
  if (!underRoot(d) || d.maskOf) {
    return false;
  }

  // Flash samples half a pixel to the left of the point and on its row: a
  // point on a shape's right edge hits, one on its left, top or bottom edge
  // does not (the corpus's displayobject_hittestpoint_boundary).
  const [lx, ly] = apply(toLocal, x - 0.5, y);
  const probe = { x: x - 0.5, y, root };
  return drawnAt(d, lx, ly, probe, false) && !clippedAbove(d, probe);
}

/** What this object itself draws under a pointer, without asking its children. */
export function hitsOwnPoint(d: DisplayObject, x: number, y: number, root: DisplayObject): boolean {
  if (!underRoot(d) || d.maskOf) {
    return false;
  }

  const toLocal = invert(toStage(d, root));
  if (!toLocal) {
    return false;
  }

  const probe = { x: x - 0.5, y, root };
  if (clippedAbove(d, probe)) {
    return false;
  }

  const [lx, ly] = apply(toLocal, probe.x, probe.y);
  if (d instanceof TextObject) {
    const r = ownBounds(d, true);
    const scroll = d.scroll;
    return (
      !!r &&
      contains(r, lx, ly) &&
      (!scroll || contains(scroll, lx, ly)) &&
      (!d.mask || inMask(d.mask, probe))
    );
  }

  return drawnAt(d, lx, ly, probe, false, false);
}

/** Whether a mask or a scroll above `d` leaves the probe out. */
function clippedAbove(d: DisplayObject, probe: Probe): boolean {
  for (let p = d.parent; p; p = p.parent) {
    if (p.mask && !p.maskOf && !p.mask.encloses(p) && !inMask(p.mask, probe)) {
      return true;
    }

    const scroll = p.scroll;
    const toLocal = scroll && invert(toStage(p, probe.root));
    if (scroll && toLocal) {
      const [x, y] = apply(toLocal, probe.x, probe.y);
      if (!(x >= scroll.xMin && x < scroll.xMax && y >= scroll.yMin && y < scroll.yMax)) {
        return true;
      }
    }
  }

  return false;
}

/** The point a shape test asks of, in the root's space: masks are found from it. */
interface Probe {
  x: number;
  y: number;
  root: DisplayObject | null;
}

/** Whether the probe is on `mask`'s fills, where it is: its lines clip nothing. */
function inMask(mask: DisplayObject, probe: Probe): boolean {
  const toLocal = invert(toStage(mask, probe.root));
  if (!toLocal) {
    return false;
  }

  const [x, y] = apply(toLocal, probe.x, probe.y);
  return drawnAt(mask, x, y, probe, true);
}

/** Whether a SWF's root, the main one's or a loaded one's, is `d` or above it. */
function underRoot(d: DisplayObject): boolean {
  for (let o: DisplayObject | null = d; o; o = o.parent) {
    if (o.loaderInfo) {
      return true;
    }
  }

  return false;
}

/**
 * Whether (x, y), in `d`'s space, is on a fill or a line of `d` or of a
 * child, within the scroll and the masks that clip it. As a mask (`mask`)
 * its lines count for nothing and its own mask is not asked, so that two
 * masks of each other end.
 */
function drawnAt(
  d: DisplayObject,
  x: number,
  y: number,
  probe: Probe,
  mask: boolean,
  children = true,
): boolean {
  const scroll = d.scroll;
  if (scroll && !(x >= scroll.xMin && x < scroll.xMax && y >= scroll.yMin && y < scroll.yMax)) {
    return false;
  }

  if (!mask && d.mask && !d.maskOf && !d.mask.encloses(d) && !inMask(d.mask, probe)) {
    return false;
  }

  // A Bitmap is hit, and masks, over its whole rectangle, transparent pixels and all.
  if (d instanceof BitmapObject) {
    const store = d.store;
    return !!store && !store.disposed && x >= 0 && x < store.width && y >= 0 && y < store.height;
  }

  if (d instanceof StaticTextObject) {
    return hitsGlyph(d.definition, d.glyphs.glyphs, x, y, mask);
  }

  const layers: ShapeLayer[] =
    d.drawing?.layers ?? (d instanceof ShapeObject ? (d.shape?.layers ?? []) : []);
  for (const layer of layers) {
    for (const { contours, winding } of layer.fills) {
      // Inside by the fill's rule: an odd number of its contours around the
      // point for even-odd, a non-zero sum of their orientations for non-zero.
      let crossings = 0;
      let sum = 0;
      for (const contour of contours) {
        const flat = flattened(contour);
        if (near(flat, x, y, 0) && inside(flat.points, x, y)) {
          crossings++;
          sum += flat.orientation;
        }
      }

      if (winding === "nonZero" ? sum !== 0 : crossings % 2) {
        return true;
      }
    }

    if (mask) {
      continue;
    }

    for (const { line, paths } of layer.strokes) {
      const half = Math.max(line.width / TWIPS, 1) / 2;
      for (const path of paths) {
        const flat = flattened(path);
        if (near(flat, x, y, half) && nearPolyline(flat.points, x, y, half)) {
          return true;
        }
      }
    }
  }

  if (children && d instanceof Container) {
    // Masks are not drawn; a timeline's clip no hit test, as Flash's do not.
    for (const child of d.children) {
      const toChild = invert(child.placed);
      if (
        toChild &&
        child.clipDepth === 0 &&
        child.maskOf === null &&
        drawnAt(child, ...apply(toChild, x, y), probe, mask)
      ) {
        return true;
      }
    }
  }

  return false;
}

/** A path as hit tests read it: its polygon, the polygon's orientation, and the box around it. */
interface Flat {
  /** How long the path was: a drawing's paths grow as lineTo adds to them. */
  length: number;
  points: number[];
  orientation: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/**
 * Paths flattened once, not on every hit test: the pointer asks on every
 * move, of every shape under the point's ancestors, and a curve's chords
 * cost more than a box test that rules most of them out.
 */
const flats = new WeakMap<Path, Flat>();

function flattened(path: Path): Flat {
  const cached = flats.get(path);
  if (cached && cached.length === path.length) {
    return cached;
  }

  const points = flatten(path);
  let [xMin, yMin, xMax, yMax] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 2) {
    xMin = Math.min(xMin, points[i]);
    xMax = Math.max(xMax, points[i]);
    yMin = Math.min(yMin, points[i + 1]);
    yMax = Math.max(yMax, points[i + 1]);
  }

  const flat = {
    length: path.length,
    points,
    orientation: orientation(points),
    xMin,
    yMin,
    xMax,
    yMax,
  };
  flats.set(path, flat);
  return flat;
}

/** Whether (x, y) is within `half` of the path's box, as it must be to be in or on it. */
function near(flat: Flat, x: number, y: number, half: number): boolean {
  return (
    x >= flat.xMin - half && x <= flat.xMax + half && y >= flat.yMin - half && y <= flat.yMax + half
  );
}

/** Whether (px, py) is within `half` of any segment of the open polyline. */
function nearPolyline(points: number[], px: number, py: number, half: number): boolean {
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2];
    const ay = points[i - 1];
    const bx = points[i];
    const by = points[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    const t =
      length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
    if (Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= half) {
      return true;
    }
  }

  return false;
}

/** Whether the two objects' bounds in the stage's space overlap. */
export function hitsObject(
  a: DisplayObject,
  b: DisplayObject,
  stage: DisplayObject | null,
): boolean {
  const ra = bounds(a, true);
  const rb = bounds(b, true);
  if (!ra || !rb) {
    return false;
  }

  return overlaps(transformRect(ra, toStage(a, stage)), transformRect(rb, toStage(b, stage)));
}
