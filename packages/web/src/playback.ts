// A player shown in its element: the renderer and its canvas, sized to
// the element and the device's pixels, the pointer, the keys and the
// focus, and the loop that plays and draws, all of which destroy lets go.

import {
  bindActivation,
  bindKeyboard,
  bindTextInput,
  type Player,
  type Scripting,
  type TextInput,
} from "@swf2es/player";
import type { RenderView } from "@swf2es/player/scene";
import {
  type Placement,
  place,
  type ScaleMode,
  sourceViewport,
  type Viewport,
  viewport,
} from "./layout.js";
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

/**
 * The ms after its last draw, or the last input on the element, from which a stage counts as
 * still. A SWF slower than the display draws in one tick of several, 12 frames a second in one
 * of five at 60 Hz, and is not still between them.
 */
const STILL_MS = 150;
/** A display's interval, in ms, until the animation frames have shown this one's. */
const DISPLAY_INTERVAL = 1000 / 60;
/** The times between animation frames kept for the display's interval, and the fewest it is told by. */
const GAPS = 9;
const MIN_GAPS = 3;
/**
 * The part of the display's interval a still stage's timer ticks at. A player ticked slower
 * than the display plays fewer frames than a 60 fps SWF has, one a tick and those lost dropped;
 * ticked a little faster it finds no frame due in a tick now and then, which costs nothing.
 */
const EARLY = 0.97;
/** How often, in ms, a still stage asks for an animation frame, to learn whether the page's still come. */
const PROBE_MS = 1000;
/**
 * The timer ticks whose lateness tells whether timers keep the display's interval: the last
 * LATENESSES, as the player's typical interval is the lower median of its last nine calls.
 */
const LATENESSES = 9;
/** The ms a still stage keeps to animation frames after its timers came too late, at first and at most. */
const RETRY_MS = 5000;
const MAX_RETRY_MS = 80_000;
/** The element's events after which what they change is drawn in the next animation frame. */
const INPUT_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointerout",
  "pointercancel",
  "wheel",
  "keydown",
  "keyup",
];

export class Playback {
  /** The animation frame asked for the next tick, 0 when none is. */
  private frame = 0;
  /** The timer set for it instead while the stage is still, 0 when none is. */
  private timer = 0;
  /** When that timer's tick is due, by the page's clock. */
  private due = 0;
  /** When it last drew, or the element last had input, by the page's clock. */
  private activeAt = 0;
  /** Whether the last tick was an animation frame's. */
  private framed = false;
  /** The timer's interval: a little under the display's, by the last run of animation frames. */
  private interval = DISPLAY_INTERVAL * EARLY;
  /** The times between that run's animation frames, the last GAPS of them, a ring. */
  private readonly gaps: number[] = [];
  private nextGap = 0;
  /** The animation frame a still stage asked for, 0 when it came, and when it asked. */
  private probe = 0;
  private probedAt = 0;
  /** How late the last timer ticks came, in ms, a ring. */
  private readonly lateness: number[] = [];
  private nextLateness = 0;
  /** Until when a still stage keeps to animation frames, its timers having come too late, and for how long next time. */
  private framesUntil = 0;
  private retry = RETRY_MS;
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
  /** The hidden textarea that takes an IME's text, focused while an input field has focus. */
  private readonly textInput: TextInput;
  private destroyed = false;
  /** The stage's quality it last drew by. */
  private quality = "";

  private constructor(
    private readonly box: HTMLElement,
    private readonly player: Player,
    private readonly scripting: Scripting | null,
    private readonly view: RenderView,
    private readonly look: () => Look,
    private readonly report: (error: unknown) => void,
    private readonly stage3D: Stage3DSession | null,
  ) {
    const canvas = view.canvas;
    canvas.style.position = "absolute";
    canvas.style.display = "block";
    if (stage3D) {
      canvas.style.zIndex = "1";
    }
    box.append(canvas);
    if (scripting) {
      scripting.drawer = view;
      scripting.onStageLayout = this.stageLayout;
    }

    // An AVM1 movie's BitmapData draws display objects by it too.
    if (player.avm1) {
      player.avm1.drawer = view;
    }

    this.unbind.push(this.view.bindPointer(player));
    // The element's keys alone, as a plug-in had them only while focused.
    const host = (box.getRootNode() as ShadowRoot).host ?? box;
    this.unbind.push(bindKeyboard(player, host));
    this.textInput = bindTextInput(player, host as HTMLElement, box);
    this.unbind.push(() => this.textInput.destroy());
    // Its keys' releases are lost when the window or the element loses focus: the player lets them go.
    this.unbind.push(bindActivation(player, window, host as HTMLElement));
    // Input changes what shows, and its drawing is not to wait for a timer: a hover is drawn
    // in the next animation frame, as any change was before a still stage ticked by timers.
    for (const type of INPUT_EVENTS) {
      host.addEventListener(type, this.input, { capture: true, passive: true });
    }
    this.unbind.push(() => {
      for (const type of INPUT_EVENTS) {
        host.removeEventListener(type, this.input, { capture: true });
      }
    });
    // Shown again, the stage is drawn anew rather than trusted to the canvas a hidden page kept.
    document.addEventListener("visibilitychange", this.shown);
    this.unbind.push(() => document.removeEventListener("visibilitychange", this.shown));
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(box);
    this.layout();
  }

