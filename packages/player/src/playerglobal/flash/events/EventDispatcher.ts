// flash.events.EventDispatcher: listeners by type on the object itself,
// which the player's dispatch (scripting/events.ts) calls along a display
// object's parent chain. The player broadcasts its frame and activation
// events through it.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent, displayOf, type Listener } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The events Flash broadcasts to every display object that listens, on the display list or not, target only. */
const BROADCAST = new Set(["enterFrame", "frameConstructed", "exitFrame", "render"]);
/**
 * The events Flash broadcasts to every EventDispatcher that listens, display
 * object or not, target only: the player's activation, which, unlike a
 * frame's events, holds no listener alive (Scripting.activationTargets).
 */
const ACTIVATION = new Set(["activate", "deactivate"]);

function listeners(o: AsObject): Map<string, Listener[]> {
  if (!o.$listeners) {
    o.$listeners = new Map<string, Listener[]>();
  }

  return o.$listeners;
}

/** An event type, declared String: refused as null, as Flash refuses it. */
function eventType(s: Scripting, type: Value): string {
  if (type === null || type === undefined) {
    throw s.rt.error("TypeError", 2007, "type");
  }

  return type as string;
}

/** `fn` added to `o`'s listeners for `type`, as EventDispatcher.addEventListener adds it; whether it was new. */
export function addListener(
  s: Scripting,
  o: AsObject,
  type: Value,
  fn: Value,
  useCapture: Value,
  priority: Value,
): boolean {
  const key = eventType(s, type);
  if (typeof fn !== "object" && typeof fn !== "function") {
    return false;
  }

  const list = listeners(o).get(key) ?? [];
  const capture = !!useCapture;
  if (list.some((l) => l.fn === fn && l.capture === capture)) {
    return false;
  }

  const listener = { fn, capture, priority: Number(priority) | 0 };
  // Higher priority first; the same priority in the order added.
  let at = list.length;
  while (at > 0 && list[at - 1].priority < listener.priority) {
    at--;
  }

  list.splice(at, 0, listener);
  listeners(o).set(key, list);
  // A display object listening for a frame event is broadcast to, wherever it is; any
  // dispatcher listening for activation is, held weakly.
  if (BROADCAST.has(key) && o.$display) {
    s.broadcastTargets(key).add(o);
  } else if (ACTIVATION.has(key)) {
    s.activationTargets(key).add(o);
  }

  return true;
}

/** `fn` taken from `o`'s listeners for `type`, as EventDispatcher.removeEventListener takes it. */
export function removeListener(
  s: Scripting,
  o: AsObject,
  type: Value,
  fn: Value,
  useCapture: Value,
): void {
  const key = eventType(s, type);
  const list = o.$listeners?.get(key);
  const at = list?.findIndex((l: Listener) => l.fn === fn && l.capture === !!useCapture) ?? -1;
  if (list && at >= 0) {
    list.splice(at, 1);
    if (list.length === 0 && BROADCAST.has(key)) {
      s.broadcastTargets(key).delete(o);
    } else if (list.length === 0 && ACTIVATION.has(key)) {
      s.activationTargets(key).delete(o);
    }
  }
}

export function eventDispatcherNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const typeOf = (type: Value) => eventType(s, type);

  class EventDispatcherNatives {
    /** The IEventDispatcher a composed dispatcher stands in for, as events' target. */
    declare $target: Value;
    declare $listeners: Map<string, Listener[]> | undefined;
    declare $display: AsObject | undefined;

    "flash.events:EventDispatcher::ctor"(target: Value): void {
      this.$target = target ?? null;
    }

    addEventListener(type: Value, fn: Value, useCapture: Value, priority: Value): void {
      addListener(s, this, type, fn, useCapture, priority);
    }

    removeEventListener(type: Value, fn: Value, useCapture: Value): void {
      removeListener(s, this, type, fn, useCapture);
    }

    hasEventListener(type: Value): boolean {
      return (this.$listeners?.get(typeOf(type))?.length ?? 0) > 0;
    }

    willTrigger(type: Value): boolean {
      const key = typeOf(type);
      for (let o: AsObject | null = this; o; o = displayOf(o)?.parent?.object ?? null) {
        if ((o.$listeners?.get(key)?.length ?? 0) > 0) {
          return true;
        }
      }

      return false;
    }

    "flash.events:EventDispatcher::dispatchEventFunction"(event: Value): boolean {
      return dispatchEvent(s, this, event);
    }
  }

  avm2.registerNativeClass(natives, "flash.events::EventDispatcher", EventDispatcherNatives);
  return natives;
}
