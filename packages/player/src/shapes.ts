// A shape's records as paths to draw: for each layer (a new set of styles
// starts one), each fill's closed contours and each line's strokes, in
// pixels. Flash fills a region on both sides of an edge: the edge belongs to
// its fill1 as it goes and to its fill0 reversed, so that each fill's edges
// join end to start into closed contours, filled even-odd. Lines stroke the
// edges they are set on, joined where one edge starts where the last ended.
import type { Fill, Line, Shape } from "@swf2es/format";

/** Path commands, flat: 1 x y (move), 2 x y (line), 3 cx cy x y (quadratic curve), in pixels. */
export type Path = number[];

export const MOVE = 1;
export const LINE = 2;
export const CURVE = 3;

export interface ShapeLayer {
  fills: { fill: Fill; contours: Path[] }[];
  strokes: { line: Line; paths: Path[] }[];
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
export function shapeLayers(shape: Shape): ShapeLayer[] {
  const layers: ShapeLayer[] = [];
  let fills = shape.fills;
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
        layer.fills.push({ fill, contours: contours(fillEdges[i]) });
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
        fills = r.styles.fills;
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
