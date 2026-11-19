import {
  beginProgram,
  endProgram,
  type GlState,
  type PendingProgram,
  ShaderError,
} from "@swf2es/context3d/device";

/** KHR_parallel_shader_compile: a program's link asked after without waiting for it. */
interface ParallelCompile {
  readonly COMPLETION_STATUS_KHR: number;
}

/** A program made ahead of its first use (ProgramQueue.add). */
interface Job {
  key: string;
  vertex: string;
  fragment: string;
  /** The texture units its samplers read, 0 besides, which its warming draw binds a texel to. */
  units: readonly number[];
  made: (program: WebGLProgram) => void;
  pending: PendingProgram | null;
}

/**
 * Programs linked and warmed in a frame, at most, without KHR_parallel_shader_compile: each a few
 * milliseconds, and a first draw may take a driver tens to build its pipeline.
 */
const LINKS_A_FRAME = 1;
const WARMS_A_FRAME = 1;

/**
 * Programs made ahead of the frame that first draws with them. A filter's
 * pass linked as a frame first needs it stalls that frame while the driver
 * compiles: on ANGLE's Direct3D back end, where GLSL becomes HLSL and that
 * is compiled, for tens or hundreds of milliseconds, and a driver may put
 * off more till the program's first draw. So once the first frame is drawn
 * (step, from the second), every program queued is compiled and linked: with
 * KHR_parallel_shader_compile all at once, on the driver's threads, each
 * asked after on later frames only once complete; without it, one a frame.
 * Each linked is then drawn with once into a target of a texel, one a
 * frame, so that what the driver builds at a program's first draw is built
 * then. A frame that needs a program before it is ready takes it at once
 * (take), waiting only for what is left of its link.
 */
