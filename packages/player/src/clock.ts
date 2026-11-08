// A script's clock that skips a spin on getTimer: a loop that only reads
// the clock until it reaches a time, as a game that caps its frame rate
// waits for the next frame. In Flash the wait costs nothing visible; in a
// browser it holds the main thread. Once a spin is told from other reads,
// each read moves the clock a small step on instead, so the wait ends at
// once, and the clock holds at the time it waited for until the real one
// passes it, the next frame with it (Player.advance). AS3's getTimer
// (scripting/timers.ts) and AVM1's (avm1/timers.ts) share one of these
// each, so both clocks skip alike.

/**
 * The clock of one movie's scripts on a real clock: what getTimer tells,
 * unrounded, and how far ahead of the real clock a spin has moved it.
 */
export class SpinClock {
  /**
   * How far a spin on getTimer in the running pass has moved the clock
   * ahead of the real one, in ms; once the pass is over, `floor` holds it.
   */
  private skip = 0;
  /** The least time the clock tells: where the last pass that skipped left it, until the real clock passes it. */
  private floor = Number.NEGATIVE_INFINITY;
  /** The time getTimer last told, unrounded: a spin's steps go on from it. */
  private told = Number.NEGATIVE_INFINITY;
  /** The spin's detection: the real time of the last call to getTimer, and of the run of calls. */
  private lastCall = Number.NEGATIVE_INFINITY;
  private windowStart = Number.NaN;
  private windowCalls = 0;
  private denseSince = Number.NaN;
  /** Set while the running pass's calls to getTimer are a spin, each moving the clock a step. */
  private spinning = false;
  /** Set once the running pass's dense calls came from more than one place: no spin in it. */
  private refused = false;
  /** A call site being checked over the next calls, and how many are still to be checked. */
  private checking = "";
  private checks = 0;
  /** Where the last spin called getTimer from: the same loop next time is known at once. */
  private site: string | null = null;

  /** `elapsed`: the real clock's ms since the start, unrounded, never going back. */
  constructor(private readonly elapsed: () => number) {}

  /**
   * What getTimer tells, unrounded: the real time, or past it by what a
   * spin has skipped. Each call counts towards telling a spin.
   */
  read(): number {
    const real = this.elapsed();
    let time = Math.max(real + this.skip, this.floor);
    if (real - this.lastCall > SPIN_GAP) {
      // A pause between calls: whatever ran was no spin, or the spin is over.
      this.spinning = false;
      this.checks = 0;
      this.windowStart = real;
      this.windowCalls = 0;
      this.denseSince = Number.NaN;
    }

    this.lastCall = real;
    if (this.spinning || this.spins(real)) {
      // Each call a small step on from the last, so the wait ends within a
      // step of its time, and the time read just after it is the same ms.
      const next = Math.max(time, this.told + SPIN_STEP);
      if (next - real <= MAX_SKIP) {
        this.skip = next - real;
        time = next;
      } else {
        // Waiting longer than any frame limiter: it spins in real time, as it did.
        this.spinning = false;
        this.refused = true;
      }
    }

    this.told = time;
    return time;
  }

  /**
   * Whether the calls to getTimer up to this one make a spin, a loop that
   * does nothing but read the clock until it reaches a time: at least
   * SPIN_DENSITY calls a ms, for SPIN_MS on end, all from one place in the
   * script. Code that times itself, or does work between its reads, calls
   * it far less often; a profiler's begin and end are two places. A place
   * that spun before is known after one dense window.
   */
  private spins(real: number): boolean {
    if (this.refused) {
      return false;
    }

    if (this.checks === 0) {
      this.windowCalls++;
      if (this.windowCalls < SPIN_WINDOW) {
        return false;
      }

      const dense = real - this.windowStart <= SPIN_WINDOW / SPIN_DENSITY;
      if (dense && Number.isNaN(this.denseSince)) {
        this.denseSince = this.windowStart;
      } else if (!dense) {
        this.denseSince = Number.NaN;
      }

      this.windowStart = real;
      this.windowCalls = 0;
      if (!dense) {
        return false;
      }
    }

    // Read on this one line alone: the stacks differ by where they were read.
    const site = callSite();
    if (this.checks > 0) {
      this.checks--;
      if (site !== this.checking) {
        this.refused = true;
        this.checks = 0;
        return false;
      }

      if (this.checks > 0) {
        return false;
      }

      this.site = site;
    } else if (site !== this.site) {
      if (real - this.denseSince >= SPIN_MS) {
        this.checking = site;
        this.checks = SPIN_CHECKS;
      }

      return false;
    }

    this.spinning = true;
    return true;
  }

  /**
   * A pass is over: a spin's skip becomes the floor the clock holds at
   * until the real clock passes it, and the next pass's calls start anew.
   */
  settle(): void {
    if (this.skip > 0) {
      this.floor = Math.max(this.floor, this.elapsed() + this.skip);
      this.skip = 0;
    }

    this.spinning = false;
    this.refused = false;
    this.checks = 0;
    this.lastCall = Number.NEGATIVE_INFINITY;
  }

  /**
   * How far getTimer and the timers run ahead of the real clock, in ms,
   * since a spin had the clock skip to the time it waited for: the frames
   * wait for the real clock (Player.advance). Ends the pass that ran.
   */
  ahead(): number {
    this.settle();
    return Math.max(0, this.floor - this.elapsed());
  }

  /** What the clock tells beyond the real clock at `real`: the timers' time keeps to getTimer's. */
  lead(real: number): number {
    return Math.max(real + this.skip, this.floor) - real;
  }
}

/** Calls to getTimer a spin's dense windows are counted in. */
const SPIN_WINDOW = 1024;
/**
 * Calls a ms that a window must reach to be dense: a loop that only reads
 * the clock makes 5,000 to 10,000 in Chrome, one with a microsecond's
 * work between its reads at most 1,000.
 */
const SPIN_DENSITY = 1000;
/** Real ms of dense calls before a place not seen spinning before counts as a spin. */
const SPIN_MS = 2;
/** Consecutive calls whose place is checked to be the first's. */
const SPIN_CHECKS = 3;
/** Real ms between two calls that end a spin or a run of dense calls. */
const SPIN_GAP = 1;
/** How far each call in a spin moves the clock on, in ms: a wait overshoots its time by about that. */
const SPIN_STEP = 1 / 8;
/** The most a pass's spin moves the clock ahead of the real one, in ms. */
const MAX_SKIP = 1000;

/**
 * Where getTimer was called from, the script's frames included, AS3's or
 * AVM1's: the same loop's calls give the same, whatever depth they are at.
 */
function callSite(): string {
  return new Error().stack ?? "";
}
