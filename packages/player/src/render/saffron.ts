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
  type Renderer,
  RendererType,
  Shader,
  UniformGroup,
  type WebGLRenderer,
} from "pixi.js";
import { CURVE, LINE, MOVE, shapeLayers } from "../display/shapes.js";
import type { CsmTable } from "../text/csm.js";

/** Most table entries a text's uniforms hold. */
const ENTRIES = 48;

/**
 * Chords a curve is cut into stray from it by this fraction of the em at
 * most: a 2048th, a hundredth of a pixel at 20 pixels, and few chords.
 */
const TOLERANCE = 2048;

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
  float across = max(abs(linear[0][1]), abs(linear[1][0]));
  if (across > max(abs(linear[0][0]), abs(linear[1][1])) / 65536.0) {
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
/** The most segments kept: 16 bytes each, 16 MB. Past it the store starts again. */
export const MOST = ROW * 1024;
/**
 * The most segments a glyph may have: every pixel of its quad goes through
 * them all, so a glyph past this is drawn as normal text is.
 */
export const GLYPH_MOST = 2048;
/**
 * The most a field may ask of the shader, its glyphs' segments times the
 * pixels of their quads: past it, the field is drawn as normal text, so
 * that no SWF has the GPU go through millions of segments a pixel.
 */
export const FIELD_BUDGET = 2 ** 25;

/**
 * The glyphs' outlines as segments, x0 y0 x1 y1 a texel, in the font's
 * units over 20 (as shapeLayers reads them), each glyph's a run of its
 * own: added as a glyph is first drawn, kept until the store is full, when
 * it starts again and the texts drawn from it are drawn again, or until the
 * last view that draws them goes.
 */
let data = new Float32Array(ROW * 4 * 16);
let used = 0;
let source: BufferImageSource | null = null;
/** Bumped as the store starts again, grows or goes: each renderer then uploads it whole. */
let epoch = 0;
/** Each renderer's upload of the store: of which epoch, and how many segments of it. */
const uploads = new WeakMap<Renderer, { epoch: number; segments: number }>();

/** A glyph's run of segments and its outline's bounds, in the font's units over 20. */
export interface Outline {
  start: number;
  count: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** What a glyph of more segments than GLYPH_MOST is known by, so that it is not cut again. */
const TOO_MANY: Outline = { start: 0, count: 0, xMin: 0, yMin: 0, xMax: 0, yMax: 0 };

/** Each glyph's outline in the store as it now is; null for an empty one. */
let outlines = new WeakMap<Glyph, Outline | null>();

/** The texts drawn from the store, each with what draws it again. */
const live = new Map<SaffronText, () => void>();

/** The segments' texture, made on first use; its contents go up as renderers draw (uploadSegments). */
function segments(): BufferImageSource {
  source ??= new BufferImageSource({
    resource: data,
    width: ROW,
    height: data.length / 4 / ROW,
    format: "rgba32float",
    scaleMode: "nearest",
    alphaMode: "no-premultiply-alpha",
    autoGenerateMipmaps: false,
  });
  return source;
}

/**
 * Upload what `renderer` has not of the store: the rows added since it last
 * did, or the whole after the store started again or grew. A view calls it
 * after it syncs, before it draws.
 */
export function uploadSegments(renderer: Renderer): void {
  if (!source || renderer.type !== RendererType.WEBGL) {
    return;
  }

  let upload = uploads.get(renderer);
  if (!upload) {
    // Its first bind uploads the texture whole.
    upload = { epoch, segments: used };
    uploads.set(renderer, upload);
    return;
  }

  const from = upload.epoch === epoch ? upload.segments : 0;
  if (from >= used) {
    return;
  }

  const gl = (renderer as WebGLRenderer).gl;
  const first = Math.floor(from / ROW);
  const rows = Math.ceil(used / ROW) - first;
  (renderer as WebGLRenderer).texture.bindForUpload(source);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, first, ROW, rows, gl.RGBA, gl.FLOAT, data, first * ROW * 4);
  upload.epoch = epoch;
  upload.segments = used;
}

/**
 * Start the store again: every outline is cut again on its next draw, and
 * every text drawn from the store hidden till it is drawn again.
 */
export function resetSegments(): void {
  used = 0;
  epoch++;
  outlines = new WeakMap();
  for (const [text, again] of live) {
    text.visible = false;
    again();
  }

  live.clear();
}

/** How many segments the store holds, for tests. */
export function segmentsUsed(): number {
  return used;
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
    if (source) {
      source.resource = data;
      source.resize(ROW, length / 4 / ROW, 1);
    }

    epoch++;
  }

  return true;
}

