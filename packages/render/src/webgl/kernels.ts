import { type GlState, linkProgram, ShaderError } from "@swf2es/context3d/device";
import type { Filters } from "../filters.js";
import { KERNEL_IMAGES, type KernelImage } from "../kernel-shaders.js";
import { CLAMP } from "../scene.js";

/** A Pixel Bender kernel's program and where it takes its uniforms, asked once each. */
export interface KernelProgram {
  program: WebGLProgram;
  at(name: string): WebGLUniformLocation | null;
}

/** Where kernels' programs find the textures their images are and the samplers they read them by. */
export interface KernelHost {
  texture(id: number): WebGLTexture | null;
  sampler(bits: number): WebGLSampler;
}

/** The unit a kernel's images are bound from, KERNEL_IMAGES of them at most. */
const KERNEL_UNIT = 6;

/**
 * The programs of kernels used outside the filter passes, a blend shader's
 * or a shader fill's (filters.ts, BLEND and FILL_SHADER), by their
 * fragment shader: linked as first used, the one used longest ago deleted
 * past `most`; null for one the GPU would not link, which its user draws
 * otherwise.
 */
export class KernelPrograms {
  private readonly programs = new Map<string, KernelProgram | null>();
  /** A chain's images, read as the plan's of a ShaderFilter are. */
  readonly images: KernelImage[] = [];
  private readonly ints = new Int32Array(4);
  /** The programs of the frame's entries asked for so far, for the filters and generation they are of. */
  private readonly byEntry = new Map<number, KernelProgram | null>();
  private entryFilters: Filters | null = null;
  private entryGeneration = -1;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly state: GlState,
    private readonly vertex: string,
    private readonly most: number,
    /** Set on a program as it is linked: its samplers' units. */
    private readonly prepare: (program: WebGLProgram) => void,
  ) {}

  /** The program of `fragment`, in use; null where it would not link. */
  use(fragment: string): KernelProgram | null {
    const gl = this.gl;
    let kernel = this.programs.get(fragment);
    if (kernel !== undefined) {
      // Used last now.
      this.programs.delete(fragment);
    } else {
      if (this.programs.size >= this.most) {
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
        const program = linkProgram(gl, this.vertex, fragment);
        const locations = new Map<string, WebGLUniformLocation | null>();
        kernel = {
          program,
          at(name) {
            let location = locations.get(name);
            if (location === undefined) {
              location = gl.getUniformLocation(program, name);
              locations.set(name, location);
            }

            return location;
          },
        };
        this.state.useProgram(program);
        this.prepare(program);
      } catch (e) {
        if (!(e instanceof ShaderError)) {
          throw e;
        }
      }
    }

    this.programs.set(fragment, kernel);
    if (kernel) {
      this.state.useProgram(kernel.program);
    }

    return kernel;
  }

  /**
   * The program of the kernel at entry `i` of `filters`, its fragment
   * shader `fragment` makes of its source and images, in use: asked for
   * once a frame, as a fill drawn in many parts names one entry. Null for
   * one of more than KERNEL_IMAGES images, or one that would not link.
   */
  useEntry(
    filters: Filters,
    i: number,
    fragment: (source: string, images: KernelImage[]) => string,
  ): KernelProgram | null {
    if (this.entryFilters !== filters || this.entryGeneration !== filters.generation) {
      this.byEntry.clear();
      this.entryFilters = filters;
      this.entryGeneration = filters.generation;
    }

    let kernel = this.byEntry.get(i);
    if (kernel === undefined) {
      const source = filters.kernels[i];
      const images = this.readImages(filters, i);
      kernel =
        source && images.filter((image) => !image.layer).length <= KERNEL_IMAGES
          ? this.use(fragment(source, images))
          : null;
      this.byEntry.set(i, kernel);
    } else if (kernel) {
      this.state.useProgram(kernel.program);
    }

    return kernel;
  }

  /**
   * The images of the kernel at entry `i` of `filters`, its values laid out
   * as SHADER's, into `images`: -1 the first bound input, -2 the second.
   */
  readImages(filters: Filters, i: number): KernelImage[] {
    const v = filters.values;
    const at = filters.start[i];
    const images = this.images;
    images.length = 0;
    for (let k = 0; k < v[at + 6]; k++) {
      const id = v[at + 8 + k * 2];
      images.push({ texture: v[at + 7 + k * 2], layer: id < 0, back: id === -1 });
    }

    return images;
  }

  /** The parameters and the other images of the kernel at entry `i` of `filters`, set on `kernel`, in use. */
  setUniforms(kernel: KernelProgram, filters: Filters, i: number, host: KernelHost): void {
    const gl = this.gl;
    const v = filters.values;
    const start = filters.start[i];
    const count = v[start + 6];
    let unit = KERNEL_UNIT;
    for (let k = 0; k < count; k++) {
      const id = v[start + 8 + k * 2];
      if (id >= 0) {
        this.state.bindTexture(unit, host.texture(id));
        this.state.bindSampler(unit, host.sampler(CLAMP));
        gl.uniform1i(kernel.at(`pbImage${v[start + 7 + k * 2]}`), unit++);
      }
    }

    const floats = start + 7 + count * 2;
    if (v[floats] > 0) {
      gl.uniform4fv(kernel.at("pbFloats"), v, floats + 1, v[floats]);
    }

    const ints = floats + 1 + v[floats];
    const n = v[ints];
    if (n > 0) {
      const values = n > this.ints.length ? new Int32Array(n) : this.ints;
      for (let k = 0; k < n; k++) {
        values[k] = v[ints + 1 + k];
      }

      gl.uniform4iv(kernel.at("pbInts"), values, 0, n);
    }
  }

  /** Every program deleted, as the context goes; none kept, as it comes back. */
  clear(): void {
    this.byEntry.clear();
    this.entryFilters = null;
    for (const kernel of this.programs.values()) {
      if (kernel) {
        this.gl.deleteProgram(kernel.program);
      }
    }

    this.programs.clear();
  }
}
