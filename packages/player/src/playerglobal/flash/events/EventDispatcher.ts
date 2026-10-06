// flash.events.EventDispatcher: listeners by type on the object itself,
// which the player's dispatch (scripting/events.ts) calls along a display
// object's parent chain. The player broadcasts its frame events through it.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent, displayOf, type Listener } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The events Flash broadcasts to every display object that listens, on the display list or not, target only. */
export const BROADCAST = new Set(["enterFrame", "frameConstructed", "exitFrame", "render"]);

function listeners(o: AsObject): Map<string, Listener[]> {
  if (!o.$listeners) {
    o.$listeners = new Map<string, Listener[]>();
  }

  return o.$listeners;
}

export function eventDispatcherNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class EventDispatcherNatives {
    /** The IEventDispatcher a composed dispatcher stands in for, as events' target. */
    declare $target: Value;
    declare $listeners: Map<string, Listener[]> | undefined;
    declare $display: AsObject | undefined;

    "flash.events:EventDispatcher::ctor"(target: Value): void {
      this.$target = target ?? null;
    }

    addEventListener(type: Value, fn: Value, useCapture: Value, priority: Value): void {
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
    }

    removeEventListener(type: Value, fn: Value, useCapture: Value): void {
      const key = String(type);
      const list = this.$listeners?.get(key);
      const at = list?.findIndex((l) => l.fn === fn && l.capture === !!useCapture) ?? -1;
      if (list && at >= 0) {
        list.splice(at, 1);
        if (list.length === 0 && BROADCAST.has(key)) {
          s.broadcastTargets(key).delete(this);
        }
      }
    }

    hasEventListener(type: Value): boolean {
      return (this.$listeners?.get(String(type))?.length ?? 0) > 0;
    }

    willTrigger(type: Value): boolean {
      const key = String(type);
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
