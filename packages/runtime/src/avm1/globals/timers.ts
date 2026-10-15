// setInterval, setTimeout, clearInterval and clearTimeout (docs/avm1.md,
// "Time"), as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/timer.rs and avm1/globals.rs (create_timer) have them: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// The timers are the runtime's, the clock the player's: it tells the
// runtime the time and asks it to fire what is due between frames.

import { Avm1Function, Avm1Object, type Native } from "../objects.js";
import { toInt32 } from "../operators.js";
import type { Realm } from "../realm.js";
import { stringOf, type Value } from "../values.js";

/** The shortest interval a timer has, in ms, as Ruffle has it: Flash fires none much faster. */
const MIN_INTERVAL = 10;

/** A timer: a function to call, or an object and the name of its method, every `interval` ms. */
export class Timer {
  constructor(
    readonly id: number,
    readonly callback: Avm1Object,
    /** The method's name, null where `callback` is the function. */
    readonly method: string | null,
    readonly args: Value[],
    readonly interval: number,
    /** When it falls due next, in the clock's ms. */
    public due: number,
    /** setTimeout's: it fires once. */
    readonly once: boolean,
    /** Its place among those due at once: the one set first fires first. */
    public seq: number,
  ) {}
}

/** A runtime's timers, by when they fall due. */
export class Timers {
  /** The time now on the player's clock, in ms: a timer set now counts from it. */
  now = 0;
  private counter = 0;
  private seq = 0;
  private readonly list: Timer[] = [];

  get size(): number {
    return this.list.length;
  }

  /** A new timer, its id: from 1, as Flash never gives 0. */
  add(
    callback: Avm1Object,
    method: string | null,
    args: Value[],
    interval: number,
    once: boolean,
  ): number {
    this.counter = (this.counter + 1) | 0;
    const ms = Math.max(interval, MIN_INTERVAL);
    this.list.push(
      new Timer(this.counter, callback, method, args, ms, this.now + ms, once, this.seq++),
    );
    return this.counter;
  }

  /** Clear timer `id`: whether there was one. */
  remove(id: number): boolean {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0) {
      return false;
    }

    this.list.splice(i, 1);
    return true;
  }

  has(timer: Timer): boolean {
    return this.list.includes(timer);
  }

  /** The timer due first by `time`, of two due at once the one set first; null for none. */
  due(time: number): Timer | null {
    let first: Timer | null = null;
    for (const t of this.list) {
      if (
        t.due <= time &&
        (first === null || t.due < first.due || (t.due === first.due && t.seq < first.seq))
      ) {
        first = t;
      }
    }

    return first;
  }

  /** `timer` fired: due again an interval on, or gone for a timeout. */
  fired(timer: Timer): void {
    if (timer.once) {
      this.remove(timer.id);
    } else {
      timer.due += timer.interval;
      timer.seq = this.seq++;
    }
  }

  clear(): void {
    this.list.length = 0;
  }
}

/**
 * setInterval's and setTimeout's native: `(function, interval, ...args)`
 * or `(object, name, interval, ...args)`; undefined where there is no
 * callback or no interval.
 */
function create(realm: Realm, args: Value[], version: number, once: boolean): Value {
  const first = args.length > 0 ? args[0] : undefined;
  if (!(first instanceof Avm1Object)) {
    return undefined;
  }

  const isFunction = first instanceof Avm1Function;
  const interval = isFunction ? args[1] : args[2];
  if (interval === undefined) {
    return undefined;
  }

  const method = isFunction ? null : stringOf(args.length > 1 ? args[1] : undefined, version);
  const rest = args.slice(isFunction ? 2 : 3);
  return realm.timers.add(first, method, rest, toInt32(interval, version), once);
}

/** The timer natives, in Flash's order on `_global`, and ASnative(250, i): setInterval, clearInterval, setTimeout. */
export function timerFunctions(realm: Realm): [string, Native][] {
  const setInterval: Native = (_, args, version) => create(realm, args, version, false);
  const setTimeout: Native = (_, args, version) => create(realm, args, version, true);
  const clear: Native = (_, args, version) => {
    realm.timers.remove(toInt32(args.length > 0 ? args[0] : undefined, version));
    return undefined;
  };
  realm.natives.set(250, (i) => [setInterval, clear, setTimeout][i] ?? null);
  return [
    ["setInterval", setInterval],
    ["clearTimeout", clear],
    ["clearInterval", clear],
    ["setTimeout", setTimeout],
  ];
}
