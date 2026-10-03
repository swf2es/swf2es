// A display object's filters drawn as adl draws them (docs/architecture.md,
// "Filters"): a blur is a box blurX by blurY wide, its ends' pixels
// weighted by how much of them it covers, run `quality` times each way,
// each run truncated to 8 bits; a glow and a shadow are the object's alpha
// so blurred, times strength and alpha, in their colour, behind or inside
// it; a colour matrix maps each pixel's straight colour, transparent ones
// too; a bevel is the object's alpha so blurred, read on and back by its
// offset, their difference in its highlight or shadow colour; a convolution
// sums its taps' straight colour over the object's pixels and one more
// right and down, as BitmapData.applyFilter does. WebGL
// alone: each pass is a filter of its own.
import {
  BufferImageSource,
  type Container,
  Filter,
  type FilterSystem,
  GlProgram,
  Texture as PixiTexture,
  type RenderSurface,
  type Texture,
  TexturePool,
} from "pixi.js";
import { filterRect, gradientTable, integerKernel } from "./bitmap-filters.js";
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

/**
 * A pool's texture let go of once drawn with: the pool destroys idle ones
 * as the screen's size changes, which Pixi warns of while a shader holds them.
 */
function unbind(filter: Filter, name: string): void {
  filter.resources[name] = PixiTexture.WHITE.source;
}

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
    unbind(this, "uBlurred");
    TexturePool.returnTexture(blurred);
  }
}

/**
 * A bevel: the input's blurred alpha (uBlurred) from uOffset texels on and
 * back; their difference times strength, clamped, times the colour's alpha,
 * the highlight where on is more and the shadow where it is less. Inner
 * (uType 0) atop the object, outer (1) behind it, full (2) over it;
 * knocked out, alone, masked to where the object is (inner) or is not
 * (outer).
 */
