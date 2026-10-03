// Morph shapes: DefineMorphShape's two ends blended at a placement's ratio
// into a shape like any other, which the player draws, bounds and hit-tests
// as it does a DefineShape's. A morph keeps its latest blends only.
import type {
  Fill,
  Gradient,
  Line,
  Matrix,
  MorphShape,
  Rect,
  Shape,
  ShapeRecord,
} from "@swf2es/format";
import type { ShapeLayer } from "./shapes.js";
import { shapeLayers } from "./shapes.js";
import type { MorphCharacter, ShapeCharacter } from "./timeline.js";

/**
 * The layers of blends a morph no longer keeps. The renderer shares a
 * blend's lines while it is kept; one made again for the same ratio has
 * layers of its own, so lines kept for these would never be found again.
 */
export const droppedLayers = new WeakSet<ShapeLayer>();

/** The layers of every blend made, whose lines the renderer watches for their dropping. */
export const blendLayers = new WeakSet<ShapeLayer>();

/** How many blends a morph keeps: its latest ratios, enough for instances in step to share them. */
const KEPT_BLENDS = 16;

/**
 * The shape `character` is at `ratio`, 0 its start to 65535 its end: made
 * the first time it is asked for and kept while it is among the morph's
 * latest, as a tween asks for a new ratio on each frame.
 */
