/**
 * The GL state of a context as its one owner last set it, so that nothing
 * is set twice: the program, vertex array, framebuffer, viewport, blending,
 * scissor, colour mask and the textures on each unit. What sets state
 * behind it (another library, a lost context) calls forget, and everything
 * is set again on its next use.
 */
export class GlState {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null | undefined;
  private vertexArray: WebGLVertexArrayObject | null | undefined;
  private framebuffer: WebGLFramebuffer | null | undefined;
  private readonly view = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  /** Blending: on or off, then the four factors and the equation, -1 as unknown. */
  private blending: boolean | undefined;
  private readonly blend = [-1, -1, -1, -1, -1];
  private scissoring: boolean | undefined;
  private readonly box = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  private mask = -1;
  private unit = -1;
  private readonly textures: (WebGLTexture | null | undefined)[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** Everything unknown: set again as next asked for. */
  forget(): void {
    this.program = undefined;
    this.vertexArray = undefined;
    this.framebuffer = undefined;
    this.view.fill(Number.NaN);
    this.blending = undefined;
    this.blend.fill(-1);
    this.scissoring = undefined;
    this.box.fill(Number.NaN);
    this.mask = -1;
    this.unit = -1;
    this.textures.length = 0;
  }

  useProgram(program: WebGLProgram | null): void {
    if (program !== this.program) {
      this.program = program;
      this.gl.useProgram(program);
    }
  }

  bindVertexArray(vertexArray: WebGLVertexArrayObject | null): void {
    if (vertexArray !== this.vertexArray) {
      this.vertexArray = vertexArray;
      this.gl.bindVertexArray(vertexArray);
    }
  }

  bindFramebuffer(framebuffer: WebGLFramebuffer | null): void {
    if (framebuffer !== this.framebuffer) {
      this.framebuffer = framebuffer;
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer);
    }
  }

  viewport(x: number, y: number, width: number, height: number): void {
    const v = this.view;
    if (v[0] !== x || v[1] !== y || v[2] !== width || v[3] !== height) {
      v[0] = x;
      v[1] = y;
      v[2] = width;
      v[3] = height;
      this.gl.viewport(x, y, width, height);
    }
  }

  /** Blending by the factors and equation given, or off with `src` null. */
  setBlend(src: number | null, dst = 0, srcAlpha = src ?? 0, dstAlpha = dst, equation = 0): void {
    const gl = this.gl;
    const on = src !== null;
    if (on !== this.blending) {
      this.blending = on;
      if (on) {
        gl.enable(gl.BLEND);
      } else {
        gl.disable(gl.BLEND);
      }
    }

    if (!on) {
      return;
    }

    const b = this.blend;
    if (b[0] !== src || b[1] !== dst || b[2] !== srcAlpha || b[3] !== dstAlpha) {
      b[0] = src;
      b[1] = dst;
      b[2] = srcAlpha;
      b[3] = dstAlpha;
      gl.blendFuncSeparate(src, dst, srcAlpha, dstAlpha);
    }

    const eq = equation || gl.FUNC_ADD;
    if (b[4] !== eq) {
      b[4] = eq;
      gl.blendEquation(eq);
    }
  }

  /** Scissoring to the box given, or off with none. */
  scissor(box: readonly [number, number, number, number] | null): void {
    const gl = this.gl;
    const on = box !== null;
    if (on !== this.scissoring) {
      this.scissoring = on;
      if (on) {
        gl.enable(gl.SCISSOR_TEST);
      } else {
        gl.disable(gl.SCISSOR_TEST);
      }
    }

    const b = this.box;
    if (box && (b[0] !== box[0] || b[1] !== box[1] || b[2] !== box[2] || b[3] !== box[3])) {
      b[0] = box[0];
      b[1] = box[1];
      b[2] = box[2];
      b[3] = box[3];
      gl.scissor(box[0], box[1], box[2], box[3]);
    }
  }

  /** Which of red, green, blue and alpha are written, as bits 1, 2, 4 and 8. */
  colorMask(bits: number): void {
    if (bits !== this.mask) {
      this.mask = bits;
      this.gl.colorMask((bits & 1) !== 0, (bits & 2) !== 0, (bits & 4) !== 0, (bits & 8) !== 0);
    }
  }

  /** `texture` bound to texture unit `unit` as a 2D texture. */
  bindTexture(unit: number, texture: WebGLTexture | null): void {
    if (this.textures[unit] === texture) {
      return;
    }

    this.textures[unit] = texture;
    this.activeTexture(unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
  }

  /** Make `unit` the active one, for an upload to the texture bound there. */
  activeTexture(unit: number): void {
    if (unit !== this.unit) {
      this.unit = unit;
      this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    }
  }

  /** A texture deleted: no unit is thought to hold it any more. */
  dropTexture(texture: WebGLTexture): void {
    for (let i = 0; i < this.textures.length; i++) {
      if (this.textures[i] === texture) {
        this.textures[i] = undefined;
      }
    }
  }
}
