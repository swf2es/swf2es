// A shape layer's fills as a geometry of the renderer's (@swf2es/render):
// each fill tessellated (fills.ts), in order, its vertices carrying its
// straight colour. Only solid fills for now; what is left out is counted.
import type { GeometryData } from "@swf2es/render";
import type { ShapeLayer } from "../display/shapes.js";
import { type FillTessellator, resolveFills } from "./fills.js";

/** What the renderer cannot draw yet, counted as it is met, for a test or a probe to read. */
export const unsupported = {
  gradientFills: 0,
  bitmapFills: 0,
  strokes: 0,
  meshes: 0,
  /** Fills the native tessellator refused, of contours that do not cross, which need a triangulator of holes. */
  containedFills: 0,
};

/** A straight ARGB colour as a vertex carries it: its bytes red, green, blue and alpha from the lowest. */
function vertexColor(argb: number): number {
  return (
    (((argb >>> 16) & 0xff) | (argb & 0xff00) | ((argb & 0xff) << 16) | (argb & 0xff000000)) >>> 0
  );
}

/**
 * `layer`'s fills as one geometry, positions in the shape's pixels, or
 * null if none of them draws yet. A fill of a bitmap the SWF lacks is red,
 * as Flash draws it.
 */
export function layerGeometry(
  layer: ShapeLayer,
  tessellator: FillTessellator,
): GeometryData | null {
  if (layer.strokes.length > 0) {
    unsupported.strokes += layer.strokes.length;
  }

  if (layer.meshes?.length) {
    unsupported.meshes += layer.meshes.length;
  }

  if (layer.fills.length === 0) {
    return null;
  }

  const plans = resolveFills(layer, false, tessellator);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < layer.fills.length; i++) {
    const { fill } = layer.fills[i];
    let argb: number;
    if (fill.type === "solid") {
      argb = fill.color;
    } else if (fill.type === "bitmap") {
      argb = 0xffff0000;
    } else {
      if (fill.type === "gradient") {
        unsupported.gradientFills++;
      } else {
        unsupported.bitmapFills++;
      }

      continue;
    }

    const color = vertexColor(argb);
    const plan = plans[i];
    const base = positions.length / 2;
    if (plan.geometry) {
      const { vertices, indices: own, indexOffset = 0 } = plan.geometry;
      for (let k = 0; k < vertices.length; k += 2) {
        positions.push(vertices[k], vertices[k + 1]);
        colors.push(color);
      }

      for (let k = 0; k < own.length; k++) {
        indices.push(own[k] - indexOffset + base);
      }
    } else if (plan.crossing) {
      // Disjoint convex pieces between the crossings: each a fan from its first corner.
      for (const piece of plan.crossing) {
        const first = positions.length / 2;
        for (let k = 0; k < piece.length; k += 2) {
          positions.push(piece[k], piece[k + 1]);
          colors.push(color);
        }

        for (let k = 2; k < piece.length / 2; k++) {
          indices.push(first, first + k - 1, first + k);
        }
      }
    } else if (plan.roots.length > 0) {
      unsupported.containedFills++;
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
