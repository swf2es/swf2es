// A shape's records as paths to draw: for each layer (a new set of styles
// starts one), each fill's closed contours and each line's strokes, in
// pixels. Flash fills a region on both sides of an edge: the edge belongs to
// its fill1 as it goes and to its fill0 reversed, so that each fill's edges
// join end to start into closed contours, filled even-odd. Lines stroke the
// edges they are set on, joined where one edge starts where the last ended.
import type { Fill, GradientStop, Line, Matrix, Shape } from "@swf2es/format";
import type { BitmapStore } from "./bitmap.js";
import type { BitmapCharacter } from "./timeline.js";

/**
 * Path commands, flat: 1 x y (move), 2 x y (line), 3 cx cy x y (quadratic
 * curve), 4 c1x c1y c2x c2y x y (cubic curve, which only a Graphics
 * draws), in pixels.
 */
export type Path = number[];

export const MOVE = 1;
export const LINE = 2;
export const CURVE = 3;
export const CUBIC = 4;

/** How many points a command takes. */
export function pointsOf(command: number): number {
  return command === CUBIC ? 3 : command === CURVE ? 2 : 1;
}

/** How a fill's contours decide what is inside: by parity, or by the winding number, as drawPath may ask. */
export type Winding = "evenOdd" | "nonZero";

/** The path as a polygon's points, x y x y..., its curves as eight chords each. */
export function flatten(path: Path): number[] {
  const points: number[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < path.length; ) {
    const command = path[i];
    if (command === CUBIC) {
      const [c1x, c1y, c2x, c2y, ax, ay] = path.slice(i + 1, i + 7);
      for (let k = 1; k <= 8; k++) {
        const t = k / 8;
        const u = 1 - t;
        points.push(
          u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ax,
          u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ay,
        );
      }

      x = ax;
      y = ay;
      i += 7;
    } else if (command === CURVE) {
      const [cx, cy, ax, ay] = path.slice(i + 1, i + 5);
      for (let k = 1; k <= 8; k++) {
        const t = k / 8;
        const u = 1 - t;
        points.push(
          u * u * x + 2 * u * t * cx + t * t * ax,
          u * u * y + 2 * u * t * cy + t * t * ay,
        );
      }

      x = ax;
      y = ay;
      i += 5;
    } else {
      x = path[i + 1];
      y = path[i + 2];
      points.push(x, y);
      i += 3;
    }
  }

  return points;
}

/** Whether (px, py) is inside the polygon, by the even-odd rule. */
export function inside(points: number[], px: number, py: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const xi = points[i];
    const yi = points[i + 1];
    const xj = points[j];
    const yj = points[j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }

  return hit;
}

/**
 * The path's extent, each curve at its true extremes, as [xMin, yMin,
 * xMax, yMax]; null for a path with no points.
 */
export function extent(path: Path): [number, number, number, number] | null {
  let xMin = Number.POSITIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const take = (x: number, y: number) => {
    xMin = Math.min(xMin, x);
    yMin = Math.min(yMin, y);
    xMax = Math.max(xMax, x);
    yMax = Math.max(yMax, y);
  };
  let x = 0;
  let y = 0;
  for (let i = 0; i < path.length; ) {
    const command = path[i];
    if (command === MOVE) {
      // A move alone has no extent: the pen's place counts once a segment leaves it.
      x = path[i + 1];
      y = path[i + 2];
      i += 3;
      continue;
    }

    take(x, y);
    if (command === CURVE) {
      const [cx, cy, ax, ay] = path.slice(i + 1, i + 5);
      take(ax, ay);
      // Where the derivative is zero on either axis, if within the curve.
      const at = (t: number) => {
        const u = 1 - t;
        take(u * u * x + 2 * u * t * cx + t * t * ax, u * u * y + 2 * u * t * cy + t * t * ay);
      };
      for (const [p0, c, p2] of [
        [x, cx, ax],
        [y, cy, ay],
      ]) {
        const denominator = p0 - 2 * c + p2;
        const t = denominator === 0 ? -1 : (p0 - c) / denominator;
        if (t > 0 && t < 1) {
          at(t);
        }
      }

      x = ax;
      y = ay;
      i += 5;
    } else if (command === CUBIC) {
      const [c1x, c1y, c2x, c2y, ax, ay] = path.slice(i + 1, i + 7);
      take(ax, ay);
      const at = (t: number) => {
        const u = 1 - t;
        take(
          u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ax,
          u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ay,
        );
      };
      for (const [p0, c1, c2, p3] of [
        [x, c1x, c2x, ax],
        [y, c1y, c2y, ay],
      ]) {
        // The derivative's roots: a t² + b t + c = 0.
        const a = -p0 + 3 * c1 - 3 * c2 + p3;
        const b = 2 * (p0 - 2 * c1 + c2);
        const c = c1 - p0;
        const roots = a === 0 ? (b === 0 ? [] : [-c / b]) : quadraticRoots(a, b, c);
        for (const t of roots) {
          if (t > 0 && t < 1) {
            at(t);
          }
        }
      }

      x = ax;
      y = ay;
      i += 7;
    } else {
      x = path[i + 1];
      y = path[i + 2];
      take(x, y);
      i += 3;
    }
  }

  return xMin <= xMax ? [xMin, yMin, xMax, yMax] : null;
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  const d = b * b - 4 * a * c;
  if (d < 0) {
    return [];
  }

  const s = Math.sqrt(d);
  return [(-b + s) / (2 * a), (-b - s) / (2 * a)];
}

