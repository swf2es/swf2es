// flash.events.EventDispatcher: listeners by type on the object itself,
// and dispatch along a display object's parent chain, capture, target,
// bubble, as Flash's. The player broadcasts its frame events through it.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { AT_TARGET, BUBBLING_PHASE, CAPTURING_PHASE } from "./Event.js";

const { plain } = avm2;
type AsObject = avm2.AsObject;
type Value = avm2.Value;

interface Listener {
  fn: Value;
  capture: boolean;
  priority: number;
}

/** The events Flash broadcasts to every display object that listens, on the display list or not, target only. */
export const BROADCAST = new Set(["enterFrame", "frameConstructed", "exitFrame", "render"]);

function listeners(o: AsObject): Map<string, Listener[]> {
  if (!o.$listeners) {
    o.$listeners = new Map<string, Listener[]>();
  }

  return o.$listeners;
}

/** The display object `o` is the face of, if it is one. */
const displayOf = (o: AsObject) => o.$display ?? null;

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

    s.rt.call(l.fn, null, event);
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

export function eventDispatcherNatives(s: Scripting): avm2.Natives {
  return {
    "flash.events::EventDispatcher#flash.events:EventDispatcher::ctor": plain(function (
      this: AsObject,
      target: Value,
    ) {
      // The IEventDispatcher a composed dispatcher stands in for, as events' target.
      this.$target = target ?? null;
    }),
    "flash.events::EventDispatcher#addEventListener": plain(function (
      this: AsObject,
      type: Value,
      fn: Value,
      useCapture: Value,
      priority: Value,
    ) {
      if (typeof fn !== "object" && typeof fn !== "function") {
        return;
      }

      const key = String(type);
      const list = listeners(this).get(key) ?? [];
      const capture = !!useCapture;
      if (list.some((l) => l.fn === fn && l.capture === capture)) {
        return;
      }

      const listener = { fn, capture, priority: Number(priority) | 0 };
      // Higher priority first; the same priority in the order added.
      let at = list.length;
      while (at > 0 && list[at - 1].priority < listener.priority) {
        at--;
      }

      list.splice(at, 0, listener);
      listeners(this).set(key, list);
      // A display object listening for a frame event is broadcast to, wherever it is.
      if (BROADCAST.has(key) && this.$display) {
        s.broadcastTargets(key).add(this);
      }
    }),
    "flash.events::EventDispatcher#removeEventListener": plain(function (
      this: AsObject,
      type: Value,
      fn: Value,
      useCapture: Value,
    ) {
      const key = String(type);
      const list = this.$listeners?.get(key) as Listener[] | undefined;
      const at = list?.findIndex((l) => l.fn === fn && l.capture === !!useCapture) ?? -1;
      if (list && at >= 0) {
        list.splice(at, 1);
        if (list.length === 0 && BROADCAST.has(key)) {
          s.broadcastTargets(key).delete(this);
        }
      }
    }),
    "flash.events::EventDispatcher#hasEventListener": plain(function (this: AsObject, type: Value) {
      return (this.$listeners?.get(String(type))?.length ?? 0) > 0;
    }),
    "flash.events::EventDispatcher#willTrigger": plain(function (this: AsObject, type: Value) {
      const key = String(type);
      for (let o: AsObject | null = this; o; o = displayOf(o)?.parent?.object ?? null) {
        if ((o.$listeners?.get(key)?.length ?? 0) > 0) {
          return true;
        }
      }

      return false;
    }),
    "flash.events::EventDispatcher#flash.events:EventDispatcher::dispatchEventFunction": (_rt) =>
      function (this: AsObject, event: Value) {
        return dispatchEvent(s, this, event);
      },
  };
}
