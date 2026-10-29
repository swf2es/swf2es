import { type GlState, linkProgram } from "@swf2es/context3d/device";
import * as shaders from "../filter-shaders.js";
import {
  BEVEL,
  BLUR,
  blurShrink,
  COLOR_MATRIX,
  CONVOLUTION,
  type Filters,
  GLOW,
  GRADIENT,
} from "../filters.js";
import { CLAMP, SMOOTH } from "../scene.js";

/** A texture a pass draws into through its framebuffer, and reads: at least its frame's size. */
export interface FilterTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

/** Where the runner takes its targets from and gives them back, and finds textures and samplers. */
export interface FilterHost<T extends FilterTarget> {
  /**
   * A target for a frame of `width` by `height`, of the one size the host
   * gives every such frame: two targets for one frame are alike, and a
   * filter that reads two at one coordinate reads them alike.
   */
  take(width: number, height: number): T;
  give(target: T): void;
  texture(id: number): WebGLTexture | null;
  sampler(bits: number): WebGLSampler;
}

/** The units a pass reads its input, the blur it combines with, and a gradient from. */
const INPUT_UNIT = 4;
const BLURRED_UNIT = 5;
const EXTRA_UNIT = 6;

/**
 * A triangle over the output's frame, the viewport, reading its input
 * from 0 to uCoord: the input's frame over its texture's size, as Pixi's
 * filter vertex has vTextureCoord, or more of it for a shrink.
 */
const VERTEX = `#version 300 es
uniform vec2 uCoord;
out vec2 vTextureCoord;
void main(void) {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vTextureCoord = p * uCoord;
}
`;

const HEADER = "#version 300 es\nprecision highp float;\n";

interface Pass {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

/** A blur run coarser or not: its target, the frame of it the blur fills, and how much coarser. */
interface Blurred<T> {
  target: T;
  width: number;
  height: number;
  across: number;
  down: number;
}

/**
 * Runs a layer's chain of Flash's filters, each a pass or a few over
 * targets the host lends, as the Pixi view's filters run them
 * (player's render/filters.ts): the same shaders, reading their input's
 * size in the target's units, uInputSize, and its texels, uInputPixel.
 * Every target's rows run down, as Pixi's textures' do, so the shaders'
 * offsets keep their sense. Each pass clears its whole output, which its
 * successor may read past the frame.
 */
export class FilterRunner<T extends FilterTarget> {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  private readonly host: FilterHost<T>;
  private readonly passes = new Map<string, Pass>();
  /** A convolution's weights, four to a vec4 as its shader takes them. */
  private readonly weights = new Float32Array(57 * 4);
  /** The target's pixels a unit of its own, for the chain running. */
  private resolution = 1;

  constructor(gl: WebGL2RenderingContext, state: GlState, host: FilterHost<T>) {
    this.gl = gl;
    this.state = state;
    this.host = host;
  }

  /**
   * Chain `chain` of `filters` run over `input`'s first `width` by `height`
   * texels: the target its last pass drew into, `input` itself where none
   * changed it. Every other target, `input` too where it was replaced, goes
   * back to the host.
   */
  run(
    filters: Filters,
    chain: number,
    input: T,
    width: number,
    height: number,
    resolution: number,
  ): T {
    this.resolution = resolution;
    let current = input;
    const end = filters.chains[chain + 1];

    for (let i = filters.chains[chain]; i < end; i++) {
      const next = this.apply(
        filters.kind[i],
        filters.values,
        filters.start[i],
        filters.texture[i],
        current,
        width,
        height,
      );
      if (next !== current) {
        this.host.give(current);
        current = next;
      }
    }

    return current;
  }

  /** One filter, its values from `v[at]`, over `input`: the target it drew into, or `input`. */
  private apply(
    kind: number,
    v: Float32Array,
    at: number,
    texture: number,
    input: T,
    width: number,
    height: number,
  ): T {
    switch (kind) {
      case BLUR:
        return this.blurFilter(v, at, input, width, height);
      case GLOW:
        return this.glow(v, at, input, width, height);
      case BEVEL:
        return this.bevel(v, at, input, width, height);
      case GRADIENT:
        return this.gradient(v, at, texture, input, width, height);
      case COLOR_MATRIX:
        return this.colorMatrix(v, at, input, width, height);
      case CONVOLUTION:
        return this.convolution(v, at, input, width, height);
      default:
        return input;
    }
  }

