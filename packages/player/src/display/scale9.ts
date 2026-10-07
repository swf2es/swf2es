// 9-slice scaling (docs/architecture.md, "Nine-slice scaling"): an object
// with a grid draws its shapes, its own and its Shape children's, with
// each vertex moved region by region, so that the corners keep their size
// in its parent's space, the edges stretch one way and the centre both.
// Its sprites, texts and bitmaps scale as ever, as do its bounds.
import type { Matrix } from "@swf2es/format";
import { ownBounds } from "./bounds.js";
import {
  Container,
  type DisplayObject,
  ShapeObject,
  StaticTextObject,
  TextObject,
} from "./display.js";
import { apply, invert, type Rect, union } from "./geometry.js";
import { pointsOf, type ShapeLayer } from "./shapes.js";

/**
 * One axis of a slice, in the owner's space: the bounds' and the grid's
 * edges, and where they are drawn, both in the owner's units.
 */
export interface Axis {
  from: [number, number, number, number];
  to: [number, number, number, number];
}

/** How an object with a grid draws its shapes, and the key that tells two apart. */
export interface Slice {
  x: Axis;
  y: Axis;
  key: string;
}

/**
 * Flash slices only an object whose own matrix neither turns nor skews,
 * to a 4096th, and mirrors neither way; any other scales as ever. adl
 * slices b = 0.000244 and not 0.0002442: a 16.16 fraction under 16.
 */
const SKEW = 1 / 4096;

/**
 * An axis from the bounds' edges lo and hi and the grid's gLo and gHi,
 * scaled by s: the corners keep their size in the parent's units, or,
 * where the scaled size is less than theirs, share it in proportion and
 * leave the centre none.
 */
export function axis(lo: number, gLo: number, gHi: number, hi: number, s: number): Axis {
  const corners = gLo - lo + (hi - gHi);
  const k = Math.min(1, (s * (hi - lo)) / corners);
  return {
    from: [lo, gLo, gHi, hi],
    to: [lo, lo + (k * (gLo - lo)) / s, hi - (k * (hi - gHi)) / s, hi],
  };
}

/**
 * The bounds a grid divides: what `o` draws, without lines, and what each
 * of its children draws itself, each in the child's own space, its matrix
 * ignored, and nothing of the grandchildren; a text field or a static
 * text counts for nothing, a bitmap or a video does. So adl slices: a
 * child's bars moved 30 to the right leave the edges where the panel's
 * are, one drawn out to 120 moves the right edge to 120 wherever the child
 * is, and a grandchild's moves nothing.
 */
export function sliceBounds(o: DisplayObject): Rect | null {
  let r = ownBounds(o, false);
  if (o instanceof Container) {
    for (const child of o.children) {
      if (!(child instanceof TextObject || child instanceof StaticTextObject)) {
        const b = ownBounds(child, false);
        if (b) {
          r = union(r, b);
        }
      }
    }
  }

  return r;
}

/** Whether `grid` is strictly inside `r` both ways, as Flash slices only by such a grid. */
export function gridInside(r: Rect | null, grid: Rect): boolean {
  return (
    r !== null &&
    r.xMin < grid.xMin &&
    grid.xMin < grid.xMax &&
    grid.xMax < r.xMax &&
    r.yMin < grid.yMin &&
    grid.yMin < grid.yMax &&
    grid.yMax < r.yMax
  );
}

/**
 * The slice `o` draws its shapes with under its matrix `m`: null where it
 * has no grid, or one not strictly inside its sliceBounds both ways, or a
 * transform Flash does not slice under, or one that changes nothing.
 */
export function sliceOf(o: DisplayObject, m: Matrix = o.matrix): Slice | null {
  const grid = o.scale9Grid;
  if (
    !grid ||
    !(m.a > 0 && m.d > 0 && Math.abs(m.b) < SKEW && Math.abs(m.c) < SKEW) ||
    (m.a === 1 && m.d === 1)
  ) {
    return null;
  }

  const r = sliceBounds(o);
  if (!r || !gridInside(r, grid)) {
    return null;
  }

  const kept = slices.get(o);
  if (
    kept &&
    kept.grid === grid &&
    kept.a === m.a &&
    kept.d === m.d &&
    kept.r.xMin === r.xMin &&
    kept.r.yMin === r.yMin &&
    kept.r.xMax === r.xMax &&
    kept.r.yMax === r.yMax
  ) {
    return kept.slice;
  }

  const x = axis(r.xMin, grid.xMin, grid.xMax, r.xMax, m.a);
  const y = axis(r.yMin, grid.yMin, grid.yMax, r.yMax, m.d);
  const slice = { x, y, key: `${x.to.join()},${y.to.join()},${x.from.join()},${y.from.join()}` };
  slices.set(o, { grid, a: m.a, d: m.d, r, slice });
  return slice;
}