const BEVEL = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBlurred;
uniform highp vec4 uInputSize;
uniform vec3 uHighlight;
uniform vec3 uShadow;
uniform float uHighlightAlpha;
uniform float uShadowAlpha;
uniform float uStrength;
uniform vec2 uOffset;
uniform float uType;
uniform float uKnockout;
void main(void) {
  // The pixel's centre, which all its texels read alike, as adl's one pixel.
  vec2 at = (floor(vTextureCoord * uInputSize.xy) + 0.5) * uInputSize.zw;
  vec4 src = texture(uTexture, at);
  vec2 step_ = uOffset * uInputSize.zw;
  // In 255ths, each read truncated, as adl's are.
  float on = floor(texture(uBlurred, at + step_).a * 255.0 + 0.001);
  float back = floor(texture(uBlurred, at - step_).a * 255.0 + 0.001);
  float d = on - back;
  bool lit = d > 0.0;
  float strong = min(255.0, floor(abs(d) * uStrength + 0.001));
  float la = floor(strong * (lit ? uHighlightAlpha : uShadowAlpha) + 0.5) / 255.0;
  float m = uType < 0.5 ? src.a : (uType < 1.5 && uKnockout > 0.5 ? 1.0 - src.a : 1.0);
  vec4 layer = vec4((lit ? uHighlight : uShadow) * la, la) * m;
  vec4 c;
  if (uKnockout > 0.5) {
    c = layer;
  } else if (uType > 0.5 && uType < 1.5) {
    c = src + layer * (1.0 - src.a);
  } else {
    c = layer + src * (1.0 - (uType < 0.5 ? la : layer.a));
  }
  finalColor = ${TRUNCATE};
}`;

class BevelFilter extends FlashFilter {
  private readonly pass = new BoxPass();

  /** Its box's pass too, a filter of its own. */
  destroy(): void {
    this.pass.destroy();
    super.destroy();
  }

  constructor(private readonly f: FilterRecord) {
    const rgb = (c: number) =>
      new Float32Array([((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255]);
    const radians = ((f.angle || 0) * Math.PI) / 180;
    const distance = f.distance || 0;
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: BEVEL, name: "flash-bevel" }),
      resources: {
        bevelUniforms: {
          uHighlight: { value: rgb(f.highlightColor), type: "vec3<f32>" },
          uShadow: { value: rgb(f.shadowColor), type: "vec3<f32>" },
          uHighlightAlpha: { value: f.highlightAlpha, type: "f32" },
          uShadowAlpha: { value: f.shadowAlpha, type: "f32" },
          uStrength: { value: f.strength, type: "f32" },
          uOffset: {
            value: new Float32Array([distance * Math.cos(radians), distance * Math.sin(radians)]),
            type: "vec2<f32>",
          },
          uType: { value: f.type === "inner" ? 0 : f.type === "outer" ? 1 : 2, type: "f32" },
          uKnockout: { value: f.knockout ? 1 : 0, type: "f32" },
        },
        uBlurred: PixiTexture.WHITE.source,
      },
    });
    this.padding = Math.ceil((f.quality * Math.max(f.blurX, f.blurY)) / 2 + Math.abs(distance));
  }

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const f = this.f;
    const blurred = TexturePool.getSameSizeTexture(input);
    blur(
      system,
      this.pass,
      input,
      blurred,
      f.blurX || 0,
      f.blurY || 0,
      f.quality,
      this.texels(input),
      true,
    );
    this.resources.uBlurred = blurred.source;
    system.applyFilter(this, input, output, clear);
    unbind(this, "uBlurred");
    TexturePool.returnTexture(blurred);
  }
}

/** Premultiplied ARGB as the RGBA bytes a texture holds, still premultiplied. */
export function rgbaOf(pixels: Uint32Array): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const j = i * 4;
    out[j] = (p >>> 16) & 0xff;
    out[j + 1] = (p >>> 8) & 0xff;
    out[j + 2] = p & 0xff;
    out[j + 3] = p >>> 24;
  }

  return out;
}

/**
 * How a bevel or a gradient filter places its layer (premultiplied) on the
 * object's pixel, as bitmap-filters' placer does: masked to where the
 * object is (uType 0, inner) or, knocked out, is not (1, outer); inner
 * atop it, outer behind it, full (2) over it, knocked out alone.
 */
const PLACE = `vec4 place(vec4 src, vec4 layer) {
  float m = uType < 0.5 ? src.a : (uType < 1.5 && uKnockout > 0.5 ? 1.0 - src.a : 1.0);
  vec4 masked = layer * m;
  if (uKnockout > 0.5) {
    return masked;
  }
  if (uType > 0.5 && uType < 1.5) {
    return src + masked * (1.0 - src.a);
  }
  return masked + src * (1.0 - (uType < 0.5 ? layer.a : masked.a));
}`;

/**
 * A gradient glow: the input's blurred alpha (uBlurred) from uOffset back,
 * as a shadow reads it, times strength, picking a texel of the gradient
 * (uGradient, 256 wide); a gradient bevel (uBevel 1): the difference of
 * that alpha on and back, the middle of the gradient where they agree.
 * Each pixel is evaluated once, at its centre, in 255ths truncated.
 */
const GRADIENT = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBlurred;
uniform sampler2D uGradient;
uniform highp vec4 uInputSize;
uniform float uStrength;
uniform vec2 uOffset;
uniform float uType;
uniform float uKnockout;
uniform float uBevel;
uniform vec4 uRegion;
${PLACE}
float alphaAt(vec2 at) {
  return floor(texture(uBlurred, at).a * 255.0 + 0.001);
}
void main(void) {
  vec2 p = floor(vTextureCoord * uInputSize.xy) + 0.5;
  // Past the filter's rect it draws nothing, though its gradient may have colour at 0.
  if (any(lessThan(p, uRegion.xy)) || any(greaterThanEqual(p, uRegion.zw))) {
    finalColor = vec4(0.0);
    return;
  }
  vec2 at = p * uInputSize.zw;
  vec4 src = texture(uTexture, at);
  vec2 step_ = uOffset * uInputSize.zw;
  float index;
  if (uBevel > 0.5) {
    float d = clamp(floor((alphaAt(at + step_) - alphaAt(at - step_)) * uStrength), -255.0, 255.0);
    index = floor((d + 256.0) / 2.0);
  } else {
    index = min(255.0, floor(alphaAt(at - step_) * uStrength + 0.001));
  }
  vec4 layer = texture(uGradient, vec2((index + 0.5) / 256.0, 0.5));
  vec4 c = place(src, layer);
  finalColor = ${TRUNCATE};
}`;

