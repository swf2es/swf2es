// Event dispatch, as Flash's: along a display object's parent chain,
// capture, target, bubble, to the listeners EventDispatcher keeps on each
// AS3 object; or to one object's own, as a broadcast reaches it. The
// player's input and frame events and playerglobal's dispatchEvent all
// go through it.
import type { avm2 } from "@swf2es/runtime";
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

/** The display object `o` is the face of, if it is one. */
export const displayOf = (o: AsObject) => o.$display ?? null;

// A listener's error is reported as uncaught, and the listeners after it
// still run: it never reaches the dispatcher, a script's dispatchEvent
// included, which returns as if none had thrown (as in Flash and Ruffle).
function invoke(s: Scripting, o: AsObject, event: AsObject, phase: number): void {
  const list = o.$listeners?.get(event.$type) as Listener[] | undefined;
  if (!list) {
    return;
  }

  event.$currentTarget = o;
  event.$phase = phase;
  // A copy: a listener may add or remove listeners.
  for (const l of [...list]) {
    if (l.capture !== (phase === CAPTURING_PHASE)) {
      continue;
    }

    try {
      s.rt.call(l.fn, null, event);
    } catch (error) {
      s.reportUncaught(error);
    }

    if (event.$stopped === 2) {
      return;
    }
  }
}

/** Dispatch `event` to `target`'s own listeners only, as a broadcast reaches each object: no capture, no bubble. */
export function dispatchTo(s: Scripting, target: AsObject, event: AsObject): void {
  event.$target = target.$target ?? target;
  invoke(s, target, event, AT_TARGET);
}

/** Dispatch `event` from `target`, as EventDispatcher.dispatchEvent does; whether no listener prevented its default. */
export function dispatchEvent(s: Scripting, target: AsObject, event: AsObject): boolean {
  event.$target = target.$target ?? target;
  // The ancestors of a display object, nearest first.
  const ancestors: AsObject[] = [];
  for (let d = displayOf(target)?.parent; d; d = d.parent) {
    if (d.object) {
      ancestors.push(d.object);
    }
  }

  for (let i = ancestors.length - 1; i >= 0 && event.$stopped === 0; i--) {
    invoke(s, ancestors[i], event, CAPTURING_PHASE);
  }

  if (event.$stopped === 0) {
    invoke(s, target, event, AT_TARGET);
  }

  if (event.$bubbles) {
    for (const a of ancestors) {
      if (event.$stopped !== 0) {
        break;
      }

      invoke(s, a, event, BUBBLING_PHASE);
    }
  }

  return !event.$prevented;
}