  /** A blur: the box's runs, done coarser and drawn back between their texels where that is close enough. */
  private blurFilter(v: Float32Array, at: number, input: T, width: number, height: number): T {
    const blurX = v[at];
    const blurY = v[at + 1];
    const quality = v[at + 2];
    if (!(quality > 0 && (blurX > 1 || blurY > 1))) {
      return input;
    }

    const texels = this.resolution * v[at + 3];
    const across = blurShrink(blurX, quality, 1, texels);
    const down = blurShrink(blurY, quality, 1, texels);
    const out = this.host.take(width, height);
    if (across === 1 && down === 1) {
      this.blur(input, width, height, out, blurX, blurY, quality, texels, texels);
      return out;
    }

    const blurred = this.blurred(input, width, height, blurX, blurY, quality, texels, across, down);
    const pass = this.use("readBack", shaders.READ_BACK);
    this.bindBlurred(pass, input, blurred);
    this.draw(pass, input, width, height, out, width, height);
    if (blurred) {
      this.host.give(blurred.target);
    }

    return out;
  }

  /** A glow or a drop shadow: the input's alpha blurred, coarser where close enough, in its colour. */
  private glow(v: Float32Array, at: number, input: T, width: number, height: number): T {
    const gl = this.gl;
    const blurX = v[at];
    const blurY = v[at + 1];
    const quality = v[at + 2];
    const strength = v[at + 8];
    const texels = this.resolution * v[at + 3];
    const across = blurShrink(blurX, quality, strength, texels);
    const down = blurShrink(blurY, quality, strength, texels);
    const blurred = this.blurred(input, width, height, blurX, blurY, quality, texels, across, down);
    const pass = this.use("glow", shaders.GLOW);
    gl.uniform3f(this.at(pass, "uColor"), v[at + 4], v[at + 5], v[at + 6]);
    gl.uniform1f(this.at(pass, "uAlpha"), v[at + 7]);
    gl.uniform1f(this.at(pass, "uStrength"), strength);
    gl.uniform2f(this.at(pass, "uOffset"), v[at + 9], v[at + 10]);
    gl.uniform1f(this.at(pass, "uInner"), v[at + 11]);
    gl.uniform1f(this.at(pass, "uKnockout"), v[at + 12]);
    gl.uniform1f(this.at(pass, "uHide"), v[at + 13]);
    this.bindBlurred(pass, input, blurred);
    const out = this.host.take(width, height);
    this.draw(pass, input, width, height, out, width, height);
    if (blurred) {
      this.host.give(blurred.target);
    }

    return out;
  }

  /** A bevel: the input's alpha blurred, read on and back by its offset. */
  private bevel(v: Float32Array, at: number, input: T, width: number, height: number): T {
    const gl = this.gl;
    const texels = this.resolution * v[at + 3];
    const blurred = this.blurred(input, width, height, v[at], v[at + 1], v[at + 2], texels, 1, 1);
    const pass = this.use("bevel", shaders.BEVEL);
    gl.uniform3f(this.at(pass, "uHighlight"), v[at + 4], v[at + 5], v[at + 6]);
    gl.uniform3f(this.at(pass, "uShadow"), v[at + 7], v[at + 8], v[at + 9]);
    gl.uniform1f(this.at(pass, "uHighlightAlpha"), v[at + 10]);
    gl.uniform1f(this.at(pass, "uShadowAlpha"), v[at + 11]);
    gl.uniform1f(this.at(pass, "uStrength"), v[at + 12]);
    gl.uniform2f(this.at(pass, "uOffset"), v[at + 13], v[at + 14]);
    gl.uniform1f(this.at(pass, "uType"), v[at + 15]);
    gl.uniform1f(this.at(pass, "uKnockout"), v[at + 16]);
    this.bindBlurred(pass, input, blurred);
    const out = this.host.take(width, height);
    this.draw(pass, input, width, height, out, width, height);
    if (blurred) {
      this.host.give(blurred.target);
    }

    return out;
  }

