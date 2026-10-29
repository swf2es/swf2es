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
   * `indexOffset`.
   */
  layer(
    fills: readonly (readonly Path[])[],
    nonZero: readonly boolean[],
  ): (FillGeometry | null)[] | null;
  /** A layer's lines built in one call, their outlines filled by this tessellator (strokes.ts). */
  lines: LineBuilder;
}

/**
 * Builds a layer's lines as scene/strokes.ts packs them into input():
 * build() gives their geometry, null for none, or undefined where it built
 * none (refused, or unwound, after which the next is tried again);
 * input() gives null where it is unavailable.
 */
export interface LineBuilder {
  input(n: number): Float64Array | null;
  build(length: number): GeometryData | null | undefined;
}

/**
 * Each fill of `layer` tessellated, in one call, or null where the
 * tessellator refused it. Resolved once at construction, so colour copies
 * do not tessellate again. A drawing used as a mask fills non-zero, even
 * where drawPath asked for even-odd.
 */
export function resolveFills(
  layer: ShapeLayer,
  masking: boolean,
  tessellate: FillTessellator,
): (FillGeometry | null)[] {
  const rules = layer.fills.map(({ winding }) => masking || winding === "nonZero");
  // The contours go as they are, their curves flattened in the call.
  const contours = new Array<Path[]>(layer.fills.length);
  for (let i = 0; i < layer.fills.length; i++) {
    contours[i] = layer.fills[i].contours;
  }

  return tessellate.layer(contours, rules) ?? layer.fills.map(() => null);
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
