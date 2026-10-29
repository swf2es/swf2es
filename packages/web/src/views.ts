// What draws the element's stage: Pixi through a PixiView, or the renderer
// of swf2es's own (docs/renderer.md), behind what the element asks of
// either, so that its loop, its layout and its input are the same for both.

import type { Tessellator } from "@swf2es/native/tessellate";
import { type Drawer, PixiView, type Player } from "@swf2es/player";
import { autoDetectRenderer, type Renderer } from "pixi.js";

export interface StageView {
  readonly canvas: HTMLCanvasElement;
  /** Its WebGL context, null on another API. */
  readonly gl: WebGLRenderingContext | WebGL2RenderingContext | null;
  /** What a BitmapData's draw draws display objects by. */
  readonly drawer: Drawer;
  /** Canvas pixels a stage pixel. */
  readonly resolution: number;
  bindPointer(player: Player): () => void;
  /** Drawn by the stage's quality, `samples` a pixel where it anti-aliases (Playback.resample). */
  setQuality(quality: string, samples: number): void;
  /** The canvas `width` by `height` stage pixels, at `resolution` canvas pixels each. */
  resize(width: number, height: number, resolution: number): void;
  /** The stage's rectangle the canvas shows, from (x, y). */
  setViewport(x: number, y: number, width: number, height: number): void;
  render(player: Player, background: number, transparent: boolean): void;
  /** Let go of what it made, the GL context with it. */
  destroy(): void;
}

/**
 * The view the element draws by: the renderer of swf2es's own where `own`
 * asks for it, which takes WebGL 2, else Pixi. The canvas keeps alpha where
 * it may ever be left clear, for a transparent wmode or Stage3D's layers
 * below.
 */
export async function stageView(
  player: Player,
  own: boolean,
  alpha: boolean,
  tessellator: Tessellator | null,
): Promise<StageView> {
  if (own) {
    const { RenderView } = await import("@swf2es/player/scene");
    return ownView(
      new RenderView({
        width: player.width,
        height: player.height,
        resolution: 1,
        background: player.background,
        transparent: alpha,
        fillTessellator: tessellator?.tessellate,
      }),
    );
  }

  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: player.width,
    height: player.height,
    resolution: 1,
    autoDensity: false,
    antialias: false,
    backgroundAlpha: alpha ? 0 : 1,
    // Filter-backed blend modes read what is below them from it (render/blend.ts).
    useBackBuffer: true,
  });
  return pixiView(renderer, new PixiView(renderer, { fillTessellator: tessellator?.tessellate }));
}

function ownView(view: import("@swf2es/player/scene").RenderView): StageView {
  let resolution = 1;
  return {
    canvas: view.canvas,
    gl: view.gl,
    drawer: view,
    get resolution() {
      return resolution;
    },
    bindPointer: (player) => view.bindPointer(player),
    setQuality(quality, samples) {
      view.quality = quality;
      view.samples = samples;
    },
    resize(width, height, at) {
      resolution = at;
      view.resize(width, height, at);
    },
    setViewport: (x, y, width, height) => view.setViewport(x, y, width, height),
    render(player, background, transparent) {
      view.background = background;
      view.transparent = transparent;
      view.render(player.stage);
    },
    destroy: () => view.destroy(),
  };
}

function pixiView(renderer: Renderer, view: PixiView): StageView {
  return {
    canvas: renderer.canvas as HTMLCanvasElement,
    gl: (renderer as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl ?? null,
    drawer: view,
    get resolution() {
      return renderer.resolution;
    },
    bindPointer: (player) => view.bindPointer(player),
    setQuality(quality, samples) {
      view.quality = quality;
      const gl = renderer as unknown as { backBuffer?: { antialias: boolean } };
      if (gl.backBuffer) {
        gl.backBuffer.antialias = quality !== "LOW";
      }

      const adaptor = (
        renderer as unknown as {
          renderTarget: { adaptor: { msaaSamples?: number; backBufferSamples?: number } };
        }
      ).renderTarget.adaptor;
      if (adaptor.backBufferSamples !== undefined) {
        adaptor.backBufferSamples = samples;
        adaptor.msaaSamples = samples;
      }
    },
    resize: (width, height, resolution) => renderer.resize(width, height, resolution),
    setViewport: (x, y, width, height) => view.setViewport(x, y, width, height),
    render(player, background, transparent) {
      renderer.background.color = background;
      renderer.background.alpha = transparent ? 0 : 1;
      view.render(player.stage);
    },
    destroy() {
      view.dropSpares();
      // Cached text measurements hold styles; destroying the scene detaches their text listeners.
      view.dispose(view.stage);
      // Pixi loses the GL context as it goes, which a browser allows only so many of.
      renderer.destroy({ removeView: true });
    },
  };
}
