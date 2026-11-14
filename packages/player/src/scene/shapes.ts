// A shape layer's fills as geometries of the renderer's (@swf2es/render): each fill tessellated
// (fills.ts), in order, a geometry for each stretch of solid fills, each stretch of fills of one
// bitmap sampled alike, and each gradient fill, its vertices carrying where they sample in texels;
// then drawTriangles' textured triangles, a geometry each mesh. What is left out is counted.

import { IDENTITY, type Matrix } from "@swf2es/format";
import type { GeometryData } from "@swf2es/render";
import { invert } from "../display/geometry.js";
import { type Region as Area, RADIAL_MAX } from "../display/gradients.js";
import type {
  GradientFill,
  ImageFill,
  LinePaint,
  Path,
  ShaderPaint,
  ShapeLayer,
  TriangleMesh,
} from "../display/shapes.js";
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
function samplesAlike(a: BitmapSampling, b: BitmapSampling): boolean {
  return a.image === b.image && a.smooth === b.smooth && a.repeat === b.repeat;
}

export interface Part {
  geometry: GeometryData;
  /** A shader fill's part has its kernel's coordinates for texels, and a depth of 1 for each vertex (MESH's). */
  paint: BitmapSampling | GradientFill | ShaderPaint | null;
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
  private paint: ImageFill | GradientFill | ShaderPaint | null = null;
  private region: Area | null = null;
  /** The fills in the part open, which is flat (GeometryData.flat) with one alone. */
  private fills = 0;

