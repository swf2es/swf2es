// The player's clock and the timers: by the real clock where the host has
// one, as Flash fires them, at each frame after ENTER_FRAME and those
// shorter than a frame between frames too; by the frame clock otherwise, a
// frame moving it on and firing the timers due by then after ENTER_FRAME. flash.utils.Timer starts and stops them, and getTimer tells
// the time.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export class Timers {
  /** The frame clock, in ms since the start, moved by the frame step alone; Timer fires by it without a real clock. */
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
  private readonly realStart: number;
  /** The timers started, by their Timer objects, and a heap of them by when they fall due. */
  private readonly running = new Map<AsObject, TimerRecord>();
  private readonly timers = new TimerHeap();
  /** Timers started so far: the order of a start, which timers due in one pass of the real clock fire in. */
  private starts = 0;
  /** Set by updateAfterEvent while a timer fires between frames: the stage renders after its closure. */
  renderAsked = false;

  constructor(
    private readonly s: Scripting,
    options: { realTime?: (() => number) | null },
  ) {
    this.realTime = options.realTime === undefined ? defaultClock() : options.realTime;
    // getTimer's zero: when the player is made, as Flash's is when it starts.
    this.realStart = this.realTime ? this.realTime() : 0;
  }

  /**
   * What getTimer tells: whole milliseconds since the start, by the real
   * clock, truncated as Flash's are, or by the frame clock's now, rounded
   * as it always has been, so that the traces recorded by it stay.
   */
  timer(): number {
    return this.realTime ? Math.floor(this.elapsed()) : Math.round(this.now);
  }

  /** Milliseconds since the start by the real clock, unrounded. */
  private elapsed(): number {
    return (this.realTime as () => number)() - this.realStart;
  }

  /** A frame begins: the frame clock moves on by `ms`; its timers fire after ENTER_FRAME (frameTimers). */
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
      this.fireDue(Number.POSITIVE_INFINITY, false);
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
    if (this.realTime) {
      this.fireDue(frameMs, true);
    }
  }

  /**
   * Each timer due by the real clock with a delay under `shorter` fires
   * once, in the order the timers were started, and next falls due its
   * delay after now: the ticks a long frame or a stall lost are dropped,
   * not caught up with, as in Flash.
   */
  private fireDue(shorter: number, between: boolean): void {
    const now = this.elapsed();
    const due: TimerRecord[] = [];
    const held: TimerRecord[] = [];
    for (;;) {
      const next = this.timers.pop(now);
      if (!next) {
        break;
      }

      (next.delay < shorter ? due : held).push(next);
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

        record.due = now + record.delay;
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
    const record: TimerRecord = {
      object,
      delay: Math.max(delay, 1),
      closure,
      due: (this.realTime ? this.elapsed() : this.now) + delay,
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
  /** When it was started among the others: timers due in one pass of the real clock fire in this order. */
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
