// A shape's fills resolved for drawing, by either renderer: each fill's
// contours flattened as Flash's curves need and tessellated by the native
// tessellator, else planned for JS as crossing spans or a containment tree
// (render/fill-polygons.ts). Nothing here draws.
import type { Region as Area } from "../display/gradients.js";
import {
  CUBIC,
  flatten,
  inside,
  LINE,
  MOVE,
  type Path,
  type ShapeLayer,
} from "../display/shapes.js";
import { crossingFill } from "../render/fill-polygons.js";

/** Triangles a tessellator made of a fill: positions, two a vertex, and indices, three a triangle. */
export interface FillGeometry {
  vertices: Float32Array | Float64Array;
  indices: Uint16Array | Uint32Array;
  /** The vertex the indices count from, 0 if left out: a layer's fills share one index buffer. */
  indexOffset?: number;
}

/** A contour flattened to a polygon, for telling which contours hold which. */
export interface Region {
  points: number[];
  parent: Region | null;
  children: Region[];
  area: number;
}

/** The contours as a tree, each under the smallest one that holds it. */
export function containment(polygons: number[][]): Region[] {
  const regions: Region[] = polygons.map((points) => {
    let area = 0;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      area += points[j] * points[i + 1] - points[i] * points[j + 1];
    }

    return { points, parent: null, children: [], area: Math.abs(area) / 2 };
  });
  for (const inner of regions) {
    for (const outer of regions) {
      if (
        outer !== inner &&
        outer.area > inner.area &&
        encloses(outer.points, inner.points) &&
        (!inner.parent || outer.area < inner.parent.area)
      ) {
        inner.parent = outer;
      }
    }
  }

  for (const r of regions) {
    r.parent?.children.push(r);
  }

  return regions.filter((r) => !r.parent);
}

/**
 * Whether the polygon `outer` holds `inner`, two contours that do not
 * cross, by a point of `inner` off `outer`'s outline: a pixel font's
 * contours touch, and a corner they share is inside one and out of the
 * other as the parity rule rounds it. Its corners, else its edges'
 * middles; a contour lying wholly along the other's outline goes by its first.
 */
function encloses(outer: number[], inner: number[]): boolean {
  for (const middles of [false, true]) {
    for (let i = 0, j = inner.length - 2; i < inner.length; j = i, i += 2) {
      const x = middles ? (inner[i] + inner[j]) / 2 : inner[i];
      const y = middles ? (inner[i + 1] + inner[j + 1]) / 2 : inner[i + 1];
      if (!onOutline(outer, x, y)) {
        return inside(outer, x, y);
      }
    }
  }

  return inside(outer, inner[0], inner[1]);
}

