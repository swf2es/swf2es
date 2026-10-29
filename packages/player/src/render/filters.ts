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

import type { ColorTransform } from "@swf2es/format";
import { blurShrink, filterShaders } from "@swf2es/render";
import {
  type BLEND_MODES,
  type Bounds,
  BufferImageSource,
  type Container,
  Filter,
  type FilterData,
  type FilterSystem,
  type FilterWithShader,
  GlProgram,
  GpuProgram,
  Texture as PixiTexture,
  type RenderSurface,
  type Texture,
  TexturePool,
  TextureSource,
} from "pixi.js";
import { rgbaOf } from "../bitmap/bitmap.js";
import {
  channelWeights,
  displacementAlpha,
  displacementGrowth,
  filterGrowth,
  gradientTable,
  integerKernel,
  paddedDistance,
} from "../bitmap/filters.js";
import {
  emptyKernel,
  type Filter as FilterRecord,
  filterOffset,
  filterRoom,
  paddingCap,
} from "../display/filters.js";
import type { AreaKeeper, PaddingFitter } from "./blend.js";

const { BEVEL, BOX, CONVOLUTION, DISPLACE, GLOW, GRADIENT, MATRIX, READ_BACK, SHRINK } =
  filterShaders;

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

/**
 * The mean of the uFactor.x by uFactor.y texels of the input that a texel
 * of the output covers, the output that many times narrower and lower: its
 * whole frame, which spans uSpan of the input's. A block at the frame's far
 * edges reaches past the input's frame, into pool space the input's pass
 * cleared or onto the texture's clamped edge, as the box's runs read there.
 */
const SHRINK_VERTEX = `in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputTexture;
uniform vec2 uSpan;
void main(void) {
  vec2 position = aPosition * 2.0 - 1.0;
  position.y *= uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * uSpan * uInputSize.zw;
}`;

let shrinkFilter: Filter | null = null;

function shrinkPass(across: number, down: number, spanX: number, spanY: number): Filter {
  shrinkFilter ??= new Filter({
    glProgram: GlProgram.from({
      vertex: SHRINK_VERTEX,
      fragment: SHRINK,
      name: "flash-blur-shrink",
    }),
    resources: {
      shrinkUniforms: {
        uFactor: { value: new Float32Array(2), type: "vec2<f32>" },
        uSpan: { value: new Float32Array(2), type: "vec2<f32>" },
      },
    },
  });
  const u = shrinkFilter.resources.shrinkUniforms.uniforms;
  u.uFactor[0] = across;
  u.uFactor[1] = down;
  u.uSpan[0] = spanX;
  u.uSpan[1] = spanY;
  return shrinkFilter;
}

/**
 * The box's runs over `input`, into a texture of the pool the caller
 * returns, `across` times narrower and `down` times lower than the input
 * (blurShrink) at its resolution; `input` itself where no run would change
 * it.
 */
function blurred(
  system: FilterSystem,
  pass: BoxPass,
  input: Texture,
  blurX: number,
  blurY: number,
  quality: number,
  texels: number,
  across: number,
  down: number,
): Texture {
  if (!(quality > 0 && (blurX > 1 || blurY > 1))) {
    return input;
  }

  let source = input;
  if (across > 1 || down > 1) {
    // Whole texels: the target's viewport is its frame in texels rounded, which would stretch a
    // fractional count across it.
    const resolution = input.source.resolution;
    const width = Math.ceil(Math.round(input.frame.width * resolution) / across) / resolution;
    const height = Math.ceil(Math.round(input.frame.height * resolution) / down) / resolution;
    source = TexturePool.getOptimalTexture({ width, height, resolution });
    // The shrink's paired reads average only where read linearly, as the pool's textures are made.
    if (input.source.scaleMode !== "linear") {
      input.source.scaleMode = "linear";
    }

    system.applyFilter(
      shrinkPass(across, down, width * across, height * down),
      input,
      source,
      true,
    );
  }

  const out = TexturePool.getSameSizeTexture(source);
  blur(system, pass, source, out, blurX, blurY, quality, texels / across, texels / down, true);
  if (source !== input) {
    TexturePool.returnTexture(source);
  }

  return out;
}

/** What scales the input's texture coordinates to `blurred`'s, which may be narrower and lower. */
function placeBlurred(
  scale: Float32Array,
  input: Texture,
  blurred: Texture,
  across: number,
  down: number,
): void {
  scale[0] = input.source.width / (blurred.source.width * across);
  scale[1] = input.source.height / (blurred.source.height * down);
}

/**
 * The box's runs over `input` into `output`, through a texture of the pool
 * between them: `texelsX` and `texelsY` to a pixel of the stage each way,
 * which the blur is in, each step a texel of the input.
 */