export class ProgramQueue {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  private readonly parallel: ParallelCompile | null;
  /** Not begun, begun and not yet asked after, linked and not yet drawn with. */
  private readonly waiting: Job[] = [];
  private readonly begun: Job[] = [];
  private readonly warming: { program: WebGLProgram; units: readonly number[] }[] = [];
  /** The target of a texel the warming draws go into, and the texel their samplers read. */
  private framebuffer: WebGLFramebuffer | null = null;
  private target: WebGLTexture | null = null;
  private texel: WebGLTexture | null = null;
  /** Frames drawn so far, but for the first, which is shown before anything is made for later. */
  private frames = 0;

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.gl = gl;
    this.state = state;
    this.parallel = gl.getExtension("KHR_parallel_shader_compile") as ParallelCompile | null;
  }

  /**
   * Program `key` of GLSL `vertex` and `fragment` to be made ahead, `made`
   * told it once it is linked (step or take), with it in use. Its samplers
   * read `units`.
   */
  add(
    key: string,
    vertex: string,
    fragment: string,
    units: readonly number[],
    made: (program: WebGLProgram) => void,
  ): void {
    this.waiting.push({ key, vertex, fragment, units, made, pending: null });
  }

  /** Whether any program is still to be linked or warmed. */
  get busy(): boolean {
    return this.waiting.length + this.begun.length + this.warming.length > 0;
  }

  /**
   * A frame's share, after its draws, from the second frame: every program
   * begun where the driver compiles in parallel, else one linked; those
   * whose links completed told to their owners; and one drawn with for the
   * first time.
   */
  step(): void {
    // A context lost mid-frame makes no shaders; a restore makes a new queue.
    if (!this.busy || this.frames++ === 0 || this.gl.isContextLost()) {
      return;
    }

    const gl = this.gl;
    if (this.parallel) {
      // Each moved as it is begun, so that a throw leaves none in both lists.
      while (this.waiting.length > 0) {
        const job = this.waiting[0];
        job.pending = beginProgram(gl, job.vertex, job.fragment);
        this.waiting.shift();
        this.begun.push(job);
      }

      const status = this.parallel.COMPLETION_STATUS_KHR;
      for (let k = 0; k < this.begun.length; k++) {
        const job = this.begun[k];
        if (gl.getProgramParameter((job.pending as PendingProgram).program, status)) {
          this.begun.splice(k--, 1);
          this.finish(job, true);
        }
      }
    } else {
      for (let k = 0; k < LINKS_A_FRAME && this.waiting.length > 0; k++) {
        const job = this.waiting.shift() as Job;
        job.pending = beginProgram(gl, job.vertex, job.fragment);
        this.finish(job, true);
      }
    }

    for (let k = 0; k < WARMS_A_FRAME && this.warming.length > 0; k++) {
      const { program, units } = this.warming.shift() as {
        program: WebGLProgram;
        units: readonly number[];
      };
      this.warm(program, units);
    }
  }

  /**
   * Program `key`, needed now: its link finished, waited for where it is
   * not complete, or begun and finished where it was not begun, and its
   * owner told. False where there is no such job, as once it was made or
   * where its link failed, which the owner then links itself to see why.
   */
  take(key: string): boolean {
    let job: Job | undefined;
    for (const list of [this.begun, this.waiting]) {
      const k = list.findIndex((j) => j.key === key);
      if (k >= 0) {
        job = list[k];
        list.splice(k, 1);
        break;
      }
    }

    if (!job) {
      return false;
    }

    job.pending ??= beginProgram(this.gl, job.vertex, job.fragment);
    // Drawn with at once, as it is needed: no warming.
    return this.finish(job, false);
  }

  /** `job`'s link finished and its owner told; whether it linked. */
  private finish(job: Job, warm: boolean): boolean {
    let program: WebGLProgram;
    try {
      program = endProgram(this.gl, job.pending as PendingProgram);
    } catch (e) {
      // A program that does not link is linked again as it is needed, which says why, or gives
      // up on the frame where the context is lost unflagged (WebGLBackend.gaveUp); one on a
      // context flagged lost gives up on it now.
      if (e instanceof ShaderError && !this.gl.isContextLost()) {
        return false;
      }

      throw e;
    }

    this.state.useProgram(program);
    job.made(program);
    if (warm) {
      this.warming.push({ program, units: job.units });
    }

    return true;
  }

  /**
   * `program` drawn with once, a triangle into a target of a texel, its
   * samplers reading another, with no attributes, blending, stencil nor
   * scissor, as the filters' passes draw.
   */
  private warm(program: WebGLProgram, units: readonly number[]): void {
    const gl = this.gl;
    const state = this.state;
    // Bound again after, as the frame left it for what reads it.
    const bound = state.boundFramebuffer ?? null;
    if (!this.framebuffer) {
      this.target = this.texture();
      this.texel = this.texture();
      this.framebuffer = gl.createFramebuffer();
      state.bindFramebuffer(this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
    }

    state.bindFramebuffer(this.framebuffer);
    state.viewport(0, 0, 1, 1);
    state.colorMask(15);
    state.stencil(null);
    state.setBlend(null);
    state.scissor(null);
    state.useProgram(program);
    state.bindVertexArray(null);
    // Unit 0 too, which a sampler its owner sets only as it draws reads till then.
    state.bindTexture(0, this.texel);
    state.bindSampler(0, null);
    for (const unit of units) {
      state.bindTexture(unit, this.texel);
      state.bindSampler(unit, null);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    state.bindFramebuffer(bound);
  }

  /** A texture of a texel, clear, complete as it is (one level, nearest). */
  private texture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture() as WebGLTexture;
    this.state.bindTexture(0, texture);
    this.state.activeTexture(0);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  /** What it made on the context, deleted: its target, and the programs begun and not finished. */
  destroy(): void {
    const gl = this.gl;
    for (const job of this.begun) {
      const pending = job.pending as PendingProgram;
      gl.deleteShader(pending.vertex);
      gl.deleteShader(pending.fragment);
      gl.deleteProgram(pending.program);
    }

    this.begun.length = 0;
    this.waiting.length = 0;
    this.warming.length = 0;
    for (const texture of [this.target, this.texel]) {
      if (texture) {
        this.state.dropTexture(texture);
        gl.deleteTexture(texture);
      }
    }

    gl.deleteFramebuffer(this.framebuffer);
    this.framebuffer = this.target = this.texel = null;
  }
}
