// Random shape layers of lines, for the line builder's tests (strokes.test.ts):
// polygons, triangles, curved outlines, dots and degenerate turns, of whole
// alpha or translucent.
import type { ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";

const MOVE = 1;
const LINE = 2;
const CURVE = 3;
const CUBIC = 4;

/** A seeded generator (mulberry32), so that a failure reproduces. */
export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Stroke = ShapeLayer["strokes"][number];

export interface LineOptions {
  width: number;
  join: number;
  cap: number;
  /** The line's alpha, 0 to 255. */
  alpha: number;
}

function line(r: () => number, options?: Partial<LineOptions>): Stroke["line"] {
  return {
    width: options?.width ?? [0, 20, 40, 100, 300, 800][Math.floor(r() * 6)],
    color:
      (((options?.alpha ?? (r() < 0.5 ? 255 : Math.floor(r() * 256))) << 24) |
        Math.floor(r() * 0xffffff)) >>>
      0,
    startCap: options?.cap ?? Math.floor(r() * 3),
    endCap: 0,
    join: options?.join ?? Math.floor(r() * 3),
    miterLimit: [1, 2, 3, 10][Math.floor(r() * 4)],
    noHScale: r() < 0.1,
    noVScale: r() < 0.1,
    pixelHinting: false,
    noClose: false,
    fill: null,
  };
}

/** A regular-ish polygon of `sides` sides, closed or open. */
function polygon(
  r: () => number,
  sides: number,
  closed: boolean,
  radius = 5 + r() * 100,
): number[] {
  const cx = r() * 400;
  const cy = r() * 400;
  const path: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * 2 * Math.PI + r() * 0.3;
    path.push(i === 0 ? MOVE : LINE, cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }

  if (closed) {
    path.push(LINE, path[1], path[2]);
  }

  return path;
}

/** A closed outline of `pieces` quadratic curves round an ellipse, with noise. */
export function curved(r: () => number, pieces: number, closed: boolean, radius: number): number[] {
  const cx = r() * 400;
  const cy = r() * 400;
  const rx = radius * (0.5 + r());
  const ry = radius * (0.5 + r());
  const point = (t: number, s: number) => [
    cx + rx * s * Math.cos(t * 2 * Math.PI),
    cy + ry * s * Math.sin(t * 2 * Math.PI),
  ];
  const [x0, y0] = point(0, 1);
  const path = [MOVE, x0, y0];
  const end = closed ? pieces : pieces - 1;
  for (let i = 0; i < end; i++) {
    const [cxp, cyp] = point((i + 0.5) / pieces, 1.1 + r() * 0.1);
    const [x, y] = i + 1 === pieces ? [x0, y0] : point((i + 1) / pieces, 0.9 + r() * 0.2);
    path.push(CURVE, cxp, cyp, x, y);
  }

  return path;
}

/** A path of awkward turns: snapped to a coarse grid, so straight runs, reversals and repeats. */
function awkward(r: () => number): number[] {
  const grid = () => Math.floor(r() * 6) * 10;
  const path = [MOVE, grid(), grid()];
  const n = 1 + Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    const pick = r();
    if (pick < 0.6) {
      path.push(LINE, grid(), grid());
    } else if (pick < 0.85) {
      path.push(CURVE, grid(), grid(), grid(), grid());
    } else {
      path.push(CUBIC, grid(), grid(), grid(), grid(), grid(), grid());
    }
  }

  return path;
}

/**
 * A random layer of 1-3 lines of 1-4 paths each, of every kind, each line
 * of whole alpha or translucent.
 */
export function randomLayer(r: () => number): ShapeLayer {
  const strokes: Stroke[] = [];
  const lines = 1 + Math.floor(r() * 3);
  for (let l = 0; l < lines; l++) {
    const paths: number[][] = [];
    const count = 1 + Math.floor(r() * 4);
    for (let p = 0; p < count; p++) {
      const pick = r();
      if (pick < 0.1) {
        // A triangle, as drawTriangles outlines it, at most as deep as the line is wide.
        paths.push(polygon(r, 3, r() < 0.7, r() < 0.5 ? 2 + r() * 10 : undefined));
      } else if (pick < 0.3) {
        paths.push(polygon(r, 2 + Math.floor(r() * 9), r() < 0.5));
      } else if (pick < 0.55) {
        paths.push(curved(r, 2 + Math.floor(r() * 12), r() < 0.5, 2 + r() * 100));
      } else if (pick < 0.9) {
        paths.push(awkward(r));
      } else {
        // A dot, a move alone, or a line there and back.
        const x = r() * 100;
        const y = r() * 100;
        paths.push(
          [
            [MOVE, x, y, LINE, x, y],
            [MOVE, x, y],
            [MOVE, x, y, LINE, x + 10, y, LINE, x, y],
          ][Math.floor(r() * 3)],
        );
      }
    }

    const stroke: Stroke = { line: line(r), paths };
    const kind = r();
    if (kind < 0.15) {
      // A fill's closing lines, some back to the start, some elsewhere.
      stroke.closes = paths.flatMap((path, at) =>
        r() < 0.5
          ? [{ at, x: r() < 0.5 ? path[1] : r() * 100, y: r() < 0.5 ? path[2] : r() * 100 }]
          : [],
      ) as Stroke["closes"];
    } else if (kind < 0.2) {
      stroke.triangles = true;
    }

    strokes.push(stroke);
  }

  return { fills: [], strokes } as unknown as ShapeLayer;
}

/** A layer of one line over `paths` paths made by `make`. */
export function layerOf(
  r: () => number,
  options: Partial<LineOptions>,
  paths: number,
  make: (r: () => number) => number[],
): ShapeLayer {
  const stroke: Stroke = { line: line(r, options), paths: [] };
  for (let i = 0; i < paths; i++) {
    stroke.paths.push(make(r));
  }

  return { fills: [], strokes: [stroke] } as unknown as ShapeLayer;
}