function blur(
  system: FilterSystem,
  pass: BoxPass,
  input: Texture,
  output: RenderSurface,
  blurX: number,
  blurY: number,
  quality: number,
  texelsX: number,
  texelsY: number,
  clear: boolean,
): void {
  // Not a stage pixel's texels: on a stage shown larger than its size those strode over texels,
  // blurring past the padding, which cut the blur off.
  const step = 1 / input.source.resolution;
  // Each quality's run across, then down, of those wider than a texel; counted, not listed, as
  // every glow's and shadow's passes come here on every frame they are drawn.
  const across = blurX > 1;
  const down = blurY > 1;
  const each = (across ? 1 : 0) + (down ? 1 : 0);
  const runs = quality * each;
  if (runs === 0) {
    pass.set(1, 0, 1);
    system.applyFilter(pass, input, output, clear);
    return;
  }

  // Between the runs, two textures in turn, the second only where a third run needs one.
  const first = runs > 1 ? TexturePool.getSameSizeTexture(input) : null;
  const second = runs > 2 ? TexturePool.getSameSizeTexture(input) : null;
  let from = input;
  for (let k = 0; k < runs; k++) {
    if (across && (!down || k % 2 === 0)) {
      pass.set(step, 0, blurX * texelsX);
    } else {
      pass.set(0, step, blurY * texelsY);
    }

    const last = k === runs - 1;
    const to = last ? output : ((k % 2 === 0 ? first : second) as Texture);
    system.applyFilter(pass, from, to, last ? clear : true);
    from = to as Texture;
  }

  if (first) {
    TexturePool.returnTexture(first);
  }

  if (second) {
    TexturePool.returnTexture(second);
  }
}

/**
 * A filter run at the target's resolution, its blurs and distances in
 * pixels of the stage: an object scaled up has its glow reach no further,
 * and a stage a host shows three times its size has it reach three times
 * as far on the screen, as Flash Player draws it.
 */
abstract class FlashFilter extends Filter {
  /** The target's units to a pixel of the stage. */
  protected units = 1;
  /** How far it draws past the object, in pixels of the stage, which its padding covers. */
  protected reach: number | null = null;

  /** The target's units to a pixel of the stage, now: the padding is the reach in those units. */
  setUnits(units: number): void {
    this.units = units;
    if (this.reach !== null) {
      // Whole units, a reach under one a unit: the filters that read the object's own pixels
      // find them that many in.
      this.padding = Math.ceil(this.reach * units);
    }
  }

  /** The texels to a stage pixel this run: the input's to a unit, at the target's resolution. */
  protected texels(input: Texture): number {
    return input.source.resolution * this.units;
  }
}

/** A private idle binding avoids scanning every other filter's listener on WHITE. */
abstract class BlurredFilter extends FlashFilter {
  private readonly unbound: TextureSource;

  constructor(options: FilterWithShader) {
    const unbound = new TextureSource();
    super({ ...options, resources: { ...options.resources, uBlurred: unbound } });
    this.unbound = unbound;
  }

  /** Release pooled textures before the pool can destroy them. */
  protected unbind(): void {
    this.resources.uBlurred = this.unbound;
  }

  destroy(): void {
    super.destroy();
    this.unbound.destroy();
  }
}

/** A blur's coarser runs drawn back (READ_BACK), a pass of the blur's own. */
class ReadBack extends BlurredFilter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: READ_BACK, name: "flash-blur-back" }),
      resources: {
        readBackUniforms: {
          uBlurredScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
        },
      },
    });
  }

  draw(
    system: FilterSystem,
    input: Texture,
    blurred: Texture,
    across: number,
    down: number,
    output: RenderSurface,
    clear: boolean,
  ): void {
    const scale = this.resources.readBackUniforms.uniforms.uBlurredScale as Float32Array;
    placeBlurred(scale, input, blurred, across, down);
    this.resources.uBlurred = blurred.source;
    system.applyFilter(this, input, output, clear);
    this.unbind();
  }
}

class BlurFilter extends FlashFilter {
  private readonly pass = new BoxPass();
  private back: ReadBack | null = null;

  /** Its box's pass and read-back too, filters of their own. */
  destroy(): void {
    this.pass.destroy();
    this.back?.destroy();
    super.destroy();
  }

