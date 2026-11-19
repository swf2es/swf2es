// The performance meter the element shows over its player, off until the
// viewer turns it on (the context menu's "Show performance", or the page,
// through `performanceMeter`): twice a second, the SWF's frames played a
// second against its frame rate, the player's ms in a frame (its scripts
// and its drawing, as the frame listener tells them), the draws of a frame
// the player drew and the WebGL calls that made them, the JS heap where the
// browser tells it (Chromium's performance.memory), and the WebAssembly
// memories behind the player. Off, it costs nothing: it is not even made
// until first shown, and once hidden it hears no frames, keeps no timer and
// leaves the context its own functions.
import type { FrameStats } from "./playback.js";

interface MemoryInfo {
  usedJSHeapSize: number;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

/**
 * Its look, which a page may give its own through custom properties on the
 * element (font, color, background, border and muted, the labels' colour),
 * as the demo site gives its theme's; by default the browser's light or dark
 * colours, as the context menu's.
 */
export const METER_STYLE =
  " .meter { position: absolute; top: 6px; left: 6px; z-index: 3; display: grid;" +
  " grid-template-columns: max-content max-content; gap: 0 8px; box-sizing: border-box;" +
  " max-width: calc(100% - 12px); overflow: hidden; margin: 0; padding: 3px 7px;" +
  " font: var(--swf2es-meter-font, 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);" +
  " font-variant-numeric: tabular-nums; color-scheme: light dark;" +
  " color: var(--swf2es-meter-color, CanvasText); background: var(--swf2es-meter-background, Canvas);" +
  " border: 1px solid var(--swf2es-meter-border, GrayText); border-radius: 4px;" +
  " pointer-events: none; user-select: none }" +
  " .meter[hidden], .meter > div[hidden] { display: none }" +
  " .meter > div { display: contents }" +
  " .meter dt { color: var(--swf2es-meter-muted, GrayText) }" +
  " .meter dd { margin: 0; text-align: right }";

/** Each figure's name, in the dd's `data-figure`, and its label. */
const FIGURES = [
  ["fps", "fps"],
  ["frame", "frame"],
  ["sub-draws", "sub-draws"],
  ["gl-calls", "GL calls"],
  ["heap", "JS heap"],
  ["codegen", "codegen"],
  ["native", "native"],
] as const;

/**
 * The draw functions counted, each with where its count of draws is: -1 for
 * one, else the index of its last argument, a multi-draw's drawcount.
 */
const DRAWS: [string, number][] = [
  ["drawArrays", -1],
  ["drawElements", -1],
  ["drawArraysInstanced", -1],
  ["drawElementsInstanced", -1],
];
const MULTI_DRAWS: [string, number][] = [
  ["multiDrawArraysWEBGL", 5],
  ["multiDrawElementsWEBGL", 6],
  ["multiDrawArraysInstancedWEBGL", 7],
  ["multiDrawElementsInstancedWEBGL", 8],
];

/** The calls of the loop kept: a second's at 500 a second, more than any display's rate. */
const KEPT = 512;
/** The span the figures cover, and how often they are shown, in ms. */
const SPAN = 1000;
const EVERY = 500;
const MB = 1024 * 1024;
/** Where the viewer's choice is kept for every element of the origin, "1" for on. */
const STORED = "swf2es.performanceMeter";

/** The viewer's choice as last kept: off where none is, or storage is refused. */
export function storedMeter(): boolean {
  try {
    return localStorage.getItem(STORED) === "1";
  } catch {
    return false;
  }
}

export function storeMeter(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(STORED, "1");
    } else {
      localStorage.removeItem(STORED);
    }
  } catch {
    // Kept for this page alone.
  }
}

/**
 * The draw calls made on a context, counted by wrapping its draw functions
 * only while the meter shows: off, and before a context is given, the
 * context has its own functions back, its canvas none of the counter's
 * listeners, and the count costs nothing. A multi-draw is one call and the
 * draws it makes, as the GPU sees them. The renderer counts neither itself.
 */
class DrawCounter {
  draws = 0;
  calls = 0;
  private gl: GL | null = null;
  private shown = false;
  private readonly restores: (() => void)[] = [];

  /** Count `gl`'s draws, while shown; null for none. */
  attach(gl: GL | null): void {
    if (gl === this.gl) {
      return;
    }

    this.listen(false);
    this.unwrap();
    this.gl = gl;
    if (this.shown) {
      this.listen(true);
      this.wrap();
    }
  }

