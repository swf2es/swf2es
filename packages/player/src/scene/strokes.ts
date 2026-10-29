// A shape layer's lines as a geometry of the renderer's, stroked as Flash
// strokes them: in the stage's axes, at one width all along, never under a
// pixel of the screen (render/strokes.ts has the rules), each line's path
// outlined and its outline filled non-zero, so that where it overlaps itself
// it is drawn once. The outline is the flattened path's sides at half the
// width, joined on the outer side of each turn as the line joins, through
// the turn's own point on the inner side, and capped at its ends; a closed
// path's sides are two loops, wound opposite ways.
import type { Line } from "@swf2es/format";
import type { GeometryData } from "@swf2es/render";
import { LINE, type Path, pointsOf, type ShapeLayer } from "../display/shapes.js";
import { convex, crossingFill } from "../render/fill-polygons.js";
import {
  containment,
  type FillGeometry,
  type FillTessellator,
  trace,
  validGeometry,
} from "./fills.js";
import { unsupported, vertexColor } from "./shapes.js";

/**
 * How far, in pixels of the screen, a line's flattened curves and its
 * round joins' and caps' chords may stray from the curve: a tenth of one,
 * where the fills' finer flatness made strokes several times the
 * triangles the Pixi view's are, which a software rasteriser pays for; a
 * quarter shows on the references' curved lines.
 */
const STROKE_FLATNESS = 0.1;

/**
 * A line's width on the stage through the linear transform (a b c d): its
 * own width scaled as its scale mode allows, never under `least`, a pixel
 * of the screen, which is also a hairline's.
 */
export function strokeWidth(
  line: Line,
  a: number,
  b: number,
  c: number,
  d: number,
  least: number,
): number {
  const sx = Math.abs(a + c);
  const sy = Math.abs(b + d);
  const scale = line.noHScale
    ? line.noVScale
      ? 1
      : sy
    : line.noVScale
      ? sx
      : Math.sqrt((sx * sx + sy * sy) / 2);
  return Math.max(least, (line.width / 20) * scale);
}

/** `path` through the linear transform (a b c d), its control points too. */
export function transformedPath(path: Path, a: number, b: number, c: number, d: number): Path {
  const out = path.slice();
  for (let i = 0; i < out.length; ) {
    const points = pointsOf(out[i]);
    for (let k = 0; k < points; k++) {
      const x = out[i + 1 + 2 * k];
      const y = out[i + 2 + 2 * k];
      out[i + 1 + 2 * k] = a * x + c * y;
      out[i + 2 + 2 * k] = b * x + d * y;
    }

    i += 1 + 2 * points;
  }

  return out;
}

/**
 * A line's paths as they are stroked, each with whether it comes back to
 * its start, closed and joined there as Flash joins it: a fill's closing
 * line `closes` names is added to its path, and a triangle's outline is
 * closed, its last point its first.
 */
export function strokePaths(
  stroke: ShapeLayer["strokes"][number],
): { path: Path; home: boolean }[] {
  const { paths, closes, triangles } = stroke;
  const out: { path: Path; home: boolean }[] = [];
  let next = 0;
  for (const [i, path] of paths.entries()) {
    const close = closes?.[next]?.at === i ? closes[next++] : null;
    const home = Boolean(triangles) || (close?.x === path[1] && close.y === path[2]);
    out.push({ path: close && !home ? [...path, LINE, close.x, close.y] : path, home });
  }

  return out;
}

/** `path` flattened as fills flatten curves (fills.ts, trace), to `flatness`, each point once. */
function polyline(path: Path, flatness: number): number[] {
  const points: number[] = [];
  const add = (x: number, y: number) => {
    const n = points.length;
    if (n === 0 || points[n - 2] !== x || points[n - 1] !== y) {
      points.push(x, y);
    }
  };
  trace({ moveTo: add, lineTo: add }, path, flatness);
  return points;
}

/**
 * The chords of an arc about (cx, cy) of radius `r`, from angle `from`
 * turning `sweep`, past its start, none further than `flatness` from it.
 */
function arc(
  out: number[],
  cx: number,
  cy: number,
  r: number,
  from: number,
  sweep: number,
  flatness: number,
): void {
  const most = r > flatness ? 2 * Math.acos(1 - flatness / r) : Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / most));
  for (let i = 1; i <= pieces; i++) {
    const angle = from + (sweep * i) / pieces;
    out.push(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
  }
}

/** The unit direction from point `i` to point `j` of `p`. */
function direction(p: number[], i: number, j: number): [number, number] {
  const dx = p[j * 2] - p[i * 2];
  const dy = p[j * 2 + 1] - p[i * 2 + 1];
  const l = Math.hypot(dx, dy);
  return [dx / l, dy / l];
}

/**
 * One side of the polyline `p` (n points), `h` out on the left of its way
 * (side 1) or the right (-1), from its first point to its last, joined at
 * each point between as `join` joins (0 round, 1 bevel, 2 miter up to
 * `limit` half widths): the points onto `out`. A closed one joins its last
 * segment to its first as well.
 */
