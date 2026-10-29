// The figures under the player, twice a second: the SWF's frames played a
// second against its frame rate, the main thread's time in an animation
// frame, the draws of a frame the player drew and the WebGL calls that made
// them, and the JS heap where the browser tells it (Chromium's
// performance.memory).

/** What the element's player gives that is counted here: its advance, which the element calls each animation frame. */
interface Advancing {
  advance(dt: number, busy?: number): number;
}

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

/**
 * The draw calls made on a context, counted by wrapping its draw functions
 * only while the figures are on screen: off it, and before a context is
 * given, the context has its own functions back and the count costs
 * nothing. A multi-draw is one call and the draws it makes, as the GPU sees
 * them.
 */
class DrawCounter {
  draws = 0;
  calls = 0;
  private gl: GL | null = null;
  private shown = false;
  private readonly restores: (() => void)[] = [];

  /** Count `gl`'s draws, while shown; null for none. */
  attach(gl: GL | null): void {
    this.unwrap();
    this.gl?.canvas.removeEventListener("webglcontextlost", this.lost);
    this.gl?.canvas.removeEventListener("webglcontextrestored", this.restored);
    this.gl = gl;
    gl?.canvas.addEventListener("webglcontextlost", this.lost);
    gl?.canvas.addEventListener("webglcontextrestored", this.restored);
    this.wrap();
  }

  show(shown: boolean): void {
    this.shown = shown;
    if (shown) {
      this.wrap();
    } else {
      this.unwrap();
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

export class Stats {
  private played = 0;
  private busy = 0;
  private frames = 0;
  private since = performance.now();
  private rate = 0;
  private watching: Advancing | null = null;
  private readonly channel = new MessageChannel();
  /** The time the animation frame being measured started at. */
  private frameStart = 0;
  private readonly counter = new DrawCounter();
  /** The draws, and the calls that made them, of the frames that drew since the last showing. */
  private draws = 0;
  private calls = 0;
  private drawnFrames = 0;

  constructor(
    private readonly fps: HTMLElement,
    private readonly frameTime: HTMLElement,
    private readonly subDraws: HTMLElement,
    private readonly glCalls: HTMLElement,
    private readonly heap: HTMLElement,
  ) {
    // The figures' list, which holds both of the counter's.
    new IntersectionObserver(([entry]) => this.counter.show(entry.isIntersecting)).observe(
      subDraws.closest("dl") ?? subDraws,
    );
    // A message posted from an animation frame arrives once the frame's
    // callbacks, style, layout and paint are done: that much is its work.
    this.channel.port1.onmessage = () => {
      this.busy += performance.now() - this.frameStart;
      this.frames++;
    };
    requestAnimationFrame(this.frame);
    setInterval(() => this.show(), 500);
  }

  /** Count the frames `player` plays, and the draw calls it makes on `gl`; null for none. */
  watch(player: Advancing | null, frameRate: number, gl: GL | null = null): void {
    this.watching = player;
    this.rate = frameRate;
    this.played = 0;
    this.counter.attach(gl);
    // The last player's frames counted towards nothing shown for this one.
    this.counter.draws = this.counter.calls = 0;
    this.draws = this.calls = this.drawnFrames = 0;
    this.subDraws.textContent = "–";
    this.glCalls.textContent = "–";
    if (!player) {
      return;
    }

    // Counted on the instance: the element's loop calls advance as a method of it.
    const advance = player.advance.bind(player);
    player.advance = (dt: number, busy?: number) => {
      const n = advance(dt, busy);
      if (this.watching === player) {
        this.played += n;
      }

      return n;
    };
  }

  private readonly frame = (now: number) => {
    this.frameStart = now;
    // One player's frame falls between two of these, whichever runs first.
    if (this.counter.calls > 0) {
      this.draws += this.counter.draws;
      this.calls += this.counter.calls;
      this.drawnFrames++;
      this.counter.draws = 0;
      this.counter.calls = 0;
    }

    this.channel.port2.postMessage(0);
    requestAnimationFrame(this.frame);
  };

  private show(): void {
    const now = performance.now();
    const seconds = (now - this.since) / 1000;
    this.fps.textContent = this.watching
      ? `${Math.round(this.played / seconds)} / ${this.rate}`
      : "–";
    this.frameTime.textContent =
      this.frames > 0 ? `${(this.busy / this.frames).toFixed(1)} ms` : "–";
    // A still stage draws nothing: the last frame drawn stands.
    if (this.drawnFrames > 0) {
      this.subDraws.textContent = String(Math.round(this.draws / this.drawnFrames));
      this.glCalls.textContent = String(Math.round(this.calls / this.drawnFrames));
    }
    const memory = (performance as { memory?: MemoryInfo }).memory;
    this.heap.textContent = memory ? `${(memory.usedJSHeapSize / 1048576).toFixed(0)} MB` : "n/a";
    this.played = 0;
    this.busy = 0;
    this.frames = 0;
    this.draws = 0;
    this.calls = 0;
    this.drawnFrames = 0;
    this.since = now;
  }
}
