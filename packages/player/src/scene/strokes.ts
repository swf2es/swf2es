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
import { type FillTessellator, trace } from "./fills.js";

/** How far, in stage pixels, a round join or cap's chords may stray from its arc. */
const ARC_FLATNESS = 0.02;

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
function transformed(path: Path, a: number, b: number, c: number, d: number): Path {
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

/** `path` flattened as fills flatten curves (fills.ts, trace), each point once. */
function polyline(path: Path): number[] {
  const points: number[] = [];
  const add = (x: number, y: number) => {
    const n = points.length;
    if (n === 0 || points[n - 2] !== x || points[n - 1] !== y) {
      points.push(x, y);
    }
  };
  trace({ moveTo: add, lineTo: add }, path);
  return points;
}

/** The chords of an arc about (cx, cy) of radius `r`, from angle `from` turning `sweep`, past its start. */
function arc(out: number[], cx: number, cy: number, r: number, from: number, sweep: number): void {
  const most = r > ARC_FLATNESS ? 2 * Math.acos(1 - ARC_FLATNESS / r) : Math.PI;
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
): void {
  const segments = closed ? n : n - 1;
  for (let k = 0; k < segments; k++) {
    const i = k;
    const j = (k + 1) % n;
    const [tx, ty] = direction(p, i, j);
    // The left of a way (tx, ty) on a y-down stage: (ty, -tx).
    const nx = ty * s * h;
    const ny = -tx * s * h;
    out.push(p[i * 2] + nx, p[i * 2 + 1] + ny, p[j * 2] + nx, p[j * 2 + 1] + ny);
    if (!closed && k === segments - 1) {
      break;
    }

    // The turn at j, to the next segment.
    const [ux, uy] = direction(p, j, (j + 1) % n);
    const mx = uy * s * h;
    const my = -ux * s * h;
    const x = p[j * 2];
    const y = p[j * 2 + 1];
    const cross = tx * uy - ty * ux;
    // Positive turns to the right on a y-down stage, where the left side is the outer one.
    const outer = cross * s > 0;
    if (!outer) {
      // The inner side goes through the turn's own point, so that the outline never winds back.
      out.push(x, y, x + mx, y + my);
      continue;
    }

    const turn = Math.atan2(Math.abs(cross), tx * ux + ty * uy);
    if (join === 0) {
      arc(
        out,
        x,
        y,
        h,
        Math.atan2(ny, nx),
        Math.sign(Math.atan2(nx * my - ny * mx, nx * mx + ny * my)) * turn,
      );
    } else if (join === 2) {
      const ratio = 1 / Math.cos(turn / 2);
      let bx = nx + mx;
      let by = ny + my;
      const l = Math.hypot(bx, by);
      bx /= l || 1;
      by /= l || 1;
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

    out.push(x + mx, y + my);
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
): void {
  const x = p[i * 2];
  const y = p[i * 2 + 1];
  // From the left of the way out, round to the right of it.
  const lx = ty * h;
  const ly = -tx * h;
  if (kind === 0) {
    arc(out, x, y, h, Math.atan2(ly, lx), Math.PI);
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
    arc(dot, p[0], p[1], h, 0, 2 * Math.PI);
    return [dot];
  }

  if (closed && n > 2) {
    const left: number[] = [];
    side(left, p, n, true, h, 1, join, limit);
    const right: number[] = [];
    side(right, p, n, true, h, -1, join, limit);
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
  side(contour, p, n, false, h, 1, join, limit);
  const [ex, ey] = direction(p, n - 2, n - 1);
  cap(contour, p, n - 1, ex, ey, h, caps);
  contour.length -= 2;
  side(contour, reversed, n, false, h, 1, join, limit);
  const [sx, sy] = direction(reversed, n - 2, n - 1);
  cap(contour, reversed, n - 1, sx, sy, h, caps);
  contour.length -= 2;
  return [contour];
}

/** A straight ARGB colour as a vertex carries it: its bytes red, green, blue and alpha from the lowest. */
function vertexColor(argb: number): number {
  return (
    (((argb >>> 16) & 0xff) | (argb & 0xff00) | ((argb & 0xff) << 16) | (argb & 0xff000000)) >>> 0
  );
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
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const { line, paths, closes, triangles } of layer.strokes) {
    const h = strokeWidth(line, a, b, c, d, least) / 2;
    const contours: number[][] = [];
    let next = 0;
    for (const [i, path] of paths.entries()) {
      const close = closes?.[next]?.at === i ? closes[next++] : null;
      // Back to the path's start, a closed path, joined there as Flash joins it; a triangle's
      // outline is, its last point its first.
      const home = triangles || (close?.x === path[1] && close.y === path[2]);
      const points = polyline(
        transformed(close && !home ? [...path, LINE, close.x, close.y] : path, a, b, c, d),
      );
      const closedPath =
        home ||
        (points.length > 4 &&
          points[0] === points[points.length - 2] &&
          points[1] === points[points.length - 1]);
      contours.push(
        ...outline(points, closedPath, h, line.startCap, line.join, Math.max(1, line.miterLimit)),
      );
    }

    const usable = contours.filter((contour) => contour.length >= 6);
    if (usable.length === 0) {
      continue;
    }

    const geometry = tessellator(usable, true);
    if (!geometry) {
      continue;
    }

    const color = vertexColor(line.color);
    const base = positions.length / 2;
    const offset = geometry.indexOffset ?? 0;
    for (let k = 0; k < geometry.vertices.length; k += 2) {
      positions.push(geometry.vertices[k], geometry.vertices[k + 1]);
      colors.push(color);
    }

    for (let k = 0; k < geometry.indices.length; k++) {
      indices.push(geometry.indices[k] - offset + base);
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