/**
 * A glyph's outline cut into segments, its curves into chords that stray
 * from them by `tolerance` at most, as x0 y0 x1 y1 each.
 */
export function chordsOf(glyph: Glyph, tolerance: number): number[] {
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
      switch (path[i]) {
        case MOVE:
          if (x !== startX || y !== startY) {
            points.push(x, y, startX, startY);
          }

          x = startX = path[i + 1];
          y = startY = path[i + 2];
          i += 3;
          break;
        case LINE:
          points.push(x, y, path[i + 1], path[i + 2]);
          x = path[i + 1];
          y = path[i + 2];
          i += 3;
          break;
        case CURVE: {
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
          break;
        }
        default:
          // A cubic, which no glyph has.
          i += 7;
      }
    }

    if (x !== startX || y !== startY) {
      points.push(x, y, startX, startY);
    }
  }

  return points;
}

/**
 * A glyph's outline in the store, cut on its first draw: null for an empty
 * glyph, undefined for one of more segments than GLYPH_MOST or past the
 * store's room.
 */
function outlineOf(glyph: Glyph, tolerance: number): Outline | null | undefined {
  const known = outlines.get(glyph);
  if (known !== undefined) {
    return known === TOO_MANY ? undefined : known;
  }

  const points = chordsOf(glyph, tolerance);
  const count = points.length / 4;
  if (count === 0) {
    outlines.set(glyph, null);
    return null;
  }

  if (count > GLYPH_MOST) {
    outlines.set(glyph, TOO_MANY);
    return undefined;
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
  outlines.set(glyph, outline);
  return outline;
}

/** The views that draw on the stage, by which the store is kept: it goes with the last. */
let views = 0;
const viewsGone = new FinalizationRegistry<null>(() => {
  views--;
  if (views === 0) {
    resetSegments();
    source?.destroy();
    source = null;
    data = new Float32Array(ROW * 4 * 16);
  }
});

/**
 * What every advanced text a view draws shares: Flash's pixels to a unit
 * of its world, and whether its renderer draws them at all (WebGL 2, as
 * the shader is GLSL ES 3.0; elsewhere text is drawn as normal text).
 */
export class SaffronView {
  readonly uniforms = new UniformGroup({
    uView: { value: new Float32Array([1, 0, 0, 0]), type: "vec4<f32>" },
  });
  readonly enabled: boolean;

  constructor(renderer: Renderer, keeps: boolean) {
    this.enabled =
      renderer.type === RendererType.WEBGL &&
      (renderer as WebGLRenderer).context?.webGLVersion === 2;
    if (keeps) {
      views++;
      viewsGone.register(this, null);
    }
  }

  get unit(): number {
    return (this.uniforms.uniforms.uView as Float32Array)[0];
  }

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

/** The finite value of `v`, 0 for NaN or an infinity, as a field's settings reach the shader. */
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/** The table's furthest cutoff from the outline, in pixels. */
function reachOf(table: CsmTable): number {
  let reach = 0;
  for (let i = 0; i < table.length; i += 3) {
    reach = Math.max(reach, Math.abs(table[i + 1]), Math.abs(table[i + 2]));
  }

  return reach;
}

/**
 * The glyphs of a text drawn with advanced anti-aliasing: each glyph first
 * reserved (reserve), which cuts its outline and counts what it asks of
 * the shader, then, if all fit, added (add) and made into one mesh
 * (done). One builds at a time: they share the vertices they write.
 */
export class SaffronBuilder {
  private glyphs = 0;
  private readonly tables: CsmTable[] = [];
  private readonly starts: number[] = [];
  private entries = 0;
  private cost = 0;
  private readonly thickness: number;
  private readonly sharpness: number;
  /** The epoch the reserved glyphs' outlines are of. */
  private reserved = epoch;

  constructor(
    private readonly view: SaffronView,
    /** 0 none, 1 pixel, 2 subpixel. */
    private readonly grid: number,
    thickness: number,
    sharpness: number,
    /** Flash's pixels to a pixel of the text, as it is placed now, for the quads' reach and cost. */
    private readonly scale: number,
    /** Draws the text again, when the store it is drawn from starts again. */
    private readonly again: () => void,
  ) {
    this.thickness = finite(thickness);
    this.sharpness = finite(sharpness);
  }

  /** Flash's pixels the shader may reach past the outline, at `size` pixels to the em, by `tables`. */
  private reach(size: number, tables: readonly [CsmTable, CsmTable]): number {
    const ppem = size * this.scale;
    const moved = 0.0001 * ppem * (Math.abs(this.thickness) + Math.abs(this.sharpness) / 2);
    // And a pixel round, and two for the pen's snapping.
    return Math.max(reachOf(tables[0]), reachOf(tables[1])) + moved + 3;
  }

  /**
   * Cut a glyph of a font of `em` units and count it at `size` pixels to the
   * em: false where the text cannot be drawn so, a glyph past GLYPH_MOST
   * or the field past FIELD_BUDGET, for the whole text to be drawn as
   * normal text. The store may start again here: reserving every glyph
   * then goes again (reserveAll).
   */
  reserve(glyph: Glyph, em: number, size: number, tables: readonly [CsmTable, CsmTable]): boolean {
    const units = em / 20;
    let outline = outlineOf(glyph, units / TOLERANCE);
    if (outline === undefined && outlines.get(glyph) !== TOO_MANY) {
      resetSegments();
      outline = outlineOf(glyph, units / TOLERANCE);
    }

    if (outline === undefined) {
      return false;
    }

    if (outline === null) {
      return true;
    }

    const s = (size / units) * this.scale;
    const margin = 2 * this.reach(size, tables);
    const area =
      ((outline.xMax - outline.xMin) * s + margin) * ((outline.yMax - outline.yMin) * s + margin);
    this.cost += outline.count * area;
    return this.cost <= FIELD_BUDGET;
  }

  /**
   * Whether every glyph reserved since restart is still in the store as it
   * was: false where the store started again while they were reserved.
   */
  intact(): boolean {
    return this.reserved === epoch;
  }

  /** Reserve afresh, the store's epoch now. */
  restart(): void {
    this.cost = 0;
    this.reserved = epoch;
  }

  /**
   * Add a reserved glyph, its pen at (x, y) in the text's pixels, `size`
   * pixels to the em, in 0xRRGGBB and `alpha`, by the light or the dark of
   * `tables` as its colour is drawn: false where the tables' room is full,
   * which leaves the text to be drawn as normal text.
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
    const units = em / 20;
    const outline = outlineOf(glyph, units / TOLERANCE);
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
    // Where the quad reaches in the text's pixels, for Pixi's bounds (filters, culling): the
    // shader moves it out by the cutoffs from where the pen snaps.
    const out = this.reach(size, tables) / Math.max(this.scale, 1 / 64);
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    let at = this.glyphs * 4 * STRIDE;
    for (let k = 0; k < 8; k += 2) {
      const sx = CORNERS[k];
      const sy = CORNERS[k + 1];
      const gx = sx < 0 ? outline.xMin : outline.xMax;
      const gy = sy < 0 ? outline.yMin : outline.yMax;
      scratch[at] = x + gx * scale + sx * out;
      scratch[at + 1] = y + gy * scale + sy * out;
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
  code(table: CsmTable): number {
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

    const text = new SaffronText(
      geometry,
      this.view,
      new Float32Array([this.grid, this.thickness, this.sharpness, 0]),
      table,
    );
    live.set(text, this.again);
    return text;
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
    live.delete(this);
    super.destroy();
    // Its buffers too: the renderer holds a buffer, and its data, till the buffer goes.
    geometry.destroy(true);
    shader.destroy();
  }
}
