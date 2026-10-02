// A display object's filters drawn as adl draws them (docs/architecture.md,
// "Filters"): a blur is a box blurX by blurY wide, its ends' pixels
// weighted by how much of them it covers, run `quality` times each way,
// each run truncated to 8 bits; a glow and a shadow are the object's alpha
// so blurred, times strength and alpha, in their colour, behind or inside
// it; a colour matrix maps each pixel's straight colour, transparent ones
// too; a convolution sums its taps' straight colour over the object's
// pixels and one more right and down, as BitmapData.applyFilter does. WebGL
// alone: each pass is a filter of its own.
import {
  Filter,
  type FilterSystem,
  GlProgram,
  Texture as PixiTexture,
  type RenderSurface,
  type Texture,
  TexturePool,
} from "pixi.js";
import { integerKernel } from "./bitmap-filters.js";
import type { Filter as FilterRecord } from "./filters.js";

const VERTEX = `in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}`;

/** Truncated to 8 bits, as adl's each pass is: a hair over, so that an exact value stays. */
const TRUNCATE = "floor(c * 255.0 + 0.001) / 255.0";

/**
 * One run of the box one way: `uWidth` texels wide, its end texels weighted
 * by their part; `uDirection` a texel's step in the input's pixels, which
 * uInputSize gives the coordinates in.
 */
const BOX = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
// As the vertex shader has it, which is highp: a program's uniforms agree.
uniform highp vec4 uInputSize;
uniform vec2 uDirection;
uniform float uWidth;
void main(void) {
  float half_ = uWidth * 0.5;
  int reach = int(ceil(half_));
  vec4 sum = vec4(0.0);
  // As far as 255 pixels at 4 texels a pixel, each way.
  for (int i = 0; i <= 2040; i++) {
    if (i > 2 * reach) { break; }
    float f = float(i - reach);
    float weight = max(0.0, min(f + 0.5, half_) - max(f - 0.5, -half_));
    sum += texture(uTexture, vTextureCoord + uDirection * uInputSize.zw * f) * weight;
  }
  vec4 c = sum / uWidth;
  finalColor = ${TRUNCATE};
}`;

class BoxPass extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: BOX, name: "flash-box-blur" }),
      resources: {
        boxUniforms: {
          uDirection: { value: new Float32Array([1, 0]), type: "vec2<f32>" },
          uWidth: { value: 1, type: "f32" },
        },
      },
    });
  }

  set(dx: number, dy: number, width: number): void {
    const u = this.resources.boxUniforms.uniforms;
    u.uDirection[0] = dx;
    u.uDirection[1] = dy;
    u.uWidth = width;
  }
}

/** The box's runs over `input` into `output`, through a texture of the pool between them. */
function blur(
  system: FilterSystem,
  pass: BoxPass,
  input: Texture,
  output: RenderSurface,
  blurX: number,
  blurY: number,
  quality: number,
  resolution: number,
  clear: boolean,
): void {
  const runs: [number, number, number][] = [];
  for (let i = 0; i < quality; i++) {
    if (blurX > 1) {
      runs.push([1 / resolution, 0, blurX * resolution]);
    }

    if (blurY > 1) {
      runs.push([0, 1 / resolution, blurY * resolution]);
    }
  }

  if (runs.length === 0) {
    pass.set(1, 0, 1);
    system.applyFilter(pass, input, output, clear);
    return;
  }

  const temps = [TexturePool.getSameSizeTexture(input), TexturePool.getSameSizeTexture(input)];
  let from = input;
  for (const [k, [dx, dy, width]] of runs.entries()) {
    pass.set(dx, dy, width);
    const last = k === runs.length - 1;
    const to = last ? output : temps[k % 2];
    system.applyFilter(pass, from, to, last ? clear : true);
    from = to as Texture;
  }

  for (const t of temps) {
    TexturePool.returnTexture(t);
  }
}

/** A filter run at the target's resolution, which the blur's width is in texels of. */
abstract class FlashFilter extends Filter {
  /** The texels to a pixel this run: the input's, made at the target's resolution. */
  protected texels(input: Texture): number {
    return input.source.resolution;
  }
}

class BlurFilter extends FlashFilter {
  private readonly pass = new BoxPass();

  /** Its box's pass too, a filter of its own. */
  destroy(): void {
    this.pass.destroy();
    super.destroy();
  }

  constructor(private readonly f: FilterRecord) {
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: BOX, name: "flash-blur" }),
      resources: {},
    });
    this.padding = Math.ceil((f.quality * Math.max(f.blurX, f.blurY)) / 2);
  }

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const f = this.f;
    blur(
      system,
      this.pass,
      input,
      output,
      f.blurX || 0,
      f.blurY || 0,
      f.quality,
      this.texels(input),
      clear,
    );
  }
}

/**
 * A glow or a shadow: the input's blurred alpha (uBlurred), from `uOffset`
 * texels back for a shadow, times strength and alpha, in its colour; behind
 * the object, or inside it for an inner one; the object kept, or not.
 */
const GLOW = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBlurred;
uniform highp vec4 uInputSize;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uStrength;
uniform vec2 uOffset;
uniform float uInner;
uniform float uKnockout;
uniform float uHide;
void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  float a = texture(uBlurred, vTextureCoord - uOffset * uInputSize.zw).a;
  vec4 c;
  if (uInner > 0.5) {
    float g = clamp((1.0 - a) * uStrength, 0.0, 1.0) * uAlpha * src.a;
    vec4 glow = vec4(uColor * g, g);
    c = uKnockout > 0.5 ? glow : glow + src * (1.0 - g);
  } else {
    float g = clamp(a * uStrength, 0.0, 1.0) * uAlpha;
    vec4 glow = vec4(uColor * g, g);
    c = uKnockout > 0.5 ? glow * (1.0 - src.a) : uHide > 0.5 ? glow : src + glow * (1.0 - src.a);
  }
  finalColor = ${TRUNCATE};
}`;

