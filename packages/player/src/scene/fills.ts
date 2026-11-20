// A shape's fills resolved for drawing: a layer's fills tessellated in one
// call by @swf2es/native's tessellator, which flattens their curves itself.
// Nothing here draws.
import type { GeometryData } from "@swf2es/render";
import type { Region as Area } from "../display/gradients.js";
import { flatten, type Path, type ShapeLayer } from "../display/shapes.js";

/** Triangles a tessellator made of a fill: positions, two a vertex, and indices, three a triangle. */
export interface FillGeometry {
  vertices: Float32Array | Float64Array;
  indices: Uint16Array | Uint32Array;
  /** The vertex the indices count from, 0 if left out: a layer's fills share one index buffer. */
  indexOffset?: number;
}

/** What draws a shape's fills and lines: @swf2es/native's Tessellator's `tessellate`. */
export interface FillTessellator {
  /**
   * Every fill of a layer at once, its contours as the shape's path
   * commands (display/shapes.ts), which the call flattens: each fill's
   * geometry, null for one it refused, or null for the whole layer. Its
   * output is drawn as it is, unchecked, as @swf2es/native's checks its
   * own: finite positions, and indices within the fill's vertices from its
   * `indexOffset`. Where `borrowed`, the geometries need only last until
   * the tessellator's next call, as @swf2es/native's then copies nothing.
   */
  layer(
    fills: readonly (readonly Path[])[],
    nonZero: readonly boolean[],
    borrowed?: boolean,
  ): (FillGeometry | null)[] | null;
  /** A layer's lines built in one call, their outlines filled by this tessellator (strokes.ts). */
  lines: LineBuilder;
}

/**
 * Builds a layer's lines as scene/strokes.ts packs them into input():
 * build() gives their geometry, null for none, or undefined where it built
 * none; input() gives null where it is unavailable. Where the last build()
 * `unwound`, the next is worth asking for the layer again.
 */
export interface LineBuilder {
  input(n: number): Float64Array | null;
  build(length: number): GeometryData | null | undefined;
  readonly unwound: boolean;
}

/**
 * Each fill of `layer` tessellated, in one call, or null where the
 * tessellator refused it. Resolved once at construction, so colour copies
 * do not tessellate again. A drawing used as a mask fills non-zero, even
 * where drawPath asked for even-odd. Where `borrowed`, the geometries are
 * read before the tessellator's next call (FillTessellator.layer).
 */
export function resolveFills(
  layer: ShapeLayer,
  masking: boolean,
  tessellate: FillTessellator,
  borrowed = false,
): (FillGeometry | null)[] {
  const count = layer.fills.length;
  const rules = new Array<boolean>(count);
  // The contours go as they are, their curves flattened in the call.
  const contours = new Array<Path[]>(count);
  for (let i = 0; i < count; i++) {
    rules[i] = masking || layer.fills[i].winding === "nonZero";
    contours[i] = layer.fills[i].contours;
  }

  return tessellate.layer(contours, rules, borrowed) ?? layer.fills.map(() => null);
}

/**
 * How much less than the area of their triangles the area of fills' contours
 * filled together may be, as a share of the first and in pixels, for the
 * fills to count as not overlapping: what rounding their positions to
 * floats and tessellating them apart and together may take.
 */
const SHARE_APART = 1e-5;
const PIXELS_APART = 1e-3;

/**
 * Whether `layer`'s fills `fills`, tessellated into `positions` and
 * `indices`, cover no point twice, as the fills of a SWF's shape layer that
 * meet edge to edge do and those of a drawing need not: their contours
 * filled together by parity cover all their triangles do, where a point two
 * of them cover is left out. One filled non-zero is not looked into.
 */
export function fillsApart(
  layer: ShapeLayer,
  fills: readonly number[],
  positions: Float32Array,
  indices: Uint32Array,
  tessellate: FillTessellator,
): boolean {
  const contours: Path[] = [];
  for (const i of fills) {
    const fill = layer.fills[i];
    if (fill.winding !== "evenOdd") {
      return false;
    }

    for (const contour of fill.contours) {
      contours.push(contour);
    }
  }

  // Read before the tessellator's next call.
  const together = tessellate.layer([contours], [false], true)?.[0];
  if (!together) {
    return false;
  }

  const apart = trianglesArea(positions, indices, 0);
  const whole = trianglesArea(together.vertices, together.indices, together.indexOffset ?? 0);
  return apart - whole <= apart * SHARE_APART + PIXELS_APART;
}

/** The area of the triangles `indices` make of `vertices`, counting from `offset`. */
function trianglesArea(
  vertices: Float32Array | Float64Array,
  indices: Uint16Array | Uint32Array,
  offset: number,
): number {
  let twice = 0;
  for (let k = 0; k + 2 < indices.length; k += 3) {
    const a = (indices[k] - offset) * 2;
    const b = (indices[k + 1] - offset) * 2;
    const c = (indices[k + 2] - offset) * 2;
    const abx = vertices[b] - vertices[a];
    const aby = vertices[b + 1] - vertices[a + 1];
    const acx = vertices[c] - vertices[a];
    const acy = vertices[c + 1] - vertices[a + 1];
    twice += Math.abs(abx * acy - aby * acx);
  }

  return twice / 2;
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