  /**
   * Open a part for `paint`, the one open first closed, unless both are
   * solid, or both sample one bitmap alike (samplesAlike): a drawing of a
   * bitmap fill a triangle so draws in a few parts. A shader fill is a part
   * of its own.
   */
  open(paint: ImageFill | GradientFill | ShaderPaint | null, region: Area | null): void {
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

  /** Room for `vertices` more vertices and `corners` more indices, which add takes. */
  reserve(vertices: number, corners: number): void {
    const n = this.vertices + vertices;
    scratchPositions = roomy(scratchPositions, n * 2, this.vertices * 2);
    scratchColors = roomy(scratchColors, n, this.vertices);
    scratchTexels = roomy(scratchTexels, n * 2, this.vertices * 2);
    scratchIndices = roomy(scratchIndices, this.corners + corners, this.corners);
  }

  /**
   * A fill's triangles in the part open, in room reserve made: its
   * `vertices` in `color`, sampling where `how` puts them, and its
   * `indices`, which count from `offset`. The loops are over the arrays
   * themselves: a call a vertex and a triangle showed in a drawing made
   * again on every frame.
   */
  add(
    vertices: Float32Array | Float64Array,
    indices: Uint16Array | Uint32Array,
    offset: number,
    color: number,
    how: Sampling | null,
  ): void {
    const first = this.vertices;
    const count = vertices.length >> 1;
    const positions = scratchPositions;
    const colors = scratchColors;
    for (let k = 0; k < count; k++) {
      positions[(first + k) * 2] = vertices[k * 2];
      positions[(first + k) * 2 + 1] = vertices[k * 2 + 1];
      colors[first + k] = color;
    }

    // A part of solid fills has no texels, and reads none.
    if (how) {
      const texels = scratchTexels;
      for (let k = 0; k < count; k++) {
        how.at(vertices[k * 2], vertices[k * 2 + 1]);
        texels[(first + k) * 2] = how.u;
        texels[(first + k) * 2 + 1] = how.v;
      }
    }

    const corners = this.corners;
    const length = indices.length;
    const out = scratchIndices;
    const base = first - offset;
    for (let k = 0; k < length; k++) {
      out[corners + k] = indices[k] + base;
    }

    this.vertices = first + count;
    this.corners = corners + length;
    this.fills++;
  }

  close(): void {
    const n = this.vertices;
    const corners = this.corners;
    const shader = this.paint?.type === "shader";
    if (corners > 0) {
      // One buffer for the part's arrays, as each array's own costs more than filling it.
      const colored = shader ? 0 : n;
      const sampled = this.paint ? n * 2 : 0;
      const deep = shader ? n : 0;
      const buffer = new ArrayBuffer((n * 2 + colored + sampled + deep + corners) * 4);
      const positions = new Float32Array(buffer, 0, n * 2);
      positions.set(scratchPositions.subarray(0, n * 2));
      let at = n * 8;
      let colors = NO_COLORS;
      // A shader fill's vertices carry a depth where others carry their colour (MESH's).
      if (!shader) {
        colors = new Uint32Array(buffer, at, n);
        colors.set(scratchColors.subarray(0, n));
        at += n * 4;
      }

      let texels: Float32Array | undefined;
      if (this.paint) {
        texels = new Float32Array(buffer, at, n * 2);
        texels.set(scratchTexels.subarray(0, n * 2));
        at += n * 8;
      }

      let depths: Float32Array | undefined;
      if (shader) {
        depths = new Float32Array(buffer, at, n).fill(1);
        at += n * 4;
      }

      const indices = new Uint32Array(buffer, at, corners);
      indices.set(scratchIndices.subarray(0, corners));
      this.parts.push({
        geometry: {
          positions,
          colors,
          texels,
          depths,
          indices,
          // One fill's triangles cover each point of it once; fills of a drawing may overlap.
          flat: this.fills === 1,
        },
        paint: this.paint,
        region: this.region,
        mesh: null,
      });
    }

    this.vertices = 0;
    this.corners = 0;
    this.fills = 0;
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

  set(paint: ImageFill | GradientFill | ShaderPaint, contours: readonly Path[]): this {
    const radial = paint.type === "gradient" && paint.radial;
    return this.setIn(paint, radial ? regionOf(contours as Path[]) : null);
  }

  /** As set, a radial gradient's texture over `region`, which is null for any other paint. */
  setIn(paint: ImageFill | GradientFill | ShaderPaint, region: Area | null): this {
    this.m = invert(paint.matrix) as Matrix;
    // A shader's coordinates are its matrix's inverse of the shape's, as a bitmap's texels are.
    this.kind = paint.type !== "gradient" ? "image" : paint.radial ? "radial" : "linear";
    this.region = region;
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
  // Read below before the tessellator is called again, so borrowed from it.
  const geometries = resolveFills(layer, masking, tessellator, true);
  const out = new Gathered();
  for (let i = 0; i < layer.fills.length; i++) {
    const { fill, contours } = layer.fills[i];
    const textured =
      fill.type === "image" || fill.type === "gradient" || fill.type === "shader" ? fill : null;
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
      out.add(vertices, indices, indexOffset, color, how);
    }
  }

  out.close();
  shrinkScratch();

  return out.parts;
}

/**
 * A painted line's outline as the line builder made it (strokes.ts),
 * through the linear transform (a b c d), white: a part sampling `paint`
 * where each vertex lies in the shape's space, as a fill's do, so that the
 * paint is mapped as Flash maps a line's. Null where the paint's matrix
 * collapses the plane, which covers nothing.
 */
export function strokePart(
  data: GeometryData,
  a: number,
  b: number,
  c: number,
  d: number,
  paint: LinePaint,
): Part | null {
  const m = paint.matrix;
  if (m.a * m.d - m.b * m.c === 0) {
    return null;
  }

  // Back into the shape's space, which the builder left by (a b c d), never collapsed there.
  const det = a * d - b * c;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const positions = data.positions;
  const count = positions.length >> 1;
  const points = new Float64Array(count * 2);
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < count; k++) {
    const px = positions[k * 2];
    const py = positions[k * 2 + 1];
    const x = ia * px + ic * py;
    const y = ib * px + id * py;
    points[k * 2] = x;
    points[k * 2 + 1] = y;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }

  // A radial gradient's texture over the outline's bounds, whole pixels out, as regionOf a fill's.
  let region: Area | null = null;
  if (paint.type === "gradient" && paint.radial) {
    const x = Math.floor(x0);
    const y = Math.floor(y0);
    region =
      x1 >= x0 && y1 >= y0
        ? { x, y, width: Math.max(1, Math.ceil(x1) - x), height: Math.max(1, Math.ceil(y1) - y) }
        : { x: 0, y: 0, width: 1, height: 1 };
  }

  const how = sampling.setIn(paint, region);
  const texels = new Float32Array(count * 2);
  for (let k = 0; k < count; k++) {
    how.at(points[k * 2], points[k * 2 + 1]);
    texels[k * 2] = how.u;
    texels[k * 2 + 1] = how.v;
  }

  return {
    geometry: { positions, colors: data.colors, texels, indices: data.indices },
    paint,
    region,
    mesh: null,
  };
}

/** A bitmap's quad, `width` by `height` pixels, its texels its pixels. */
export function bitmapQuad(width: number, height: number): GeometryData {
  return {
    positions: Float32Array.of(0, 0, width, 0, width, height, 0, height),
    colors: Uint32Array.of(WHITE, WHITE, WHITE, WHITE),
    texels: Float32Array.of(0, 0, width, 0, width, height, 0, height),
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
    flat: true,
  };
}
