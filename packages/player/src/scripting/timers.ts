// The player's clocks and the timers. Where the host has a real clock the
// timers fire as Flash's do, in each frame after ENTER_FRAME by the
// frame's time on the grid, and those shorter than a frame between frames
// too; otherwise by the frame clock, a frame moving it on and firing every
// due time in it after ENTER_FRAME. flash.utils.Timer starts and stops
// them, and getTimer tells the time.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export class Timers {
  /**
   * The frame clock, in ms since the start, moved by the frame step alone;
   * Timer fires by it without a real clock, and sounds go by it with one.
   */
  clock = 0;
  /**
   * By the frame clock, the time getTimer tells and a timer started now
   * counts from (sounds go by it with either clock): the clock,
   * except while a timer's closure runs, when it is the time the timer fell
   * due, as Flash fires timers between frames at their own times, so that
   * one timer set from another keeps the first's pace, not the frame's.
   */
  now = 0;
  private readonly realTime: (() => number) | null;
  /** The timers started, by their Timer objects, and a heap of them by when they fall due. */
  private readonly running = new Map<AsObject, TimerRecord>();
  private readonly timers = new TimerHeap();
  /** Timers started so far: a pass of the real clock fires those due in start order. */
  private starts = 0;
  /** Set by updateAfterEvent: a timer fired between frames has the stage render after it. */
  renderAsked = false;
  /**
   * The timers' time with a real clock: the host's, the sum of what it
   * passed to advance() since the first call, which started it at the
   * real clock's; NaN until then. Frames lie on an exact grid by it, where
   * the real clock read as each runs wobbles with the host's latency, and
   * a timer as long as a frame would miss frames by a fraction of a ms.
   */
  private host = Number.NaN;
  /** elapsed() when `host` last moved, to tell the time between calls. */
  private hostReal = 0;
  /**
   * The time of the frame or the between-frames pass that runs, which a
   * timer started in it counts from; NaN outside. A frame's is the call's
   * time, less the frame interval for each frame the call plays after it.
   */
  private at = Number.NaN;
  /**
   * The running frame's time on the frame grid: the time it fell due,
   * which the timers as long as a frame or longer go by, so that one of
   * the frame's length fires every frame however the host's calls fall
   * (a 25 fps SWF's frames are 33 and 50 ms apart at 60 Hz). Those shorter
   * go by `at`, so as not to wait for a between-frames check's time plus
   * their delay while the frame runs late.
   */
  private grid = Number.NaN;
  /** The last pass's time: none goes back before it. */
  private lastPass = Number.NEGATIVE_INFINITY;
  /** The real clock's last finite reading, and the sum of its forward steps since the start. */
  private lastRaw = Number.NaN;
  private sum = 0;

  constructor(
    private readonly s: Scripting,
    options: { realTime?: (() => number) | null },
  ) {
    this.realTime = options.realTime === undefined ? defaultClock() : options.realTime;
    // getTimer's zero: when the player is made, as Flash's is when it starts.
    if (this.realTime) {
      this.elapsed();
    }
  }

  /**
   * What getTimer tells: whole milliseconds since the start, by the real
   * clock, truncated as Flash's are, or by the frame clock's now, rounded
   * as it always has been, so that the traces recorded by it stay.
   */
  timer(): number {
    return this.realTime ? Math.floor(this.elapsed()) : Math.round(this.now);
  }

  /**
   * Milliseconds since the start by the real clock, unrounded: the sum of
   * its forward steps, so that a reading that is not finite is skipped and
   * one that jumps back neither goes back nor stops the time after it.
   */
  private elapsed(): number {
    const raw = (this.realTime as () => number)();
    if (Number.isFinite(raw)) {
      if (raw > this.lastRaw) {
        this.sum += raw - this.lastRaw;
      }

      this.lastRaw = raw;
    }

    return this.sum;
  }

  /** The timers' time now with a real clock: the host's, run on by the real clock since. */
  private current(): number {
    const real = this.elapsed();
    return Number.isNaN(this.host) ? real : this.host + (real - this.hostReal);
  }

  /** advance() was called with `passed` ms: the host's time moves on. */
  hostPassed(passed: number): void {
    if (!this.realTime) {
      return;
    }

    const real = this.elapsed();
    this.host = Number.isNaN(this.host) ? real : this.host + passed;
    this.hostReal = real;
  }

  /**
   * The next frame of the call runs `slot` ms of frames before its last,
   * and fell due on the grid `rest` ms before that; both NaN once the
   * call's frames are over.
   */
  frameAt(slot: number, rest: number): void {
    const off = Number.isNaN(slot) || Number.isNaN(this.host);
    this.at = off ? Number.NaN : this.host - slot;
    this.grid = off ? Number.NaN : this.host - slot - rest;
  }

  /** A frame begins: the frame clock moves on by `ms`; its timers fire after ENTER_FRAME. */
  beginFrame(ms: number): void {
    this.clock += ms;
    this.now = this.clock;
  }

  /**
   * By the frame clock, the timers that fall due by the frame's time, each
   * firing the earliest due, so that two timers interleave as their times
   * do and one started from another with time to spare fires in the same
   * pass.
   */
  private fireByClock(): void {
    try {
      for (;;) {
        const next = this.timers.pop(this.clock);
        if (!next) {
          break;
        }

        this.now = next.due;
        next.due += next.delay;
        try {
          this.s.rt.call(next.closure, next.object);
        } catch (error) {
          // Reported, and the timers after it and the frame still run.
          this.s.reportUncaught(error);
        } finally {
          // Pushed back whatever the call did, unless it stopped the timer or
          // started it anew: one whose closure throws still has its next time.
          if (!next.stopped) {
            this.timers.push(next);
          }
        }
      }
    } finally {
      this.now = this.clock;
    }
  }

  /**
   * The frame's timers, after ENTER_FRAME and before the frame's
   * construction, as Flash fires them: by the real clock every timer due
   * fires once; by the frame clock every due time in the frame fires.
   */
  frameTimers(): void {
    if (this.realTime) {
      // A frame run by tick() alone, not advance(), goes by the time now.
      const now = Number.isNaN(this.at) ? this.current() : this.at;
      const grid = Number.isNaN(this.grid) ? now : this.grid;
      this.fireDue(now, grid, 1000 / this.s.frameRate, false);
    } else {
      this.fireByClock();
    }
  }

  /**
   * A check between frames by the real clock: the timers due whose delay
   * is shorter than the frame fire once each. Flash fires those between
   * frames at their times and holds a longer one for the next frame, a
   * 45 ms timer at 24 fps firing every other frame though the player
   * checks between (measured in adl, docs/architecture.md).
   */
  betweenFrames(frameMs: number): void {
    if (!this.realTime) {
      return;
    }

    this.at = Number.isNaN(this.host) ? this.elapsed() : this.host;
    try {
      this.fireDue(this.at, Number.NaN, frameMs, true);
    } finally {
      this.at = Number.NaN;
    }
  }

  /**
   * A pass: each timer due fires once, in the order the timers were
   * started, and next falls due its delay after the frame's time on the
   * grid, or after `time` between frames (`grid` NaN), so the ticks a long
   * frame or a stall lost are dropped, not caught up with, as in Flash.
   * Those shorter than `frameMs` are due by `time`; the others by `grid`,
   * and wait for a frame.
   */
  private fireDue(time: number, grid: number, frameMs: number, between: boolean): void {
    const now = Math.max(time, this.lastPass);
    this.lastPass = now;
    const due: TimerRecord[] = [];
    const held: TimerRecord[] = [];
    for (;;) {
      // The grid's time is never after the call's. Sums of a host's
      // intervals land a hair off the grid: due then is due.
      const next = this.timers.pop(now + GRID_SLACK);
      if (!next) {
        break;
      }

      // A short timer is due by the call's time, so as not to wait for a
      // between-frames check's time plus its delay while the frame runs
      // late; a longer one by the grid's. Either next falls due from the
      // grid's, which frames keep to, as Flash's keep to its own.
      // Between frames, a short one also waits its whole delay since it
      // last fired, as Flash's do: due from the grid, it is a little early.
      const short = next.delay < frameMs;
      const ready = !between || next.fired + next.delay <= now + GRID_SLACK;
      if (ready && next.due <= (short ? now : grid) + GRID_SLACK) {
        next.due = Number.isNaN(grid) ? now : grid;
        next.fired = now;
        due.push(next);
      } else {
        held.push(next);
      }
    }

    for (const record of held) {
      this.timers.push(record);
    }

    if (!due.length) {
      return;
    }

    due.sort((a, b) => a.order - b.order);

    try {
      for (const record of due) {
        // Stopped by a closure before it in the pass; one started anew has a record of its own.
        if (record.stopped) {
          continue;
        }

        // `due` holds the time it fired by, set above.
        record.due += record.delay;
        this.renderAsked = false;
        try {
          this.s.rt.call(record.closure, record.object);
        } catch (error) {
          this.s.reportUncaught(error);
        } finally {
          if (!record.stopped) {
            this.timers.push(record);
          }
        }

        // updateAfterEvent between frames: the stage renders now, RENDER and all, as in Flash.
        if (between && this.renderAsked) {
          this.s.render();
        }
      }
    } finally {
      this.renderAsked = false;
    }
  }

  /** Timer._start: `closure` is called every `delay` ms from now, until stopped; a timer running already is started anew. */
  startTimer(object: AsObject, delay: number, closure: Value): void {
    this.stopTimer(object);
    // Whole milliseconds, as Flash's: Timer(1000 / 24) is 41 ms, shorter than the frame.
    const ms = Math.max(Math.trunc(delay) || 0, 1);
    // In a frame, one as long as a frame counts from the frame's time on
    // the grid, which it fires by; others from the frame's or the pass's.
    let from = this.now;
    if (this.realTime) {
      const long = ms >= 1000 / this.s.frameRate && !Number.isNaN(this.grid);
      from = long ? this.grid : Number.isNaN(this.at) ? this.current() : this.at;
    }

    const record: TimerRecord = {
      object,
      delay: ms,
      closure,
      due: from + ms,
      fired: Number.NEGATIVE_INFINITY,
      seq: 0,
      order: this.starts++,
      stopped: false,
    };
    this.running.set(object, record);
    this.timers.push(record);
  }

  stopTimer(object: AsObject): void {
    const record = this.running.get(object);
    if (record) {
      record.stopped = true;
      this.running.delete(object);
      this.timers.stopped();
    }
  }

  timerRunning(object: AsObject): boolean {
    return this.running.has(object);
  }
}

