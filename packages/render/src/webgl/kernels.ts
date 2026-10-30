import { type GlState, linkProgram, ShaderError } from "@swf2es/context3d/device";
import type { Filters } from "../filters.js";
import type { KernelImage } from "../kernel-shaders.js";
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

  /** What readImages reads into, its records kept from call to call. */
  private readonly images: KernelImage[] = [];

  /**
   * The images of the kernel at entry `i` of `filters`, a blend shader's
   * or a shader fill's, its values laid out as a ShaderFilter's
   * (filters.ts, SHADER): -1 for what is below, -2 for the layer blended.
   * Null where a texture of its own is gone, as such a kernel is left out.
   */
  readImages(filters: Filters, i: number, host: KernelHost): KernelImage[] | null {
    const v = filters.values;
    const at = filters.start[i];
    const count = v[at + 7];
    const images = this.images;
    for (let k = 0; k < count; k++) {
      const id = v[at + 9 + k * 3];
      if (id >= 0 && !host.texture(id)) {
        return null;
      }

      if (!images[k]) {
        images[k] = { texture: 0, layer: false, float: false, back: false };
      }

      const image = images[k];
      image.texture = v[at + 8 + k * 3];
      image.layer = id < 0;
      image.back = id === -1;
      image.float = v[at + 10 + k * 3] > 0;
    }

    images.length = count;
    return images;
  }

  /** The parameters and own images of the kernel at entry `i` of `filters` set on `kernel`, in use. */
  setUniforms(kernel: KernelProgram, filters: Filters, i: number, host: KernelHost): void {
    const v = filters.values;
    const at = filters.start[i];
    const count = v[at + 7];
    let unit = 0;
    for (let k = 0; k < count; k++) {
      const id = v[at + 9 + k * 3];
      if (id >= 0) {
        this.bindImage(kernel.at(`pbImage${v[at + 8 + k * 3]}`), unit++, id, host);
      }
    }

    const floats = at + 8 + count * 3;
    if (v[floats] > 0) {
      this.gl.uniform4fv(kernel.at("pbFloats"), v, floats + 1, v[floats]);
    }

    const ints = filters.intStart[i];
    const n = filters.intStart[i + 1] - ints;
    if (n > 0) {
      this.setInts(kernel.at("pbInts"), filters.ints, ints, n);
    }
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
