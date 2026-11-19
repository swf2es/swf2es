// The performance meter over the player, off until the viewer turns it on
// (the controls' Performance box, or Ctrl+Shift+F), twice a second: the
// SWF's frames played a second against its frame rate, the player's time in
// a frame (its scripts and its drawing, as the element's frame listener
// tells them), the draws of a frame the player drew and the WebGL calls that
// made them, the JS heap where the browser tells it (Chromium's
// performance.memory), and the WebAssembly memories behind the player. Off,
// it costs nothing: no listener, no timer, and the context's own functions.
import type { FrameStats, Swf2esPlayerElement } from "@swf2es/web";

interface MemoryInfo {
  usedJSHeapSize: number;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const DRAWS = ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"];
// Each of WEBGL_multi_draw's takes the number of draws it makes last.
const MULTI_DRAWS = [
  "multiDrawArraysWEBGL",
  "multiDrawElementsWEBGL",
  "multiDrawArraysInstancedWEBGL",
  "multiDrawElementsInstancedWEBGL",
];

/** The calls of the loop kept: a second's at 500 a second, more than any display's rate. */
const KEPT = 512;
/** The span the figures cover, and how often they are shown, in ms. */
const SPAN = 1000;
const EVERY = 500;
const MB = 1024 * 1024;
/** Where the viewer's choice is kept, "1" for on. */
const STORED = "swf2es.performanceMeter";

/**
 * The draw calls made on a context, counted by wrapping its draw functions
 * only while the meter shows: off, and before a context is given, the
 * context has its own functions back, its canvas none of the counter's
 * listeners, and the count costs nothing. A multi-draw is one call and the
 * draws it makes, as the GPU sees them.
 */
class DrawCounter {
  draws = 0;
  calls = 0;
  private gl: GL | null = null;
  private shown = false;
  private readonly restores: (() => void)[] = [];

  /** Count `gl`'s draws, while shown; null for none. */
  attach(gl: GL | null): void {
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

    for (const name of DRAWS) {
      this.patch(gl, name, () => 1);
    }

    const multi = gl.getExtension("WEBGL_multi_draw");
    if (multi) {
      for (const name of MULTI_DRAWS) {
        this.patch(multi, name, (args) => args[args.length - 1] as number);
      }
    }
  }

  private unwrap(): void {
    for (const restore of this.restores.splice(0)) {
      restore();
    }
  }

