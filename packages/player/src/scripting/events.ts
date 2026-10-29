// Event dispatch, as Flash's: along a display object's parent chain,
// capture, target, bubble, to the listeners EventDispatcher keeps on each
// AS3 object; or to one object's own, as a broadcast reaches it. The
// player's input and frame events and playerglobal's dispatchEvent all
// go through it.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export const CAPTURING_PHASE = 1;
export const AT_TARGET = 2;
export const BUBBLING_PHASE = 3;

export interface Listener {
  fn: Value;
  capture: boolean;
  priority: number;
}

/**
 * Where an event keeps what dispatch reads and writes, by field: the slots
 * of playerglobal's AS3 fields (as3/playerglobal/src/flash/events/Event.as),
 * which compiled code reads directly, or under Flash Player's playerglobal
 * the fields its natives keep (playerglobal/flash/events/Event.ts).
 */
export interface EventFields {
  type: string;
  bubbles: string;
  target: string;
  currentTarget: string;
  phase: string;
  /** 0 propagating, 1 stopped after the current object, 2 stopped at once. */
  stopped: string;
  prevented: string;
}

/** The fields of `s`'s events, found once playerglobal is loaded. */
export function eventFields(s: Scripting): EventFields {
  if (s.eventFields) {
    return s.eventFields;
  }

  const cls = s.rt.classNamed("flash.events::Event");
  const field = (as3: string, native: string) => avm2.instanceVarField(cls, as3) ?? native;
  s.eventFields = {
    type: field("_type", "$type"),
    bubbles: field("_bubbles", "$bubbles"),
    target: field("_target", "$target"),
    currentTarget: field("_currentTarget", "$currentTarget"),
    phase: field("_eventPhase", "$phase"),
    stopped: field("_stopped", "$stopped"),
    prevented: field("_prevented", "$prevented"),
  };
  return s.eventFields;
}

/** The display object `o` is the face of, if it is one. */
export const displayOf = (o: AsObject) => o.$display ?? null;

// A listener's error is reported as uncaught, and the listeners after it
// still run: it never reaches the dispatcher, a script's dispatchEvent
// included, which returns as if none had thrown (as in Flash and Ruffle).
// `current` is `o` but where `o` stands in for another dispatcher, which
// its listeners see as the current target, as in Flash.
function invoke(
  s: Scripting,
  f: EventFields,
  o: AsObject,
  event: AsObject,
  phase: number,
  current: AsObject = o,
): void {
  const list = o.$listeners?.get(event[f.type]) as Listener[] | undefined;
  if (!list) {
    return;
  }

  event[f.currentTarget] = current;
  event[f.phase] = phase;
  // A copy: a listener may add or remove listeners. Not of one alone, read before it is called,
  // which nothing it does could add to or take from what this dispatch calls: each frame's
  // events reach thousands of objects so.
  const listeners = list.length === 1 ? list : [...list];
  const count = listeners.length;
  for (let i = 0; i < count; i++) {
    const l = listeners[i];
    if (l.capture !== (phase === CAPTURING_PHASE)) {
      continue;
    }

    try {
      s.rt.call(l.fn, null, event);
    } catch (error) {
      s.reportUncaught(error);
    }

    if (event[f.stopped] === 2) {
      return;
    }
  }
}

/**
 * Whether `target` or an object above it listens for `type`, in any phase.
 * Where none does, dispatching an event of the type runs no script, so
 * none could tell whether it was made: the player's own events, one for
 * each object put on the list or taken off, are made only where heard.
 */
export function heard(target: AsObject, type: string): boolean {
  if ((target.$listeners?.get(type) as Listener[] | undefined)?.length) {
    return true;
  }

  for (let d = displayOf(target)?.parent; d; d = d.parent) {
    if ((d.object?.$listeners?.get(type) as Listener[] | undefined)?.length) {
      return true;
    }
  }

  return false;
}

/** Dispatch `event` to `target`'s own listeners only, as a broadcast reaches each object: no capture, no bubble. */
export function dispatchTo(s: Scripting, target: AsObject, event: AsObject): void {
  const f = eventFields(s);
  event[f.target] = target.$target ?? target;
  invoke(s, f, target, event, AT_TARGET);
}

/**
 * Dispatch `event` from `target`, as EventDispatcher.dispatchEvent does; whether no listener
 * prevented its default. A dispatcher that stands in for another, an
 * EventDispatcher made with a target, dispatches as that one, along its
 * parent chain, with its own listeners at the target.
 */
export function dispatchEvent(s: Scripting, target: AsObject, event: AsObject): boolean {
  const f = eventFields(s);
  const owner: AsObject = target.$target ?? target;
  event[f.target] = owner;
  // The ancestors of a display object, nearest first.
  const ancestors: AsObject[] = [];
  for (let d = displayOf(owner)?.parent; d; d = d.parent) {
    if (d.object) {
      ancestors.push(d.object);
    }
  }

  for (let i = ancestors.length - 1; i >= 0 && event[f.stopped] === 0; i--) {
    invoke(s, f, ancestors[i], event, CAPTURING_PHASE);
  }

  if (event[f.stopped] === 0) {
    invoke(s, f, target, event, AT_TARGET, owner);
  }

  if (event[f.bubbles]) {
    for (const a of ancestors) {
      if (event[f.stopped] !== 0) {
        break;
      }

      invoke(s, f, a, event, BUBBLING_PHASE);
    }
  }

  return !event[f.prevented];
}

/**
 * Broadcast targets held weakly, in the order first added: a listener for
 * ACTIVATE or DEACTIVATE keeps no object alive, nor its timeline playing.
 * One collected drops out as it goes.
 */
export class WeakTargets {
  private readonly refs = new Set<WeakRef<AsObject>>();
  private readonly byObject = new WeakMap<AsObject, WeakRef<AsObject>>();
  private readonly collected = new FinalizationRegistry<WeakRef<AsObject>>((ref) =>
    this.refs.delete(ref),
  );

  add(o: AsObject): void {
    if (this.byObject.has(o)) {
      return;
    }

    const ref = new WeakRef(o);
    this.byObject.set(o, ref);
    this.refs.add(ref);
    this.collected.register(o, ref, ref);
  }

  delete(o: AsObject): void {
    const ref = this.byObject.get(o);
    if (ref) {
      this.byObject.delete(o);
      this.refs.delete(ref);
      this.collected.unregister(ref);
    }
  }

  /** Those still alive, in order, found first: a listener may add or remove others. */
  live(): AsObject[] {
    const live: AsObject[] = [];
    for (const ref of this.refs) {
      const o = ref.deref();
      if (o) {
        live.push(o);
      }
    }

    return live;
  }
}