  constructor(private readonly f: FilterRecord) {
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: BOX, name: "flash-blur" }),
      resources: {},
    });
    this.reach = (f.quality * Math.max(f.blurX, f.blurY)) / 2;
    this.padding = Math.ceil(this.reach);
    this.idle = !(f.quality > 0 && ((f.blurX || 0) > 1 || (f.blurY || 0) > 1));
  }

  /** Whether it leaves its input as it is, a box a texel wide or none: its chain skips it. */
  readonly idle: boolean;

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const f = this.f;
    const blurX = f.blurX || 0;
    const blurY = f.blurY || 0;
    const texels = this.texels(input);
    const across = blurShrink(blurX, f.quality, 1, texels);
    const down = blurShrink(blurY, f.quality, 1, texels);
    if (across === 1 && down === 1) {
      blur(system, this.pass, input, output, blurX, blurY, f.quality, texels, texels, clear);
      return;
    }

    const out = blurred(system, this.pass, input, blurX, blurY, f.quality, texels, across, down);
    this.back ??= new ReadBack();
    this.back.draw(system, input, out, across, down, output, clear);
    TexturePool.returnTexture(out);
  }
}

class GlowFilter extends BlurredFilter {
  private readonly pass = new BoxPass();

  /** Its box's pass too, a filter of its own. */
  destroy(): void {
    this.pass.destroy();
    super.destroy();
  }

  constructor(private readonly f: FilterRecord) {
    const shadow = f.kind === "dropShadow";
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
          uOffset: { value: new Float32Array(2), type: "vec2<f32>" },
          uBlurredScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
          uInner: { value: f.inner ? 1 : 0, type: "f32" },
          uKnockout: { value: f.knockout ? 1 : 0, type: "f32" },
          uHide: { value: shadow && f.hideObject ? 1 : 0, type: "f32" },
        },
      },
    });
    this.reach = (f.quality * Math.max(f.blurX, f.blurY)) / 2 + Math.abs(paddedDistance(distance));
    this.padding = Math.ceil(this.reach);
    this.distance = distance;
  }

  /** A drop shadow's distance; a glow's is none. */
  private readonly distance: number;

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const f = this.f;
    const uniforms = this.resources.glowUniforms.uniforms;
    filterOffset(uniforms.uOffset as Float32Array, f, this.distance, this.units);
    const blurX = f.blurX || 0;
    const blurY = f.blurY || 0;
    const texels = this.texels(input);
    const across = blurShrink(blurX, f.quality, f.strength, texels);
    const down = blurShrink(blurY, f.quality, f.strength, texels);
    const alpha = blurred(system, this.pass, input, blurX, blurY, f.quality, texels, across, down);
    placeBlurred(uniforms.uBlurredScale as Float32Array, input, alpha, across, down);
    this.resources.uBlurred = alpha.source;
    system.applyFilter(this, input, output, clear);
    this.unbind();
    if (alpha !== input) {
      TexturePool.returnTexture(alpha);
    }
  }
}

class BevelFilter extends BlurredFilter {
  private readonly pass = new BoxPass();

  /** Its box's pass too, a filter of its own. */
  destroy(): void {
    this.pass.destroy();
    super.destroy();
  }

  constructor(private readonly f: FilterRecord) {
    const rgb = (c: number) =>
      new Float32Array([((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255]);
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
          uOffset: { value: new Float32Array(2), type: "vec2<f32>" },
          uType: { value: f.type === "inner" ? 0 : f.type === "outer" ? 1 : 2, type: "f32" },
          uKnockout: { value: f.knockout ? 1 : 0, type: "f32" },
        },
      },
    });
    this.reach = (f.quality * Math.max(f.blurX, f.blurY)) / 2 + Math.abs(paddedDistance(distance));
    this.padding = Math.ceil(this.reach);
  }

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const f = this.f;
    const alpha = blurred(
      system,
      this.pass,
      input,
      f.blurX || 0,
      f.blurY || 0,
      f.quality,
      this.texels(input),
      1,
      1,
    );
    this.resources.uBlurred = alpha.source;
    const offset = this.resources.bevelUniforms.uniforms.uOffset as Float32Array;
    filterOffset(offset, f, f.distance || 0, this.units);
    system.applyFilter(this, input, output, clear);
    this.unbind();
    if (alpha !== input) {
      TexturePool.returnTexture(alpha);
    }
  }
}

class GradientFilter extends BlurredFilter {
  private readonly pass = new BoxPass();
  private readonly gradient: PixiTexture;

  /** Its box's pass and its gradient too. */
  destroy(): void {
    this.pass.destroy();
    super.destroy();
    this.gradient.destroy(true);
  }