function side(
  out: number[],
  p: number[],
  n: number,
  closed: boolean,
  h: number,
  s: 1 | -1,
  join: number,
  limit: number,
  flatness: number,
): void {
  const segments = closed ? n : n - 1;
  // Whether the segment's start is already out, as where the inner side was cut at its turn.
  let started = false;
  for (let k = 0; k < segments; k++) {
    const i = k;
    const j = (k + 1) % n;
    const [tx, ty] = direction(p, i, j);
    // The left of a way (tx, ty) on a y-down stage: (ty, -tx).
    const nx = ty * s * h;
    const ny = -tx * s * h;
    if (!started) {
      put(out, p[i * 2] + nx, p[i * 2 + 1] + ny);
    }

    started = false;
    if (!closed && k === segments - 1) {
      put(out, p[j * 2] + nx, p[j * 2 + 1] + ny);
      break;
    }

    // The turn at j, to the next segment.
    const [ux, uy] = direction(p, j, (j + 1) % n);
    const mx = uy * s * h;
    const my = -ux * s * h;
    const x = p[j * 2];
    const y = p[j * 2 + 1];
    const cross = tx * uy - ty * ux;
    const dot = tx * ux + ty * uy;
    // Positive turns to the right on a y-down stage, where the left side is the outer one; a way
    // that turns right back is joined on both sides, around its tip.
    const outer = cross * s > 0 || (cross === 0 && dot < 0);
    const turn = Math.atan2(Math.abs(cross), dot);
    if (!outer) {
      // A gentle turn's inner sides cross within both segments: one point, where they cross. Else
      // the inner side goes through the turn's own point, so that the outline never winds back; and
      // so at a closed contour's last turn, to its first segment's start, already out.
      const back = h * Math.tan(turn / 2);
      const next = (j + 1) % n;
      if (
        dot > 0 &&
        !(closed && k === segments - 1) &&
        back <= Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]) &&
        back <= Math.hypot(p[next * 2] - p[j * 2], p[next * 2 + 1] - p[j * 2 + 1])
      ) {
        put(out, x + nx - tx * back, y + ny - ty * back);
        started = true;
        continue;
      }

      put(out, x + nx, y + ny);
      put(out, x, y);
      put(out, x + mx, y + my);
      started = true;
      continue;
    }

    put(out, x + nx, y + ny);
    if (join === 0) {
      // Around from this side's normal to the next's, by way of the tip where the way turns back.
      const way = cross !== 0 ? Math.sign(nx * my - ny * mx) : Math.sign(nx * ty - ny * tx);
      arc(out, x, y, h, Math.atan2(ny, nx), way * turn, flatness);
    } else if (join === 2) {
      const ratio = 1 / Math.cos(turn / 2);
      let bx = nx + mx;
      let by = ny + my;
      const l = Math.hypot(bx, by);
      // Turned right back, the bisector is the way out past the tip.
      [bx, by] = l ? [bx / l, by / l] : [tx, ty];
      if (ratio <= limit) {
        out.push(x + bx * h * ratio, y + by * h * ratio);
      } else {
        // Cut where the limit, `limit` half widths out along the bisector, crosses each side.
        const reach = limit * h;
        const cut = (px: number, py: number, dx: number, dy: number) => {
          const along = dx * bx + dy * by;
          const t = along ? (reach - (px * bx + py * by)) / along : 0;
          out.push(x + px + dx * t, y + py + dy * t);
        };
        cut(nx, ny, tx, ty);
        cut(mx, my, -ux, -uy);
      }
    }

    put(out, x + mx, y + my);
    started = true;
  }
}

/** (x, y) onto `out`, unless it is the point last put there. */
function put(out: number[], x: number, y: number): void {
  const n = out.length;
  if (n < 2 || out[n - 2] !== x || out[n - 1] !== y) {
    out.push(x, y);
  }
}

/** A cap at point `i` of `p`, facing out along (tx, ty), from the side at +n to the side at -n. */
function cap(
  out: number[],
  p: number[],
  i: number,
  tx: number,
  ty: number,
  h: number,
  kind: number,
  flatness: number,
): void {
  const x = p[i * 2];
  const y = p[i * 2 + 1];
  // From the left of the way out, round to the right of it.
  const lx = ty * h;
  const ly = -tx * h;
  if (kind === 0) {
    arc(out, x, y, h, Math.atan2(ly, lx), Math.PI, flatness);
  } else if (kind === 2) {
    out.push(x + lx + tx * h, y + ly + ty * h, x - lx + tx * h, y - ly + ty * h, x - lx, y - ly);
  } else {
    out.push(x - lx, y - ly);
  }
}

/**
 * The outline of the polyline `p` as contours to fill non-zero: an open
 * one is one contour, out along its left side, around its end cap, back
 * along its right side and around its start cap; a closed one is two, its
 * left side forward and its right side back. A single point with round
 * caps is a dot; with others, nothing.
 */
