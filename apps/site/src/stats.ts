// The figures under the player, twice a second: the SWF's frames played a
// second against its frame rate, the main thread's time in an animation
// frame, and the JS heap where the browser tells it (Chromium's
// performance.memory).

/** What the element's player gives that is counted here: its advance, which the element calls each animation frame. */
interface Advancing {
  advance(dt: number, busy?: number): number;
}

interface MemoryInfo {
  usedJSHeapSize: number;
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

  constructor(
    private readonly fps: HTMLElement,
    private readonly frameTime: HTMLElement,
    private readonly heap: HTMLElement,
  ) {
    // A message posted from an animation frame arrives once the frame's
    // callbacks, style, layout and paint are done: that much is its work.
    this.channel.port1.onmessage = () => {
      this.busy += performance.now() - this.frameStart;
      this.frames++;
    };
    requestAnimationFrame(this.frame);
    setInterval(() => this.show(), 500);
  }

  /** Count the frames `player` plays; null for none. */
  watch(player: Advancing | null, frameRate: number): void {
    this.watching = player;
    this.rate = frameRate;
    this.played = 0;
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
    const memory = (performance as { memory?: MemoryInfo }).memory;
    this.heap.textContent = memory ? `${(memory.usedJSHeapSize / 1048576).toFixed(0)} MB` : "n/a";
    this.played = 0;
    this.busy = 0;
    this.frames = 0;
    this.since = now;
  }
}