/** Each object's last slice and what it was made of: a hit test asks for it on every pointer move. */
const slices = new WeakMap<
  DisplayObject,
  { grid: Rect; a: number; d: number; r: Rect; slice: Slice }
>();

/**
 * Where `v` is drawn on the axis: piecewise linear through the edges, and
 * on past the bounds at the corners' rate, as a curve's control point may be.
 */
export function onAxis(axis: Axis, v: number): number {
  const { from, to } = axis;
  const i = v < from[1] ? 0 : v < from[2] ? 1 : 2;
  return to[i] + ((v - from[i]) * (to[i + 1] - to[i])) / (from[i + 1] - from[i]);
}

/**
 * The slice that reshapes what `d` itself draws, and the matrix from its
 * space to the owner's, null for the owner itself: its own grid's, or,
 * for a shape, its parent's. Null for none.
 */
export function sliceFor(d: DisplayObject): { slice: Slice; m: Matrix | null } | null {
  if (masks(d)) {
    return null;
  }

  if (d.scale9Grid) {
    const slice = sliceOf(d);
    if (slice) {
      return { slice, m: null };
    }
  }

  const parent = d.parent;
  if (d instanceof ShapeObject && parent?.scale9Grid && !masks(parent)) {
    const slice = sliceOf(parent);
    if (slice) {
      return { slice, m: d.placed };
    }
  }

  return null;
}

/** Whether `d` is a mask, a script's or a timeline's, which adl draws and hits unsliced. */
function masks(d: DisplayObject): boolean {
  return d.maskOf !== null || d.clipDepth > 0;
}

/**
 * Layers with every point of their paths, fills' and lines' alike, moved
 * as the slice moves them. A fill's gradient or bitmap keeps its matrix,
 * stretched as ever, as Flash's does. `version` is a drawing's, whose
 * layers change in place.
 */
export function sliceLayers(
  layers: ShapeLayer[],
  slice: Slice,
  m: Matrix | null,
  version = 0,
): ShapeLayer[] {
  const at = m ? `;${m.a},${m.b},${m.c},${m.d},${m.tx},${m.ty}` : "";
  const key = `${slice.key}${at};${version}`;
  let kept = sliced.get(layers);
  const found = kept?.get(key);
  if (found) {
    return found;
  }

  const made = moveLayers(layers, slice, m);
  if (!kept) {
    kept = new Map();
    sliced.set(layers, kept);
  }

  // The oldest goes past a few: instances of one symbol at a few sizes alternate.
  if (kept.size >= SLICES_KEPT) {
    kept.delete(kept.keys().next().value as string);
  }

  kept.set(key, made);
  return made;
}

const SLICES_KEPT = 4;

/**
 * The latest slices of each set of layers, by the key of the slice, matrix
 * and version: a hit test asks on every pointer move, and the renderer
 * again on a redraw that is not a reslice.
 */
const sliced = new WeakMap<ShapeLayer[], Map<string, ShapeLayer[]>>();

function moveLayers(layers: ShapeLayer[], slice: Slice, m: Matrix | null): ShapeLayer[] {
  const inverse = m && invert(m);
  if (m && !inverse) {
    return layers;
  }

  const move = (path: number[]): number[] => {
    const out = path.slice();
    for (let i = 0; i < out.length; ) {
      const points = pointsOf(out[i]);
      for (let k = 0; k < points; k++) {
        const at = i + 1 + 2 * k;
        const [ox, oy] = m ? apply(m, out[at], out[at + 1]) : [out[at], out[at + 1]];
        const sx = onAxis(slice.x, ox);
        const sy = onAxis(slice.y, oy);
        [out[at], out[at + 1]] = inverse ? apply(inverse, sx, sy) : [sx, sy];
      }

      i += 1 + 2 * points;
    }

    return out;
  };

  return layers.map((layer) => ({
    fills: layer.fills.map((f) => ({ ...f, contours: f.contours.map(move) })),
    strokes: layer.strokes.map((s) => ({ ...s, paths: s.paths.map(move) })),
  }));
}
