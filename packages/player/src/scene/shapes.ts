// A shape layer's fills as geometries of the renderer's (@swf2es/render): each fill tessellated
// (fills.ts), in order, a geometry for each stretch of solid fills, each stretch of fills of one
// bitmap sampled alike, and each gradient fill, its vertices carrying where they sample in texels;
// then drawTriangles' textured triangles, a geometry each mesh. What is left out is counted.

import { IDENTITY, type Matrix } from "@swf2es/format";
import type { GeometryData } from "@swf2es/render";
import { invert } from "../display/geometry.js";
import { type Region as Area, RADIAL_MAX } from "../display/gradients.js";
import type { GradientFill, ImageFill, Path, ShapeLayer, TriangleMesh } from "../display/shapes.js";
import { type FillTessellator, regionOf, resolveFills } from "./fills.js";

/**
 * What the renderer cannot draw yet, counted as it is met, for a test or a
 * probe to read: advanced text drawn as normal; clips within masks left
 * out; displacement maps and other filters it has no pass for, ignored.
 */
export const unsupported = {
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
};

/**
 * A layer's geometry for one paint: a stretch of solid fills (null), a
 * stretch of fills of one bitmap (the first's paint), a gradient fill, or
 * drawTriangles' mesh, whose texels are its u and v and which carries its
 * t (MESH).
 */
/**
 * What a bitmap part is sampled by, all the view reads of its paint
 * (paintTexture, paintSampler): fills of one bitmap that sample it alike
 * (samplesAlike) share a part, each through its own matrix, which its
 * vertices' texels hold.
 */
export type BitmapSampling = Pick<ImageFill, "type" | "image" | "smooth" | "repeat">;

/** Whether `a` and `b` sample one bitmap alike, and so may share a part. */
export function samplesAlike(a: BitmapSampling, b: BitmapSampling): boolean {
  return a.image === b.image && a.smooth === b.smooth && a.repeat === b.repeat;
}

export interface Part {
  geometry: GeometryData;
  paint: BitmapSampling | GradientFill | null;
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

/**
 * What the part open is gathered in, grown as it needs and kept for the
 * next: a drawing redrawn on every frame made each part's numbers in lists
 * and copied them out, garbage on every frame. A part copies out what it used.
 */
const SCRATCH_VERTICES = 512;
/** The vertices past which scratch grown for a large drawing is let go of after it, not kept. */
const MOST_KEPT_VERTICES = 65536;
let scratchPositions = new Float32Array(SCRATCH_VERTICES * 2);
let scratchColors = new Uint32Array(SCRATCH_VERTICES);
let scratchTexels = new Float32Array(SCRATCH_VERTICES * 2);
let scratchIndices = new Uint32Array(SCRATCH_VERTICES * 3);

/** `array` with room for `n` elements, its first `used` kept. */
function roomy<T extends Float32Array | Uint32Array>(array: T, n: number, used: number): T {
  if (n <= array.length) {
    return array;
  }

  const grown = new (array.constructor as new (n: number) => T)(Math.max(n, array.length * 2));
  grown.set(array.subarray(0, used));

  return grown;
}

/** The scratch back at its usual size, where a large drawing grew it. */
function shrinkScratch(): void {
  if (scratchColors.length > MOST_KEPT_VERTICES) {
    scratchPositions = new Float32Array(SCRATCH_VERTICES * 2);
    scratchColors = new Uint32Array(SCRATCH_VERTICES);
    scratchTexels = new Float32Array(SCRATCH_VERTICES * 2);
  }

  if (scratchIndices.length > MOST_KEPT_VERTICES * 3) {
    scratchIndices = new Uint32Array(SCRATCH_VERTICES * 3);
  }
}

/** The parts being gathered: positions, colours, texels and indices of the part open. */
class Gathered {
  readonly parts: Part[] = [];
  private vertices = 0;
  private corners = 0;
  private paint: ImageFill | GradientFill | null = null;
  private region: Area | null = null;

  /**
   * Open a part for `paint`, the one open first closed, unless both are
   * solid, or both sample one bitmap alike (samplesAlike): a drawing of a
   * bitmap fill a triangle so draws in a few parts.
   */
  open(paint: ImageFill | GradientFill | null, region: Area | null): void {
    if (paint === null && this.paint === null) {
      return;
    }

    const open = this.paint;
    if (paint?.type === "image" && open?.type === "image" && samplesAlike(paint, open)) {
      return;
    }

    this.close();
    this.paint = paint;
    this.region = region;
  }

  /** The index the next vertex takes in the part. */
  get next(): number {
    return this.vertices;
  }

  /** Room for `vertices` more vertices and `corners` more indices, which vertex and triangle take. */
  reserve(vertices: number, corners: number): void {
    const n = this.vertices + vertices;
    scratchPositions = roomy(scratchPositions, n * 2, this.vertices * 2);
    scratchColors = roomy(scratchColors, n, this.vertices);
    scratchTexels = roomy(scratchTexels, n * 2, this.vertices * 2);
    scratchIndices = roomy(scratchIndices, this.corners + corners, this.corners);
  }

