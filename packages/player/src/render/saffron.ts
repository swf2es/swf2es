// Advanced anti-aliasing (Saffron) drawn as adl draws it: each glyph a
// quad whose shader finds, for each of Flash's pixels it covers, the
// pixel's signed distance to the glyph's outline, and covers it by where
// that falls between the cutoffs of text/csm.ts. The distance is exact:
// the glyph's outline, its curves cut into fine chords, is in a texture
// of segments, which the shader goes through for the nearest and, by
// parity, for whether the pixel is inside, so that a stem a third of a
// pixel wide comes out as Flash's does, at every size and under every
// transform alike, with nothing to keep per size.
//
// Measured in adl, a glyph is placed so: the field's origin on the
// screen at a whole pixel; then a glyph's pen, where it stood in
// fractions of a twip, at a quarter of a pixel across and down under
// gridFitType none, at an eighth across and a whole pixel down under
// pixel, and at a quarter across and a whole pixel down under subpixel,
// each the nearer, ties to even; and sampled half a pixel left of each
// pixel's centre. Turned or skewed, it lies where it falls. The pixels
// are the stage's, or a BitmapData's in a draw, wherever the target lies
// on them, a filter's input too; every sample of a pixel that the target
// has more of (the test page's, which averages them; a draw's) takes the
// pixel's coverage.
import type { ColorTransform, Glyph } from "@swf2es/format";
import {
  Buffer,
  BufferImageSource,
  BufferUsage,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  UniformGroup,
} from "pixi.js";
import { CURVE, LINE, MOVE, shapeLayers } from "../display/shapes.js";
import type { CsmTable } from "../text/csm.js";

/** Most table entries a text's uniforms hold. */
const ENTRIES = 48;

// uView.x: Flash's pixels to a unit of the world, on whose grid they lie, whatever the target.
// uMode: gridFitType (0 none, 1 pixel, 2 subpixel), thickness, sharpness, and whether a Flash
// colour transform (uMul, uAdd) replaces Pixi's colour. uWorldOffset (the Pixi fork's): what a
// filter's input took off the world's translation. uTable: the tables' entries, size, inside,
// outside. A glyph's aOrigin is its pen and its light and dark tables, each its first entry plus
// 64 times its entries; aGlyph a corner of its outline's bounds and the way out from it; aRun its
// segments, first and count, the pixels of a unit of its outline, and its size.
const vertex = `#version 300 es
in vec2 aPosition;
in vec4 aOrigin;
in vec4 aGlyph;
in vec4 aRun;
in vec4 aColor;
out vec2 vPixel;
flat out vec2 vPen;
flat out vec4 vToGlyph;
flat out vec4 vToPixel;
flat out vec4 vCut;
flat out vec4 vShown;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec2 uWorldOffset;
uniform vec4 uView;
uniform vec4 uMode;
uniform vec4 uMul;
uniform vec4 uAdd;
uniform vec4 uTable[${ENTRIES}];

// The cutoffs at ppem by the table of entries start to start + count, as text/csm.ts' cutoffs.
vec2 cutoffs(int start, int count, float ppem) {
  vec4 first = uTable[start];
  vec4 last = uTable[start + count - 1];
  vec2 c = first.yz;
  if (ppem >= last.x) {
    c = last.yz;
  } else if (ppem > first.x) {
    for (int i = 1; i < ${ENTRIES}; i++) {
      if (i >= count) {
        break;
      }

      vec4 b = uTable[start + i];
      if (ppem <= b.x) {
        vec4 a = uTable[start + i - 1];
        c = mix(a.yz, b.yz, (ppem - a.x) / (b.x - a.x));
        break;
      }
    }
  }

  float unit = 0.0001 * ppem;
  float t = clamp(uMode.y, -200.0, 200.0);
  float s = clamp(uMode.z, -400.0, 400.0);
  c -= unit * vec2(t + s * 0.5, t - s * 0.5);
  if (c.x < c.y) {
    c = vec2((c.x + c.y) * 0.5);
  }

  return c;
}

void main(void) {
  // The local space to Flash's pixels, in the world's space: their grid is the stage's (or a
  // BitmapData's) wherever the target lies on it, as a filter's does.
  float unit = uView.x;
  mat3 m = mat3(unit, 0.0, 0.0, 0.0, unit, 0.0, uWorldOffset * unit, 1.0)
    * uWorldTransformMatrix * uTransformMatrix;
  mat2 linear = mat2(m[0].xy, m[1].xy);
  vec2 origin = m[2].xy;
  vec2 pen = (m * vec3(aOrigin.xy, 1.0)).xy + roundEven(origin) - origin;
  if (linear[0][1] != 0.0 || linear[1][0] != 0.0) {
    // Turned or skewed: no grid.
  } else if (uMode.x == 1.0) {
    pen = vec2(roundEven(pen.x * 8.0) / 8.0 + 0.5, roundEven(pen.y));
  } else if (uMode.x == 2.0) {
    pen = vec2(roundEven(pen.x * 4.0) / 4.0 + 0.5, roundEven(pen.y));
  } else {
    pen = roundEven(pen * 4.0) / 4.0 + vec2(0.5, 0.0);
  }

  float ppem = aRun.w * sqrt(abs(determinant(linear)));
  // The colour as drawn, straight: light or dark by it, as adl chooses.
  vec4 tint = uColor * uWorldColorAlpha;
  vec4 shown = uMode.w < 0.5
    ? vec4(aColor.rgb * (tint.a > 0.0 ? tint.rgb / tint.a : vec3(0.0)), aColor.a * tint.a)
    : clamp(aColor * uMul + uAdd, 0.0, 1.0);
  bool light = dot(floor(shown.rgb * 255.0 + 0.5), vec3(30.0, 59.0, 11.0)) > 20000.0;
  int table = int(light ? aOrigin.z : aOrigin.w);
  vec2 cut = cutoffs(table & 63, table >> 6, ppem);
  mat2 toPixel = linear * aRun.z;
  float margin = max(abs(cut.x), abs(cut.y)) + 1.0;
  vec2 p = pen + toPixel * aGlyph.xy + aGlyph.zw * margin;
  float det = determinant(toPixel);
  mat2 inverse = det != 0.0
    ? mat2(toPixel[1][1], -toPixel[0][1], -toPixel[1][0], toPixel[0][0]) / det
    : mat2(0.0);
  vPixel = p;
  vPen = pen;
  vToGlyph = vec4(inverse[0], inverse[1]);
  vToPixel = vec4(toPixel[0], toPixel[1]);
  vCut = vec4(cut, aRun.xy);
  vShown = shown;
  gl_Position = vec4((uProjectionMatrix * vec3(p / unit - uWorldOffset, 1.0)).xy, 0.0, 1.0);
}
`;

const fragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 vPixel;
flat in vec2 vPen;
flat in vec4 vToGlyph;
flat in vec4 vToPixel;
flat in vec4 vCut;
flat in vec4 vShown;
out vec4 finalColor;
uniform highp sampler2D uSegments;

void main(void) {
  vec2 centre = floor(vPixel) + 0.5;
  mat2 toGlyph = mat2(vToGlyph.xy, vToGlyph.zw);
  mat2 toPixel = mat2(vToPixel.xy, vToPixel.zw);
  vec2 g = toGlyph * (centre - vPen);
  int start = int(vCut.z);
  int count = int(vCut.w);
  float nearest = 3.4e38;
  vec2 along = vec2(1.0, 0.0);
  bool inside = false;
  for (int i = 0; i < count; i++) {
    int k = start + i;
    vec4 s = texelFetch(uSegments, ivec2(k & 1023, k >> 10), 0);
    vec2 a = s.xy;
    vec2 e = s.zw - a;
    vec2 w = g - a;
    float t = clamp(dot(w, e) / max(dot(e, e), 1e-20), 0.0, 1.0);
    vec2 off = w - e * t;
    float d = dot(off, off);
    if (d < nearest) {
      nearest = d;
      along = e;
    }

    if ((a.y > g.y) != (s.w > g.y) && a.x + (g.y - a.y) * e.x / e.y > g.x) {
      inside = !inside;
    }
  }

  // In Flash's pixels, across the nearest edge as the transform stretches it.
  float stretch = length(toPixel * along);
  float d = stretch > 0.0
    ? sqrt(nearest) * abs(determinant(toPixel)) * length(along) / stretch
    : 0.0;
  d = inside ? d : -d;
  float coverage = vCut.x > vCut.y
    ? clamp((d - vCut.y) / (vCut.x - vCut.y), 0.0, 1.0)
    : step(vCut.x, d);
  // Nothing outside: as a mask, which writes the stencil wherever it draws, a glyph is its shape.
  if (coverage <= 0.0) {
    discard;
  }

  finalColor = vec4(vShown.rgb * vShown.a, vShown.a) * coverage;
}
`;

let program: GlProgram | null = null;

/** Segments to a row of the texture. */
const ROW = 1024;
/** The most segments kept: 16 bytes each, 16 MB. Glyphs past it are drawn as normal text is. */
const MOST = ROW * 1024;

/**
 * The glyphs' outlines as segments, x0 y0 x1 y1 a texel, in the font's
 * units over 20 (as shapeLayers reads them), each glyph's a run of its
 * own: added as a glyph is first drawn, and kept, up to MOST, as the
 * glyphs' fills are (render/text.ts).
 */
let data = new Float32Array(ROW * 4 * 16);
let used = 0;
let source: BufferImageSource | null = null;
/** Whether segments were added since the texture was last told. */
let added = false;

/** A glyph's run of segments and its outline's bounds, in the font's units over 20. */
interface Outline {
  start: number;
  count: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** Each glyph's outline; null for an empty one. */
const outlines = new WeakMap<Glyph, Outline | null>();

/** The segments' texture, told of those added since. */
function segments(): BufferImageSource {
  if (!source) {
    source = new BufferImageSource({
      resource: data,
      width: ROW,
      height: data.length / 4 / ROW,
      format: "rgba32float",
      scaleMode: "nearest",
      alphaMode: "no-premultiply-alpha",
      autoGenerateMipmaps: false,
    });
    added = false;
  } else if (added) {
    added = false;
    const rows = data.length / 4 / ROW;
    if (source.resource !== data || source.pixelHeight !== rows) {
      source.resource = data;
      source.resize(ROW, rows, 1);
    }

    source.update();
  }

  return source;
}

/** Room for `count` more segments, the store grown to hold them: false past MOST. */
function room(count: number): boolean {
  if (used + count > MOST) {
    return false;
  }

  if ((used + count) * 4 > data.length) {
    let length = data.length;
    while ((used + count) * 4 > length) {
      length *= 2;
    }

    const grown = new Float32Array(length);
    grown.set(data.subarray(0, used * 4));
    data = grown;
  }

  return true;
}

/**
 * A glyph's outline as segments, its curves cut into chords that stray from
 * them by `tolerance` at most: added on its first draw. Null for an empty
 * glyph, undefined past the most kept.
 */
function outlineOf(glyph: Glyph, tolerance: number): Outline | null | undefined {
  const known = outlines.get(glyph);
  if (known !== undefined) {
    return known;
  }

  const shape = {
    id: 0,
    bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
    edgeBounds: null,
    fills: [{ type: "solid" as const, color: 0xffffffff }],
    lines: [],
    records: glyph.records,
    truncated: false,
  };
  const layers = shapeLayers(shape);
  const points: number[] = [];
  const contours = layers.length > 0 ? layers[0].fills.flatMap((f) => f.contours) : [];
  for (const path of contours) {
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    for (let i = 0; i < path.length; ) {
      const command = path[i];
      if (command === MOVE) {
        if (x !== startX || y !== startY) {
          points.push(x, y, startX, startY);
        }

        x = startX = path[i + 1];
        y = startY = path[i + 2];
        i += 3;
      } else if (command === LINE) {
        points.push(x, y, path[i + 1], path[i + 2]);
        x = path[i + 1];
        y = path[i + 2];
        i += 3;
      } else if (command === CURVE) {
        const cx = path[i + 1];
        const cy = path[i + 2];
        const ax = path[i + 3];
        const ay = path[i + 4];
        // A quadratic strays from its chords of a nth of it by |p0 - 2c + p1| / 4n² at most.
        const bend = Math.hypot(x - 2 * cx + ax, y - 2 * cy + ay);
        const n = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(bend / (4 * tolerance)))));
        let px = x;
        let py = y;
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          const qx = u * u * x + 2 * u * t * cx + t * t * ax;
          const qy = u * u * y + 2 * u * t * cy + t * t * ay;
          points.push(px, py, qx, qy);
          px = qx;
          py = qy;
        }

        x = ax;
        y = ay;
        i += 5;
      } else {
        // A cubic, which no glyph has.
        i += 7;
      }
    }

    if (x !== startX || y !== startY) {
      points.push(x, y, startX, startY);
    }
  }

  const count = points.length / 4;
  if (count === 0) {
    outlines.set(glyph, null);
    return null;
  }

  if (!room(count)) {
    return undefined;
  }

  const outline: Outline = {
    start: used,
    count,
    xMin: Number.POSITIVE_INFINITY,
    yMin: Number.POSITIVE_INFINITY,
    xMax: Number.NEGATIVE_INFINITY,
    yMax: Number.NEGATIVE_INFINITY,
  };
  for (let i = 0; i < points.length; i += 2) {
    outline.xMin = Math.min(outline.xMin, points[i]);
    outline.xMax = Math.max(outline.xMax, points[i]);
    outline.yMin = Math.min(outline.yMin, points[i + 1]);
    outline.yMax = Math.max(outline.yMax, points[i + 1]);
  }

  data.set(points, used * 4);
  used += count;
  added = true;
  outlines.set(glyph, outline);
  return outline;
}

/** What every advanced text a view draws shares: Flash's pixels to a unit of its world. */
export class SaffronView {
  readonly uniforms = new UniformGroup({
    uView: { value: new Float32Array([1, 0, 0, 0]), type: "vec4<f32>" },
  });

  set unit(unit: number) {
    const view = this.uniforms.uniforms.uView as Float32Array;
    if (view[0] !== unit) {
      view[0] = unit;
      this.uniforms.update();
    }
  }
}

/** The corners of a glyph's quad, as signs: the margin goes out from it so. */
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

/** Floats a vertex: aPosition 2, then aOrigin, aGlyph, aRun and aColor 4 each. */
const STRIDE = 18;

/** The vertices a builder writes, reused by the next: builders build one at a time. */
let scratch = new Float32Array(STRIDE * 4 * 64);
/** Indices of quads in order, two triangles each: views of one array, which only grows. */
let quads = new Uint32Array(0);

function quadIndices(count: number): Uint32Array {
  if (quads.length < count * 6) {
    const n = Math.max(count, quads.length / 3);
    quads = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4;
      const at = i * 6;
      quads[at] = v;
      quads[at + 1] = v + 1;
      quads[at + 2] = v + 2;
      quads[at + 3] = v;
      quads[at + 4] = v + 2;
      quads[at + 5] = v + 3;
    }
  }

  return quads.subarray(0, count * 6);
}

/**
 * The glyphs of a text drawn with advanced anti-aliasing, gathered as the
 * text is laid out (add), then made into one mesh (done). One builds at a
 * time: they share the vertices they write.
 */
export class SaffronBuilder {
  private glyphs = 0;
  private readonly tables: CsmTable[] = [];
  private readonly starts: number[] = [];
  private entries = 0;

  constructor(
    private readonly view: SaffronView,
    /** 0 none, 1 pixel, 2 subpixel. */
    private readonly grid: number,
    private readonly thickness: number,
    private readonly sharpness: number,
  ) {}

  /**
   * Add a glyph of a font of `em` units, its pen at (x, y) in the text's
   * pixels, `size` pixels to the em, in 0xRRGGBB and `alpha`, by the
   * light or the dark of `tables` as its colour is drawn: false where it
   * cannot, past the segments kept or the tables' room, for the glyph to
   * be drawn as normal text is.
   */
  add(
    glyph: Glyph,
    em: number,
    x: number,
    y: number,
    size: number,
    color: number,
    alpha: number,
    tables: readonly [CsmTable, CsmTable],
  ): boolean {
    // The units shapeLayers reads glyphs in: the font's over 20, a 1024th of the em for DefineFont3.
    const units = em / 20;
    const outline = outlineOf(glyph, units / 8192);
    if (outline === null) {
      return true;
    }

    if (outline === undefined) {
      return false;
    }

    const light = this.code(tables[0]);
    const dark = this.code(tables[1]);
    if (light < 0 || dark < 0) {
      return false;
    }

    if ((this.glyphs + 1) * 4 * STRIDE > scratch.length) {
      const grown = new Float32Array(scratch.length * 2);
      grown.set(scratch.subarray(0, this.glyphs * 4 * STRIDE));
      scratch = grown;
    }

    const scale = size / units;
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    let at = this.glyphs * 4 * STRIDE;
    for (let k = 0; k < 8; k += 2) {
      const sx = CORNERS[k];
      const sy = CORNERS[k + 1];
      const gx = sx < 0 ? outline.xMin : outline.xMax;
      const gy = sy < 0 ? outline.yMin : outline.yMax;
      // Where the quad reaches, for Pixi's bounds: the shader moves it to the pen's place.
      scratch[at] = x + gx * scale + sx * 3;
      scratch[at + 1] = y + gy * scale + sy * 3;
      scratch[at + 2] = x;
      scratch[at + 3] = y;
      scratch[at + 4] = light;
      scratch[at + 5] = dark;
      scratch[at + 6] = gx;
      scratch[at + 7] = gy;
      scratch[at + 8] = sx;
      scratch[at + 9] = sy;
      scratch[at + 10] = outline.start;
      scratch[at + 11] = outline.count;
      scratch[at + 12] = scale;
      scratch[at + 13] = size;
      scratch[at + 14] = r;
      scratch[at + 15] = g;
      scratch[at + 16] = b;
      scratch[at + 17] = alpha;
      at += STRIDE;
    }

    this.glyphs++;
    return true;
  }

  /** A table's place in the uniforms, its first entry plus 64 times its entries, added where new; -1 past their room. */
  private code(table: CsmTable): number {
    let t = this.tables.indexOf(table);
    if (t < 0) {
      if (this.entries + table.length / 3 > ENTRIES) {
        return -1;
      }

      t = this.tables.length;
      this.tables.push(table);
      this.starts.push(this.entries);
      this.entries += table.length / 3;
    }

    return this.starts[t] + (table.length / 3) * 64;
  }

  /** The mesh of the glyphs added, null for none. */
  done(): SaffronText | null {
    if (this.glyphs === 0) {
      return null;
    }

    const buffer = new Buffer({
      data: scratch.slice(0, this.glyphs * 4 * STRIDE),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    const bytes = STRIDE * 4;
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer, format: "float32x2", stride: bytes, offset: 0 },
        aOrigin: { buffer, format: "float32x4", stride: bytes, offset: 8 },
        aGlyph: { buffer, format: "float32x4", stride: bytes, offset: 24 },
        aRun: { buffer, format: "float32x4", stride: bytes, offset: 40 },
        aColor: { buffer, format: "float32x4", stride: bytes, offset: 56 },
      },
      indexBuffer: quadIndices(this.glyphs),
    });
    const table = new Float32Array(ENTRIES * 4);
    for (let t = 0; t < this.tables.length; t++) {
      const entries = this.tables[t];
      for (let i = 0; i < entries.length; i += 3) {
        const at = (this.starts[t] + i / 3) * 4;
        table[at] = entries[i];
        table[at + 1] = entries[i + 1];
        table[at + 2] = entries[i + 2];
      }
    }

    return new SaffronText(
      geometry,
      this.view,
      new Float32Array([this.grid, this.thickness, this.sharpness, 0]),
      table,
    );
  }
}

/**
 * A text's glyphs drawn with advanced anti-aliasing: a mesh of their
 * quads under its own shader, one draw. It destroys its geometry and its
 * shader with itself, and leaves the segments' texture, which every one
 * shares.
 */
export class SaffronText extends Mesh<Geometry, Shader> {
  private readonly uniforms: UniformGroup;
  private flash: ColorTransform | null = null;

  constructor(geometry: Geometry, view: SaffronView, mode: Float32Array, table: Float32Array) {
    program ??= new GlProgram({ vertex, fragment, name: "flash-saffron" });
    const uniforms = new UniformGroup({
      uMode: { value: mode, type: "vec4<f32>" },
      uMul: { value: new Float32Array([1, 1, 1, 1]), type: "vec4<f32>" },
      uAdd: { value: new Float32Array(4), type: "vec4<f32>" },
      uTable: { value: table, type: "vec4<f32>", size: ENTRIES },
    });
    const shader = new Shader({
      glProgram: program,
      resources: { uSegments: segments(), saffronView: view.uniforms, saffronText: uniforms },
    });
    super({ geometry, shader });
    this.uniforms = uniforms;
  }

  /** The Flash colour transform it draws under, in place of Pixi's colour (render/color.ts). */
  get flashColor(): ColorTransform | null {
    return this.flash;
  }

  set flashColor(ct: ColorTransform | null) {
    this.flash = ct;
    const { uMode, uMul, uAdd } = this.uniforms.uniforms as Record<string, Float32Array>;
    uMode[3] = ct ? 1 : 0;
    if (ct) {
      uMul.set([ct.rMul, ct.gMul, ct.bMul, ct.aMul]);
      uAdd.set([ct.rAdd / 255, ct.gAdd / 255, ct.bAdd / 255, ct.aAdd / 255]);
    }

    this.uniforms.update();
  }

  override destroy(): void {
    const geometry = this.geometry;
    const shader = this.shader as Shader;
    super.destroy();
    // Its buffers too: the renderer holds a buffer, and its data, till the buffer goes.
    geometry.destroy(true);
    shader.destroy();
  }
}