class GlowFilter extends FlashFilter {
  private readonly pass = new BoxPass();

  /** Its box's pass too, a filter of its own. */
  destroy(): void {
    this.pass.destroy();
    super.destroy();
  }

  constructor(private readonly f: FilterRecord) {
    const shadow = f.kind === "dropShadow";
    const radians = ((f.angle || 0) * Math.PI) / 180;
    const distance = shadow ? f.distance || 0 : 0;
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: GLOW, name: "flash-glow" }),
      resources: {
        glowUniforms: {
          uColor: {
            value: new Float32Array([
              ((f.color >> 16) & 0xff) / 255,
              ((f.color >> 8) & 0xff) / 255,
              (f.color & 0xff) / 255,
            ]),
            type: "vec3<f32>",
          },
          uAlpha: { value: f.alpha, type: "f32" },
          uStrength: { value: f.strength, type: "f32" },
          uOffset: {
            value: new Float32Array([distance * Math.cos(radians), distance * Math.sin(radians)]),
            type: "vec2<f32>",
          },
          uInner: { value: f.inner ? 1 : 0, type: "f32" },
          uKnockout: { value: f.knockout ? 1 : 0, type: "f32" },
          uHide: { value: shadow && f.hideObject ? 1 : 0, type: "f32" },
        },
        uBlurred: PixiTexture.WHITE.source,
      },
    });
    this.padding = Math.ceil((f.quality * Math.max(f.blurX, f.blurY)) / 2 + Math.abs(distance));
  }

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const f = this.f;
    const resolution = this.texels(input);
    const offset = this.resources.glowUniforms.uniforms.uOffset as Float32Array;
    const radians = ((f.angle || 0) * Math.PI) / 180;
    const distance = f.kind === "dropShadow" ? f.distance || 0 : 0;
    // In the input's pixels, as its coordinates are.
    offset[0] = distance * Math.cos(radians);
    offset[1] = distance * Math.sin(radians);
    const blurred = TexturePool.getSameSizeTexture(input);
    blur(
      system,
      this.pass,
      input,
      blurred,
      f.blurX || 0,
      f.blurY || 0,
      f.quality,
      resolution,
      true,
    );
    this.resources.uBlurred = blurred.source;
    system.applyFilter(this, input, output, clear);
    TexturePool.returnTexture(blurred);
  }
}