  /** A vertex at (x, y) of `color`, sampling at texel (u, v), in room reserve made. */
  vertex(x: number, y: number, color: number, u: number, v: number): void {
    const n = this.vertices;
    scratchPositions[n * 2] = x;
    scratchPositions[n * 2 + 1] = y;
    scratchColors[n] = color;
    scratchTexels[n * 2] = u;
    scratchTexels[n * 2 + 1] = v;
    this.vertices = n + 1;
  }

  /** A triangle of the part's vertices `a`, `b` and `c`, in room reserve made. */
  triangle(a: number, b: number, c: number): void {
    const n = this.corners;
    scratchIndices[n] = a;
    scratchIndices[n + 1] = b;
    scratchIndices[n + 2] = c;
    this.corners = n + 3;
  }

  close(): void {
    const n = this.vertices;
    if (this.corners > 0) {
      this.parts.push({
        geometry: {
          positions: scratchPositions.slice(0, n * 2),
          colors: scratchColors.slice(0, n),
          texels: this.paint ? scratchTexels.slice(0, n * 2) : undefined,
          indices: scratchIndices.slice(0, this.corners),
        },
        paint: this.paint,
        region: this.region,
        mesh: null,
      });
    }

    this.vertices = 0;
    this.corners = 0;
  }
}

/**
 * Where a textured fill samples, in texels, at (x, y) of the shape. A
 * bitmap: through its matrix's inverse. A linear gradient: across its ramp,
 * half a pixel back so that a pixel's centre reads what Flash reads at its
 * corner. A radial one: across the region its texture was computed over.
 * at() leaves the texel in u and v, not in a pair made for each vertex,
 * and one is set again for each fill (sampling), not made for each.
 */
class Sampling {
  u = 0;
  v = 0;
  region: Area | null = null;
  private kind: "image" | "linear" | "radial" = "image";
  private m: Matrix = IDENTITY;
  private columns = 0;
  private rows = 0;

  set(paint: ImageFill | GradientFill, contours: readonly Path[]): this {
    this.m = invert(paint.matrix) as Matrix;
    this.kind = paint.type === "image" ? "image" : paint.radial ? "radial" : "linear";
    this.region = this.kind === "radial" ? regionOf(contours as Path[]) : null;
    this.columns = this.region ? radialTexels(this.region.width) : 0;
    this.rows = this.region ? radialTexels(this.region.height) : 0;
    return this;
  }

  at(x: number, y: number): void {
    const m = this.m;
    switch (this.kind) {
      case "image":
        this.u = m.a * x + m.c * y + m.tx;
        this.v = m.b * x + m.d * y + m.ty;
        break;
      case "linear": {
        const sx = m.a * (x - 0.5) + m.c * (y - 0.5) + m.tx;
        const sy = m.b * (x - 0.5) + m.d * (y - 0.5) + m.ty;
        this.u = ((sx + 819.2) * RAMP) / 1638.4;
        this.v = (sy + 819.2) / 1638.4;
        break;
      }
      default: {
        const r = this.region as Area;
        this.u = ((x - r.x) * this.columns) / r.width;
        this.v = ((y - r.y) * this.rows) / r.height;
      }
    }
  }
}

/** The one Sampling fillParts sets for each textured fill. */
const sampling = new Sampling();

/** The texels a radial gradient's texture has across `pixels` of its region. */
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
  const geometries = resolveFills(layer, masking, tessellator);
  const out = new Gathered();
  for (let i = 0; i < layer.fills.length; i++) {
    const { fill, contours } = layer.fills[i];
    const textured = fill.type === "image" || fill.type === "gradient" ? fill : null;
    // A paint whose matrix collapses the plane covers nothing.
    if (textured) {
      const m = textured.matrix;
      if (m.a * m.d - m.b * m.c === 0) {
        continue;
      }
    }

    const how = textured ? sampling.set(textured, contours) : null;
    out.open(textured, how?.region ?? null);
    const color = textured ? WHITE : vertexColor(fill.type === "solid" ? fill.color : 0xffff0000);

    // A fill refused, or of nothing, adds no vertex.
    const geometry = geometries[i];
    if (geometry && geometry.vertices.length > 0) {
      const { vertices, indices, indexOffset = 0 } = geometry;
      out.reserve(vertices.length / 2, indices.length);
      const first = out.next;
      for (let k = 0; k < vertices.length; k += 2) {
        const x = vertices[k];
        const y = vertices[k + 1];
        how?.at(x, y);
        out.vertex(x, y, color, how ? how.u : 0, how ? how.v : 0);
      }

      for (let k = 0; k < indices.length; k += 3) {
        out.triangle(
          first + indices[k] - indexOffset,
          first + indices[k + 1] - indexOffset,
          first + indices[k + 2] - indexOffset,
        );
      }
    }
  }

  out.close();
  shrinkScratch();

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
