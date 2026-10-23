// A player shown in its element: the renderer and its canvas, sized to
// the element and the device's pixels, the pointer, the keys and the
// focus, and the loop that plays and draws, all of which destroy lets go.
import {
  bindActivation,
  bindKeyboard,
  PixiView,
  type Player,
  type Scripting,
} from "@swf2es/player";
import { autoDetectRenderer, type Renderer } from "pixi.js";
import { MAX_SIDE, place, type ScaleMode } from "./layout.js";
import type { Stage3DSession } from "./stage3d.js";

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
  private readonly view: PixiView;
  /** The stage's quality it last drew by. */
  private quality = "";

  private constructor(
    private readonly box: HTMLElement,
    private readonly player: Player,
    private readonly scripting: Scripting | null,
    private readonly renderer: Renderer,
    private readonly look: () => Look,
    private readonly report: (error: unknown) => void,
    private readonly stage3D: Stage3DSession | null,
  ) {
    const canvas = renderer.canvas as HTMLCanvasElement;
    canvas.style.position = "absolute";
    canvas.style.display = "block";
    if (stage3D) {
      canvas.style.zIndex = "1";
    }
    box.append(canvas);
    this.view = new PixiView(renderer);
    if (scripting) {
      scripting.drawer = this.view;
      if (stage3D) {
        scripting.onStageLayout = this.stageLayout;
      }
    }

    // An AVM1 movie's BitmapData draws display objects by it too.
    if (player.avm1) {
      player.avm1.drawer = this.view;
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
   * A renderer for `player` in `box`. The canvas is not multisampled: the
   * stage is drawn into the back buffer, which is, but at low quality,
   * which Flash draws aliased.
   */
  static async create(
    box: HTMLElement,
    player: Player,
    scripting: Scripting | null,
    look: () => Look,
    report: (error: unknown) => void,
    stage3D: Stage3DSession | null = null,
  ): Promise<Playback> {
    const renderer = await autoDetectRenderer({
      preference: "webgl",
      width: player.width,
      height: player.height,
      resolution: 1,
      autoDensity: false,
      antialias: false,
      backgroundAlpha: stage3D || look().wmode === "transparent" ? 0 : 1,
      // Filter-backed blend modes read what is below them from it (render/blend.ts).
      useBackBuffer: true,
    });
    return new Playback(box, player, scripting, renderer, look, report, stage3D);
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
    const quality = this.player.quality;
    this.quality = quality;
    this.view.quality = quality;

    const gl = this.renderer as unknown as { backBuffer?: { antialias: boolean } };
    if (gl.backBuffer) {
      gl.backBuffer.antialias = quality !== "LOW";
    }

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
   * as before samples could be chosen.
   */
  private resample(): void {
    const adaptor = (
      this.renderer as unknown as {
        renderTarget: { adaptor: { msaaSamples?: number; backBufferSamples?: number } };
      }
    ).renderTarget.adaptor;
    if (adaptor.backBufferSamples === undefined) {
      return;
    }

    const canvas = this.renderer.canvas as HTMLCanvasElement;
    const fits = fittingSamples(canvas.width * canvas.height);
    const quality = this.player.quality;
    const samples = Math.min(quality === "MEDIUM" ? 4 : quality === "HIGH" ? 8 : 16, fits);
    adaptor.backBufferSamples = samples;
    adaptor.msaaSamples = samples;
  }

  private draw(): void {
    const look = this.look();
    // A script may set Stage.color, which moves `changes`: read it as it draws.
    const color = look.bgcolor ?? this.player.background;
    const transparent = look.wmode === "transparent";
    const overlay = this.stage3D?.active ?? false;
    // A transparent clear must contain no RGB for the browser's premultiplied
    // compositor; the stage color belongs below the opaque Stage3D viewports.
    this.renderer.background.color = overlay ? 0 : color;
    this.renderer.background.alpha = transparent || overlay ? 0 : 1;
    // What showAll leaves around the stage is the stage's colour, as in Flash.
    this.box.style.background = transparent ? "" : `#${color.toString(16).padStart(6, "0")}`;
    this.drawn = this.player.changes;
    this.dirty = false;
    this.view.render(this.player.stage);
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
    const noScale = !!scripting && mode === "noScale";
    const width = noScale ? this.box.clientWidth : this.player.width;
    const height = noScale ? this.box.clientHeight : this.player.height;
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
    const canvas = this.renderer.canvas as HTMLCanvasElement;
    canvas.style.left = `${noScale ? 0 : placed.x}px`;
    canvas.style.top = `${noScale ? 0 : placed.y}px`;
    canvas.style.width = `${noScale ? width : placed.width}px`;
    canvas.style.height = `${noScale ? height : placed.height}px`;
    // noScale can show artwork beyond the SWF's authored rectangle. Keep its
    // origin aligned while drawing the whole viewport, including negative coordinates.
    const resolution = noScale
      ? Math.max(1 / 64, Math.min(this.dpr, MAX_SIDE / Math.max(width, height, 1)))
      : placed.resolution;
    if (
      resolution !== this.renderer.resolution ||
      this.renderer.screen.width !== Math.max(1, width) ||
      this.renderer.screen.height !== Math.max(1, height)
    ) {
      this.renderer.resize(Math.max(1, width), Math.max(1, height), resolution);
      this.resample();
    }

    // AVM1's _xmouse is measured in the screen's pixels, as Flash Player measures it.
    if (this.player.avm1) {
      this.player.avm1.pixelRatio = placed.resolution;
    }

    if (scripting) {
      scripting.stageViewportX = noScale ? -placed.x : 0;
      scripting.stageViewportY = noScale ? -placed.y : 0;
    }

    this.view.setViewport(
      noScale ? -placed.x : 0,
      noScale ? -placed.y : 0,
      Math.max(1, width),
      Math.max(1, height),
    );
    this.stage3D?.layout(placed, this.player.width, this.player.height);
    this.dirty = true;
    // Dispatch only after placement is current: a resize listener may set
    // another layout or reconfigure its Stage3D back buffer synchronously.
    scripting?.resizeStage(width, height);
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

    if (this.scripting?.drawer === this.view) {
      this.scripting.drawer = null;
    }
    if (this.scripting?.onStageLayout === this.stageLayout) {
      this.scripting.onStageLayout = null;
    }

    if (this.player.avm1?.drawer === this.view) {
      this.player.avm1.drawer = null;
    }

    this.view.dropSpares();
    // Cached text measurements hold styles; destroying the scene detaches their text listeners.
    this.view.dispose(this.view.stage);

    // Pixi loses the GL context as it goes, which a browser allows only so many of.
    this.renderer.destroy({ removeView: true });
  }
}

/** The most a canvas's multisampled buffers may take, colour and depth-stencil together. */
const STAGE_BYTES = 256 * 1024 * 1024;

/** The most samples, a power of two and 4 at least, whose buffers for `pixels` fit STAGE_BYTES. */
export function fittingSamples(pixels: number): number {
  let samples = 16;
  while (samples > 4 && pixels * samples * 8 > STAGE_BYTES) {
    samples /= 2;
  }

  return samples;
}
