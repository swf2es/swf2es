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
import type { ColorTransform } from "@swf2es/format";
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
import {
  type BuiltQuads,
  ENTRIES,
  GlyphQuads,
  holdSegments,
  onSegmentsReset,
  quadIndices,
  ROW,
  STRIDE,
  store,
} from "../text/saffron.js";

export {
  chordsOf,
  FIELD_BUDGET,
  GLYPH_MOST,
  MOST,
  resetSegments,
  segmentsUsed,
} from "../text/saffron.js";

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
  float det = determinant(toPixel);
  mat2 inverse = det != 0.0
    ? mat2(toPixel[1][1], -toPixel[0][1], -toPixel[1][0], toPixel[0][0]) / det
    : mat2(0.0);
  // Expand in glyph space so the margin stays outside under reflections and rotations.
  // Each inverse row gives the glyph units needed for a pixel perpendicular to that edge.
  vec2 reach = vec2(length(vec2(inverse[0][0], inverse[1][0])),
                    length(vec2(inverse[0][1], inverse[1][1]))) * margin;
  vec2 p = pen + toPixel * (aGlyph.xy + aGlyph.zw * reach);
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

/** The store's texture, made on first use; its contents go up as renderers draw (uploadSegments). */
let source: BufferImageSource | null = null;
/** Each renderer's upload of the store: of which epoch, and how many segments of it. */
const uploads = new WeakMap<Renderer, { epoch: number; segments: number }>();

/** The texts drawn from the store, each with what draws it again. */
const live = new Map<SaffronText, () => void>();

// As the store starts again, every text drawn from it is hidden till it is drawn again.
onSegmentsReset(() => {
  for (const [text, again] of live) {
    text.visible = false;
    again();
  }

  live.clear();
});

/** The segments' texture, made on first use, of the store's array as it now is. */
function segments(): BufferImageSource {
  const data = store.data;
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
  } else if (source.resource !== data) {
    // The store grew: its epoch moved on too, so each renderer uploads it whole.
    source.resource = data;
    source.resize(ROW, data.length / 4 / ROW, 1);
  }

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

  const texture = segments();
  const { data, used, epoch } = store;
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
  (renderer as WebGLRenderer).texture.bindForUpload(texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, first, ROW, rows, gl.RGBA, gl.FLOAT, data, first * ROW * 4);
  upload.epoch = epoch;
  upload.segments = used;
}

/** The views that draw on the stage, by which the store is kept (holdSegments): its texture goes with the last. */
let views = 0;
const viewsGone = new FinalizationRegistry<() => void>((release) => {
  release();
  views--;
  if (views === 0) {
    source?.destroy();
    source = null;
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
      viewsGone.register(this, holdSegments());
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

/**
 * The glyphs of a text drawn with advanced anti-aliasing (GlyphQuads), made
 * into one mesh of the Pixi view's (done), drawn `again` as the store
 * starts again.
 */
export class SaffronBuilder extends GlyphQuads {
  constructor(
    private readonly view: SaffronView,
    grid: number,
    thickness: number,
    sharpness: number,
    scale: number,
    private readonly again: () => void,
  ) {
    super(grid, thickness, sharpness, scale);
  }

  /** The mesh of the glyphs added, null for none. */
  done(): SaffronText | null {
    const built = this.built();
    if (!built) {
      return null;
    }

    const text = saffronText(built, this.view);
    live.set(text, this.again);
    return text;
  }
}

/** `built`'s quads as a mesh under the view's uniforms. */
function saffronText(built: BuiltQuads, view: SaffronView): SaffronText {
  const buffer = new Buffer({
    data: built.vertices,
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
    indexBuffer: quadIndices(built.glyphs),
  });
  return new SaffronText(geometry, view, built.mode, built.table);
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