  show(shown: boolean): void {
    if (shown === this.shown) {
      return;
    }

    this.shown = shown;
    this.listen(shown);
    if (shown) {
      this.wrap();
    } else {
      this.unwrap();
    }
  }

  /** Hear the context lost and given back, or no longer. */
  private listen(on: boolean): void {
    const canvas = this.gl?.canvas;
    if (!canvas) {
      return;
    }

    if (on) {
      canvas.addEventListener("webglcontextlost", this.lost);
      canvas.addEventListener("webglcontextrestored", this.restored);
    } else {
      canvas.removeEventListener("webglcontextlost", this.lost);
      canvas.removeEventListener("webglcontextrestored", this.restored);
    }
  }

  private readonly lost = () => this.unwrap();
  // The renderer's own listener, added before this one, has fetched the extensions anew.
  private readonly restored = () => this.wrap();

  private wrap(): void {
    const gl = this.gl;
    this.unwrap();
    if (!gl || !this.shown || gl.isContextLost()) {
      return;
    }

    for (const [name, drawcount] of DRAWS) {
      this.patch(gl, name, drawcount);
    }

    const multi = gl.getExtension("WEBGL_multi_draw");
    if (multi) {
      for (const [name, drawcount] of MULTI_DRAWS) {
        this.patch(multi, name, drawcount);
      }
    }
  }

  private unwrap(): void {
    for (const restore of this.restores.splice(0)) {
      restore();
    }
  }

  /**
   * Wrap `target[name]`, to be put back as it was, a property of its own or
   * its prototype's: with as many arguments as the widest multi-draw takes,
   * the rest undefined, which WebGL ignores, so that a draw allocates no
   * array of its arguments.
   */
  private patch(target: object, name: string, drawcount: number): void {
    const functions = target as Record<string, unknown>;
    const original = functions[name] as (...args: unknown[]) => unknown;
    if (typeof original !== "function") {
      return;
    }

    const own = Object.getOwnPropertyDescriptor(target, name);
    functions[name] = (
      a: unknown,
      b: unknown,
      c: unknown,
      d: unknown,
      e: unknown,
      f: unknown,
      g: unknown,
      h: unknown,
      i: unknown,
    ) => {
      this.calls++;
      this.draws +=
        drawcount === 5
          ? (f as number)
          : drawcount === 6
            ? (g as number)
            : drawcount === 7
              ? (h as number)
              : drawcount === 8
                ? (i as number)
                : 1;
      return original.call(target, a, b, c, d, e, f, g, h, i);
    };
    this.restores.push(() => {
      if (own) {
        Object.defineProperty(target, name, own);
      } else {
        delete functions[name];
      }
    });
  }
}

export class PerformanceMeter {
  private readonly root: HTMLDListElement;
  private readonly cells = new Map<string, HTMLElement>();
  private shown = false;
  /** Whether a player plays, whose frames the meter hears. */
  private playing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly counter = new DrawCounter();
  /** The loop's last KEPT calls, a ring: each one's time, frames played, and ms (-1 for no work). */
  private readonly times = new Float64Array(KEPT);
  private readonly frames = new Float64Array(KEPT);
  private readonly costs = new Float64Array(KEPT);
  private readonly sorted = new Float64Array(KEPT);
  private next = 0;
  private count = 0;
  /** When the calls counted began: shown, or a SWF started, whichever came last. */
  private since = 0;
  /** The SWF's frame rate as of the last call, 0 before one. */
  private rate = 0;
  /** The draws, and the calls that made them, of the frames that drew since the last showing. */
  private draws = 0;
  private calls = 0;
  private drawnFrames = 0;

  /** Shown in `parent`, the element's shadow root; `memory` is the element's wasmMemory. */
  constructor(
    parent: Node,
    private readonly memory: () => { codegen: number; native: number },
  ) {
    this.root = document.createElement("dl");
    this.root.className = "meter";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Performance");
    for (const [name, label] of FIGURES) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.dataset.figure = name;
      dd.textContent = "–";
      row.append(dt, dd);
      this.root.append(row);
      this.cells.set(name, dd);
    }