class GradientFilter extends FlashFilter {
  private readonly pass = new BoxPass();
  private readonly gradient: PixiTexture;

  /** Its box's pass and its gradient too. */
  destroy(): void {
    this.pass.destroy();
    this.gradient.destroy(true);
    super.destroy();
  }

  constructor(private readonly f: FilterRecord) {
    const radians = ((f.angle || 0) * Math.PI) / 180;
    const distance = f.distance || 0;
    const gradient = new PixiTexture({
      source: new BufferImageSource({
        resource: rgbaOf(gradientTable(f)),
        width: 256,
        height: 1,
        alphaMode: "premultiplied-alpha",
        scaleMode: "nearest",
        addressMode: "clamp-to-edge",
      }),
    });
    super({
      glProgram: GlProgram.from({
        vertex: VERTEX,
        fragment: GRADIENT,
        name: "flash-gradient-filter",
      }),
      resources: {
        gradientUniforms: {
          uStrength: { value: f.strength, type: "f32" },
          uOffset: {
            value: new Float32Array([distance * Math.cos(radians), distance * Math.sin(radians)]),
            type: "vec2<f32>",
          },
          uType: { value: f.type === "inner" ? 0 : f.type === "outer" ? 1 : 2, type: "f32" },
          uKnockout: { value: f.knockout ? 1 : 0, type: "f32" },
          uBevel: { value: f.kind === "gradientBevel" ? 1 : 0, type: "f32" },
          uRegion: { value: new Float32Array(4), type: "vec4<f32>" },
        },
        uBlurred: PixiTexture.WHITE.source,
        uGradient: gradient.source,
      },
    });
    this.gradient = gradient;
    // The rect's growth each way, as applyFilter's: left, top, right, bottom.
    const rect = filterRect({ x: 0, y: 0, width: 1, height: 1 }, f);
    this.grows = [-rect.x, -rect.y, rect.x + rect.width - 1, rect.y + rect.height - 1];
    this.padding = Math.max(...this.grows) + 1;
  }

  /** How far the filter's rect grows past the object, each way: left, top, right, bottom. */
  private readonly grows: number[];

  /** How far in from the input's frame the object's pixels start: this and the later filters' padding. */
  inset = 0;

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const f = this.f;
    const blurred = TexturePool.getSameSizeTexture(input);
    blur(
      system,
      this.pass,
      input,
      blurred,
      f.blurX || 0,
      f.blurY || 0,
      f.quality,
      this.texels(input),
      true,
    );
    this.resources.uBlurred = blurred.source;
    // The object's pixels and one more right and down, as adl's bitmap of it, grown by the rect.
    const region = this.resources.gradientUniforms.uniforms.uRegion as Float32Array;
    const [left, top, right, bottom] = this.grows;
    region[0] = this.inset - left;
    region[1] = this.inset - top;
    region[2] = input.frame.width - this.inset + 1 + right;
    region[3] = input.frame.height - this.inset + 1 + bottom;
    system.applyFilter(this, input, output, clear);
    unbind(this, "uBlurred");
    TexturePool.returnTexture(blurred);
  }
}

/**
 * A displacement map, in the input's pixels from its frame's corner: each
 * pixel of the object's (uBox) where the map lies (uMapAt, uMapSize) takes
 * the input at itself moved by the map's channel (uComponents picks one
 * for x, one for y) less 128, times scale, in 256ths toward 0, between
 * pixels with weights in 256ths; past the object's pixels as uMode says:
 * 0 wrap, 1 clamp, 2 its own place, 3 uColor, which also fills uGrow pixels
 * round the object, as adl's drawing of it does. Each pixel once, at its
 * centre.
 */