/** Whether (px, py) lies on one of the polygon's edges, to within a millionth of a pixel. */
function onOutline(points: number[], px: number, py: number): boolean {
  const near = 1e-6;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    // Four reads, not an array destructured: this runs for every edge of every fill built.
    const x0 = points[j];
    const y0 = points[j + 1];
    const x1 = points[i];
    const y1 = points[i + 1];
    if (
      px >= Math.min(x0, x1) - near &&
      px <= Math.max(x0, x1) + near &&
      py >= Math.min(y0, y1) - near &&
      py <= Math.max(y0, y1) + near &&
      Math.abs((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) <=
        near * Math.max(1, Math.hypot(x1 - x0, y1 - y0))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * How far, in pixels, a flattened curve may stray from the curve. Pixi's
 * own flattening allows a fraction of the curve's length, which leaves
 * Flash's long curves visibly polygonal; this holds up to a few times scale.
 */
const FLATNESS = 0.02;

export function trace(
  context: { moveTo(x: number, y: number): unknown; lineTo(x: number, y: number): unknown },
  path: Path,
  flatness = FLATNESS,
): void {
  let x = 0;
  let y = 0;
  for (let i = 0; i < path.length; ) {
    const command = path[i];
    if (command === MOVE || command === LINE) {
      x = path[i + 1];
      y = path[i + 2];
      if (command === MOVE) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }

      i += 3;
      continue;
    }

    if (command === CUBIC) {
      // A cubic's chords stray at most 3|Δ²| / 4n² for the larger of its two second differences.
      const [c1x, c1y, c2x, c2y, ax, ay] = path.slice(i + 1, i + 7);
      const bend = Math.max(
        Math.hypot(x - 2 * c1x + c2x, y - 2 * c1y + c2y),
        Math.hypot(c1x - 2 * c2x + ax, c1y - 2 * c2y + ay),
      );
      const n = Math.min(256, Math.max(1, Math.ceil(Math.sqrt((3 * bend) / (4 * flatness)))));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const u = 1 - t;
        context.lineTo(
          u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ax,
          u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ay,
        );
      }

      context.lineTo(ax, ay);
      x = ax;
      y = ay;
      i += 7;
      continue;
    }

    // A quadratic's chords of parameter step 1/n stray at most |p0 - 2c + p2| / 4n².
    const cx = path[i + 1];
    const cy = path[i + 2];
    const ax = path[i + 3];
    const ay = path[i + 4];
    const bend = Math.hypot(x - 2 * cx + ax, y - 2 * cy + ay);
    const n = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(bend / (4 * flatness)))));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const u = 1 - t;
      context.lineTo(
        u * u * x + 2 * u * t * cx + t * t * ax,
        u * u * y + 2 * u * t * cy + t * t * ay,
      );
    }

    context.lineTo(ax, ay);
    x = ax;
    y = ay;
    i += 5;
  }
}

/** A fill's contours as polygons, those of fewer than three points left out. */
export function polygonsOf(contours: readonly Path[]): number[][] {
  return contours.map(polygon).filter((points) => points.length >= 6);
}

/** The same chords used for rendering, so a crossing of curves cannot hide between samples. */
function polygon(path: Path): number[] {
  const points: number[] = [];
  const append = (x: number, y: number) => {
    if (points.length === 0 || points[points.length - 2] !== x || points[points.length - 1] !== y) {
      points.push(x, y);
    }
  };
  trace({ moveTo: append, lineTo: append }, path);
  if (
    points.length > 2 &&
    points[0] === points[points.length - 2] &&
    points[1] === points[points.length - 1]
  ) {
    points.length -= 2;
  }

  return points;
}

/** An optional tessellator returns immutable caller-owned buffers, or null to use JS for this fill. */
export interface FillTessellator {
  (contours: readonly (readonly number[])[], nonZero: boolean): FillGeometry | null;
  /**
   * Every fill of a layer at once, its contours as the shape's path
   * commands (display/shapes.ts), which the call flattens as trace does,
   * then tessellates as the call alone would: each fill's geometry or null,
   * or null for each fill to be tessellated alone. Its output is drawn as it
   * is, unchecked, as @swf2es/native's checks its own: finite positions, and
   * indices within the fill's vertices from its `indexOffset`.
   */
  layer?(
    fills: readonly (readonly Path[])[],
    nonZero: readonly boolean[],
  ): (FillGeometry | null)[] | null;
}

export interface ResolvedFill {
  geometry: FillGeometry | null;
  crossing: number[][] | null;
  roots: Region[];
}

/** A fill's plan: its tessellation, else what JS fills it with. */
function resolved(
  polygons: number[][],
  nonZero: boolean,
  geometry: FillGeometry | null,
): ResolvedFill {
  if (geometry) {
    return { geometry, crossing: null, roots: [] };
  }

  const crossing = crossingFill(polygons, nonZero);
  return { geometry: null, crossing, roots: crossing ? [] : containment(polygons) };
}

/**
 * Resolve once at construction, including fallback, so colour copies do
 * not retry native work: a layer's fills in one call where the tessellator
 * takes layers, their positions in one buffer and their indices in another
 * that Pixi draws as they are (FillGeometry.indexOffset), else a call a fill.
 */