export function morphAt(character: MorphCharacter, ratio: number): ShapeCharacter {
  const blends = character.blends;
  let shape = blends.get(ratio);
  if (shape) {
    // Last in the map's order, the most recently asked for.
    blends.delete(ratio);
  } else {
    const blended = blend(character.morph, ratio / 65535);
    shape = {
      type: "shape",
      id: character.id,
      shape: blended,
      layers: shapeLayers(blended, character.bitmap),
    };
    for (const layer of shape.layers) {
      blendLayers.add(layer);
    }
  }

  blends.set(ratio, shape);
  if (blends.size > KEPT_BLENDS) {
    const oldest = blends.keys().next().value as number;
    for (const layer of blends.get(oldest)?.layers ?? []) {
      droppedLayers.add(layer);
    }

    blends.delete(oldest);
  }

  return shape;
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Each channel of two 0xAARRGGBB colours mixed, as a byte. */
function mixColor(a: number, b: number, t: number): number {
  let out = 0;
  for (let shift = 24; shift >= 0; shift -= 8) {
    const channel = Math.round(mix((a >>> shift) & 0xff, (b >>> shift) & 0xff, t));
    out = out * 256 + channel;
  }

  return out;
}

function mixMatrix(a: Matrix, b: Matrix, t: number): Matrix {
  return {
    a: mix(a.a, b.a, t),
    b: mix(a.b, b.b, t),
    c: mix(a.c, b.c, t),
    d: mix(a.d, b.d, t),
    tx: mix(a.tx, b.tx, t),
    ty: mix(a.ty, b.ty, t),
  };
}

function mixRect(a: Rect, b: Rect, t: number): Rect {
  return {
    xMin: mix(a.xMin, b.xMin, t),
    xMax: mix(a.xMax, b.xMax, t),
    yMin: mix(a.yMin, b.yMin, t),
    yMax: mix(a.yMax, b.yMax, t),
  };
}

function mixGradient(a: Gradient, b: Gradient, t: number): Gradient {
  return {
    matrix: mixMatrix(a.matrix, b.matrix, t),
    spread: a.spread,
    interpolation: a.interpolation,
    stops: a.stops.map((stop, i) => {
      const other = b.stops[i] ?? stop;
      return {
        ratio: Math.round(mix(stop.ratio, other.ratio, t)),
        color: mixColor(stop.color, other.color, t),
      };
    }),
    focal: mix(a.focal, b.focal, t),
  };
}

/** Two fills of one MORPHFILLSTYLE, which share their type. */
function mixFill(a: Fill, b: Fill, t: number): Fill {
  if (a.type === "solid" && b.type === "solid") {
    return { type: "solid", color: mixColor(a.color, b.color, t) };
  }

  if (a.type === "bitmap" && b.type === "bitmap") {
    return { ...a, matrix: mixMatrix(a.matrix, b.matrix, t) };
  }

  if (a.type !== "solid" && a.type !== "bitmap" && b.type === a.type) {
    return { type: a.type, gradient: mixGradient(a.gradient, b.gradient, t) };
  }

  return a;
}

function mixLine(a: Line, b: Line, t: number): Line {
  return {
    ...a,
    width: mix(a.width, b.width, t),
    color: mixColor(a.color, b.color, t),
    fill: a.fill && b.fill ? mixFill(a.fill, b.fill, t) : a.fill,
  };
}

type Edge = Extract<ShapeRecord, { type: "line" | "curve" }>;
type Style = Extract<ShapeRecord, { type: "style" }>;
type Point = { x: number; y: number };

const NO_EDGE: Edge = { type: "line", dx: 0, dy: 0 };

/**
 * An edge from `pen` in absolute twips: its control point, halfway along a straight one, and
 * anchor.
 */
function absolute(e: Edge, pen: Point): { control: Point; anchor: Point; straight: boolean } {
  if (e.type === "line") {
    const anchor = { x: pen.x + e.dx, y: pen.y + e.dy };
    return {
      control: { x: (pen.x + anchor.x) / 2, y: (pen.y + anchor.y) / 2 },
      anchor,
      straight: true,
    };
  }

  const control = { x: pen.x + e.cx, y: pen.y + e.cy };
  return { control, anchor: { x: control.x + e.ax, y: control.y + e.ay }, straight: false };
}

/**
 * Two points mixed, to the twip: whole twips keep the pen's sums exact, and closed paths closed.
 */
const mixPoint = (a: Point, b: Point, t: number): Point => ({
  x: Math.round(mix(a.x, b.x, t)),
  y: Math.round(mix(a.y, b.y, t)),
});

/**
 * The morph at `t`, 0 to 1. The ends' edges pair in order, a straight
 * one with a curve as a curve, and their points are mixed where they lie,
 * not their deltas. A style change is the start's, its move mixed with
 * the end's where the end has one there, else with the end's pen; a move
 * only the end has moves the pen from the start's.
 */
function blend(morph: MorphShape, t: number): Shape {
  const records: ShapeRecord[] = [];
  const start = morph.start;
  const end = morph.end;
  let startPen: Point = { x: 0, y: 0 };
  let endPen: Point = { x: 0, y: 0 };
  let pen: Point = { x: 0, y: 0 };
  let i = 0;
  let j = 0;

  while (i < start.length) {
    const s = start[i];
    const e: ShapeRecord | undefined = end[j];
    if (s.type === "style") {
      const endStyle = e?.type === "style" ? e : null;
      if (endStyle) {
        j++;
        endPen = endStyle.moveTo ?? endPen;
      }

      startPen = s.moveTo ?? startPen;
      const moves = s.moveTo !== null || endStyle?.moveTo;
      if (moves) {
        pen = mixPoint(startPen, endPen, t);
      }

      records.push({ ...s, moveTo: moves ? pen : null } satisfies Style);
      i++;
      continue;
    }

    if (e?.type === "style") {
      if (e.moveTo) {
        endPen = e.moveTo;
        pen = mixPoint(startPen, endPen, t);
        records.push({
          type: "style",
          moveTo: pen,
          fill0: null,
          fill1: null,
          line: null,
          styles: null,
        });
      }

      j++;
      continue;
    }

    const a = absolute(s, startPen);
    const b = absolute(e ?? NO_EDGE, endPen);
    const anchor = mixPoint(a.anchor, b.anchor, t);
    if (a.straight && b.straight) {
      records.push({ type: "line", dx: anchor.x - pen.x, dy: anchor.y - pen.y });
    } else {
      const control = mixPoint(a.control, b.control, t);
      records.push({
        type: "curve",
        cx: control.x - pen.x,
        cy: control.y - pen.y,
        ax: anchor.x - control.x,
        ay: anchor.y - control.y,
      });
    }

    startPen = a.anchor;
    endPen = b.anchor;
    pen = anchor;
    i++;
    j++;
  }

  return {
    id: morph.id,
    bounds: mixRect(morph.startBounds, morph.endBounds, t),
    edgeBounds:
      morph.startEdgeBounds && morph.endEdgeBounds
        ? mixRect(morph.startEdgeBounds, morph.endEdgeBounds, t)
        : null,
    fills: morph.fills.map((f) => mixFill(f.start, f.end, t)),
    lines: morph.lines.map((l) => mixLine(l.start, l.end, t)),
    records,
    truncated: morph.truncated,
  };
}
