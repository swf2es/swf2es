// A player shown in its element: the renderer and its canvas, sized to
// the element and the device's pixels, the pointer, the keys and the
// focus, and the loop that plays and draws, all of which destroy lets go.

import type { Convolver } from "@swf2es/native/bitmap";
import type { Tessellator } from "@swf2es/native/tessellate";
import { bindActivation, bindKeyboard, type Player, type Scripting } from "@swf2es/player";
import { configuration } from "./config.js";
import { place, type ScaleMode, viewport } from "./layout.js";
import type { Stage3DSession } from "./stage3d.js";
import { type StageView, stageView } from "./views.js";

/** How the element shows its player, read again as the page changes them. */
export interface Look {
  scale: ScaleMode;
  salign: string | null;
  /** "transparent" leaves the stage's background out, so the page shows through. */
  wmode: string;
  /** The background the page gives, 0xRRGGBB, in place of the SWF's. */
  bgcolor: number | null;
}

export class Playback {
  private frame = 0;
  private last: number | null = null;
  /**
   * The ms the last call to advance took, by which the player tells frames
   * that overran. Drawing is left out: it costs the same however many frames
   * a call plays, and counted with one it would keep the player at one a call.
   */
  private busy = 0;
  private drawn = -1;
  /** Something the host changed, a size or a look, which the next frame draws though the player has not. */
  private dirty = true;
  private dpr = 0;
  private readonly resize: ResizeObserver;
  private readonly unbind: (() => void)[] = [];
  private destroyed = false;
  /** The stage's quality it last drew by. */
  private quality = "";

  private constructor(
    private readonly box: HTMLElement,
    private readonly player: Player,
    private readonly scripting: Scripting | null,
    private readonly view: StageView,
    private readonly look: () => Look,
    private readonly report: (error: unknown) => void,
    private readonly stage3D: Stage3DSession | null,
    private readonly tessellator: Tessellator | null,
    private readonly convolver: Convolver | null,
  ) {
    const canvas = view.canvas;
    canvas.style.position = "absolute";
    canvas.style.display = "block";
    if (stage3D) {
      canvas.style.zIndex = "1";
    }
    box.append(canvas);
    if (scripting) {
      scripting.drawer = view.drawer;
      scripting.bitmapConvolver = convolver?.convolve ?? null;
      if (stage3D) {
        scripting.onStageLayout = this.stageLayout;
      }
    }

    // An AVM1 movie's BitmapData draws display objects by it too.
    if (player.avm1) {
      player.avm1.drawer = view.drawer;
      player.avm1.bitmapConvolver = convolver?.convolve ?? null;
    }

    this.unbind.push(this.view.bindPointer(player));
    // The element's keys alone, as a plug-in had them only while focused.
    const host = (box.getRootNode() as ShadowRoot).host ?? box;
    this.unbind.push(bindKeyboard(player, host));
    // Its keys' releases are lost when the window or the element loses focus: the player lets them go.
    this.unbind.push(bindActivation(player, window, host as HTMLElement));
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(box);
    this.layout();
  }

  /**
   * A renderer for `player` in `box`, Pixi or, where the configuration asks
   * for it, the renderer of swf2es's own (views.ts). The canvas is not
   * multisampled: the stage is drawn into buffers that are, but at low
   * quality, which Flash draws aliased.
   */
  static async create(
    box: HTMLElement,
    player: Player,
    scripting: Scripting | null,
    look: () => Look,
    report: (error: unknown) => void,
    stage3D: Stage3DSession | null = null,
  ): Promise<Playback> {
    // Both load together, so the second costs playback no extra round trip. An
    // embedder without a module, or a page that cannot load it, plays through JS.
    const { nativeFills, nativeBitmaps, renderer } = configuration();
    const [tessellator, convolver] = await Promise.all([
      nativeFills === false
        ? null
        : import("@swf2es/native/tessellate")
            .then(({ Tessellator }): Tessellator => new Tessellator())
            .catch(() => null),
      nativeBitmaps === false
        ? null
        : import("@swf2es/native/bitmap")
            .then(({ Convolver }): Convolver => new Convolver())
            .catch(() => null),
    ]);

    const view = await stageView(
      player,
      renderer !== "pixi",
      !!stage3D || look().wmode === "transparent",
      tessellator,
    );
    return new Playback(
      box,
      player,
      scripting,
      view,
      look,
      report,
      stage3D,
      tessellator,
      convolver,
    );
  }