export function outline(
  p: number[],
  closed: boolean,
  h: number,
  caps: number,
  join: number,
  limit: number,
  flatness = 0.02,
): number[][] {
  let n = p.length / 2;
  if (closed && n > 1 && p[0] === p[(n - 1) * 2] && p[1] === p[(n - 1) * 2 + 1]) {
    n--;
  }

  if (n === 1) {
    if (caps !== 0) {
      return [];
    }

    const dot: number[] = [];
    arc(dot, p[0], p[1], h, 0, 2 * Math.PI, flatness);
    return [dot];
  }

  if (closed && n >= 2) {
    const left: number[] = [];
    side(left, p, n, true, h, 1, join, limit, flatness);
    // There and back: its left side, joined at both ends, is the whole outline.
    if (n === 2) {
      return [left];
    }

    const right: number[] = [];
    side(right, p, n, true, h, -1, join, limit, flatness);
    const back: number[] = [];
    for (let i = right.length - 2; i >= 0; i -= 2) {
      back.push(right[i], right[i + 1]);
    }

    return [left, back];
  }

  // Out along the left side, around the end, back along the right side (the reversed points' left).
  const reversed: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    reversed.push(p[i * 2], p[i * 2 + 1]);
  }

  const contour: number[] = [];
  side(contour, p, n, false, h, 1, join, limit, flatness);
  const [ex, ey] = direction(p, n - 2, n - 1);
  cap(contour, p, n - 1, ex, ey, h, caps, flatness);
  contour.length -= 2;
  side(contour, reversed, n, false, h, 1, join, limit, flatness);
  const [sx, sy] = direction(reversed, n - 2, n - 1);
  cap(contour, reversed, n - 1, sx, sy, h, caps, flatness);
  contour.length -= 2;
  return [contour];
}

/**
 * `layer`'s lines as seen through the linear transform (a b c d) on the
 * stage, in its axes, each at least `least` wide, as one geometry in their
 * order; null if it has none, or none came out of the tessellator.
 */
export function layerStrokes(
  layer: ShapeLayer,
  a: number,
  b: number,
  c: number,
  d: number,
  least: number,
  tessellator: FillTessellator,
): GeometryData | null {
  // Seen through a transform that collapses the plane, lines cover nothing, as in the Pixi view.
  if (a * d - b * c === 0) {
    return null;
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  // `least` is a pixel of the screen, in the stage's pixels the lines are drawn in.
  const flatness = STROKE_FLATNESS * least;
  for (const stroke of layer.strokes) {
    const line = stroke.line;
    const h = strokeWidth(line, a, b, c, d, least) / 2;
    // Codes a SWF reserves draw round, as the Pixi view draws them.
    const caps = line.startCap <= 2 ? line.startCap : 0;
    const join = line.join <= 2 ? line.join : 0;
    const contours: number[][] = [];
    for (const { path, home } of strokePaths(stroke)) {
      const points = polyline(transformedPath(path, a, b, c, d), flatness);
      const closedPath =
        home ||
        (points.length > 4 &&
          points[0] === points[points.length - 2] &&
          points[1] === points[points.length - 1]);
      contours.push(
        ...outline(points, closedPath, h, caps, join, Math.max(1, line.miterLimit), flatness),
      );
    }

    const usable = contours.filter((contour) => contour.length >= 6);
    if (usable.length === 0) {
      continue;
    }

    if (!fillOutline(usable, tessellator, vertexColor(line.color), positions, colors, indices)) {
      unsupported.strokes++;
    }
  }

  if (indices.length === 0) {
    return null;
  }

  return {
    positions: Float32Array.from(positions),
    colors: Uint32Array.from(colors),
    indices: Uint32Array.from(indices),
  };
}

/**
 * The outline `contours` filled non-zero onto the arrays, in `color`: by the
 * tessellator, its output checked as a fill's is (fills.ts), else in JS where
 * it can be, its crossing spans or a region convex alone each as a fan.
 * False if none of it could be.
 */
function fillOutline(
  contours: number[][],
  tessellator: FillTessellator,
  color: number,
  positions: number[],
  colors: number[],
  indices: number[],
): boolean {
  let geometry: FillGeometry | null = null;
  try {
    const made = tessellator(contours, true);
    geometry = made && validGeometry(made) ? made : null;
  } catch {
    // A refused native instance or a custom tessellator's failure leaves the JS fill.
  }

  if (geometry) {
    const base = positions.length / 2;
    const offset = geometry.indexOffset ?? 0;
    for (let k = 0; k < geometry.vertices.length; k += 2) {
      positions.push(geometry.vertices[k], geometry.vertices[k + 1]);
      colors.push(color);
    }

    for (let k = 0; k < geometry.indices.length; k++) {
      indices.push(geometry.indices[k] - offset + base);
    }

    return true;
  }

  const pieces =
    crossingFill(contours, true) ??
    containment(contours).flatMap((root) =>
      root.children.length === 0 && convex(root.points) !== 0 ? [root.points] : [],
    );
  for (const piece of pieces) {
    const first = positions.length / 2;
    for (let k = 0; k < piece.length; k += 2) {
      positions.push(piece[k], piece[k + 1]);
      colors.push(color);
    }

    for (let k = 2; k < piece.length / 2; k++) {
      indices.push(first, first + k - 1, first + k);
    }
  }

  return pieces.length > 0;
}