const DISPLACE = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uMap;
uniform highp vec4 uInputSize;
uniform vec4 uBox;
uniform vec4 uMapAt;
uniform vec4 uComponentX;
uniform vec4 uComponentY;
uniform vec2 uScale;
uniform float uMode;
uniform vec4 uColor;
uniform vec2 uGrow;
vec4 read(vec2 at, vec2 own) {
  vec2 size = uBox.zw - uBox.xy;
  vec2 i = at - uBox.xy;
  if (any(lessThan(i, vec2(0.0))) || any(greaterThanEqual(i, size))) {
    if (uMode < 0.5) {
      i = mod(i, size);
    } else if (uMode < 2.5) {
      i = clamp(i, vec2(0.0), size - 1.0);
    } else {
      return uColor;
    }
  }
  return texture(uTexture, (uBox.xy + i + 0.5) * uInputSize.zw);
}
void main(void) {
  vec2 p = floor(vTextureCoord * uInputSize.xy);
  vec4 own = texture(uTexture, (p + 0.5) * uInputSize.zw);
  vec2 m = p - uMapAt.xy;
  if (any(lessThan(p, uBox.xy)) || any(greaterThanEqual(p, uBox.zw))) {
    bool near = all(greaterThanEqual(p, uBox.xy - uGrow)) && all(lessThan(p, uBox.zw + uGrow));
    finalColor = uMode > 2.5 && near ? uColor : vec4(0.0);
    return;
  }
  if (any(lessThan(m, vec2(0.0))) || any(greaterThanEqual(m, uMapAt.zw))) {
    finalColor = own;
    return;
  }
  vec4 map = texture(uMap, (m + 0.5) / uMapAt.zw);
  vec4 straight = map.a > 0.0 ? vec4(map.rgb / map.a, map.a) : vec4(0.0);
  vec2 c = floor(vec2(dot(straight, uComponentX), dot(straight, uComponentY)) * 255.0 + 0.5);
  // None picked: no move.
  c = vec2(uComponentX == vec4(0.0) ? 128.0 : c.x, uComponentY == vec4(0.0) ? 128.0 : c.y);
  // Toward 0, without trunc, which GLSL ES 1 has not.
  vec2 moved = (c - 128.0) * uScale;
  vec2 q = p * 256.0 + sign(moved) * floor(abs(moved));
  vec2 whole = floor(q / 256.0);
  vec2 f = q - whole * 256.0;
  if (uMode > 1.5 && uMode < 2.5) {
    vec2 i = whole - uBox.xy;
    vec2 size = uBox.zw - uBox.xy;
    whole = vec2(i.x < 0.0 || i.x >= size.x ? p.x : whole.x, i.y < 0.0 || i.y >= size.y ? p.y : whole.y);
  }
  float w00 = floor((256.0 - f.x) * (256.0 - f.y) / 256.0);
  float w10 = floor(f.x * (256.0 - f.y) / 256.0);
  float w01 = floor((256.0 - f.x) * f.y / 256.0);
  float w11 = floor(f.x * f.y / 256.0);
  vec4 v = read(whole, p) * w00 + read(whole + vec2(1.0, 0.0), p) * w10 +
    read(whole + vec2(0.0, 1.0), p) * w01 + read(whole + vec2(1.0, 1.0), p) * w11;
  vec4 c8 = floor(v * 255.0 / 256.0 + 0.001) / 255.0;
  finalColor = c8;
}`;

class DisplacementFilter extends FlashFilter {
  /** How far in from the input's frame the object's pixels start: this and the later filters' padding. */
  inset = 0;

  constructor(
    private readonly f: FilterRecord,
    private readonly map: Texture,
  ) {
    const pick = (c: number) =>
      new Float32Array([c === 1 ? 1 : 0, c === 2 ? 1 : 0, c === 4 ? 1 : 0, c === 8 ? 1 : 0]);
    // Colour mode draws half the scale round the object, as adl does.
    const grow =
      f.mode === "color"
        ? [Math.floor(Math.abs(f.scaleX) / 2) || 0, Math.floor(Math.abs(f.scaleY) / 2) || 0]
        : [0, 0];
    const a = Math.floor(f.alpha * 255) / 255;
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: DISPLACE, name: "flash-displacement" }),
      resources: {
        displaceUniforms: {
          uBox: { value: new Float32Array(4), type: "vec4<f32>" },
          uMapAt: { value: new Float32Array(4), type: "vec4<f32>" },
          uComponentX: { value: pick(f.componentX), type: "vec4<f32>" },
          uComponentY: { value: pick(f.componentY), type: "vec4<f32>" },
          uScale: { value: new Float32Array([f.scaleX || 0, f.scaleY || 0]), type: "vec2<f32>" },
          uMode: {
            value: ["wrap", "clamp", "ignore", "color"].indexOf(f.mode),
            type: "f32",
          },
          uColor: {
            value: new Float32Array([
              (((f.color >> 16) & 0xff) / 255) * a,
              (((f.color >> 8) & 0xff) / 255) * a,
              ((f.color & 0xff) / 255) * a,
              a,
            ]),
            type: "vec4<f32>",
          },
          uGrow: { value: new Float32Array(grow), type: "vec2<f32>" },
        },
        uMap: PixiTexture.EMPTY.source,
      },
    });
    this.padding = Math.max(...grow) + 1;
  }

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const map = this.map;
    const u = this.resources.displaceUniforms.uniforms;
    const box = u.uBox as Float32Array;
    // The object's pixels and one more right and down, as adl's bitmap of it.
    box[0] = this.inset;
    box[1] = this.inset;
    box[2] = input.frame.width - this.inset + 1;
    box[3] = input.frame.height - this.inset + 1;
    const at = u.uMapAt as Float32Array;
    at[0] = this.inset + this.f.mapPoint[0];
    at[1] = this.inset + this.f.mapPoint[1];
    at[2] = map.width;
    at[3] = map.height;
    this.resources.uMap = map.source;
    system.applyFilter(this, input, output, clear);
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

/**
 * A convolution with no taps as adl draws it, a copy moved up and left by
 * the half of the other size: one tap there, of 1, the edges transparent.
 */
function emptyKernel(f: FilterRecord): FilterRecord {
  const hx = f.matrixX >> 1;
  const hy = f.matrixY >> 1;
  const matrixX = 2 * hx + 1;
  const matrixY = 2 * hy + 1;
  const matrix = new Array(matrixX * matrixY).fill(0);
  matrix[matrix.length - 1] = 1;
  return {
    ...f,
    matrixX,
    matrixY,
    matrix,
    divisor: 1,
    bias: 0,
    clamp: false,
    color: 0,
    alpha: 0,
    preserveAlpha: false,
  };
}

/** The texture of a displacement map's map, as its renderer holds it; null for none. */
export type MapTexture = (map: object) => Texture | null;

/** The Pixi filters a display object's filter records draw as: those swf2es draws yet, in their order. */
export function displayFilters(
  records: readonly FilterRecord[],
  mapTexture: MapTexture = () => null,
): Filter[] {
  const out: Filter[] = [];
  for (const f of records) {
    let filter: FlashFilter | null = null;
    if (f.kind === "blur") {
      filter = new BlurFilter(f);
    } else if (f.kind === "glow" || f.kind === "dropShadow") {
      filter = new GlowFilter(f);
    } else if (f.kind === "colorMatrix") {
      filter = new ColorMatrixFilter(f);
    } else if (f.kind === "bevel") {
      filter = new BevelFilter(f);
    } else if (f.kind === "gradientGlow" || f.kind === "gradientBevel") {
      filter = new GradientFilter(f);
    } else if (f.kind === "displacementMap") {
      // Its map, a copy the object took when its filters were set, as a
      // texture now, never in a pass; with none it leaves the object be.
      const map = f.mapSnapshot ?? f.mapBitmap;
      const texture = map ? mapTexture(map) : null;
      filter = texture ? new DisplacementFilter(f, texture) : null;
    } else if (f.kind === "convolution") {
      filter = new ConvolutionFilter(f.matrixX * f.matrixY > 0 ? f : emptyKernel(f));
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
    if (
      filter instanceof ConvolutionFilter ||
      filter instanceof GradientFilter ||
      filter instanceof DisplacementFilter
    ) {
      filter.inset = inset;
    }
  }

  return out;
}

const COPY = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
void main(void) {
  finalColor = texture(uTexture, vTextureCoord);
}`;

