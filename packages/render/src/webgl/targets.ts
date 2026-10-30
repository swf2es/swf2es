import type { GlState } from "@swf2es/context3d/device";
import type { KernelObject } from "../filter-plan.js";
import { SizedPool } from "./pool.js";
import { LAYER_UNIT } from "./programs.js";

/** Where a frame is drawn: the target's size in pixels, and how stage pixels map onto it. */
export interface Target {
  width: number;
  height: number;
  /** Target pixels a stage pixel, and where the stage's origin lies on the target. */
  scale: number;
  x: number;
  y: number;
  /** Target pixels a unit of the target's own, which filters read their input's size in. */
  resolution: number;
  /**
   * Target pixels a side of a pixel of Flash's, which a mesh's texture is
   * read once in: a pixel of the screen, or a BitmapData's draw's sample.
   */
  pixel: number;
}

/**
 * A target a layer is drawn into: a texture at least its rectangle's size,
 * with a stencil of its own for masks within it. Its rows run down, the
 * first the rectangle's top, as filters read them.
 */
export interface Layer {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  /** Its stencil, made as it is first drawn into unmultisampled; filters' targets take none. */
  stencil: WebGLRenderbuffer | null;
  width: number;
  height: number;
  /** The frame it was last drawn into. */
  usedAt: number;
}

/**
 * Multisampled colour and depth-stencil a target is drawn into, its edges
 * covered by `samples` a pixel, then resolved into a texture to be read.
 */
export interface Multisampled {
  framebuffer: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depthStencil: WebGLRenderbuffer;
  width: number;
  height: number;
  samples: number;
  /** The frame it was last drawn into. */
  usedAt: number;
}

/**
 * The most a multisampled target may take, colour and depth-stencil
 * together, 8 bytes a sample, as web's fittingSamples has for the
 * canvas.
 */
export const MSAA_BYTES = 256 * 1024 * 1024;

/**
 * The samples a target of `width` by `height` takes for `samples`, a power
 * of two, as a driver rounds others for colour and depth-stencil alike
 * or not: halved till its buffers fit MSAA_BYTES, none (1) where two would
 * not. A layer goes so far, as one padded as far as a texture goes would
 * take gigabytes; the stage, as web's canvas, keeps 4 at least.
 */
export function fittingSamples(width: number, height: number, samples: number, least = 1): number {
  let fitting = 1;
  while (fitting * 2 <= samples) {
    fitting *= 2;
  }

  const floor = Math.min(fitting, least);
  while (fitting > floor && width * height * fitting * 8 > MSAA_BYTES) {
    fitting /= 2;
  }

  return fitting;
}

/** The sizes a layer's texture is made in: rounded up to a multiple, so that one serves many. */
export const LAYER_STEP = 128;
/**
 * The sizes a small layer's side is made in, under LAYER_STEP: a glow of a
 * few dozen pixels took a texture of 128 a side, and a crowd keeps
 * thousands of them as their filters' outputs.
 */
const SMALL_STEP = 16;
/**
 * The most the free layers and multisampled buffers may take between
 * frames, past which the least lately freed go as a frame ends; within a
 * frame its own working set may pass it.
 */
const FREE_BYTES = 128 * 1024 * 1024;

/** A side of a layer made for `n` pixels: rounded up to SMALL_STEP, past LAYER_STEP to that. */
export function layerSide(n: number): number {
  return n <= LAYER_STEP
    ? Math.max(SMALL_STEP, Math.ceil(n / SMALL_STEP) * SMALL_STEP)
    : Math.ceil(n / LAYER_STEP) * LAYER_STEP;
}

/** The bytes multisampled buffers take: colour and depth-stencil, 8 a sample. */
function msaaBytes(msaa: { width: number; height: number; samples: number }): number {
  return msaa.width * msaa.height * msaa.samples * 8;
}

/** The bytes a layer takes: its colour, and its stencil where it has one. */
function layerBytes(layer: { width: number; height: number; stencil: unknown }): number {
  return layer.width * layer.height * (layer.stencil ? 8 : 4);
}
/** Frames a free layer is kept undrawn into before it is let go of. */
export const LAYER_IDLE_FRAMES = 60;