  /** A gradient glow or bevel: the blurred alpha picking a colour of its gradient, texture `id`. */
  private gradient(
    v: Float32Array,
    at: number,
    id: number,
    input: T,
    width: number,
    height: number,
  ): T {
    const gl = this.gl;
    const colors = id >= 0 ? this.host.texture(id) : null;
    if (!colors) {
      return input;
    }

    const units = v[at + 3];
    const texels = this.resolution * units;
    const blurred = this.blurred(input, width, height, v[at], v[at + 1], v[at + 2], texels, 1, 1);
    const pass = this.use("gradient", shaders.GRADIENT);
    gl.uniform1f(this.at(pass, "uStrength"), v[at + 4]);
    gl.uniform2f(this.at(pass, "uOffset"), v[at + 5], v[at + 6]);
    gl.uniform1f(this.at(pass, "uType"), v[at + 7]);
    gl.uniform1f(this.at(pass, "uKnockout"), v[at + 8]);
    gl.uniform1f(this.at(pass, "uBevel"), v[at + 9]);
    // The object's pixels and one more right and down, as adl's bitmap of it, grown by the rect.
    const inset = v[at + 10];
    gl.uniform4f(
      this.at(pass, "uRegion"),
      inset - v[at + 11] * units,
      inset - v[at + 12] * units,
      width / this.resolution - inset + units + v[at + 13] * units,
      height / this.resolution - inset + units + v[at + 14] * units,
    );
    this.state.bindTexture(EXTRA_UNIT, colors);
    this.state.bindSampler(EXTRA_UNIT, this.host.sampler(CLAMP));
    this.bindBlurred(pass, input, blurred);
    const out = this.host.take(width, height);
    this.draw(pass, input, width, height, out, width, height);
    if (blurred) {
      this.host.give(blurred.target);
    }

    return out;
  }

  private colorMatrix(v: Float32Array, at: number, input: T, width: number, height: number): T {
    const gl = this.gl;
    const pass = this.use("colorMatrix", shaders.MATRIX);
    gl.uniformMatrix4fv(this.at(pass, "uMatrix"), false, v, at, 16);
    gl.uniform4fv(this.at(pass, "uOffset"), v, at + 16, 4);
    const out = this.host.take(width, height);
    this.draw(pass, input, width, height, out, width, height);
    return out;
  }

  private convolution(v: Float32Array, at: number, input: T, width: number, height: number): T {
    const gl = this.gl;
    const columns = v[at];
    const rows = v[at + 1];
    const weights = this.weights;
    weights.fill(0);
    // As many as its shader takes: a SWF's matrix may be larger than 15 by 15, whose taps past
    // those go unread, as the Pixi view's filter drops them.
    weights.set(v.subarray(at + 12, at + 12 + Math.min(columns * rows, weights.length)));
    const pass = this.use("convolution", shaders.CONVOLUTION);
    gl.uniform4fv(this.at(pass, "uMatrix"), weights);
    gl.uniform2f(this.at(pass, "uSize"), columns, rows);
    gl.uniform4fv(this.at(pass, "uEdge"), v, at + 2, 4);
    gl.uniform1f(this.at(pass, "uDivisor"), v[at + 6]);
    gl.uniform1f(this.at(pass, "uReciprocal"), v[at + 7]);
    gl.uniform1f(this.at(pass, "uBias"), v[at + 8]);
    gl.uniform1f(this.at(pass, "uClamp"), v[at + 9]);
    gl.uniform1f(this.at(pass, "uPreserve"), v[at + 10]);
    // The object's pixels and one more right and down, as adl's bitmap of it.
    const inset = v[at + 11];
    gl.uniform4f(
      this.at(pass, "uBox"),
      inset,
      inset,
      width / this.resolution - inset + 1,
      height / this.resolution - inset + 1,
    );
    const out = this.host.take(width, height);
    this.draw(pass, input, width, height, out, width, height);
    return out;
  }

  /**
   * The box's runs over `input`'s frame into a target, `across` times
   * narrower and `down` times lower (blurShrink); null where no run would
   * change it.
   */
  private blurred(
    input: T,
    width: number,
    height: number,
    blurX: number,
    blurY: number,
    quality: number,
    texels: number,
    across: number,
    down: number,
  ): Blurred<T> | null {
    if (!(quality > 0 && (blurX > 1 || blurY > 1))) {
      return null;
    }

    let source = input;
    let w = width;
    let h = height;
    if (across > 1 || down > 1) {
      w = Math.ceil(width / across);
      h = Math.ceil(height / down);
      source = this.host.take(w, h);
      const pass = this.use("shrink", shaders.SHRINK);
      this.gl.uniform2f(this.at(pass, "uFactor"), across, down);
      this.draw(pass, input, w * across, h * down, source, w, h);
    }

    const shrunk = source !== input;
    const out = this.host.take(w, h);
    this.blur(source, w, h, out, blurX, blurY, quality, texels / across, texels / down);
    if (shrunk) {
      this.host.give(source);
    }

    return { target: out, width: w, height: h, across, down };
  }

