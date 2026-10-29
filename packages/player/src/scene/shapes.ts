// A shape layer's fills as geometries of the renderer's (@swf2es/render):
// each fill tessellated (fills.ts), in order, a geometry for each stretch of
// solid fills and one for each textured fill, a bitmap's or a gradient's,
// its vertices carrying where they sample in texels, as Pixi's matrices
// would map them; then drawTriangles' textured triangles, a geometry each
// mesh. What is left out is counted.

import type { Matrix } from "@swf2es/format";
import type { GeometryData } from "@swf2es/render";
import { invert } from "../display/geometry.js";
import { type Region as Area, RADIAL_MAX } from "../display/gradients.js";
import type { GradientFill, ImageFill, Path, ShapeLayer, TriangleMesh } from "../display/shapes.js";
import { convex } from "./fill-polygons.js";
import { type FillTessellator, regionOf, resolveFills } from "./fills.js";

/**
 * What the renderer cannot draw yet, counted as it is met, for a test or a
 * probe to read: lines that could not be filled with no native
 * tessellator, left out; advanced text drawn as normal;
 * clips within masks left out; displacement maps and other filters it
 * has no pass for, ignored.
 */
export const unsupported = {
  strokes: 0,
  /** Texts with advanced anti-aliasing, drawn as normal. */
  advancedTexts: 0,
  /**
   * Masks that mask nothing, a 3D one or one inside what it masks; and what
   * would clip a mask's own coverage (its mask, scrollRect, clip layer or
   * gutter), which it is drawn without.
   */
  masks: 0,
  /** Blend modes no blend is drawn for, a Pixel Bender shader's, drawn as normal. */
  blendModes: 0,
  filters: 0,
  /** Fills the native tessellator refused, of contours one inside another that are not convex alone. */
  containedFills: 0,
};

/**
 * A layer's geometry for one paint: a stretch of solid fills (null), a
 * bitmap or gradient fill, or drawTriangles' mesh, whose texels are its u
 * and v and which carries its t (MESH).
 */
export interface Part {
  geometry: GeometryData;
  paint: ImageFill | GradientFill | null;
  /** A radial gradient's region, the texels its texture covers. */
  region: Area | null;
  mesh: TriangleMesh | null;
}

const WHITE = 0xffffffff;
/** The texels a linear gradient's ramp has: 256 across the gradient square, -819.2 to 819.2. */
const RAMP = 256;

/** A straight ARGB colour as a vertex carries it: its bytes red, green, blue and alpha from the lowest. */
export function vertexColor(argb: number): number {
  return (
    (((argb >>> 16) & 0xff) | (argb & 0xff00) | ((argb & 0xff) << 16) | (argb & 0xff000000)) >>> 0
  );
}

/** The parts being gathered: positions, colours, texels and indices of the part open. */
class Gathered {
  readonly parts: Part[] = [];
  private positions: number[] = [];
  private colors: number[] = [];
  private texels: number[] = [];
  private indices: number[] = [];
  private paint: ImageFill | GradientFill | null = null;
  private region: Area | null = null;

  /** Open a part for `paint`, the one open first closed, unless both are solid. */
  open(paint: ImageFill | GradientFill | null, region: Area | null): void {
    if (paint === null && this.paint === null) {
      return;
    }

    this.close();
    this.paint = paint;
    this.region = region;
  }