  /** Wrap `target[name]`, to be put back as it was, a property of its own or its prototype's. */
  private patch(target: object, name: string, count: (args: unknown[]) => number): void {
    const functions = target as Record<string, unknown>;
    const original = functions[name];
    if (typeof original !== "function") {
      return;
    }

    const own = Object.getOwnPropertyDescriptor(target, name);
    functions[name] = (...args: unknown[]) => {
      this.draws += count(args);
      this.calls++;
      return original.apply(target, args);
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

/** The figures' cells, each a <dd> in a row of its own. */
export interface MeterCells {
  fps: HTMLElement;
  frameTime: HTMLElement;
  subDraws: HTMLElement;
  glCalls: HTMLElement;
  /** Its row hidden where the browser does not tell the heap. */
  heap: HTMLElement;
  codegen: HTMLElement;
  native: HTMLElement;
}

export class Meter {
  private shown = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly counter = new DrawCounter();
  /** The loop's last KEPT calls, a ring: each one's time, frames played, and ms (-1 for no work). */
  private readonly times = new Float64Array(KEPT);
  private readonly frames = new Float64Array(KEPT);
  private readonly costs = new Float64Array(KEPT);
  private readonly sorted = new Float64Array(KEPT);
  private next = 0;
  private count = 0;
  /** When the calls counted began: shown, or a SWF loaded, whichever came last. */
  private since = 0;
  /** The SWF's frame rate as of the last call, 0 before one. */
  private rate = 0;
  /** The draws, and the calls that made them, of the frames that drew since the last showing. */
  private draws = 0;
  private calls = 0;
  private drawnFrames = 0;

  constructor(
    private readonly player: Swf2esPlayerElement,
    private readonly root: HTMLElement,
    private readonly cells: MeterCells,
  ) {}

  get on(): boolean {
    return this.shown;
  }

  /** Show the meter and measure, or hide it and stop. */
  show(on: boolean): void {
    if (on === this.shown) {
      return;
    }

    this.shown = on;
    this.root.hidden = !on;
    this.counter.show(on);
    this.player.frameListener = on ? this.heard : null;
    clearInterval(this.timer);
    this.timer = undefined;
    if (on) {
      this.reset();
      this.timer = setInterval(this.update, EVERY);
      this.update();
    }
  }

  /** A new SWF, drawing with `gl`, or none: what was counted of the last is let go. */
  watch(gl: GL | null): void {
    this.counter.attach(gl);
    this.reset();
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
    this.cells.subDraws.textContent = "–";
    this.cells.glCalls.textContent = "–";
  }

  /** Each call of the player's loop, kept in the ring without allocating. */
  private readonly heard = (stats: FrameStats) => {
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
    const cells = this.cells;
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
    const playing = this.player.player !== null && this.rate > 0;
    cells.fps.textContent =
      playing && span >= EVERY / 2
        ? `${((played * 1000) / span).toFixed(1)} / ${rateText(this.rate)}`
        : "–";
    cells.frameTime.textContent =
      playing && working > 0
        ? `${median(this.sorted, working).toFixed(1)} ms, max ${this.sorted[working - 1].toFixed(1)}`
        : "–";
    // A still stage draws nothing: the last frame drawn stands.
    if (this.drawnFrames > 0) {
      cells.subDraws.textContent = String(Math.round(this.draws / this.drawnFrames));
      cells.glCalls.textContent = String(Math.round(this.calls / this.drawnFrames));
    }

    const memory = (performance as { memory?: MemoryInfo }).memory;
    const heapRow = cells.heap.parentElement;
    if (heapRow) {
      heapRow.hidden = !memory;
    }

    if (memory) {
      cells.heap.textContent = megabytes(memory.usedJSHeapSize);
    }

    const wasm = this.player.wasmMemory;
    cells.codegen.textContent = wasm.codegen > 0 ? megabytes(wasm.codegen) : "–";
    cells.native.textContent = megabytes(wasm.native);
    this.draws = this.calls = this.drawnFrames = 0;
  };

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

/** The viewer's choice as last kept: off where none is, or storage is refused. */
function stored(): boolean {
  try {
    return localStorage.getItem(STORED) === "1";
  } catch {
    return false;
  }
}

function store(on: boolean): void {
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
 * The meter turned on and off by `toggle` and by Ctrl+Shift+F, as the
 * viewer last left it. The shortcut is the page's even while the player has
 * the focus: its F, pressed and released, never reaches the SWF. An F held
 * down before is the SWF's, its repeats and its release with it, so that it
 * is never left held there.
 */
export function bindMeter(meter: Meter, toggle: HTMLInputElement): void {
  const set = (on: boolean) => {
    toggle.checked = on;
    meter.show(on);
    store(on);
  };
  toggle.addEventListener("change", () => set(toggle.checked));
  let swallowed = false;
  addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "KeyF" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) {
        return;
      }

      if (e.repeat && !swallowed) {
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();
      swallowed = true;
      if (!e.repeat) {
        set(!meter.on);
      }
    },
    { capture: true },
  );
  addEventListener(
    "keyup",
    (e) => {
      if (swallowed && e.code === "KeyF") {
        swallowed = false;
        e.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  // A release the window never hears, the focus gone elsewhere, leaves no F to swallow later.
  addEventListener("blur", () => {
    swallowed = false;
  });
  if (stored()) {
    toggle.checked = true;
    meter.show(true);
  }
}
