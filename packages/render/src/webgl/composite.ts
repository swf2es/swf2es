import { type GlState, linkProgram } from "@swf2es/context3d/device";
import { BLEND, type Filters } from "../filters.js";
import { blendKernel, kernelImagesFit } from "../kernel-shaders.js";
import { ADD, KERNEL, LAYER, NORMAL, SCREEN } from "../scene.js";
import type { KernelHost, KernelProgram, KernelPrograms } from "./kernels.js";
import {
  BACK_UNIT,
  compositeFragment,
  compositeVertex,
  LAYER_COLOR,
  LAYER_UNIT,
} from "./programs.js";
import { framebufferOf, LAYER_STEP, type Layer, type Open } from "./targets.js";

/** Where a compositor finds the frame's blend shaders and the textures they read. */
export interface CompositeHost extends KernelHost {
  filters(): Filters | null;
}

/**
 * Layers composited onto what they are drawn over, in Flash's blend modes:
 * through GL's blending where it computes the blend, else by the composite
 * program from a copy of what is below, or by a blend shader's program
 * (KERNEL).
 */
export class Compositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  /** The layers' composite program and where it takes its mode and row. */
  private composite!: WebGLProgram;
  private modeLocation: WebGLUniformLocation | null = null;
  private compositeRowLocation: WebGLUniformLocation | null = null;
  private offsetLocation: WebGLUniformLocation | null = null;
  private flipLocation: WebGLUniformLocation | null = null;
  private backOffsetLocation: WebGLUniformLocation | null = null;
  private rectLocation: WebGLUniformLocation | null = null;
  /** A copy of what is below a layer whose mode reads it, the target's size. */
  private back: WebGLTexture | null = null;
  private backFramebuffer: WebGLFramebuffer | null = null;
  private backWidth = 0;
  private backHeight = 0;
  constructor(
    gl: WebGL2RenderingContext,
    state: GlState,
    private readonly host: CompositeHost,
    /** Blend shaders' programs, the backend's one cache of kernels'. */
    private readonly kernels: KernelPrograms,
  ) {
    this.gl = gl;
    this.state = state;
  }

  /** The composite program made, and no copy yet, as the context comes or comes back. */
  setUp(): void {
    const gl = this.gl;
    this.composite = linkProgram(gl, compositeVertex, compositeFragment);
    this.state.useProgram(this.composite);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uLayer"), LAYER_UNIT);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uBack"), BACK_UNIT);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uRows"), 0);
    this.modeLocation = gl.getUniformLocation(this.composite, "uMode");
    this.compositeRowLocation = gl.getUniformLocation(this.composite, "uRow");
    this.offsetLocation = gl.getUniformLocation(this.composite, "uOffset");
    this.flipLocation = gl.getUniformLocation(this.composite, "uFlip");
    this.backOffsetLocation = gl.getUniformLocation(this.composite, "uBackOffset");
    this.rectLocation = gl.getUniformLocation(this.composite, "uRect");
    this.back = null;
    this.backFramebuffer = null;
    this.backWidth = 0;
    this.backHeight = 0;
  }

  /**
   * `open` composited onto `under`, bound, in blend mode `mode`, coloured by
   * row `row` (or -1), over its rectangle alone: through GL's blending where
   * it computes Flash's blend, else from a copy of what is below there, the
   * result replacing it. Its rectangle is cut to `under`'s, as a filtered
   * one may reach past the canvas; in `under`'s framebuffer its rows run
   * up on the canvas and down in a layer.
   */
  compositeLayer(open: Open, under: Open, given: number, row: number): void {
    const gl = this.gl;
    // A blend shader that will not link, of too many images, or with an image gone, composites as
    // normal.
    const kernel = given >= KERNEL ? this.useKernel(given - KERNEL) : null;
    const mode = given >= KERNEL && !kernel ? NORMAL : given;
    const state = this.state;
    const dx = open.x - under.x;
    const dy = open.y - under.y;
    const flip = !under.layer;
    const y = flip ? under.height - dy - open.height : dy;
    const x0 = Math.max(0, dx);
    const y0 = Math.max(0, y);
    const width = Math.min(under.width, dx + open.width) - x0;
    const height = Math.min(under.height, y + open.height) - y0;
    if (width <= 0 || height <= 0) {
      return;
    }

    const direct = mode === NORMAL || mode === LAYER || mode === ADD || mode === SCREEN;
    // The rectangle's corner in the target's framebuffer, where the target is a held layer's
    // rectangle of a page (HOLD_PUSH).
    const fx = x0 + (under.ox ?? 0);
    const fy = y0 + (under.oy ?? 0);
    // Where the copy of what is below has the rectangle's corner, less where the target has it.
    let backX = 0;
    let backY = 0;
    if (!direct) {
      // Out of a multisampled page, its rectangle resolved into the page's own texture first, which
      // a blit may then copy anywhere: copied where it lies, the copy would stay as large as the
      // page's far corner.
      let from = framebufferOf(under);
      const paged = under.msaa !== null && under.layer !== null && under.ox !== undefined;
      if (paged) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, (under.layer as Layer).framebuffer);
        gl.blitFramebuffer(
          fx,
          fy,
          fx + width,
          fy + height,
          fx,
          fy,
          fx + width,
          fy + height,
          gl.COLOR_BUFFER_BIT,
          gl.NEAREST,
        );
        from = (under.layer as Layer).framebuffer;
      }

      // Copied from its corner, or out of a multisampled target to where it lies, as a blit
      // resolving must keep its rectangle: then as large as the rectangle's far corner.
      const bx = under.msaa && !paged ? fx : 0;
      const by = under.msaa && !paged ? fy : 0;
      backX = fx - bx;
      backY = fy - by;
      const right = bx + width;
      const top = by + height;
      if (!this.back || this.backWidth < right || this.backHeight < top) {
        if (this.back) {
          state.dropTexture(this.back);
          gl.deleteTexture(this.back);
          gl.deleteFramebuffer(this.backFramebuffer);
          this.backFramebuffer = null;
        }

        this.back = gl.createTexture() as WebGLTexture;
        this.backWidth = Math.max(this.backWidth, Math.ceil(right / LAYER_STEP) * LAYER_STEP);
        this.backHeight = Math.max(this.backHeight, Math.ceil(top / LAYER_STEP) * LAYER_STEP);
        state.bindTexture(BACK_UNIT, this.back);
        state.activeTexture(BACK_UNIT);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          this.backWidth,
          this.backHeight,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      }

      // Blitted, not copied: the canvas' colour may have no alpha, which copyTexSubImage2D into an
      // RGBA texture refuses, where a blit fills it in.
      // Out of a multisampled target the blit resolves the rectangle alone.
      if (!this.backFramebuffer) {
        this.backFramebuffer = gl.createFramebuffer() as WebGLFramebuffer;
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.backFramebuffer);
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          this.back,
          0,
        );
      } else {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.backFramebuffer);
      }

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
      gl.blitFramebuffer(
        fx,
        fy,
        fx + width,
        fy + height,
        bx,
        by,
        right,
        top,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      // Both bindings back as the state cache has them.
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebufferOf(under));
    }

    state.bindTexture(LAYER_UNIT, (open.layer as Layer).texture);
    state.bindSampler(LAYER_UNIT, null);
    state.bindSampler(BACK_UNIT, null);
    state.bindVertexArray(null);
    // Less its corner on its page, where it is a held layer's rectangle of one (HELD), and past
    // the target's, where that is one.
    const ox = (under.ox ?? 0) - (open.ox ?? 0);
    const oy = (under.oy ?? 0) - (open.oy ?? 0);
    const offsetY = flip ? under.height - 1 - dy - oy : dy + oy;
    if (kernel) {
      const filters = this.host.filters() as Filters;
      const entry = filters.chains[mode - KERNEL];
      state.useProgram(kernel.program);
      gl.uniform1i(kernel.at("uRow"), row);
      gl.uniform2i(kernel.at("uOffset"), dx + ox, offsetY);
      gl.uniform1i(kernel.at("uFlip"), flip ? 1 : 0);
      gl.uniform2i(kernel.at("uBackOffset"), backX, backY);
      gl.uniform1i(kernel.at("uWhole"), filters.values[filters.start[entry]]);
      this.kernels.setUniforms(kernel, filters, entry, this.host);
    } else {
      state.useProgram(this.composite);
      gl.uniform1i(this.modeLocation, mode);
      gl.uniform1i(this.compositeRowLocation, row);
      gl.uniform2i(this.offsetLocation, dx + ox, offsetY);
      gl.uniform1i(this.flipLocation, flip ? 1 : 0);
      gl.uniform2i(this.backOffsetLocation, backX, backY);
    }

    switch (mode) {
      case ADD:
        state.setBlend(gl.ONE, gl.ONE);
        break;
      case SCREEN:
        state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
        break;
      case NORMAL:
      case LAYER:
        state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      default:
        state.setBlend(null);
    }

    // Over the rectangle alone, in the target's clip space; the scissor keeps it to whole pixels.
    const tw = under.width;
    const th = under.height;
    gl.uniform4f(
      kernel ? kernel.at("uRect") : this.rectLocation,
      (2 * x0) / tw - 1,
      (2 * y0) / th - 1,
      (2 * (x0 + width)) / tw - 1,
      (2 * (y0 + height)) / th - 1,
    );
    state.scissor([fx, fy, width, height]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    state.scissor(null);
  }

  /**
   * The program of the blend shader of chain `chain` of the frame's
   * filters (KernelPrograms), in use; null for none, one that would not
   * link, one of more images than a program binds, or one whose image is gone.
   */
  private useKernel(chain: number): KernelProgram | null {
    const filters = this.host.filters();
    if (!filters || chain >= filters.chainCount) {
      return null;
    }

    const i = filters.chains[chain];
    const source = filters.kernels[i];
    const images =
      source && filters.kind[i] === BLEND ? this.kernels.readImages(filters, i, this.host) : null;
    if (!source || !images || !kernelImagesFit(images)) {
      return null;
    }

    return this.kernels.use(
      compositeVertex,
      blendKernel(source, images, LAYER_COLOR),
      (program) => {
        const gl = this.gl;
        gl.uniform1i(gl.getUniformLocation(program, "uLayer"), LAYER_UNIT);
        gl.uniform1i(gl.getUniformLocation(program, "uBack"), BACK_UNIT);
        gl.uniform1i(gl.getUniformLocation(program, "uRows"), 0);
      },
    );
  }

  /** The program and the copy made on the context, deleted. */
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.composite);

    if (this.back) {
      gl.deleteTexture(this.back);
      gl.deleteFramebuffer(this.backFramebuffer);
    }
  }
}