  /** A vertex at (x, y) of `color`, sampling at texel (u, v): its index in the part. */
  vertex(x: number, y: number, color: number, u: number, v: number): number {
    this.positions.push(x, y);
    this.colors.push(color);
    this.texels.push(u, v);
    return this.positions.length / 2 - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  close(): void {
    if (this.indices.length > 0) {
      this.parts.push({
        geometry: {
          positions: Float32Array.from(this.positions),
          colors: Uint32Array.from(this.colors),
          texels: this.paint ? Float32Array.from(this.texels) : undefined,
          indices: Uint32Array.from(this.indices),
        },
        paint: this.paint,
        region: this.region,
        mesh: null,
      });
    }

    this.positions = [];
    this.colors = [];
    this.texels = [];
    this.indices = [];
  }
}

/**
 * Where a textured fill samples, in texels, at (x, y) of the shape. A
 * bitmap: through its matrix's inverse. A linear gradient: across its ramp,
 * half a pixel back so that a pixel's centre reads what Flash reads at its
 * corner. A radial one: across the region its texture was computed over.
 */
type Sampling = (x: number, y: number) => [number, number];

function sampling(
  paint: ImageFill | GradientFill,
  contours: readonly Path[],
): {
  at: Sampling;
  region: Area | null;
} {
  const m = invert(paint.matrix) as Matrix;
  const inverse = (x: number, y: number): [number, number] => [
    m.a * x + m.c * y + m.tx,
    m.b * x + m.d * y + m.ty,
  ];
  if (paint.type === "image") {
    return { at: inverse, region: null };
  }

  if (!paint.radial) {
    return {
      at: (x, y) => {
        const [sx, sy] = inverse(x - 0.5, y - 0.5);
        return [((sx + 819.2) * RAMP) / 1638.4, (sy + 819.2) / 1638.4];
      },
      region: null,
    };
  }

  const region = regionOf(contours as Path[]);
  const columns = radialTexels(region.width);
  const rows = radialTexels(region.height);
  return {
    at: (x, y) => [
      ((x - region.x) * columns) / region.width,
      ((y - region.y) * rows) / region.height,
    ],
    region,
  };
}

/** The texels a radial gradient's texture has across `pixels` of its region, as the Pixi view computes it. */
export function radialTexels(pixels: number): number {
  return Math.min(RADIAL_MAX, pixels);
}

/**
 * `layer`'s fills as geometries in order, positions in the shape's pixels,
 * then its meshes, drawn after the fills, as drawTriangles' are. A fill of
 * a bitmap the SWF lacks is red, as Flash draws it.
 */
export function layerParts(
  layer: ShapeLayer,
  tessellator: FillTessellator,
  masking = false,
): Part[] {
  const parts = layer.fills.length > 0 ? fillParts(layer, tessellator, masking) : [];

  for (const mesh of layer.meshes ?? []) {
    const part = meshPart(mesh);
    if (part) {
      parts.push(part);
    }
  }

  return parts;
}

const NO_COLORS = new Uint32Array(0);

/** A mesh's triangles, three vertices each, as a geometry: its u and v the texels, its t their depths. */
function meshPart(mesh: TriangleMesh): Part | null {
  // Three vertices a triangle, as drawTriangles keeps them.
  const count = mesh.positions.length / 2;
  if (count === 0) {
    return null;
  }

  const texels = new Float32Array(count * 2);
  const depths = new Float32Array(count);

  for (let k = 0; k < count; k++) {
    texels[k * 2] = mesh.uvt[k * 3];
    texels[k * 2 + 1] = mesh.uvt[k * 3 + 1];
    depths[k] = mesh.uvt[k * 3 + 2];
  }

  const indices = new Uint32Array(count);

  for (let k = 0; k < count; k++) {
    indices[k] = k;
  }

  return {
    geometry: { positions: mesh.positions, colors: NO_COLORS, texels, depths, indices },
    paint: null,
    region: null,
    mesh,
  };
}

/** `layer`'s fills as geometries in order. */
function fillParts(layer: ShapeLayer, tessellator: FillTessellator, masking: boolean): Part[] {
  // A drawing used as a mask fills non-zero, whatever its winding (fills.ts, resolveFills).
  const plans = resolveFills(layer, masking, tessellator);
  const out = new Gathered();
  for (let i = 0; i < layer.fills.length; i++) {
    const { fill, contours } = layer.fills[i];
    const textured = fill.type === "image" || fill.type === "gradient" ? fill : null;
    // A paint whose matrix collapses the plane covers nothing, as in the Pixi view.
    if (textured) {
      const m = textured.matrix;
      if (m.a * m.d - m.b * m.c === 0) {
        continue;
      }
    }

    const how = textured ? sampling(textured, contours) : null;
    out.open(textured, how?.region ?? null);
    const color = textured ? WHITE : vertexColor(fill.type === "solid" ? fill.color : 0xffff0000);
    const vertex = (x: number, y: number) => {
      const [u, v] = how ? how.at(x, y) : [0, 0];
      return out.vertex(x, y, color, u, v);
    };

    const plan = plans[i];
    if (plan.geometry) {
      const { vertices, indices, indexOffset = 0 } = plan.geometry;
      const first = vertex(vertices[0], vertices[1]);
      for (let k = 2; k < vertices.length; k += 2) {
        vertex(vertices[k], vertices[k + 1]);
      }

      for (let k = 0; k < indices.length; k += 3) {
        out.triangle(
          first + indices[k] - indexOffset,
          first + indices[k + 1] - indexOffset,
          first + indices[k + 2] - indexOffset,
        );
      }
    } else if (plan.crossing) {
      // Disjoint convex pieces between the crossings: each a fan from its first corner.
      for (const piece of plan.crossing) {
        const first = vertex(piece[0], piece[1]);
        for (let k = 2; k < piece.length; k += 2) {
          vertex(piece[k], piece[k + 1]);
        }

        for (let k = 2; k < piece.length / 2; k++) {
          out.triangle(first, first + k - 1, first + k);
        }
      }
    } else {
      // Each region with nothing inside it, convex, as a fan; anything else needs a triangulator of holes.
      for (const root of plan.roots) {
        const points = root.points;
        if (root.children.length > 0 || convex(points) === 0) {
          unsupported.containedFills++;
          continue;
        }

        const first = vertex(points[0], points[1]);
        for (let k = 2; k < points.length; k += 2) {
          vertex(points[k], points[k + 1]);
        }

        for (let k = 2; k < points.length / 2; k++) {
          out.triangle(first, first + k - 1, first + k);
        }
      }
    }
  }

  out.close();
  return out.parts;
}

/** A bitmap's quad, `width` by `height` pixels, its texels its pixels. */
export function bitmapQuad(width: number, height: number): GeometryData {
  return {
    positions: Float32Array.of(0, 0, width, 0, width, height, 0, height),
    colors: Uint32Array.of(WHITE, WHITE, WHITE, WHITE),
    texels: Float32Array.of(0, 0, width, 0, width, height, 0, height),
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
  };
}