/** A colour matrix of a pixel's straight colour, its offsets in 255ths, transparent pixels too. */
const MATRIX = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform mat4 uMatrix;
uniform vec4 uOffset;
void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  vec4 straight = src.a > 0.0 ? vec4(src.rgb / src.a, src.a) : vec4(0.0);
  vec4 s = clamp(uMatrix * straight + uOffset, 0.0, 1.0);
  vec4 c = vec4(s.rgb * s.a, s.a);
  finalColor = ${TRUNCATE};
}`;

class ColorMatrixFilter extends FlashFilter {
  constructor(f: FilterRecord) {
    const m = f.matrix;
    // Column-major for GLSL: column j is input channel j's part of each output.
    const matrix = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        matrix[col * 4 + row] = m[row * 5 + col] || 0;
      }
    }

    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: MATRIX, name: "flash-color-matrix" }),
      resources: {
        matrixUniforms: {
          uMatrix: { value: matrix, type: "mat4x4<f32>" },
          uOffset: {
            value: new Float32Array([0, 1, 2, 3].map((row) => (m[row * 5 + 4] || 0) / 255)),
            type: "vec4<f32>",
          },
        },
      },
    });
  }
}

/**
 * A convolution, in 255ths: the taps' straight colour over uBox, the
 * object's pixels as adl filters them, in the input's pixels from its
 * frame's corner; past it the nearest edge's or uEdge; summed, divided,
 * biased, clamped and premultiplied as bitmap-filters' convolve does, the
 * fixed-point way too (uReciprocal not 0) where every tap lies in the box.
 */
const CONVOLUTION = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uMatrix[57];
uniform vec2 uSize;
uniform vec4 uBox;
uniform vec4 uEdge;
uniform float uDivisor;
uniform float uReciprocal;
uniform float uBias;
uniform float uClamp;
uniform float uPreserve;
vec4 straight(vec2 p) {
  if (any(lessThan(p, uBox.xy)) || any(greaterThanEqual(p, uBox.zw))) {
    if (uClamp < 0.5) { return uEdge; }
    p = clamp(p, floor(uBox.xy) + 0.5, floor(uBox.zw) - 0.5);
  }
  vec4 c = texture(uTexture, p * uInputSize.zw);
  return c.a > 0.0 ? floor(vec4(c.rgb / c.a, c.a) * 255.0 + 0.5) : vec4(0.0);
}
void main(void) {
  // The pixel's centre, which all its texels read alike, as adl's one pixel.
  vec2 p = floor(vTextureCoord * uInputSize.xy) + 0.5;
  vec2 reach = floor(uSize * 0.5);
  if (any(lessThan(p, uBox.xy - reach)) || any(greaterThanEqual(p, uBox.zw + reach))) {
    finalColor = vec4(0.0);
    return;
  }
  bool fixed_ = uReciprocal != 0.0 && all(greaterThanEqual(p - 1.0, uBox.xy)) &&
    all(lessThan(p + 1.0, uBox.zw));
  int cols = int(uSize.x);
  int count = cols * int(uSize.y);
  vec4 sum = vec4(0.0);
  // One loop, its index alone indexing the weights, as GLSL ES 1 allows.
  for (int k = 0; k < 225; k++) {
    if (k >= count) { break; }
    float w = dot(uMatrix[k / 4], vec4(equal(vec4(float(k - k / 4 * 4)), vec4(0.0, 1.0, 2.0, 3.0))));
    if (w != 0.0) {
      int j = k / cols;
      vec2 at = vec2(float(k - j * cols), float(j)) - reach;
      sum += straight(fixed_ && k == 8 ? p : p + at) * w;
    }
  }
  sum = fixed_ ? floor(sum * uReciprocal) : sum / uDivisor;
  vec4 v = floor(clamp(sum + uBias, 0.0, 255.0) + 0.0001);
  float a = uPreserve > 0.5 ? straight(p).a : v.a;
  vec3 c = fixed_ ? floor(v.rgb * a / 255.0) : floor((v.rgb * a + 127.0) / 255.0);
  finalColor = vec4(c, a) / 255.0;
}`;

