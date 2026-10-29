import { type GlState, linkProgram } from "@swf2es/context3d/device";
import {
  BEVEL_PASS,
  BOX_PASS,
  CONVOLUTION_PASS,
  FilterPlan,
  GLOW_PASS,
  GRADIENT_PASS,
  MATRIX_PASS,
  MATRIX4,
  NO_BLUR,
  planChain,
  READ_BACK_PASS,
  SHRINK_PASS,
  VEC4S,
} from "../filter-plan.js";
import * as shaders from "../filter-shaders.js";
import type { Filters } from "../filters.js";
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

/** The input as it is, read where the vertex shader says: halved, at a corner four texels share. */
const COPY = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
void main(void) {
  finalColor = texture(uTexture, vTextureCoord);
}`;

interface Pass {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
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
  /** The chain being run, planned (filter-plan.ts), each slot's target and the last pass using it. */
  private readonly plan = new FilterPlan();
  private readonly targets: (T | null)[] = [];
  private readonly lastUse: number[] = [];
  private readonly hasTexture = (id: number) => id >= 0 && this.host.texture(id) !== null;
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
    const plan = this.plan;
    planChain(plan, filters, chain, width, height, resolution, this.hasTexture);
    return this.execute(plan, input);
  }

  /**
   * `input`'s first `width` by `height` texels at half the size each way,
   * each texel the mean of the four it covers, read once linearly at the
   * corner they share: a target the host lends, which the caller gives
   * back. Not a filter's pass, so at a texel a unit.
   */
  halve(input: T, width: number, height: number): T {
    this.resolution = 1;
    const out = this.host.take(width, height);
    this.draw(this.use("copy", COPY), input, width * 2, height * 2, out, width, height);
    return out;
  }

  /**
   * `plan`'s passes drawn in order, its slot 0 `input`: each slot's target
   * taken as a pass first draws into it and given back after the last pass
   * that reads it, but the one the plan leaves its output in.
   */
  private execute(plan: FilterPlan, input: T): T {
    const gl = this.gl;
    this.resolution = plan.resolution;
    const targets = this.targets;
    const last = this.lastUse;
    targets.length = plan.slots;
    last.length = plan.slots;
    targets.fill(null);
    last.fill(-1);
    targets[0] = input;
    for (let k = 0; k < plan.count; k++) {
      const pass = plan.passes[k];
      last[pass.input] = k;
      last[pass.output] = k;
      if (pass.blurred >= 0) {
        last[pass.blurred] = k;
      }
    }

    for (let k = 0; k < plan.count; k++) {
      const pass = plan.passes[k];
      const from = targets[pass.input] as T;
      let to = targets[pass.output];
      if (!to) {
        to = this.host.take(plan.slotWidth[pass.output], plan.slotHeight[pass.output]);
        targets[pass.output] = to;
      }

      const program = this.program(pass.program);
      for (let u = pass.first; u < pass.end; u++) {
        this.setUniform(program, plan, u);
      }

      if (pass.texture >= 0) {
        this.state.bindTexture(EXTRA_UNIT, this.host.texture(pass.texture));
        this.state.bindSampler(EXTRA_UNIT, this.host.sampler(CLAMP));
      }

      if (pass.blurred !== NO_BLUR) {
        // The blur, or the input where nothing blurred it, with the scale between them.
        const blurred = pass.blurred >= 0 ? (targets[pass.blurred] as T) : from;
        this.state.bindTexture(BLURRED_UNIT, blurred.texture);
        this.state.bindSampler(BLURRED_UNIT, this.host.sampler(SMOOTH | CLAMP));
        gl.uniform2f(
          this.at(program, "uBlurredScale"),
          from.width / (blurred.width * pass.across),
          from.height / (blurred.height * pass.down),
        );
      }

      this.draw(program, from, pass.readWidth, pass.readHeight, to, pass.width, pass.height);
      for (let slot = 0; slot < plan.slots; slot++) {
        const target = targets[slot];
        if (target && last[slot] === k && slot !== plan.result) {
          this.host.give(target);
          targets[slot] = null;
        }
      }
    }

    return targets[plan.result] as T;
  }

  /** Uniform `u` of `plan` set on `pass`, in use. */
  private setUniform(pass: Pass, plan: FilterPlan, u: number): void {
    const gl = this.gl;
    const location = this.at(pass, plan.uniformName[u]);
    const values = plan.values;
    const at = plan.uniformAt[u];
    const count = plan.uniformCount[u];
    switch (plan.uniformKind[u]) {
      case MATRIX4:
        gl.uniformMatrix4fv(location, false, values, at, 16);
        break;
      case VEC4S:
        gl.uniform4fv(location, values, at, count);
        break;
      default:
        switch (count) {
          case 1:
            gl.uniform1f(location, values[at]);
            break;
          case 2:
            gl.uniform2f(location, values[at], values[at + 1]);
            break;
          case 3:
            gl.uniform3f(location, values[at], values[at + 1], values[at + 2]);
            break;
          default:
            gl.uniform4f(location, values[at], values[at + 1], values[at + 2], values[at + 3]);
        }
    }
  }

  /** The pass of program `id` (filter-plan.ts), in use. */
  private program(id: number): Pass {
    switch (id) {
      case BOX_PASS:
        return this.use("box", shaders.BOX);
      case SHRINK_PASS:
        return this.use("shrink", shaders.SHRINK);
      case READ_BACK_PASS:
        return this.use("readBack", shaders.READ_BACK);
      case GLOW_PASS:
        return this.use("glow", shaders.GLOW);
      case BEVEL_PASS:
        return this.use("bevel", shaders.BEVEL);
      case GRADIENT_PASS:
        return this.use("gradient", shaders.GRADIENT);
      case MATRIX_PASS:
        return this.use("colorMatrix", shaders.MATRIX);
      case CONVOLUTION_PASS:
        return this.use("convolution", shaders.CONVOLUTION);
      default:
        return this.use("displacement", shaders.DISPLACE);
    }
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
      gl.uniform1i(gl.getUniformLocation(program, "uMap"), EXTRA_UNIT);
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