  constructor(private readonly f: FilterRecord) {
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
          uOffset: { value: new Float32Array(2), type: "vec2<f32>" },
          uType: { value: f.type === "inner" ? 0 : f.type === "outer" ? 1 : 2, type: "f32" },
          uKnockout: { value: f.knockout ? 1 : 0, type: "f32" },
          uBevel: { value: f.kind === "gradientBevel" ? 1 : 0, type: "f32" },
          uRegion: { value: new Float32Array(4), type: "vec4<f32>" },
        },
        uGradient: gradient.source,
      },
    });
    this.gradient = gradient;
    // The rect's growth each way, as applyFilter's: left, top, right, bottom.
    this.grows = filterGrowth(f);
    this.reach = Math.max(...this.grows) + 1;
    this.padding = this.reach;
  }

  /** How far the filter's rect grows past the object in stage pixels: left, top, right, bottom. */
  private readonly grows: number[];

  /** How far in from the input's frame the object's pixels start: this and the later filters' padding. */
  inset = 0;

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const f = this.f;
    const alpha = blurred(
      system,
      this.pass,
      input,
      f.blurX || 0,
      f.blurY || 0,
      f.quality,
      this.texels(input),
      1,
      1,
    );
    this.resources.uBlurred = alpha.source;
    const offset = this.resources.gradientUniforms.uniforms.uOffset as Float32Array;
    filterOffset(offset, f, f.distance || 0, this.units);
    // The object's pixels and one more right and down, as adl's bitmap of it, grown by the rect.
    const region = this.resources.gradientUniforms.uniforms.uRegion as Float32Array;
    const grows = this.grows;
    const units = this.units;
    region[0] = this.inset - grows[0] * units;
    region[1] = this.inset - grows[1] * units;
    region[2] = input.frame.width - this.inset + units + grows[2] * units;
    region[3] = input.frame.height - this.inset + units + grows[3] * units;
    system.applyFilter(this, input, output, clear);
    this.unbind();
    if (alpha !== input) {
      TexturePool.returnTexture(alpha);
    }
  }
}

class DisplacementFilter extends FlashFilter {
  /** How far in from the input's frame the object's pixels start: this and the later filters' padding. */
  inset = 0;

  constructor(
    private readonly f: FilterRecord,
    private readonly map: Texture,
  ) {
    const pick = (c: number) => Float32Array.from(channelWeights(c));
    // Colour mode draws half the scale round the object, as adl does.
    const grow = displacementGrowth(f);
    const a = displacementAlpha(f);
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
    switch (f.kind) {
      case "blur":
        filter = new BlurFilter(f);
        break;
      case "glow":
      case "dropShadow":
        filter = new GlowFilter(f);
        break;
      case "colorMatrix":
        filter = new ColorMatrixFilter(f);
        break;
      case "bevel":
        filter = new BevelFilter(f);
        break;
      case "gradientGlow":
      case "gradientBevel":
        filter = new GradientFilter(f);
        break;
      case "displacementMap": {
        // Its map, a copy the object took when its filters were set, as a
        // texture now, never in a pass; with none it leaves the object be.
        const map = f.mapSnapshot ?? f.mapBitmap;
        const texture = map ? mapTexture(map) : null;
        filter = texture ? new DisplacementFilter(f, texture) : null;
        break;
      }
      case "convolution":
        filter = new ConvolutionFilter(f.matrixX * f.matrixY > 0 ? f : emptyKernel(f));
        break;
    }

    if (filter) {
      filter.resolution = "inherit";
      out.push(filter);
    }
  }

  scaleFilters(out, 1);
  return out;
}

/**
 * Filters drawn at `units` of the target to a pixel of the stage, each
 * filter that reads the object's own pixels told how far in they start:
 * the padding of it and the filters after it.
 */
function scaleFilters(filters: readonly Filter[], units: number): void {
  for (const filter of filters) {
    if (filter instanceof FlashFilter) {
      filter.setUnits(units);
    }
  }

  insetFilters(filters);
}

/** Each filter that reads the object's own pixels told how far in they start: its and the later filters' padding. */
function insetFilters(filters: readonly Filter[]): void {
  let inset = 0;
  for (let i = filters.length - 1; i >= 0; i--) {
    const filter = filters[i];
    inset += filter.padding;
    if (
      filter instanceof ConvolutionFilter ||
      filter instanceof GradientFilter ||
      filter instanceof DisplacementFilter
    ) {
      filter.inset = inset;
    }
  }
}