/**
 * A target drawn into: its rectangle of the canvas, in pixels from the
 * top left, and the layer it is drawn into, or none for the canvas itself.
 */
export interface Open {
  layer: Layer | null;
  /** What it is drawn into while it is multisampled, resolved before it is read. */
  msaa: Multisampled | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where its rectangle's corner is in its framebuffer, a page's (HOLD_PUSH); else 0, 0. */
  ox?: number;
  oy?: number;
  /** Where a whole layer's object lies in it, which its ShaderFilters read (filter-plan.ts). */
  object?: KernelObject | null;
}

/** A whole layer's object from params `p` from `at` (plan.ts, layerParams): null for none. */
export function objectOf(p: Float32Array, at: number): KernelObject | null {
  return p[at + 2] < 0 ? null : { x: p[at], y: p[at + 1], width: p[at + 2], height: p[at + 3] };
}

/** The framebuffer `open` is drawn into: its multisampled one while it has one, else its own. */
export function framebufferOf(open: Open): WebGLFramebuffer | null {
  return open.msaa?.framebuffer ?? open.layer?.framebuffer ?? null;
}

/**
 * The backend's render targets: layers and the multisampled buffers they
 * are drawn through, pooled by their size and samples, taken for a frame's
 * layers, given back and let go of once idle; and the layers kept from
 * frame to frame.
 */