/**
 * What a chain's output depends on beyond its object: its input's size
 * and place, and the colour it is drawn in.
 */
interface Input {
  width: number;
  height: number;
  resolution: number;
  /** Its corner from the object's origin, in texels: a clip at the screen's edge moves it. */
  dx: number;
  dy: number;
  colorAlpha: number;
}

/** Whether `a` and `b` give the same output: a move may shift the corner a texel either way. */
function sameInput(a: Input, b: Input): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.resolution === b.resolution &&
    Math.abs(a.dx - b.dx) <= 1 &&
    Math.abs(a.dy - b.dy) <= 1 &&
    a.colorAlpha === b.colorAlpha
  );
}

/**
 * A display object's filters as one, their output kept and drawn again
 * while nothing they were run on changed, as Flash caches a filtered
 * object as a bitmap: the object, all below it, its transform but for a
 * move, the colour and alpha it is drawn in, and how much of it the
 * screen shows. The owner calls `changed()` for what Pixi cannot see.
 * One changing frame after frame is filtered straight to the target,
 * with no copy kept; so is one that `keeps` not, drawn once.
 */
export class FilterChain extends Filter {
  /** The input last run on, and the output kept of it, if any. */
  private ran: Input | null = null;
  private kept: Texture | null = null;
  private stale = true;
  /** Runs in a row its object changed for. */
  private changing = 0;