export function resolveFills(
  layer: ShapeLayer,
  masking: boolean,
  tessellate: FillTessellator,
): ResolvedFill[] {
  // A Graphics drawing used as a mask uses non-zero even when drawPath asked for even-odd.
  const rules = layer.fills.map(({ winding }) => masking || winding === "nonZero");
  let together: (FillGeometry | null)[] | null = null;
  if (tessellate.layer) {
    // The contours go as they are, their curves flattened in the call: no points are built here.
    const contours = new Array<Path[]>(layer.fills.length);
    for (let i = 0; i < layer.fills.length; i++) {
      contours[i] = layer.fills[i].contours;
    }

    try {
      together = tessellate.layer(contours, rules);
    } catch {
      // A custom tessellator's layer call failing leaves each fill to be tried alone.
    }
  }

  if (together) {
    const layerGeometry = together;
    return layer.fills.map(({ contours }, i) =>
      layerGeometry[i]
        ? resolved([], rules[i], layerGeometry[i])
        : resolved(polygonsOf(contours), rules[i], null),
    );
  }

  const polygons = layer.fills.map(({ contours }) => polygonsOf(contours));
  const plans = polygons.map((points, i) => {
    let geometry: FillGeometry | null = null;
    try {
      const result = tessellate(points, rules[i]);
      if (result && validGeometry(result)) {
        geometry = result;
      }
    } catch {
      // A rejected native instance or custom tessellator must leave the ordinary fill usable.
    }

    return resolved(points, rules[i], geometry);
  });

  // Contiguous views let Pixi retain these positions instead of making another layer-sized copy.
  const first = plans[0]?.geometry?.vertices;
  if (
    plans.length > 1 &&
    first &&
    plans.every(({ geometry }) => geometry?.vertices.constructor === first.constructor)
  ) {
    const size = plans.reduce((sum, { geometry }) => sum + (geometry?.vertices.length ?? 0), 0);
    const vertices =
      first instanceof Float64Array ? new Float64Array(size) : new Float32Array(size);
    let at = 0;
    for (const plan of plans) {
      const geometry = plan.geometry as FillGeometry;
      vertices.set(geometry.vertices, at);
      plan.geometry = {
        vertices: vertices.subarray(at, at + geometry.vertices.length),
        indices: geometry.indices,
        indexOffset: geometry.indexOffset,
      };
      at += geometry.vertices.length;
    }
  }

  return plans;
}

/** Whether a fill tessellated alone can be drawn: a custom tessellator's output is checked. */
export function validGeometry({ vertices, indices, indexOffset = 0 }: FillGeometry): boolean {
  if (
    !Number.isInteger(indexOffset) ||
    indexOffset < 0 ||
    !(vertices instanceof Float32Array || vertices instanceof Float64Array) ||
    !(indices instanceof Uint16Array || indices instanceof Uint32Array) ||
    vertices.length % 2 !== 0 ||
    indices.length % 3 !== 0
  ) {
    return false;
  }

  for (let i = 0; i < vertices.length; i++) {
    if (!Number.isFinite(vertices[i])) {
      return false;
    }
  }

  for (let i = 0; i < indices.length; i++) {
    const index = indices[i] - indexOffset;
    if (index < 0 || index >= vertices.length / 2) {
      return false;
    }
  }

  return true;
}

/** The bounds of a fill's contours, whole pixels out. */
export function regionOf(contours: Path[]): Area {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const path of contours) {
    const points = flatten(path);
    for (let i = 0; i < points.length; i += 2) {
      x0 = Math.min(x0, points[i]);
      x1 = Math.max(x1, points[i]);
      y0 = Math.min(y0, points[i + 1]);
      y1 = Math.max(y1, points[i + 1]);
    }
  }

  if (!(x1 >= x0 && y1 >= y0)) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  const x = Math.floor(x0);
  const y = Math.floor(y0);
  return { x, y, width: Math.max(1, Math.ceil(x1) - x), height: Math.max(1, Math.ceil(y1) - y) };
}