    parent.appendChild(this.root);
  }

  /** Show the meter and measure, or hide it and stop. */
  show(on: boolean): void {
    if (on === this.shown) {
      return;
    }

    this.shown = on;
    this.root.hidden = !on;
    this.counter.show(on);
    if (on) {
      this.reset();
    }

    this.tick();
  }

  /** A player begun, drawing with `gl`, or none playing: what was counted before is let go. */
  attach(gl: GL | null, playing: boolean): void {
    this.counter.attach(gl);
    this.playing = playing;
    this.reset();
    this.tick();
  }

  /** The timer runs while the meter shows a player's figures; it shows them at once as it starts. */
  private tick(): void {
    const run = this.shown && this.playing;
    if (run && this.timer === undefined) {
      this.timer = setInterval(this.update, EVERY);
    } else if (!run && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.shown) {
      this.update();
    }
  }

  private reset(): void {
    this.next = this.count = 0;
    this.since = performance.now();
    this.rate = 0;
    this.counter.draws = this.counter.calls = 0;
    this.draws = this.calls = this.drawnFrames = 0;
    this.text("sub-draws", "–");
    this.text("gl-calls", "–");
  }

  /** Each call of the player's loop, kept in the ring without allocating. */
  readonly heard = (stats: FrameStats): void => {
    const i = this.next;
    this.next = i + 1 === KEPT ? 0 : i + 1;
    if (this.count < KEPT) {
      this.count++;
    }

    this.times[i] = stats.time;
    this.frames[i] = stats.frames;
    this.costs[i] = stats.frames > 0 || stats.drew ? stats.play + stats.draw : -1;
    this.rate = stats.frameRate;
    // What the context was asked since the last call belongs to the frame this one drew.
    if (stats.drew && this.counter.calls > 0) {
      this.draws += this.counter.draws;
      this.calls += this.counter.calls;
      this.drawnFrames++;
    }

    this.counter.draws = this.counter.calls = 0;
  };

  private readonly update = () => {
    const now = performance.now();
    const from = Math.max(now - SPAN, this.since);
    let played = 0;
    let working = 0;
    // From the newest back, to the span's start.
    for (let k = 0, i = this.next; k < this.count; k++) {
      i = i === 0 ? KEPT - 1 : i - 1;
      if (this.times[i] < from) {
        break;
      }

      played += this.frames[i];
      if (this.costs[i] >= 0) {
        this.insert(working++, this.costs[i]);
      }
    }

    const span = now - from;
    const playing = this.playing && this.rate > 0;
    this.text(
      "fps",
      playing && span >= EVERY / 2
        ? `${((played * 1000) / span).toFixed(1)} / ${rateText(this.rate)}`
        : "–",
    );
    this.text(
      "frame",
      playing && working > 0
        ? `${median(this.sorted, working).toFixed(1)} ms, max ${this.sorted[working - 1].toFixed(1)}`
        : "–",
    );
    // A still stage draws nothing: the last frame drawn stands.
    if (this.drawnFrames > 0) {
      this.text("sub-draws", String(Math.round(this.draws / this.drawnFrames)));
      this.text("gl-calls", String(Math.round(this.calls / this.drawnFrames)));
    }

    const heap = (performance as { memory?: MemoryInfo }).memory;
    const heapRow = this.cells.get("heap")?.parentElement;
    if (heapRow) {
      heapRow.hidden = !heap;
    }

    if (heap) {
      this.text("heap", megabytes(heap.usedJSHeapSize));
    }

    const wasm = this.memory();
    this.text("codegen", wasm.codegen > 0 ? megabytes(wasm.codegen) : "–");
    this.text("native", megabytes(wasm.native));
    this.draws = this.calls = this.drawnFrames = 0;
  };

  private text(figure: string, text: string): void {
    const cell = this.cells.get(figure);
    if (cell && cell.textContent !== text) {
      cell.textContent = text;
    }
  }

  /** Put `cost` among the first `n` sorted, by insertion: a second's few hundred, twice a second. */
  private insert(n: number, cost: number): void {
    const sorted = this.sorted;
    let j = n;
    while (j > 0 && sorted[j - 1] > cost) {
      sorted[j] = sorted[j - 1];
      j--;
    }

    sorted[j] = cost;
  }
}

function median(sorted: Float64Array, n: number): number {
  const middle = n >> 1;
  return n % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A frame rate as a SWF declares it, whole or to the hundredth: its 8.8 fixed point. */
function rateText(rate: number): string {
  return `${Number.isInteger(rate) ? rate : Number(rate.toFixed(2))} fps`;
}

function megabytes(bytes: number): string {
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}