export class TargetPool {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  /** Frames executed, which a layer's idleness is counted in. */
  private frameCount = 0;
  /**
   * The samples the layers of the frame drawing take: the stage's, which a
   * BitmapData's frame draws with none of.
   */
  private layerSamples = 1;
  /** Layers free to draw into, by their size. */
  private freeLayers = new SizedPool<Layer>(layerBytes);
  /** Multisampled buffers free to draw a layer into, kept while drawn into often enough. */
  private freeMsaa = new SizedPool<Multisampled>(msaaBytes);
  /** The layers kept from frame to frame, by their ids in Keeps. */
  private kept: (Layer | null)[] = [];

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.gl = gl;
    this.state = state;
  }

  /** The pools and the kept layers emptied, as the context comes or comes back. */
  setUp(): void {
    this.freeLayers = new SizedPool<Layer>(layerBytes);
    this.kept = [];
    this.freeMsaa = new SizedPool<Multisampled>(msaaBytes);
  }

  get frame(): number {
    return this.frameCount;
  }

  get frameSamples(): number {
    return this.layerSamples;
  }

  /** A frame begun, its layers taking `samples`: the stage's, 1 for a BitmapData's frame. */
  beginFrame(samples: number): void {
    this.layerSamples = samples;
  }

  /**
   * A frame of the canvas' ended: the free layers and multisampled buffers
   * undrawn into for LAYER_IDLE_FRAMES let go of, and the frame counted.
   */
  endFrame(): void {
    this.freeLayers.trim(
      this.frameCount,
      LAYER_IDLE_FRAMES,
      FREE_BYTES - this.freeMsaa.bytes,
      (l) => this.deleteLayer(l),
    );
    this.freeMsaa.trim(
      this.frameCount,
      LAYER_IDLE_FRAMES,
      FREE_BYTES - this.freeLayers.bytes,
      (m) => this.deleteMultisampled(m),
    );
    this.frameCount++;
  }

  /** The layer kept as output `id` (Keeps), or none. */
  keptLayer(id: number): Layer | null {
    return this.kept[id] ?? null;
  }

  /** `layer` kept as output `id` (Keeps) for the frames after, the one kept before given back. */
  keep(id: number, layer: Layer): void {
    const before = this.kept[id];
    if (before && before !== layer) {
      this.giveLayer(before);
    }

    this.kept[id] = layer;
  }

  /** The layer kept as output `id` given back, as Keeps let go of it. */
  release(id: number): void {
    const layer = this.kept[id];
    if (layer) {
      this.giveLayer(layer);
      this.kept[id] = null;
    }
  }

  /**
   * `open`'s multisampled pixels resolved into its layer's texture, its
   * first `width` by `height`, once: what reads it after reads them.
   */
  resolve(open: Open, width: number, height: number): void {
    const msaa = open.msaa;
    const layer = open.layer;
    if (!msaa || !layer) {
      return;
    }

    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.framebuffer);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    // Bound as the state cache has it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa.framebuffer);
    open.msaa = null;
    // Free for the next layer: only those drawn into now hold multisampled buffers.
    this.freeMsaa.give(msaa, this.frameCount, msaa.samples);
  }

  /**
   * Multisampled buffers to draw `layer` into at `wanted` samples, as many
   * as fit, free ones of its size or made; none where it takes none, its
   * own stencil then made if it has none.
   */
  layerMsaa(layer: Layer, wanted: number): Multisampled | null {
    const samples = fittingSamples(layer.width, layer.height, wanted);
    const kept = samples > 1 ? this.freeMsaa.take(layer.width, layer.height, samples) : null;
    if (kept) {
      return kept;
    }

    const msaa = samples > 1 ? this.multisampled(layer.width, layer.height, samples) : null;
    if (!msaa && !layer.stencil) {
      const gl = this.gl;
      const stencil = gl.createRenderbuffer() as WebGLRenderbuffer;
      gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, layer.width, layer.height);
      this.state.bindFramebuffer(layer.framebuffer);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        stencil,
      );
      layer.stencil = stencil;
    }

    return msaa;
  }

  /** Multisampled buffers, or none where the driver leaves their framebuffer incomplete. */
  multisampled(width: number, height: number, samples: number): Multisampled | null {
    const gl = this.gl;
    const color = gl.createRenderbuffer() as WebGLRenderbuffer;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    const depthStencil = gl.createRenderbuffer() as WebGLRenderbuffer;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthStencil);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, width, height);
    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer;
    this.state.bindFramebuffer(framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      depthStencil,
    );
    const msaa = {
      framebuffer,
      color,
      depthStencil,
      width,
      height,
      samples,
      usedAt: this.frameCount,
    };
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.deleteMultisampled(msaa);
      return null;
    }

    return msaa;
  }

  deleteMultisampled(msaa: Multisampled): void {
    this.gl.deleteFramebuffer(msaa.framebuffer);
    this.gl.deleteRenderbuffer(msaa.color);
    this.gl.deleteRenderbuffer(msaa.depthStencil);
  }

  /**
   * A layer of at least `width` by `height`, the smallest of those free
   * that is, or one made, its sides rounded as layerSide rounds them;
   * `exact`, of just the rounded size, which filters take so that a frame's
   * targets are alike, and no larger than it needs.
   */
  takeLayer(width: number, height: number, exact = false): Layer {
    width = layerSide(width);
    height = layerSide(height);
    // Found by its size, or the smallest size held that holds it.
    const found =
      this.freeLayers.take(width, height) ??
      (exact ? null : this.freeLayers.takeFitting(width, height));
    if (found) {
      found.usedAt = this.frameCount;
      return found;
    }

    return this.makeLayer(width, height);
  }

  /** A layer just `width` by `height`, made. */
  makeLayer(width: number, height: number): Layer {
    const gl = this.gl;
    const texture = gl.createTexture() as WebGLTexture;
    this.state.bindTexture(LAYER_UNIT, texture);
    this.state.activeTexture(LAYER_UNIT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // Read texel by texel: with no mipmaps, the default filter would leave it incomplete, reading 0.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer;
    this.state.bindFramebuffer(framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { framebuffer, texture, stencil: null, width, height, usedAt: this.frameCount };
  }

  /** A layer free again, kept for the layers after it while it is drawn into often enough. */
  giveLayer(layer: Layer): void {
    this.freeLayers.give(layer, this.frameCount);
  }

  deleteLayer(layer: Layer): void {
    this.state.dropTexture(layer.texture);
    this.gl.deleteFramebuffer(layer.framebuffer);
    this.gl.deleteTexture(layer.texture);
    if (layer.stencil) {
      this.gl.deleteRenderbuffer(layer.stencil);
    }
  }

  /** The free and the kept layers, and the free multisampled buffers, deleted. */
  destroy(): void {
    this.freeLayers.clear((l) => this.deleteLayer(l));
    for (const layer of this.kept) {
      if (layer) {
        this.deleteLayer(layer);
      }
    }

    this.freeMsaa.clear((m) => this.deleteMultisampled(m));
  }
}