/** How far past a pass's time a timer still counts as due, in ms: far below a whole one. */
const GRID_SLACK = 1e-6;

/** The real clock where the host has one, browsers and node alike; else none, and the frame clock. */
function defaultClock(): (() => number) | null {
  return typeof performance !== "undefined" ? () => performance.now() : null;
}

interface TimerRecord {
  object: AsObject;
  delay: number;
  closure: Value;
  due: number;
  /** Its place among timers due at the same time: the one scheduled first fires first. */
  seq: number;
  /** The pass time it last fired at with a real clock. */
  fired: number;
  /** When it was started among the others: a pass of the real clock fires by this order. */
  order: number;
  /** Stopped, and so to be dropped when it surfaces; a Timer started anew gets a record of its own. */
  stopped: boolean;
}

/**
 * The started timers by due time, a binary min-heap as asyncio keeps its
 * scheduled callbacks: the next due is found and rescheduled in O(log n)
 * where a scan of all timers is O(n) per firing, which at a thousand
 * timers is the difference between 0.3 and 2.5 ms a frame. A stopped
 * timer stays until it surfaces, and the heap is rebuilt without the
 * stopped when they are more than half of it.
 */
class TimerHeap {
  private heap: TimerRecord[] = [];
  private seq = 0;
  private stoppedCount = 0;

