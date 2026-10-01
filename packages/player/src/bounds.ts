// A display object's bounds and hit tests (docs/architecture.md, "Bounds
// and hit tests"): a SWF shape's recorded rectangles, a drawing's true
// extent, a container's children's through their matrices.
import type { Matrix } from "@swf2es/format";
import { BitmapObject, Container, type DisplayObject, ShapeObject } from "./display.js";
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
import { flatten, inside, orientation, type ShapeLayer } from "./shapes.js";

const TWIPS = 20;
const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** The matrix from `d`'s space to the stage's (`stage` itself excluded), through every parent. */
export function toStage(d: DisplayObject, stage: DisplayObject | null): Matrix {
  let m = d.matrix;
  for (let p = d.parent; p && p !== stage; p = p.parent) {
    m = concat(m, p.matrix);
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

/** `d`'s bounds in its own space, its children's included: null for an object with nothing in it. */
export function bounds(d: DisplayObject, lines: boolean): Rect | null {
  let r = ownBounds(d, lines);
  if (d instanceof Container) {
    for (const child of d.children) {
      const b = bounds(child, lines);
      if (b) {
        r = union(r, transformRect(b, child.matrix));
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

  if (!underRoot(d)) {
    return false;
  }

  // Flash samples half a pixel to the left of the point and on its row: a
  // point on a shape's right edge hits, one on its left, top or bottom edge
  // does not (the corpus's displayobject_hittestpoint_boundary).
  const [lx, ly] = apply(toLocal, x - 0.5, y);
  return drawnAt(d, lx, ly);
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

/** Whether (x, y), in `d`'s space, is on a fill or a line of `d` or of a child. */
function drawnAt(d: DisplayObject, x: number, y: number): boolean {
  const layers: ShapeLayer[] =
    d.drawing?.layers ?? (d instanceof ShapeObject ? (d.shape?.layers ?? []) : []);
  for (const layer of layers) {
    for (const { contours, winding } of layer.fills) {
      // Inside by the fill's rule: an odd number of its contours around the
      // point for even-odd, a non-zero sum of their orientations for non-zero.
      let crossings = 0;
      let sum = 0;
      for (const contour of contours) {
        const points = flatten(contour);
        if (inside(points, x, y)) {
          crossings++;
          sum += orientation(points);
        }
      }

      if (winding === "nonZero" ? sum !== 0 : crossings % 2) {
        return true;
      }
    }

    for (const { line, paths } of layer.strokes) {
      const half = Math.max(line.width / TWIPS, 1) / 2;
      for (const path of paths) {
        if (nearPolyline(flatten(path), x, y, half)) {
          return true;
        }
      }
    }
  }

  if (d instanceof Container) {
    for (const child of d.children) {
      const toChild = invert(child.matrix);
      if (toChild) {
        const [cx, cy] = apply(toChild, x, y);
        if (drawnAt(child, cx, cy)) {
          return true;
        }
      }
    }
  }

  return false;
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