  constructor(
    readonly filters: Filter[],
    private readonly owner: Container,
    private readonly keeps = true,
  ) {
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: COPY, name: "flash-filter-copy" }),
      resources: {},
    });
    this.padding = filters.reduce((sum, f) => sum + f.padding, 0);
    this.resolution = "inherit";
    // The object is drawn into the chain's input as the target draws, with
    // its multisampling: Pixi's filters default to none, which left a
    // filtered object's edges stepped beside its unfiltered neighbours'.
    // Any filter of an object that says "off" turns it off for all of them.
    this.antialias = "inherit";
  }

  /** What it was run on changed: run it again. */
  changed(): void {
    this.stale = true;
  }

  /** The output kept let go of, as its object leaves the display list. */
  forget(): void {
    this.release();
    this.ran = null;
  }

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    if (!this.keeps) {
      this.run(system, input, output, clear);
      return;
    }

    const resolution = input.source.resolution;
    // The input's corner on the screen, which Pixi 8 keeps to itself.
    const bounds = (
      system as unknown as { _activeFilterData: { bounds: { minX: number; minY: number } } }
    )._activeFilterData.bounds;
    const m = this.owner.worldTransform;
    const now: Input = {
      width: input.frame.width,
      height: input.frame.height,
      resolution,
      dx: (bounds.minX - m.tx) * resolution,
      dy: (bounds.minY - m.ty) * resolution,
      colorAlpha: this.owner.groupColorAlpha,
    };
    const same = this.ran !== null && sameInput(this.ran, now);
    if (same && !this.stale && this.kept) {
      this.changing = 0;
      system.applyFilter(this, this.kept, output, clear);
      return;
    }

    // Unchanged but not kept, as after being filtered straight: kept now.
    this.changing = this.stale || !same ? this.changing + 1 : 0;
    this.stale = false;
    this.ran = now;
    this.release();
    if (this.changing > 1) {
      this.run(system, input, output, clear);
      return;
    }

    const kept = TexturePool.getSameSizeTexture(input);
    this.run(system, input, kept, true);
    this.kept = kept;
    system.applyFilter(this, kept, output, clear);
  }

  /** The filters in turn, as Pixi runs a chain, through a texture of the pool between them. */
  private run(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const filters = this.filters;
    if (filters.length === 1) {
      filters[0].apply(system, input, output, clear);
      return;
    }

    const temps = [TexturePool.getSameSizeTexture(input)];
    if (filters.length > 2) {
      temps.push(TexturePool.getSameSizeTexture(input));
    }

    let from = input;
    for (let i = 0; i < filters.length - 1; i++) {
      const to = temps[i % temps.length];
      filters[i].apply(system, from, to, true);
      from = to;
    }

    filters[filters.length - 1].apply(system, from, output, clear);
    for (const t of temps) {
      TexturePool.returnTexture(t);
    }
  }

  private release(): void {
    if (this.kept) {
      TexturePool.returnTexture(this.kept);
      this.kept = null;
    }
  }

  /** Its filters too, and the output it kept. */
  destroy(): void {
    this.release();
    for (const f of this.filters) {
      f.destroy();
    }

    super.destroy();
  }
}