class ConvolutionFilter extends FlashFilter {
  /** How far in from the input's frame the object's pixels start: this and the later filters' padding. */
  inset = 0;

  constructor(f: FilterRecord) {
    const matrix = new Float32Array(57 * 4);
    const count = f.matrixX * f.matrixY;
    for (let k = 0; k < count; k++) {
      matrix[k] = f.matrix[k] || 0;
    }

    const divisor = f.divisor || 1;
    const reciprocal = integerKernel(Array.from(matrix.subarray(0, count)), divisor);
    super({
      glProgram: GlProgram.from({
        vertex: VERTEX,
        fragment: CONVOLUTION,
        name: "flash-convolution",
      }),
      resources: {
        convolutionUniforms: {
          uMatrix: { value: matrix, type: "vec4<f32>", size: 57 },
          uSize: { value: new Float32Array([f.matrixX, f.matrixY]), type: "vec2<f32>" },
          uBox: { value: new Float32Array(4), type: "vec4<f32>" },
          uEdge: {
            value: new Float32Array([
              (f.color >> 16) & 0xff,
              (f.color >> 8) & 0xff,
              f.color & 0xff,
              Math.floor(f.alpha * 255),
            ]),
            type: "vec4<f32>",
          },
          uDivisor: { value: divisor, type: "f32" },
          uReciprocal: { value: reciprocal === null ? 0 : reciprocal / 65536, type: "f32" },
          uBias: { value: f.bias || 0, type: "f32" },
          uClamp: { value: f.clamp ? 1 : 0, type: "f32" },
          uPreserve: { value: f.preserveAlpha ? 1 : 0, type: "f32" },
        },
      },
    });
    // Its reach, and the pixel right and down adl's bitmap of the object has.
    this.padding = Math.max(f.matrixX >> 1, f.matrixY >> 1) + 1;
  }

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const box = this.resources.convolutionUniforms.uniforms.uBox as Float32Array;
    box[0] = this.inset;
    box[1] = this.inset;
    box[2] = input.frame.width - this.inset + 1;
    box[3] = input.frame.height - this.inset + 1;
    system.applyFilter(this, input, output, clear);
  }
}

/** The Pixi filters a display object's filter records draw as: those swf2es draws yet, in their order. */
export function displayFilters(records: readonly FilterRecord[]): Filter[] {
  const out: Filter[] = [];
  for (const f of records) {
    let filter: FlashFilter | null = null;
    if (f.kind === "blur") {
      filter = new BlurFilter(f);
    } else if (f.kind === "glow" || f.kind === "dropShadow") {
      filter = new GlowFilter(f);
    } else if (f.kind === "colorMatrix") {
      filter = new ColorMatrixFilter(f);
    } else if (f.kind === "convolution") {
      filter = new ConvolutionFilter(f);
    }

    if (filter) {
      filter.resolution = "inherit";
      out.push(filter);
    }
  }

  let inset = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    inset += out[i].padding;
    const filter = out[i];
    if (filter instanceof ConvolutionFilter) {
      filter.inset = inset;
    }
  }

  return out;
}
