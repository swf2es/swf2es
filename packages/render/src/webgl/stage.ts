import type { GlState } from "@swf2es/context3d/device";
import { LAYER_UNIT } from "./programs.js";
import {
  fittingSamples,
  LAYER_IDLE_FRAMES,
  type Layer,
  type Multisampled,
  type Targets,
} from "./targets.js";

/**
 * The stage's own targets and their way onto the canvas: multisampled
 * buffers the canvas's size and the texture they resolve into, the layer a
 * frame that clears the stage is drawn into before an opaque canvas, and
 * the copies onto the canvas.
 */
export class Stage {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  private readonly targets: Targets;
  /** The most samples the GPU takes, and whether the canvas has alpha, asked once. */
  private maxSamples = 1;
  canvasAlpha = false;
  /**
   * The stage's multisampled buffers, and the texture they resolve into before a canvas they may
   * not be resolved onto (present), made as first needed.
   */
  private stageMsaa: Multisampled | null = null;
  private stageResolved: { framebuffer: WebGLFramebuffer; texture: WebGLTexture } | null = null;
  /**
   * Whether the driver resolves the stage straight onto a canvas with alpha, found as it first does
   * (present): null till then. SwiftShader refuses it.
   */
  private directResolve: boolean | null = null;
  /** The layer a frame that clears the stage is drawn into before an opaque canvas (stageAlpha). */
  private stageLayer: Layer | null = null;

  constructor(gl: WebGL2RenderingContext, state: GlState, targets: Targets) {
    this.gl = gl;
    this.state = state;
    this.targets = targets;
  }

  /** Nothing made yet, and the GPU and the canvas asked again, as the context comes or comes back. */
  setUp(): void {
    const gl = this.gl;
    this.stageMsaa = null;
    this.stageResolved = null;
    this.directResolve = null;
    this.stageLayer = null;
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    this.canvasAlpha = gl.getContextAttributes()?.alpha ?? false;
  }

  /**
   * The stage's multisampled pixels onto the canvas: resolved straight onto one with alpha where
   * the driver lets a resolve go there, else into a texture first, as an opaque canvas's must be, a
   * resolve keeping its format. Whether the driver lets it is found once, by the error it raises.
   */
  present(msaa: Multisampled): void {
    const gl = this.gl;
    const { width, height } = msaa;
    if (this.canvasAlpha && this.directResolve !== false) {
      const finding = this.directResolve === null;
      if (finding) {
        gl.getError();
      }

      this.toCanvas(msaa.framebuffer, width, height, false);
      if (finding) {
        this.directResolve = gl.getError() !== gl.INVALID_OPERATION;
      }

      if (this.directResolve) {
        return;
      }
    }

    const resolved = this.resolveTarget(width, height);
    this.state.bindFramebuffer(msaa.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved.framebuffer);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.toCanvas(resolved.framebuffer, width, height, false);
  }

  /** The texture the stage resolves into before the canvas (present), made as first needed. */
  private resolveTarget(
    width: number,
    height: number,
  ): { framebuffer: WebGLFramebuffer; texture: WebGLTexture } {
    if (this.stageResolved) {
      return this.stageResolved;
    }

    const gl = this.gl;
    const texture = gl.createTexture() as WebGLTexture;
    this.state.bindTexture(LAYER_UNIT, texture);
    this.state.activeTexture(LAYER_UNIT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer;
    this.state.bindFramebuffer(framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    this.stageResolved = { framebuffer, texture };
    return this.stageResolved;
  }

  /**
   * The first `width` by `height` pixels of `source` copied onto the canvas,
   * upside down where `flip`. Bound through the state cache first and as
   * it was after, so the cache holds what is bound, whatever it held.
   */
  toCanvas(source: WebGLFramebuffer, width: number, height: number, flip: boolean): void {
    const gl = this.gl;
    this.state.bindFramebuffer(source);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    const top = flip ? 0 : height;
    gl.blitFramebuffer(
      0,
      0,
      width,
      height,
      0,
      height - top,
      width,
      top,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, source);
  }

  /**
   * The layer the canvas' size a frame that clears the stage is drawn into
   * before an opaque canvas (execute): its own, kept apart from the free
   * layers so that none smaller takes it, made again for another size, let
   * go of once idle as they are.
   */
  stageAlpha(width: number, height: number): Layer {
    const known = this.stageLayer;
    if (known && known.width === width && known.height === height) {
      known.usedAt = this.targets.frame;
      return known;
    }

    if (known) {
      this.targets.deleteLayer(known);
    }

    const layer = this.targets.makeLayer(width, height);
    this.stageLayer = layer;
    return layer;
  }

  /**
   * The stage's multisampled buffers, made again for another size or samples, their resolve's
   * texture let go of; none where it takes no samples.
   */
  stageBuffers(width: number, height: number, wanted: number): Multisampled | null {
    const samples = fittingSamples(width, height, Math.min(wanted, this.maxSamples), 4);
    const known = this.stageMsaa;
    if (known && known.width === width && known.height === height && known.samples === samples) {
      return known;
    }

    this.dropStageBuffers();
    const msaa = samples > 1 ? this.targets.multisampled(width, height, samples) : null;
    if (!msaa) {
      return null;
    }

    this.stageMsaa = msaa;
    return msaa;
  }

  /** The stage's multisampled buffers and their resolve let go of, as samples or size change. */
  dropStageBuffers(): void {
    const gl = this.gl;
    if (this.stageMsaa) {
      this.targets.deleteMultisampled(this.stageMsaa);
      this.stageMsaa = null;
    }

    if (this.stageResolved) {
      this.state.dropTexture(this.stageResolved.texture);
      gl.deleteTexture(this.stageResolved.texture);
      gl.deleteFramebuffer(this.stageResolved.framebuffer);
      this.stageResolved = null;
    }
  }

  /** The stage's layer (stageAlpha) let go of, undrawn into for LAYER_IDLE_FRAMES. */
  dropIdleLayer(): void {
    const stage = this.stageLayer;
    if (stage && this.targets.frame - stage.usedAt > LAYER_IDLE_FRAMES) {
      this.targets.deleteLayer(stage);
      this.stageLayer = null;
    }
  }

  /** What the stage made on the context, deleted. */
  destroy(): void {
    this.dropStageBuffers();
    if (this.stageLayer) {
      this.targets.deleteLayer(this.stageLayer);
    }
  }
}