  push(record: TimerRecord): void {
    record.seq = this.seq++;
    this.insert(record);
  }

  /** `record` in its place by due time and the sequence it has. */
  private insert(record: TimerRecord): void {
    const h = this.heap;
    h.push(record);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(h[i], h[parent])) {
        break;
      }

      [h[i], h[parent]] = [h[parent], h[i]];
      i = parent;
    }
  }

  /** The earliest due timer at or before `clock`, taken out; stopped ones in the way are dropped. */
  pop(clock: number): TimerRecord | null {
    for (;;) {
      const top = this.heap[0];
      if (!top || top.due > clock) {
        return null;
      }

      this.remove();
      if (top.stopped) {
        this.stoppedCount--;
        continue;
      }

      return top;
    }
  }

  stopped(): void {
    this.stoppedCount++;
    if (this.stoppedCount > this.heap.length / 2) {
      // Rebuilt with each record's own sequence: the order of two due at once must not change.
      const live = this.heap.filter((r) => !r.stopped);
      this.heap = [];
      this.stoppedCount = 0;
      for (const record of live) {
        this.insert(record);
      }
    }
  }

  private remove(): void {
    const h = this.heap;
    const last = h.pop() as TimerRecord;
    if (!h.length) {
      return;
    }

    h[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let least = i;
      if (left < h.length && before(h[left], h[least])) {
        least = left;
      }

      if (right < h.length && before(h[right], h[least])) {
        least = right;
      }

      if (least === i) {
        break;
      }

      [h[i], h[least]] = [h[least], h[i]];
      i = least;
    }
  }
}

function before(a: TimerRecord, b: TimerRecord): boolean {
  return a.due < b.due || (a.due === b.due && a.seq < b.seq);
}
