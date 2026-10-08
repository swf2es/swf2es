// A player shown in its element: the renderer and its canvas, sized to
// the element and the device's pixels, the pointer and the keys, and the
// loop that plays and draws, all of which destroy lets go.
import { bindKeyboard, PixiView, type Player, type Scripting } from "@swf2es/player";
import { autoDetectRenderer, type Renderer } from "pixi.js";
import { type Placement, place, type ScaleMode } from "./layout.js";

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
  private drawn = -1;
  /** Something the host changed, a size or a look, which the next frame draws though the player has not. */
  private dirty = true;
  private placed: Placement | null = null;
  private dpr = 0;
  private readonly resize: ResizeObserver;
  private readonly unbind: (() => void)[] = [];
  private destroyed = false;
  private readonly view: PixiView;

  private constructor(
    private readonly box: HTMLElement,
    private readonly player: Player,
    private readonly scripting: Scripting | null,
    private readonly renderer: Renderer,
    private readonly look: () => Look,
    private readonly report: (error: unknown) => void,
  ) {
    const canvas = renderer.canvas as HTMLCanvasElement;
    canvas.style.position = "absolute";
    canvas.style.display = "block";
    box.append(canvas);
    this.view = new PixiView(renderer);
    if (scripting) {
      scripting.drawer = this.view;
    }

    this.unbind.push(this.view.bindPointer(player));
    // The element's keys alone, as a plug-in had them only while focused.
    const host = (box.getRootNode() as ShadowRoot).host ?? box;
    this.unbind.push(bindKeyboard(player, host));
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(box);
    this.layout();
  }

  /** A renderer for `player` in `box`, anti-aliased but at low quality, which Flash draws unsmoothed. */
  static async create(
    box: HTMLElement,
    player: Player,
    scripting: Scripting | null,
    antialias: boolean,
    look: () => Look,
    report: (error: unknown) => void,
  ): Promise<Playback> {
    const renderer = await autoDetectRenderer({
      preference: "webgl",
      width: player.width,
      height: player.height,
      resolution: 1,
      autoDensity: false,
      antialias,
      backgroundAlpha: look().wmode === "transparent" ? 0 : 1,
      // Filter-backed blend modes read what is below them from it (render/blend.ts).
      useBackBuffer: true,
    });
    return new Playback(box, player, scripting, renderer, look, report);
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

  private readonly tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last === null ? 0 : now - this.last;
    this.last = now;
    // Moved to a display of another density, or zoomed: drawn anew for its pixels.
    if (devicePixelRatio !== this.dpr) {
      this.layout();
    }

    try {
      this.player.advance(dt);
    } catch (error) {
      this.report(error);
    }

    if (this.player.changes !== this.drawn || this.dirty) {
      this.draw();
    }
  };

  private draw(): void {
    const look = this.look();
    // A script may set Stage.color, which moves `changes`: read it as it draws.
    const color = look.bgcolor ?? this.player.background;
    const transparent = look.wmode === "transparent";
    this.renderer.background.color = color;
    this.renderer.background.alpha = transparent ? 0 : 1;
    // What showAll leaves around the stage is the stage's colour, as in Flash.
    this.box.style.background = transparent ? "" : `#${color.toString(16).padStart(6, "0")}`;
    this.drawn = this.player.changes;
    this.dirty = false;
    this.view.render(this.player.stage);
  }

  /** The canvas placed in the box by the look, and drawn at the device's pixels. */
  private layout(): void {
    if (this.destroyed) {
      return;
    }

    const look = this.look();
    this.dpr = devicePixelRatio || 1;
    const placed = place(
      this.player.width || 1,
      this.player.height || 1,
      this.box.clientWidth,
      this.box.clientHeight,
      look.scale,
      look.salign,
      this.dpr,
    );
    const canvas = this.renderer.canvas as HTMLCanvasElement;
    canvas.style.left = `${placed.x}px`;
    canvas.style.top = `${placed.y}px`;
    canvas.style.width = `${placed.width}px`;
    canvas.style.height = `${placed.height}px`;
    if (placed.resolution !== this.placed?.resolution) {
      this.renderer.resize(this.player.width, this.player.height, placed.resolution);
    }

    this.placed = placed;
    this.dirty = true;
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

    // Pixi loses the GL context as it goes, which a browser allows only so many of.
    this.renderer.destroy({ removeView: true });
  }
}