/**
 * A bitmap fill the player resolved: of a SWF's bitmap character, or of a
 * BitmapData's store through beginBitmapFill, the matrix in pixels.
 */
export interface ImageFill {
  type: "image";
  image: BitmapCharacter | BitmapStore;
  matrix: Matrix;
  repeat: boolean;
  smooth: boolean;
}

/**
 * A gradient fill, of a SWF's shape or beginGradientFill: radial or not,
 * its stops, at most 16, and its matrix in pixels, which maps the gradient
 * square, -819.2 to 819.2 a side, to the shape.
 */
export interface GradientFill {
  type: "gradient";
  radial: boolean;
  /** Where the focal point lies across the circle, -1 to 1; 0 for one centred. */
  focal: number;
  stops: GradientStop[];
  /** 0 pad, 1 reflect, 2 repeat. */
  spread: number;
  linearRgb: boolean;
  matrix: Matrix;
}

/** A fill as the player paints it: a solid colour, a bitmap fill of a bitmap the SWF lacks, or a resolved bitmap or gradient. */
export type Paint = Fill | ImageFill | GradientFill;

export interface ShapeLayer {
  fills: { fill: Paint; contours: Path[]; winding: Winding }[];
  strokes: { line: Line; paths: Path[] }[];
}

/** The polygon's orientation: 1 clockwise on a y-down screen, -1 the other way, 0 for no area. */
export function orientation(points: number[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    area += points[j] * points[i + 1] - points[i] * points[j + 1];
  }

  return Math.sign(area);
}

interface Edge {
  x0: number;
  y0: number;
  /** A curve's control point, or NaN for a straight edge. */
  cx: number;
  cy: number;
  x1: number;
  y1: number;
}

const TWIPS = 20;

function reversed(e: Edge): Edge {
  return { x0: e.x1, y0: e.y1, cx: e.cx, cy: e.cy, x1: e.x0, y1: e.y0 };
}

/** Each fill's edges joined into contours: from an edge, the next one that starts where it ends. */
function contours(edges: Edge[]): Path[] {
  const from = new Map<string, number[]>();
  for (const [i, e] of edges.entries()) {
    const key = `${e.x0},${e.y0}`;
    const list = from.get(key);
    if (list) {
      list.push(i);
    } else {
      from.set(key, [i]);
    }
  }

  const used = new Uint8Array(edges.length);
  const paths: Path[] = [];
  for (let first = 0; first < edges.length; first++) {
    if (used[first]) {
      continue;
    }

    const start = edges[first];
    const path: Path = [MOVE, start.x0 / TWIPS, start.y0 / TWIPS];
    let e = start;
    let i = first;
    for (;;) {
      used[i] = 1;
      if (Number.isNaN(e.cx)) {
        path.push(LINE, e.x1 / TWIPS, e.y1 / TWIPS);
      } else {
        path.push(CURVE, e.cx / TWIPS, e.cy / TWIPS, e.x1 / TWIPS, e.y1 / TWIPS);
      }

      if (e.x1 === start.x0 && e.y1 === start.y0) {
        break;
      }

      const next = from.get(`${e.x1},${e.y1}`)?.find((k) => !used[k]);
      if (next === undefined) {
        break;
      }

      i = next;
      e = edges[i];
    }

    paths.push(path);
  }

  return paths;
}