// The chain's output, as its object's colour transform colours it where it has one: each pixel's
// straight colour multiplied and offset, clamped; a clear pixel stays clear, as a bitmap's does.
const COPY = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uColored;
uniform vec4 uMul;
uniform vec4 uAdd;
void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  if (uColored > 0.5) {
    if (c.a > 0.0) {
      vec4 t = clamp(vec4(c.rgb / c.a, c.a) * uMul + uAdd, 0.0, 1.0);
      c = vec4(t.rgb * t.a, t.a);
    }
  }
  finalColor = c;
}`;

// Plain layers use the colour pass under WebGPU too; Flash's other filters remain WebGL-only.
const COPY_GPU = `struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};
struct ColorUniforms {
  uColored: f32,
  uMul: vec4<f32>,
  uAdd: vec4<f32>,
};
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> colorUniforms: ColorUniforms;
struct Output {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>) -> Output {
  var p = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  p.x = p.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  p.y = p.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return Output(vec4<f32>(p, 0.0, 1.0), aPosition * gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}
@fragment fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  var c = textureSample(uTexture, uSampler, uv);
  if (colorUniforms.uColored > 0.5 && c.a > 0.0) {
    let t = clamp(vec4<f32>(c.rgb / c.a, c.a) * colorUniforms.uMul + colorUniforms.uAdd,
                  vec4<f32>(0.0), vec4<f32>(1.0));
    c = vec4<f32>(t.rgb * t.a, t.a);
  }
  return c;
}`;

function copyGpuProgram(): GpuProgram {
  return GpuProgram.from({
    vertex: { source: COPY_GPU, entryPoint: "mainVertex" },
    fragment: { source: COPY_GPU, entryPoint: "mainFragment" },
  });
}

/** A chain's object's area on the stage, and its transform on the stage then. */
interface Measured {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

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

/**
 * Whether `a` and `b` give the same output: a move may shift the corner a texel either way, as a
 * filtered object's bitmap moves (Flash moves its cache by whole pixels); or, `exact`, by whole
 * texels alone, as a layer kept for a blend is no bitmap of Flash's, which draws the object where
 * it is to the part of a pixel (the `blend-subpixel` case).
 */
function sameInput(a: Input, b: Input, exact: boolean): boolean {
  const reach = exact ? 1e-3 : 1;
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.resolution === b.resolution &&
    Math.abs(a.dx - b.dx) <= reach &&
    Math.abs(a.dy - b.dy) <= reach &&
    a.colorAlpha === b.colorAlpha
  );
}

/**
 * A display object's filters as one, their output kept and drawn again
 * while nothing they were run on changed, as Flash caches a filtered
 * object as a bitmap: the object, all below it, its transform but for a
 * move, and how much of it the screen shows; its colour is the output's
 * (recolor). The owner calls `changed()` for what Pixi cannot see.
 * One changing frame after frame is filtered straight to the target,
 * with no copy kept; so is one that `keeps` not, drawn once.
 */
/** A pass that draws its input as it is, made once: an empty chain's (FilterChain.run). */
let plainCopyFilter: Filter | null = null;

function plainCopy(): Filter {
  plainCopyFilter ??= new Filter({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment: COPY, name: "flash-filter-copy" }),
    gpuProgram: copyGpuProgram(),
    resources: {
      colorUniforms: {
        uColored: { value: 0, type: "f32" },
        uMul: { value: new Float32Array([1, 1, 1, 1]), type: "vec4<f32>" },
        uAdd: { value: new Float32Array(4), type: "vec4<f32>" },
      },
    },
  });
  return plainCopyFilter;
}

/** Each renderer's largest texture side, asked once. */
const textureLimits = new WeakMap<object, number>();

/** The largest texture side `renderer` makes: WebGL's MAX_TEXTURE_SIZE, WebGPU's limit, else 4096. */
function textureLimit(renderer: FilterSystem["renderer"]): number {
  let limit = textureLimits.get(renderer);
  if (limit === undefined) {
    const r = renderer as unknown as {
      gl?: WebGLRenderingContext;
      gpu?: { device?: { limits?: { maxTextureDimension2D?: number } } };
    };
    limit =
      (r.gl?.getParameter(r.gl.MAX_TEXTURE_SIZE) as number | undefined) ??
      r.gpu?.device?.limits?.maxTextureDimension2D ??
      4096;
    textureLimits.set(renderer, limit);
  }

  return limit;
}

/**
 * The GPU contexts given to the renderers so far: what a chain kept in one is empty in the next, as
 * a lost context's textures come back with no contents (render/hooks.ts counts them).
 */
export const gpuContexts = { generation: 0 };

export class FilterChain extends Filter implements AreaKeeper, PaddingFitter {
  /** The input last run on, and the output kept of it, if any. */
  private ran: Input | null = null;
  /** The input to be compared with it, which then becomes it. */
  private next: Input = { width: 0, height: 0, resolution: 0, dx: 0, dy: 0, colorAlpha: 0 };
  /**
   * The area its object was last measured at on the stage, and the
   * object's transform on the stage then; null till measured again.
   */
  private area: Measured | null = null;
  /** What `area` points to when it is set, filled again at each measure. */
  private readonly measured: Measured = {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    a: 0,
    b: 0,
    c: 0,
    d: 0,
    tx: 0,
    ty: 0,
  };
  private kept: Texture | null = null;
  /** The context `kept` was drawn in (gpuContexts). */
  private keptIn = 0;
  private stale = true;
  /** Runs in a row its object changed for. */
  private changing = 0;
  private drawnAt = 1;

  constructor(
    readonly filters: Filter[],
    private readonly owner: Container,
    private readonly keeps = true,
    units = 1,
  ) {
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: COPY, name: "flash-filter-copy" }),
      gpuProgram: copyGpuProgram(),
      resources: {
        colorUniforms: {
          uColored: { value: 0, type: "f32" },
          uMul: { value: new Float32Array([1, 1, 1, 1]), type: "vec4<f32>" },
          uAdd: { value: new Float32Array(4), type: "vec4<f32>" },
        },
      },
    });
    this.running = filters.filter((f) => !(f instanceof BlurFilter && f.idle));
    this.rescale(units);
    this.resolution = "inherit";
    // The object is drawn into the chain's input as the target draws, with
    // its multisampling: Pixi's filters default to none, which left a
    // filtered object's edges stepped beside its unfiltered neighbours'.
    // Any filter of an object that says "off" turns it off for all of them.
    this.antialias = "inherit";
  }

  /**
   * The filters it runs: a blur of none, as hundreds of an animation's
   * placements carry, takes no pass, though it still pads as Flash's does.
   */
  private readonly running: Filter[];

  /** What it was run on changed: run it again, and measure it again. */
  changed(): void {
    this.stale = true;
    this.area = null;
    this.masked = true;
  }

  /**
   * The area kept, moved as the object moved: while nothing in the object
   * changed (`changed`) and its transform on the stage only moved, all it
   * draws moved alike, and so did its bounds.
   */
  keptArea(container: Container, bounds: Bounds): boolean {
    const area = this.area;
    if (!area || container !== this.owner) {
      return false;
    }

    const m = container.worldTransform;
    if (m.a !== area.a || m.b !== area.b || m.c !== area.c || m.d !== area.d) {
      return false;
    }

    const dx = m.tx - area.tx;
    const dy = m.ty - area.ty;
    bounds.minX = area.minX + dx;
    bounds.minY = area.minY + dy;
    bounds.maxX = area.maxX + dx;
    bounds.maxY = area.maxY + dy;
    return true;
  }

  keepArea(container: Container, bounds: Bounds): void {
    // A view drawn once measures once; an object that draws nothing is placed by its group, not by
    // itself.
    if (!this.keeps || container !== this.owner || !(bounds.width > 0 && bounds.height > 0)) {
      this.area = null;
      return;
    }

    // In place: a moving object is measured again on every frame.
    const m = container.worldTransform;
    const area = this.measured;
    area.minX = bounds.minX;
    area.minY = bounds.minY;
    area.maxX = bounds.maxX;
    area.maxY = bounds.maxY;
    area.a = m.a;
    area.b = m.b;
    area.c = m.c;
    area.d = m.d;
    area.tx = m.tx;
    area.ty = m.ty;
    this.area = area;
  }

  forgetArea(): void {
    this.area = null;
  }

  /**
   * Whether a mask from outside bounds something below its object, as last measured: until it is
   * measured again, which it is on each frame while one does or once anything in it changes.
   */
  private masked = true;

  maskedWithin(within: boolean): void {
    this.masked = within;
  }

  /** The target's units to a pixel of the stage its filters are drawn at. */
  get units(): number {
    return this.drawnAt;
  }

  /** Its filters drawn at `units` of the target to a pixel of the stage from now on. */
  rescale(units: number): void {
    this.drawnAt = units;
    scaleFilters(this.filters, units);
    this.wanted = this.filters.map((f) => f.padding);
    this.padding = this.wanted.reduce((sum, p) => sum + p, 0);
    this.stale = true;
    this.area = null;
  }

  /** Each filter's padding as its reach asks, before fitPadding cuts it to what can be drawn. */
  private wanted: number[] = [];

  /**
   * The filters' padding as their reach asks, where the texture the object
   * is filtered in, its area within the screen and twice the padding at
   * the target's resolution, fits the renderer's largest; past that, cut
   * alike from the furthest reaching down to what fits, as a shadow cast
   * 1e9 away, or Infinity, asks. What is cut lies past the screen, but for
   * an object off it whose shadow is not.
   */
  fitPadding(bounds: Bounds, system: FilterSystem): void {
    const renderer = system.renderer;
    const target = renderer.renderTarget;
    const resolution = target.rootRenderTarget.colorTexture.source.resolution;
    const viewport = target.rootViewPort;
    // As the filter system clips the area before it pads it.
    const width = Math.min(bounds.maxX, viewport.width / resolution) - Math.max(bounds.minX, 0);
    const height = Math.min(bounds.maxY, viewport.height / resolution) - Math.max(bounds.minY, 0);
    const room = filterRoom(textureLimit(renderer), resolution, width, height);
    const wanted = this.wanted;
    // The most any one filter pads: all they want where it fits, else the level that fits.
    const cap = paddingCap(wanted, room);
    let changed = false;
    let total = 0;
    for (let i = 0; i < this.filters.length; i++) {
      const padding = Math.min(wanted[i], cap);
      changed ||= this.filters[i].padding !== padding;
      this.filters[i].padding = padding;
      total += padding;
    }

    if (changed) {
      insetFilters(this.filters);
    }

    this.padding = total;
  }

  /**
   * Its result blended over what is below in `mode`, by the GPU's own
   * blending as its last pass draws it, where that is Flash's blend
   * (render/compositing.ts): no copy of what is below, nor a blend filter after it.
   */
  blendOver(mode: BLEND_MODES): void {
    this.blendMode = mode;
  }

  /** Whether its output is drawn coloured (recolor), which takes a pass of its own. */
  private colored = false;

  /**
   * Its output drawn in `color`, its object's colour transform from the stage down (or from the
   * filtered object it is in), as Flash colours a filtered object's bitmap: the glow and the
   * shadow too, and not what they are run on. What it kept stands.
   */
  recolor(color: ColorTransform | null): void {
    const u = this.resources.colorUniforms.uniforms;
    // A placement's transform that changes nothing takes no pass: most filtered objects have one.
    this.colored =
      color !== null &&
      !(
        color.rMul === 1 &&
        color.gMul === 1 &&
        color.bMul === 1 &&
        color.aMul === 1 &&
        color.rAdd === 0 &&
        color.gAdd === 0 &&
        color.bAdd === 0 &&
        color.aAdd === 0
      );
    u.uColored = this.colored ? 1 : 0;
    if (color && this.colored) {
      u.uMul[0] = color.rMul;
      u.uMul[1] = color.gMul;
      u.uMul[2] = color.bMul;
      u.uMul[3] = color.aMul;
      u.uAdd[0] = color.rAdd / 255;
      u.uAdd[1] = color.gAdd / 255;
      u.uAdd[2] = color.bAdd / 255;
      u.uAdd[3] = color.aAdd / 255;
    }
  }

  /** The output kept let go of, as its object leaves the display list. */
  forget(): void {
    this.release();
    this.ran = null;
    this.area = null;
  }

  /**
   * Its kept output, while it would draw it again: before its object is drawn into an input,
   * which is then not drawn at all, nor the filters run. The input `apply` would compare is the
   * one the system sizes from the bounds it measured.
   */
  override reusedOutput(_system: FilterSystem, data: FilterData): Texture | null {
    const kept = this.kept;
    if (!this.keeps || this.stale || !kept || !this.ran || this.keptIn !== gpuContexts.generation) {
      return null;
    }

    // A layer kept only for a blend is no bitmap Flash caches: one with a mask from outside on
    // something in it, which may move as nothing in it changes, is drawn again on every frame
    // (its area is then measured, and not kept, each time: measureFilterArea). A mask on the
    // object itself bounds the area measured, which changes as the mask moves.
    if (this.filters.length === 0 && this.masked) {
      return null;
    }

    const bounds = data.bounds;
    const resolution = data.resolution;
    const m = this.owner.worldTransform;
    const now = this.next;
    now.width = bounds.width;
    now.height = bounds.height;
    now.resolution = resolution;
    now.dx = (bounds.minX - m.tx) * resolution;
    now.dy = (bounds.minY - m.ty) * resolution;
    now.colorAlpha = this.owner.groupColorAlpha;
    if (!sameInput(this.ran, now, this.filters.length === 0)) {
      return null;
    }

    this.changing = 0;
    return kept;
  }

  apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    if (!this.keeps) {
      this.runOver(system, input, output, clear);
      return;
    }

    if (this.unchanged(system, input)) {
      system.applyFilter(this, this.kept as Texture, output, clear);
      return;
    }

    if (!this.rerun()) {
      this.runOver(system, input, output, clear);
      return;
    }

    if (this.running.length === 0) {
      this.keep(system, input);
    } else {
      this.kept = TexturePool.getSameSizeTexture(input);
      this.run(system, input, this.kept, true);
    }

    system.applyFilter(this, this.kept as Texture, output, clear);
  }

  /**
   * A layer kept for a blend that reads what is behind (render/compositing.ts), uncoloured and
   * blended normally, draws its input as it is: the blend after it reads the input, or the output
   * kept, which the filter system gives as the input when it reuses it, with no pass of the chain's.
   * The input is still kept while the object stands, as apply keeps it.
   */
  override passesInput(system: FilterSystem, input: Texture): boolean {
    if (this.running.length > 0 || this.colored || this.blendMode !== "normal") {
      return false;
    }

    if (!this.keeps || input === this.kept || this.unchanged(system, input) || !this.rerun()) {
      return true;
    }

    this.keep(system, input);
    return true;
  }

  /**
   * Keep what the object was drawn into: the input itself, taken from the pool, where it holds
   * one sample a pixel; a multisampled one is resolved into a copy, which holds no samples.
   */
  private keep(system: FilterSystem, input: Texture): void {
    if (!input.source.antialias && system.takeInput(input)) {
      this.kept = input;
      return;
    }

    const kept = TexturePool.getSameSizeTexture(input);
    plainCopy().apply(system, input, kept, true);
    this.kept = kept;
  }

  /** Whether `input` is what the output kept was run on, nothing having changed since. */
  private unchanged(system: FilterSystem, input: Texture): boolean {
    const resolution = input.source.resolution;
    // The input's corner on the screen.
    const bounds = system.activeBounds as Bounds;
    const m = this.owner.worldTransform;
    // Filled in place, and swapped with `ran` as it becomes that: a chain runs on every frame.
    const now = this.next;
    now.width = input.frame.width;
    now.height = input.frame.height;
    now.resolution = resolution;
    now.dx = (bounds.minX - m.tx) * resolution;
    now.dy = (bounds.minY - m.ty) * resolution;
    now.colorAlpha = this.owner.groupColorAlpha;
    this.same = this.ran !== null && sameInput(this.ran, now, this.filters.length === 0);
    if (this.same && !this.stale && this.kept && this.keptIn === gpuContexts.generation) {
      this.changing = 0;
      return true;
    }

    return false;
  }

  /** Whether the input last compared (unchanged) was the same as the one run before. */
  private same = false;

  /**
   * The input last compared made the one run on, the output kept let go of: whether to keep the
   * new one, which one changing frame after frame is not.
   */
  private rerun(): boolean {
    // Unchanged but not kept, as after being filtered straight: kept now.
    this.changing = this.stale || !this.same ? this.changing + 1 : 0;
    this.keptIn = gpuContexts.generation;
    this.stale = false;
    const now = this.next;
    this.next = this.ran ?? { width: 0, height: 0, resolution: 0, dx: 0, dy: 0, colorAlpha: 0 };
    this.ran = now;
    this.release();
    return this.changing <= 1;
  }

  /**
   * Run into `output`; blended over it or coloured, into a texture of the
   * pool first, which its own pass then blends and colours: the filters'
   * last passes draw as each of them blends, not as the chain does.
   */
  private runOver(
    system: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clear: boolean,
  ): void {
    // No inner filters: this copy can colour and blend the input directly, as AlphaFilter did.
    if (this.running.length === 0) {
      system.applyFilter(this, input, output, clear);
      return;
    }

    if (this.blendMode === "normal" && !this.colored) {
      this.run(system, input, output, clear);
      return;
    }

    const result = TexturePool.getSameSizeTexture(input);
    this.run(system, input, result, true);
    system.applyFilter(this, result, output, clear);
    TexturePool.returnTexture(result);
  }

  /** The filters in turn, as Pixi runs a chain, through a texture of the pool between them. */
  private run(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const filters = this.running;
    // A layer kept for a blend (render/compositing.ts): what was drawn, as it was drawn.
    if (filters.length === 0) {
      plainCopy().apply(system, input, output, clear);
      return;
    }

    if (filters.length === 1) {
      filters[0].apply(system, input, output, clear);
      return;
    }

    // Two textures in turn between them, the second only for a third filter.
    const first = TexturePool.getSameSizeTexture(input);
    const second = filters.length > 2 ? TexturePool.getSameSizeTexture(input) : first;
    let from = input;
    for (let i = 0; i < filters.length - 1; i++) {
      const to = i % 2 === 0 ? first : second;
      filters[i].apply(system, from, to, true);
      from = to;
    }

    filters[filters.length - 1].apply(system, from, output, clear);
    TexturePool.returnTexture(first);
    if (second !== first) {
      TexturePool.returnTexture(second);
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

export { rgbaOf };
