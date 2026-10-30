import { type GlState, linkProgram, ShaderError } from "@swf2es/context3d/device";
import {
  BEVEL_PASS,
  BOX_PASS,
  CONVOLUTION_PASS,
  DISPLACE_PASS,
  FilterPlan,
  FLOATS,
  GLOW_PASS,
  GRADIENT_PASS,
  IVEC4S,
  KERNEL_PASS,
  MATRIX_PASS,
  MATRIX4,
  NO_BLUR,
  planChain,
  READ_BACK_PASS,
  SAMPLER,
  SHRINK_PASS,
  VEC4S,
} from "../filter-plan.js";
import * as shaders from "../filter-shaders.js";
import type { Filters } from "../filters.js";
import { CLAMP, SMOOTH } from "../scene.js";

/**
 * A texture a pass draws into through its framebuffer, and reads: at least
 * its frame's size; or a rectangle of one, `width` by `height` from texel
 * (x, y), read as if it were a texture of its own, its edges clamped.
 */
export interface FilterTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  x?: number;
  y?: number;
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

/**
 * The units a pass reads its input, the blur it combines with, and a
 * gradient from; a kernel's images take those from the last on, as far as
 * KERNEL_UNITS.
 */
const INPUT_UNIT = 4;
const BLURRED_UNIT = 5;
const EXTRA_UNIT = 6;
const KERNEL_UNITS = 8;

/** The most kernels' programs kept, the one used longest ago deleted for another. */
const KERNEL_PROGRAMS = 32;

/**
 * A triangle over the output's frame, the viewport, reading its input
 * from 0 to uCoord: the input's frame over its texture's size, or more of
 * it for a shrink.
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

/**
 * The input and the blur read within their rectangles (FilterTarget), as a
 * texture of their own size clamped to its edges reads, linearly: a texel
 * coordinate kept half a texel in from each edge reads the edge texel, as
 * the edge's clamp does.
 */
const READS = `uniform vec4 uTextureRect;
uniform vec4 uBlurredRect;
vec4 within(sampler2D t, vec4 rect, vec2 at) {
  vec2 texel = clamp(at * rect.zw, vec2(0.5), rect.zw - 0.5);
  return texture(t, (rect.xy + texel) / vec2(textureSize(t, 0)));
}
`;

/** A filter's fragment shader reading its input and its blur within their rectangles (READS). */
function withinRects(fragment: string): string {
  const reads = fragment
    .replaceAll("texture(uTexture,", "within(uTexture, uTextureRect,")
    .replaceAll("texture(uBlurred,", "within(uBlurred, uBlurredRect,");
  // A read left as it was would read past its rectangle, into another's on a page: refused.
  if (/\b(texture\w*|texelFetch\w*)\s*\(\s*u(Texture|Blurred)\b/.test(reads)) {
    throw new Error("a filter shader reads its input other than as texture(uTexture, at)");
  }

  // After the samplers' declarations, which READS's function takes.
  const at = reads.lastIndexOf("uniform sampler2D");
  const end = reads.indexOf("\n", at) + 1;
  return reads.slice(0, end) + READS + reads.slice(end);
}

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
  /** The values of up to four floats it was last told for each uniform, by name (set). */
  told: Map<string, Float32Array>;
}

/**
 * Runs a layer's chain of Flash's filters, each a pass or a few over
 * targets the host lends: the shaders of filter-shaders.ts, reading their
 * input's size in the target's units, uInputSize, and its texels,
 * uInputPixel. Every target's rows run down, so the shaders' offsets keep
 * their sense. Each pass clears its whole output, which its
 * successor may read past the frame.
 */
export class FilterRunner<T extends FilterTarget> {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  private readonly host: FilterHost<T>;
  private readonly passes = new Map<string, Pass>();
  /** Kernels' passes by their fragment shader, the one used last last; null for one that would not link. */
  private readonly kernels = new Map<string, Pass | null>();
  /** The units a kernel's pass has bound its images to so far. */
  private samplers = 0;
  private readonly ints = new Int32Array(4);
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
      if (!targets[pass.output]) {
        targets[pass.output] = this.host.take(
          plan.slotWidth[pass.output],
          plan.slotHeight[pass.output],
        );
      }