/** The layers a shape draws, in order: each layer's fills, then its lines. */
export function shapeLayers(
  shape: Shape,
  bitmap: (id: number) => BitmapCharacter | null = () => null,
): ShapeLayer[] {
  const layers: ShapeLayer[] = [];
  // A bitmap fill's bitmap, its matrix from twips to pixels; one the SWF lacks stays the SWF's fill.
  const paint = (fill: Fill): Paint => {
    if (fill.type === "linear" || fill.type === "radial" || fill.type === "focal") {
      const g = fill.gradient;
      const m = g.matrix;
      return {
        type: "gradient",
        radial: fill.type !== "linear",
        focal: fill.type === "focal" ? g.focal : 0,
        stops: g.stops.slice(0, 16),
        spread: g.spread <= 2 ? g.spread : 0,
        linearRgb: g.interpolation === 1,
        // The square is in twips as the shape is, so only the translation goes to pixels.
        matrix: { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx / 20, ty: m.ty / 20 },
      };
    }

    const image = fill.type === "bitmap" ? bitmap(fill.bitmap) : null;
    if (fill.type !== "bitmap" || !image) {
      return fill;
    }

    const m = fill.matrix;
    return {
      type: "image",
      image,
      matrix: { a: m.a / 20, b: m.b / 20, c: m.c / 20, d: m.d / 20, tx: m.tx / 20, ty: m.ty / 20 },
      repeat: fill.repeat,
      smooth: fill.smooth,
    };
  };
  let fills = shape.fills.map(paint);
  let lines = shape.lines;
  let fillEdges: Edge[][] = fills.map(() => []);
  let strokes: Path[][] = lines.map(() => []);
  let fill0 = 0;
  let fill1 = 0;
  let line = 0;
  let x = 0;
  let y = 0;
  // The stroke being extended, and where it ends.
  let stroke: Path | null = null;
  let strokeX = Number.NaN;
  let strokeY = Number.NaN;

  const flush = () => {
    const layer: ShapeLayer = { fills: [], strokes: [] };
    for (const [i, fill] of fills.entries()) {
      if (fillEdges[i].length) {
        layer.fills.push({ fill, contours: contours(fillEdges[i]), winding: "evenOdd" });
      }
    }

    for (const [i, l] of lines.entries()) {
      if (strokes[i].length) {
        layer.strokes.push({ line: l, paths: strokes[i] });
      }
    }

    if (layer.fills.length || layer.strokes.length) {
      layers.push(layer);
    }
  };

  const edge = (e: Edge) => {
    if (fill1 > 0 && fill1 <= fills.length) {
      fillEdges[fill1 - 1].push(e);
    }

    if (fill0 > 0 && fill0 <= fills.length) {
      fillEdges[fill0 - 1].push(reversed(e));
    }

    if (line > 0 && line <= lines.length) {
      if (!stroke || strokeX !== e.x0 || strokeY !== e.y0) {
        stroke = [MOVE, e.x0 / TWIPS, e.y0 / TWIPS];
        strokes[line - 1].push(stroke);
      }

      if (Number.isNaN(e.cx)) {
        stroke.push(LINE, e.x1 / TWIPS, e.y1 / TWIPS);
      } else {
        stroke.push(CURVE, e.cx / TWIPS, e.cy / TWIPS, e.x1 / TWIPS, e.y1 / TWIPS);
      }

      strokeX = e.x1;
      strokeY = e.y1;
    }
  };

  for (const r of shape.records) {
    if (r.type === "style") {
      if (r.styles) {
        // New styles: what came before is a layer of its own, drawn first.
        flush();
        fills = r.styles.fills.map(paint);
        lines = r.styles.lines;
        fillEdges = fills.map(() => []);
        strokes = lines.map(() => []);
        fill0 = 0;
        fill1 = 0;
        line = 0;
      }

      if (r.moveTo) {
        x = r.moveTo.x;
        y = r.moveTo.y;
      }

      if (r.fill0 !== null) {
        fill0 = r.fill0;
      }

      if (r.fill1 !== null) {
        fill1 = r.fill1;
      }

      if (r.line !== null) {
        line = r.line;
      }

      // A style change or a move starts a new stroke.
      stroke = null;
    } else if (r.type === "line") {
      const e = { x0: x, y0: y, cx: Number.NaN, cy: Number.NaN, x1: x + r.dx, y1: y + r.dy };
      x = e.x1;
      y = e.y1;
      edge(e);
    } else {
      const cx = x + r.cx;
      const cy = y + r.cy;
      const e = { x0: x, y0: y, cx, cy, x1: cx + r.ax, y1: cy + r.ay };
      x = e.x1;
      y = e.y1;
      edge(e);
    }
  }

  flush();
  return layers;
}