  /**
   * A renderer for `player` in `box` (docs/renderer.md), which takes WebGL 2.
   * The canvas is not multisampled: the stage is drawn into buffers that
   * are, but at low quality, which Flash draws aliased. It keeps alpha where
   * it may ever be left clear, for a transparent wmode or Stage3D's layers
   * below.
   */
  static async create(
    box: HTMLElement,
    player: Player,
    scripting: Scripting | null,
    look: () => Look,
    report: (error: unknown) => void,
    stage3D: Stage3DSession | null = null,
  ): Promise<Playback> {
    // The view makes its own tessellator, and throws where the page cannot run the render module.
    const { RenderView } = await import("@swf2es/player/scene");
    const view = new RenderView({
      width: player.width,
      height: player.height,
      resolution: 1,
      background: player.background,
      transparent: !!stage3D || look().wmode === "transparent",
    });

    return new Playback(box, player, scripting, view, look, report, stage3D);
  }

  /** The renderer's WebGL context, null once destroyed. */
  get gl(): WebGL2RenderingContext | null {
    if (this.destroyed) {
      return null;
    }

    return this.view.gl;
  }

  /** Play and draw from the next animation frame on. */
  run(): void {
    if (!this.destroyed && !this.frame && !this.timer) {
      this.frame = requestAnimationFrame(this.animate);
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

  private readonly shown = () => {
    if (document.visibilityState === "visible") {
      this.dirty = true;
    }
  };

  /** Input on the element: ticks by animation frames from the next. */
  private readonly input = () => {
    this.activeAt = performance.now();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
      this.wait();
    }
  };

  /** A tick in an animation frame, where what it draws shows in step with the display. */
  private readonly animate = (now: number) => {
    this.frame = 0;
    if (this.framed && this.last !== null && now > this.last) {
      this.gaps[this.nextGap] = now - this.last;
      this.nextGap = (this.nextGap + 1) % GAPS;
    }

    this.framed = true;
    // A stage drawn on lately has its next tick in the next animation frame whatever this one
    // does: asked for first, as a loop of animation frames asks.
    if (now - this.activeAt < STILL_MS) {
      this.frame = requestAnimationFrame(this.animate);
    }

    this.tick(now);
  };

  /** A tick by the timer, while the stage is still. */
  private readonly timed = () => {
    this.timer = 0;
    const now = performance.now();
    // Hidden, the page has no animation frames and the player stops with them, where a timer
    // would go on once a second.
    if (document.visibilityState !== "visible") {
      this.wait();
      return;
    }

    this.late(now - this.due, now);
    this.framed = false;
    this.tick(now);
  };

  /**
   * A timer's tick came `ms` late. Timers too coarse to keep the display's
   * interval would have the player run its frames in batches: where the
   * lower median of the last ticks' lateness is half an interval, as the
   * player's typical interval is the lower median of its last calls, a still
   * stage keeps to animation frames for a while, and tries the timers again
   * after it, twice as long each time they fail in a row. A thread busy now and then
   * makes some ticks late, not most of them, and batches no frame.
   */
  private late(ms: number, now: number): void {
    const lateness = this.lateness;
    lateness[this.nextLateness] = ms;
    this.nextLateness = (this.nextLateness + 1) % LATENESSES;
    if (lateness.length < LATENESSES) {
      return;
    }

    if (!tooLate(lateness, this.interval)) {
      this.retry = RETRY_MS;
      return;
    }

    this.framesUntil = now + this.retry;
    this.retry = Math.min(MAX_RETRY_MS, this.retry * 2);
    lateness.length = 0;
    this.nextLateness = 0;
  }

  private readonly probed = () => {
    this.probe = 0;
  };

  /** The next tick is the next animation frame's, whenever the page has one. */
  private wait(): void {
    cancelAnimationFrame(this.probe);
    this.probe = 0;
    this.frame = requestAnimationFrame(this.animate);
  }

  /**
   * The next tick asked for: an animation frame's, or a timer's once the
   * stage is still. The browser makes a frame of the page ready for every
   * animation frame asked of it, drawn to or not, which costs a still stage
   * more than its ticks do; a timer at the display's interval ticks the
   * same, and the tick that finds something to draw draws it at once and
   * goes back to animation frames. Not under Stage3D, which presents on its
   * own canvases, nor where the page's animation frames have stopped, as
   * out of sight in a frame of another origin: the one a still stage asks
   * for now and then has not come, and the player waits with them.
   */
  private schedule(now: number): void {
    if (this.destroyed || this.frame) {
      return;
    }

    if (
      now - this.activeAt < STILL_MS ||
      now < this.framesUntil ||
      this.stage3D?.active ||
      document.visibilityState !== "visible"
    ) {
      if (!this.framed) {
        this.gaps.length = 0;
        this.nextGap = 0;
      }

      this.wait();
      return;
    }

    if (this.framed) {
      // 240 Hz at most, and no slower than a tenth of a second.
      if (this.gaps.length >= MIN_GAPS) {
        this.interval = Math.min(100, Math.max(1000 / 240, displayInterval(this.gaps) * EARLY));
      }

      this.due = now;
      this.probedAt = now;
      this.lateness.length = 0;
      this.nextLateness = 0;
    } else if (now - this.probedAt >= PROBE_MS) {
      if (this.probe) {
        this.wait();
        return;
      }

      this.probedAt = now;
      this.probe = requestAnimationFrame(this.probed);
    }

    // On the grid of the last animation frame, so that the timers' lateness does not add up;
    // from now after a stall.
    const at = performance.now();
    this.due = Math.max(this.due + this.interval, at);
    this.timer = window.setTimeout(this.timed, this.due - at);
  }

  private tick(at: number): void {
    // An animation frame's time is its display frame's, which may be before a timer's tick ran.
    const now = this.last === null ? at : Math.max(at, this.last);
    const dt = this.last === null ? 0 : now - this.last;
    this.last = now;
    // The next is asked for whatever this one throws, as when it was asked first.
    try {
      this.play(dt);
      if ((this.player.changes !== this.drawn || this.dirty) && this.draw()) {
        this.activeAt = Math.max(this.activeAt, now);
      }
    } finally {
      this.schedule(now);
    }
  }

  /** The player advanced by `dt` ms, and what follows from its frames. */
  private play(dt: number): void {
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
    // The frame's clicks, Tabs and scripts may have moved the SWF's focus into or out of a field.
    this.textInput.sync();

    if (this.player.quality !== this.quality) {
      this.requality();
    }
  }

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
   * for each of its pixels (denseSamples). Only as fine as the screen makes
   * it, though: a stage zoomed into a large window on a screen of ratio 1
   * shows each canvas pixel at its full size, where 4 levels of coverage
   * show as rough edges.
   */
  private resample(): void {
    const canvas = this.view.canvas;
    const quality = this.player.quality;
    this.view.quality = quality;
    this.view.samples = stageSamples(
      quality,
      canvas.width * canvas.height,
      this.view.canvasResolution,
      devicePixelRatio || 1,
    );
  }

  /** Whether it drew. */
  private draw(): boolean {
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
    const forced = this.dirty;
    this.drawn = this.player.changes;
    this.dirty = false;
    this.view.background = background;
    this.view.transparent = clear;
    // A frame played that changed nothing drawn is left as it shows: no frame for the browser to
    // composite, as Flash repaints nothing of a still stage. What the host changed draws anew.
    if (forced || !this.view.unchanged(this.player.stage)) {
      this.view.render(this.player.stage);
      return true;
    }

    return false;
  }

  /**
   * The SWF set its stage's scaleMode or align, or began: placed again, and
   * the page told by a stagelayout event, once the script that set it
   * returns, so that no listener runs inside it.
   */
  private readonly stageLayout = () => {
    this.layout();
    const scripting = this.scripting;
    if (!scripting) {
      return;
    }

    queueMicrotask(() => {
      if (this.destroyed) {
        return;
      }

      const detail = { scaleMode: scripting.stageScaleMode, align: scripting.stageAlign };
      this.box.dispatchEvent(
        new CustomEvent("stagelayout", { bubbles: true, composed: true, detail }),
      );
    });
  };

  /** The canvas placed in the box by the look, and drawn at the device's pixels. */
  private layout(): void {
    if (this.destroyed) {
      return;
    }

    const look = this.look();
    const scripting = this.scripting;
    scripting?.setStageDefaults(look.scale, look.salign ?? "");
    const mode = scripting?.stageScaleMode ?? look.scale;
    const align = scripting?.stageAlign ?? look.salign;
    // In full screen with a fullScreenSourceRect, that part of the stage alone is shown.
    const rect = scripting?.fullScreen.rect ?? null;
    // Live noScale makes the stage the box's size, or the source rect's; every other mode keeps the SWF's.
    const noScale = !!scripting && mode === "noScale";
    const stageWidth = noScale ? (rect?.width ?? this.box.clientWidth) : this.player.width;
    const stageHeight = noScale ? (rect?.height ?? this.box.clientHeight) : this.player.height;
    this.dpr = devicePixelRatio || 1;
    const placed = place(
      this.player.width || 1,
      this.player.height || 1,
      this.box.clientWidth,
      this.box.clientHeight,
      mode,
      align,
      this.dpr,
      // AIR's top and left edges win where both are named; checked with Stage3D only.
      !!this.stage3D,
    );
    const view = rect
      ? sourceViewport(rect, this.box.clientWidth, this.box.clientHeight, this.dpr)
      : viewport(
          this.player.width || 1,
          this.player.height || 1,
          this.box.clientWidth,
          this.box.clientHeight,
          mode,
          placed,
          this.player.originX,
          this.player.originY,
        );
    const canvas = this.view.canvas;
    canvas.style.left = `${view.css.x}px`;
    canvas.style.top = `${view.css.y}px`;
    canvas.style.width = `${view.css.width}px`;
    canvas.style.height = `${view.css.height}px`;
    const screenWidth = Math.max(1, view.width);
    const screenHeight = Math.max(1, view.height);
    // Compared in the canvas's pixels, which resize rounds the screen to: a fractional
    // screen would otherwise never compare equal and resize on every layout.
    if (
      view.resolution !== this.view.canvasResolution ||
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
    this.stage3D?.layout(
      rect ? stageAround(rect, view, this.player.width, this.player.height) : placed,
      this.player.width,
      this.player.height,
    );
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
    cancelAnimationFrame(this.probe);
    clearTimeout(this.timer);
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

    this.view.destroy();
    this.view.canvas.remove();
  }
}

/** Where the whole stage lies in the box when `view` shows `rect` of it: Stage3D's layers are placed by the stage. */
function stageAround(
  rect: { x: number; y: number; width: number },
  view: Viewport,
  stageWidth: number,
  stageHeight: number,
): Placement {
  const scale = view.css.width / rect.width;
  return {
    x: view.css.x - rect.x * scale,
    y: view.css.y - rect.y * scale,
    width: stageWidth * scale,
    height: stageHeight * scale,
    resolution: view.resolution,
  };
}

/**
 * Whether timer ticks that came `lateness` ms late are too late to tick a
 * still stage by, at `interval`: the lower median of their lateness half an
 * interval or more, where the player, whose typical interval is the lower
 * median of its last calls, would run two frames a call.
 */
export function tooLate(lateness: readonly number[], interval: number): boolean {
  const sorted = lateness.slice().sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1] >= interval / 2;
}

/**
 * The display's interval by the times between a run of animation frames: the mean of those
 * within a quarter of their median. Not the shortest: the first frames after a still period
 * come out of step, two at once in Firefox and one early in Chrome, and a timer at the time
 * between those ticked several times a display frame. Not the median: Firefox's frames come
 * 16 and 17 ms apart by turns, 60 a second. Nor the mean of all: a frame the page was too
 * busy for leaves a time twice as long.
 */
export function displayInterval(gaps: readonly number[]): number {
  const sorted = gaps.slice().sort((a, b) => a - b);
  const median = sorted[(sorted.length - 1) >> 1];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] >= median * 0.75 && gaps[i] <= median * 1.25) {
      sum += gaps[i];
      count++;
    }
  }

  return sum / count;
}

/** The most a canvas's multisampled buffers may take, colour and depth-stencil together. */
const STAGE_BYTES = 256 * 1024 * 1024;

/**
 * The samples a canvas of `pixels` takes at `quality`, at `resolution` of its
 * pixels to a stage pixel on a screen of `ratio` device pixels to a CSS pixel.
 */
export function stageSamples(
  quality: string,
  pixels: number,
  resolution: number,
  ratio: number,
): number {
  const samples = quality === "MEDIUM" ? 4 : quality === "HIGH" ? 8 : 16;
  // Fewer where a stage pixel spans several of the screen's, not where it is only zoomed.
  return denseSamples(Math.min(samples, fittingSamples(pixels)), Math.min(resolution, ratio));
}

/**
 * The samples a pixel of the canvas takes for `samples` a stage pixel, at
 * `resolution` of the canvas's pixels to a stage pixel, at most the
 * screen's pixels to a CSS pixel: where a stage pixel
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