  /**
   * The box's runs over `input`'s frame into `output`'s, through targets
   * between them: `texelsX` and `texelsY` to a stage pixel each way, which
   * the blur is in, each step a texel of the input.
   */
  private blur(
    input: T,
    width: number,
    height: number,
    output: T,
    blurX: number,
    blurY: number,
    quality: number,
    texelsX: number,
    texelsY: number,
  ): void {
    const gl = this.gl;
    const step = 1 / this.resolution;
    const across = blurX > 1;
    const down = blurY > 1;
    const runs = quality * ((across ? 1 : 0) + (down ? 1 : 0));
    const pass = this.use("box", shaders.BOX);
    const direction = this.at(pass, "uDirection");
    const boxWidth = this.at(pass, "uWidth");
    if (runs === 0) {
      gl.uniform2f(direction, 1, 0);
      gl.uniform1f(boxWidth, 1);
      this.draw(pass, input, width, height, output, width, height);
      return;
    }

    // Between the runs, two targets in turn, the second only where a third run needs one.
    const first = runs > 1 ? this.host.take(width, height) : null;
    const second = runs > 2 ? this.host.take(width, height) : null;
    let from = input;
    for (let k = 0; k < runs; k++) {
      this.state.useProgram(pass.program);
      if (across && (!down || k % 2 === 0)) {
        gl.uniform2f(direction, step, 0);
        gl.uniform1f(boxWidth, blurX * texelsX);
      } else {
        gl.uniform2f(direction, 0, step);
        gl.uniform1f(boxWidth, blurY * texelsY);
      }

      const to = k === runs - 1 ? output : ((k % 2 === 0 ? first : second) as T);
      this.draw(pass, from, width, height, to, width, height);
      from = to;
    }

    if (first) {
      this.host.give(first);
    }

    if (second) {
      this.host.give(second);
    }
  }

  /** `blurred`, or `input` where nothing blurred it, bound for `pass`, with the scale between them. */
  private bindBlurred(pass: Pass, input: T, blurred: Blurred<T> | null): void {
    const target = blurred?.target ?? input;
    this.state.bindTexture(BLURRED_UNIT, target.texture);
    this.state.bindSampler(BLURRED_UNIT, this.host.sampler(SMOOTH | CLAMP));
    this.gl.uniform2f(
      this.at(pass, "uBlurredScale"),
      input.width / (target.width * (blurred?.across ?? 1)),
      input.height / (target.height * (blurred?.down ?? 1)),
    );
  }

  /**
   * `pass` drawn into `output`'s first `width` by `height` texels, the rest
   * of it cleared, reading `input` from its corner over `readWidth` by
   * `readHeight` texels.
   */
  private draw(
    pass: Pass,
    input: T,
    readWidth: number,
    readHeight: number,
    output: T,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    const state = this.state;
    state.bindFramebuffer(output.framebuffer);
    state.viewport(0, 0, width, height);
    state.scissor(null);
    state.colorMask(15);
    state.stencil(null);
    state.setBlend(null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    state.useProgram(pass.program);
    state.bindVertexArray(null);
    state.bindTexture(INPUT_UNIT, input.texture);
    state.bindSampler(INPUT_UNIT, this.host.sampler(SMOOTH | CLAMP));
    const res = this.resolution;
    gl.uniform4f(
      this.at(pass, "uInputSize"),
      input.width / res,
      input.height / res,
      res / input.width,
      res / input.height,
    );
    gl.uniform4f(
      this.at(pass, "uInputPixel"),
      input.width,
      input.height,
      1 / input.width,
      1 / input.height,
    );
    gl.uniform2f(this.at(pass, "uCoord"), readWidth / input.width, readHeight / input.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The pass of `fragment`, linked as first used, in use. */
  private use(name: string, fragment: string): Pass {
    const gl = this.gl;
    let pass = this.passes.get(name);
    if (!pass) {
      const program = linkProgram(gl, VERTEX, HEADER + fragment);
      pass = { program, uniforms: new Map() };
      this.passes.set(name, pass);
      this.state.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, "uTexture"), INPUT_UNIT);
      gl.uniform1i(gl.getUniformLocation(program, "uBlurred"), BLURRED_UNIT);
      gl.uniform1i(gl.getUniformLocation(program, "uGradient"), EXTRA_UNIT);
    }

    this.state.useProgram(pass.program);
    return pass;
  }

  /** Where `pass` takes uniform `name`, asked once. */
  private at(pass: Pass, name: string): WebGLUniformLocation | null {
    let location = pass.uniforms.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(pass.program, name);
      pass.uniforms.set(name, location);
    }

    return location;
  }

  destroy(): void {
    for (const pass of this.passes.values()) {
      this.gl.deleteProgram(pass.program);
    }

    this.passes.clear();
  }
}
