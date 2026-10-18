// An AVM1 movie's clock: the time getTimer and setInterval's timers go by,
// the real clock's or the frames', and the script timeout's start and end
// around the scripts that run.
// GetTime's frame clock follows Ruffle's (https://github.com/ruffle-rs/
// ruffle): MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors.
import { MovieClip } from "../display/display.js";
import type { Avm1 } from "./avm1.js";

/** The ms in a frame of the SWF's rate. */
const frameMs = (rate: number) => 1000 / (rate || 24);

export const defaultClock = (): (() => number) | null =>
  typeof performance !== "undefined" ? () => performance.now() : null;

/** The real clock the script timeout reads, whatever clock the timers go by. */
const timeoutClock =
  typeof performance !== "undefined" ? () => performance.now() : () => Date.now();

/** The movie's clock and its timers, which fire between frames. */
export class Timers {
  /** The frame clock, ms since the start, a frame's duration on each frame. */
  private frameClock = 0;
  /** GetTime's calls in the frame, and what they have added to a frame clock that stands still. */
  private timeCalls = 0;
  private timeOffset = 0;
  /** The real clock's reading at the start. */
  private readonly start: number;
  /** How deep begin() is: only the outermost begin and end start and stop the scripts' clock. */
  private beginDepth = 0;

  constructor(
    private readonly movie: Avm1,
    private readonly realTime: (() => number) | null,
  ) {
    this.start = this.realTime?.() ?? 0;
  }

  /** A frame starts: GetTime's calls are counted afresh. */
  frameStarted(): void {
    this.timeCalls = 0;
  }

  /** A frame's actions have run: until the next frame, its time passes and the timers due fire. */
  afterFrame(rate: number): void {
    this.frameClock += frameMs(rate);
    this.fire();
  }

  /** The time on the player's clock: the real clock's since the start, or the frame clock. */
  now(): number {
    return this.realTime === null ? this.frameClock : this.realTime() - this.start;
  }

  /**
   * GetTime: whole ms since the start. A frame clock stands still through
   * a frame, so, as Ruffle has it, a script that asks it again and again,
   * waiting for it to move, sees a ms pass every fifth call from the 20th.
   */
  getTime(): number {
    if (this.realTime !== null) {
      return Math.floor(this.realTime() - this.start);
    }

    this.timeCalls++;
    if (this.timeCalls >= 20 && this.timeCalls % 5 === 0) {
      this.timeOffset++;
    }

    return Math.floor(this.movie.realm.timers.now) + this.timeOffset;
  }

  /** Scripts start running: the script timeout counts from now. */
  begin(): void {
    if (this.beginDepth++ > 0) {
      return;
    }

    this.movie.realm.timers.now = this.now();
    this.movie.rt.begin(timeoutClock(), timeoutClock);
  }

  end(): void {
    if (--this.beginDepth > 0) {
      return;
    }

    this.movie.rt.end();
  }

  /** The timers due by now, each running what it queues after it. */
  fire(): void {
    const movie = this.movie;
    const root = movie.root as MovieClip | null;
    if (movie.realm.timers.size === 0 || root === null) {
      return;
    }

    movie.rt.fireTimers(
      this.now(),
      movie.version,
      () => movie.activationOf(root),
      () => movie.queue.run(),
      (object) => {
        const target = object.display?.target;
        return target instanceof MovieClip && movie.removed(target);
      },
    );
  }
}