      this.drawPass(plan, k, targets, true);
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

  /**
   * Pass `k` of `plan` drawn from and into `targets`, by slot, which hold
   * every one it reads and draws into; its output's rectangle cleared first
   * where `clear`, else left as it is, as a rectangle no pass drew into yet is.
   */
  drawPass(
    plan: FilterPlan,
    k: number,
    targets: readonly (FilterTarget | null)[],
    clear: boolean,
  ): void {
    this.resolution = plan.resolution;
    const pass = plan.passes[k];
    const from = targets[pass.input] as FilterTarget;
    const to = targets[pass.output] as FilterTarget;
    // A kernel the GPU will not compile leaves its input as it was.
    const program =
      pass.program === KERNEL_PASS
        ? (this.kernel(pass.kernel as string) ?? this.use("copy", COPY))
        : this.program(pass.program);
    this.samplers = 0;
    for (let u = pass.first; u < pass.end; u++) {
      this.setUniform(program, plan, u);
    }

    if (pass.texture >= 0) {
      this.state.bindTexture(EXTRA_UNIT, this.host.texture(pass.texture));
      this.state.bindSampler(EXTRA_UNIT, this.host.sampler(CLAMP));
    }

    if (pass.blurred !== NO_BLUR) {
      // The blur, or the input where nothing blurred it, with the scale between them.
      const blurred = pass.blurred >= 0 ? (targets[pass.blurred] as FilterTarget) : from;
      this.state.bindTexture(BLURRED_UNIT, blurred.texture);
      this.state.bindSampler(BLURRED_UNIT, this.host.sampler(SMOOTH | CLAMP));
      this.set(
        program,
        "uBlurredScale",
        2,
        from.width / (blurred.width * pass.across),
        from.height / (blurred.height * pass.down),
      );
      this.set(
        program,
        "uBlurredRect",
        4,
        blurred.x ?? 0,
        blurred.y ?? 0,
        blurred.width,
        blurred.height,
      );
    }

    this.draw(program, from, pass.readWidth, pass.readHeight, to, pass.width, pass.height, clear);
  }

  /**
   * `pass`'s uniform `name`, of `count` floats, set to `x` and those after,
   * unless it was told them last: a frame's glows alike tell their passes
   * the same values over and over.
   */
  private set(pass: Pass, name: string, count: number, x: number, y = 0, z = 0, w = 0): void {
    let told = pass.told.get(name);
    if (!told) {
      told = new Float32Array(4).fill(Number.NaN);
      pass.told.set(name, told);
    }

    // Compared as the floats the uniform holds.
    if (
      told[0] === Math.fround(x) &&
      told[1] === Math.fround(y) &&
      told[2] === Math.fround(z) &&
      told[3] === Math.fround(w)
    ) {
      return;
    }

    told[0] = x;
    told[1] = y;
    told[2] = z;
    told[3] = w;
    const gl = this.gl;
    const location = this.at(pass, name);
    switch (count) {
      case 1:
        gl.uniform1f(location, x);
        break;
      case 2:
        gl.uniform2f(location, x, y);
        break;
      case 3:
        gl.uniform3f(location, x, y, z);
        break;
      default:
        gl.uniform4f(location, x, y, z, w);
    }
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
      case IVEC4S: {
        let ints = this.ints;
        if (ints.length < count) {
          ints = new Int32Array(count);
        }

        for (let k = 0; k < count; k++) {
          ints[k] = values[at + k];
        }

        gl.uniform4iv(location, ints, 0, count);
        break;
      }

      case SAMPLER: {
        const unit = EXTRA_UNIT + this.samplers++;
        if (unit < EXTRA_UNIT + KERNEL_UNITS) {
          this.state.bindTexture(unit, this.host.texture(values[at]));
          this.state.bindSampler(unit, this.host.sampler(CLAMP));
          gl.uniform1i(location, unit);
        }

        break;
      }
      case FLOATS:
        this.set(
          pass,
          plan.uniformName[u],
          count,
          values[at],
          count > 1 ? values[at + 1] : 0,
          count > 2 ? values[at + 2] : 0,
          count > 3 ? values[at + 3] : 0,
        );
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
      case DISPLACE_PASS:
        return this.use("displacement", shaders.DISPLACE);
    }

