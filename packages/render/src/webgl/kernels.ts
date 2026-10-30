import { type GlState, linkProgram, ShaderError } from "@swf2es/context3d/device";
import { CLAMP } from "../scene.js";

/**
 * A Pixel Bender kernel's program: where it takes its uniforms, asked
 * once each, and the values of up to four floats it was last told for
 * each, by name (the filter runner's `set`).
 */
export interface KernelProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  told: Map<string, Float32Array>;
  at(name: string): WebGLUniformLocation | null;
}

/** Where kernels' programs find the textures their images are and the samplers they read them by. */
export interface KernelHost {
  texture(id: number): WebGLTexture | null;
  sampler(bits: number): WebGLSampler;
}

/**
 * The first unit a kernel's own images are bound to, as many as
 * kernel-shaders.ts's KERNEL_IMAGES: past every unit the other programs
 * use (programs.ts's, and the filter passes' 4 to 6), as WebGL 2 has 32
 * for a draw's programs together.
 */
export const KERNEL_UNIT = 16;

/** The most kernels' programs kept, the one used longest ago deleted for another. */
const KERNEL_PROGRAMS = 32;

/**
 * The programs of Pixel Bender kernels, a ShaderFilter's, a blend
 * shader's or a shader fill's, by their vertex and fragment shaders:
 * linked as first used, the one used longest ago deleted past
 * KERNEL_PROGRAMS; null for one the GPU would not link, which its user
 * draws otherwise. One for the backend, which its users share.
 */
export class KernelPrograms {
  private readonly programs = new Map<string, KernelProgram | null>();
  private readonly ints = new Int32Array(4);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly state: GlState,
  ) {}

  /**
   * The program of `vertex` and `fragment`, in use; null where it would
   * not link. `prepare` is told it as it is linked, to set its samplers.
   */
  use(
    vertex: string,
    fragment: string,
    prepare: (program: WebGLProgram) => void,
  ): KernelProgram | null {
    const gl = this.gl;
    const key = vertex + fragment;
    let kernel = this.programs.get(key);
    if (kernel !== undefined) {
      // Used last now.
      this.programs.delete(key);
    } else {
      if (this.programs.size >= KERNEL_PROGRAMS) {
        const [oldest, old] = this.programs.entries().next().value as [
          string,
          KernelProgram | null,
        ];
        if (old) {
          gl.deleteProgram(old.program);
        }

        this.programs.delete(oldest);
      }

      kernel = null;
      try {
        const program = linkProgram(gl, vertex, fragment);
        const uniforms = new Map<string, WebGLUniformLocation | null>();
        kernel = {
          program,
          uniforms,
          told: new Map(),
          at(name) {
            let location = uniforms.get(name);
            if (location === undefined) {
              location = gl.getUniformLocation(program, name);
              uniforms.set(name, location);
            }

            return location;
          },
        };
        this.state.useProgram(program);
        prepare(program);
      } catch (e) {
        if (!(e instanceof ShaderError)) {
          throw e;
        }
      }
    }

    this.programs.set(key, kernel);
    if (kernel) {
      this.state.useProgram(kernel.program);
    }

    return kernel;
  }

  /** Whether `kernel` is still kept, not deleted for another since it was given. */
  kept(vertex: string, fragment: string, kernel: KernelProgram): boolean {
    return this.programs.get(vertex + fragment) === kernel;
  }

  /** Texture `id` bound to a kernel's own image unit `k`, which its sampler at `location` names. */
  bindImage(location: WebGLUniformLocation | null, k: number, id: number, host: KernelHost): void {
    this.state.bindTexture(KERNEL_UNIT + k, host.texture(id));
    // Nearest: a float texture with a linear sampler is incomplete, and texelFetch reads either.
    this.state.bindSampler(KERNEL_UNIT + k, host.sampler(CLAMP));
    this.gl.uniform1i(location, KERNEL_UNIT + k);
  }

  /** `count` ints of `source` from `at` set as the ivec4 array at `location`, its program in use. */
  setInts(location: WebGLUniformLocation | null, source: Int32Array, at: number, count: number) {
    let values = this.ints;
    if (count > values.length) {
      values = new Int32Array(count);
    }

    values.set(source.subarray(at, at + count));
    this.gl.uniform4iv(location, values, 0, count);
  }

  /** Every program deleted, as the backend goes; none kept, as a lost context comes back. */
  clear(): void {
    for (const kernel of this.programs.values()) {
      if (kernel) {
        this.gl.deleteProgram(kernel.program);
      }
    }

    this.programs.clear();
  }
}