  /** The renderer's WebGL context, null on another API or once destroyed. */
  get gl(): WebGLRenderingContext | WebGL2RenderingContext | null {
    if (this.destroyed) {
      return null;
    }

    return this.view.gl;
  }

  /** Play and draw on every animation frame, from now. */
  run(): void {
    if (!this.destroyed && !this.frame) {
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  /** Something the host shows differently: draw again on the next frame. */
  changed(): void {
    this.dirty = true;
    this.layout();
  }

  /** A host layer changed composition without changing stage placement. */
  invalidate(): void {
    this.dirty = true;
  }

  private readonly tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last === null ? 0 : now - this.last;
    this.last = now;
    // Moved to a display of another density, or zoomed: drawn anew for its pixels.
    if (devicePixelRatio !== this.dpr) {
      this.layout();
    }

    const start = performance.now();
    try {
      this.player.advance(dt, this.busy);
    } catch (error) {
      this.report(error);
    }

    this.busy = performance.now() - start;

    if (this.player.quality !== this.quality) {
      this.requality();
    }

    if (this.player.changes !== this.drawn || this.dirty) {
      this.draw();
    }
  };

  /**
   * Drawn by the stage's quality as a script or the page changes it:
   * Flash's low draws edges aliased and smooths no bitmap; medium, high and
   * best anti-alias the edges, as the GPU's multisampling does.
   */
  private requality(): void {
    this.quality = this.player.quality;
    this.resample();
    this.dirty = true;
  }

  /**
   * The samples the stage and the filter layers take, by the quality and the
   * canvas's pixels: 4 at medium, 8 at high and 16 at best. Flash covers an
   * edge with 16 at high, but 8 look alike but on the longest, shallowest
   * edges, and cost half the memory; best takes Flash's 16. Every
   * sample costs its pixels' 4 bytes of colour and 4 of depth and stencil, so
   * a large canvas takes fewer: at most what fits STAGE_BYTES, and 4 at least,
   * as before samples could be chosen. Those are a stage pixel's: a canvas
   * finer than the stage, as at a device pixel ratio of 2 or 3, takes fewer
   * for each of its pixels (denseSamples).
   */
  private resample(): void {
    const canvas = this.view.canvas;
    const fits = fittingSamples(canvas.width * canvas.height);
    const quality = this.player.quality;
    const samples = Math.min(quality === "MEDIUM" ? 4 : quality === "HIGH" ? 8 : 16, fits);
    // As fine as the stage's pixels on the canvas: fewer where each spans several.
    this.view.setQuality(quality, denseSamples(samples, this.view.resolution));
  }

  private draw(): void {
    const look = this.look();
    // A script may set Stage.color, which moves `changes`: read it as it draws.
    const color = look.bgcolor ?? this.player.background;
    const transparent = look.wmode === "transparent";
    const overlay = this.stage3D?.active ?? false;
    // A transparent clear must contain no RGB for the browser's premultiplied
    // compositor; the stage color belongs below the opaque Stage3D viewports.
    const background = overlay ? 0 : color;
    const clear = transparent || overlay;
    // What showAll leaves around the stage is the stage's colour, as in Flash.
    this.box.style.background = transparent ? "" : `#${color.toString(16).padStart(6, "0")}`;
    this.drawn = this.player.changes;
    this.dirty = false;
    this.view.render(this.player, background, clear);
  }

  private readonly stageLayout = () => this.layout();

  /** The canvas placed in the box by the look, and drawn at the device's pixels. */
  private layout(): void {
    if (this.destroyed) {
      return;
    }

    const look = this.look();
    const scripting = this.stage3D ? this.scripting : null;
    scripting?.setStageDefaults(look.scale, look.salign ?? "");
    const mode = scripting?.stageScaleMode ?? look.scale;
    const align = scripting?.stageAlign ?? look.salign;
    // Live noScale makes the stage the box's size; every other mode keeps the SWF's.
    const noScale = !!scripting && mode === "noScale";
    const stageWidth = noScale ? this.box.clientWidth : this.player.width;
    const stageHeight = noScale ? this.box.clientHeight : this.player.height;
    this.dpr = devicePixelRatio || 1;
    const placed = place(
      this.player.width || 1,
      this.player.height || 1,
      this.box.clientWidth,
      this.box.clientHeight,
      mode,
      align,
      this.dpr,
      !!scripting,
    );
    const view = viewport(
      this.player.width || 1,
      this.player.height || 1,
      this.box.clientWidth,
      this.box.clientHeight,
      mode,
      placed,
    );
    const canvas = this.view.canvas;
    canvas.style.left = `${view.css.x}px`;
    canvas.style.top = `${view.css.y}px`;
    canvas.style.width = `${view.css.width}px`;
    canvas.style.height = `${view.css.height}px`;
    const screenWidth = Math.max(1, view.width);
    const screenHeight = Math.max(1, view.height);
    // Compared in the canvas's pixels, which Pixi rounds the screen to: a fractional
    // screen would otherwise never compare equal and resize on every layout.
    if (
      view.resolution !== this.view.resolution ||
      canvas.width !== Math.round(screenWidth * view.resolution) ||
      canvas.height !== Math.round(screenHeight * view.resolution)
    ) {
      this.view.resize(screenWidth, screenHeight, view.resolution);
      this.resample();
    }

    // AVM1's _xmouse is measured in the screen's pixels, as Flash Player measures it.
    if (this.player.avm1) {
      this.player.avm1.pixelRatio = placed.resolution;
    }

    // Flash takes the pointer in the margins too, at stage coordinates past its edges.
    if (this.scripting) {
      this.scripting.stageViewportX = view.x;
      this.scripting.stageViewportY = view.y;
      this.scripting.stageViewportWidth = screenWidth;
      this.scripting.stageViewportHeight = screenHeight;
    }

    this.view.setViewport(view.x, view.y, screenWidth, screenHeight);
    this.stage3D?.layout(placed, this.player.width, this.player.height);
    this.dirty = true;
    // Dispatch only after placement is current: a resize listener may set
    // another layout or reconfigure its Stage3D back buffer synchronously.
    scripting?.resizeStage(stageWidth, stageHeight);
  }

  /** Stop the loop and let go of the renderer, its GL context, the canvas and the input. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    for (const unbind of this.unbind.splice(0)) {
      unbind();
    }

    if (this.scripting?.drawer === this.view.drawer) {
      this.scripting.drawer = null;
    }
    if (this.scripting?.onStageLayout === this.stageLayout) {
      this.scripting.onStageLayout = null;
    }

    if (this.player.avm1?.drawer === this.view.drawer) {
      this.player.avm1.drawer = null;
    }

    if (this.scripting && this.scripting.bitmapConvolver === this.convolver?.convolve) {
      this.scripting.bitmapConvolver = null;
    }
    if (this.player.avm1 && this.player.avm1.bitmapConvolver === this.convolver?.convolve) {
      this.player.avm1.bitmapConvolver = null;
    }
    this.convolver?.dispose();

    this.view.destroy();
    // The view's geometry let go of first, which the native scratch may then follow.
    this.tessellator?.dispose();
    this.view.canvas.remove();
  }
}

/** The most a canvas's multisampled buffers may take, colour and depth-stencil together. */
const STAGE_BYTES = 256 * 1024 * 1024;

/**
 * The samples a pixel of the canvas takes for `samples` a stage pixel, at
 * `resolution` of the canvas's pixels to a stage pixel: where a stage pixel
 * spans several, as many as cover it with as many samples as at one, a
 * power of two, 4 at least and `samples` at most. At three device pixels a
 * stage pixel, 4 samples each are 36 a stage pixel, more than best's 16 at
 * one; 8 would double the multisampled canvas's memory traffic for edges a
 * third of a stage pixel wide.
 */
export function denseSamples(samples: number, resolution: number): number {
  const wanted = samples / Math.max(1, resolution * resolution);
  let dense = 4;
  while (dense < wanted) {
    dense *= 2;
  }

  return Math.min(samples, dense);
}

/** The most samples, a power of two and 4 at least, whose buffers for `pixels` fit STAGE_BYTES. */
export function fittingSamples(pixels: number): number {
  let samples = 16;
  while (samples > 4 && pixels * samples * 8 > STAGE_BYTES) {
    samples /= 2;
  }

  return samples;
}