    throw new Error(`no filter pass ${id}`);
  }

  /**
   * `pass` drawn into `output`'s first `width` by `height` texels, the rest
   * of it cleared, reading `input` from its corner over `readWidth` by
   * `readHeight` texels.
   */
  private draw(
    pass: Pass,
    input: FilterTarget,
    readWidth: number,
    readHeight: number,
    output: FilterTarget,
    width: number,
    height: number,
    clear = true,
  ): void {
    const gl = this.gl;
    const state = this.state;
    const x = output.x ?? 0;
    const y = output.y ?? 0;
    state.bindFramebuffer(output.framebuffer);
    state.viewport(x, y, width, height);
    state.colorMask(15);
    state.stencil(null);
    state.setBlend(null);
    if (clear) {
      state.scissor([x, y, output.width, output.height]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    state.scissor(null);
    state.useProgram(pass.program);
    state.bindVertexArray(null);
    state.bindTexture(INPUT_UNIT, input.texture);
    state.bindSampler(INPUT_UNIT, this.host.sampler(SMOOTH | CLAMP));
    const res = this.resolution;
    this.set(
      pass,
      "uInputSize",
      4,
      input.width / res,
      input.height / res,
      res / input.width,
      res / input.height,
    );
    this.set(pass, "uInputPixel", 4, input.width, input.height, 1 / input.width, 1 / input.height);
    this.set(pass, "uCoord", 2, readWidth / input.width, readHeight / input.height);
    this.set(pass, "uTextureRect", 4, input.x ?? 0, input.y ?? 0, input.width, input.height);
    // A kernel's alone: the others need not be told.
    if (this.at(pass, "uOutputAt")) {
      this.set(pass, "uOutputAt", 2, x, y);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The pass of `fragment`, linked as first used, in use. */
  private use(name: string, fragment: string): Pass {
    const gl = this.gl;
    let pass = this.passes.get(name);
    if (!pass) {
      const program = linkProgram(gl, VERTEX, HEADER + withinRects(fragment));
      pass = {
        program,
        uniforms: new Map(),
        told: new Map(),
      };
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

  /** The pass of a kernel's fragment shader, linked as first used, in use; null where it would not link. */
  private kernel(fragment: string): Pass | null {
    const gl = this.gl;
    let pass = this.kernels.get(fragment);
    if (pass !== undefined) {
      // Used last now.
      this.kernels.delete(fragment);
    } else {
      if (this.kernels.size >= KERNEL_PROGRAMS) {
        const [oldest, old] = this.kernels.entries().next().value as [string, Pass | null];
        if (old) {
          gl.deleteProgram(old.program);
        }

        this.kernels.delete(oldest);
      }

      pass = null;
      try {
        const program = linkProgram(gl, VERTEX, HEADER + fragment);
        pass = { program, uniforms: new Map(), told: new Map() };
        this.state.useProgram(program);
        gl.uniform1i(gl.getUniformLocation(program, "uTexture"), INPUT_UNIT);
      } catch (e) {
        if (!(e instanceof ShaderError)) {
          throw e;
        }
      }
    }

    this.kernels.set(fragment, pass);
    if (pass) {
      this.state.useProgram(pass.program);
    }

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
    for (const pass of [...this.passes.values(), ...this.kernels.values()]) {
      if (pass) {
        this.gl.deleteProgram(pass.program);
      }
    }

    this.passes.clear();
    this.kernels.clear();
  }
}
