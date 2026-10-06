// flash.events.Event: its constructor's private native ctor keeps the type
// and flags; dispatch sets the target, current target and phase.
import { avm2 } from "@swf2es/runtime";
import { AT_TARGET } from "../../../scripting/events.js";

type Value = avm2.Value;

export function eventNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class EventNatives {
    declare $type: string;
    declare $bubbles: boolean;
    declare $cancelable: boolean;
    declare $target: Value;
    declare $currentTarget: Value;
    declare $phase: number;
    /** 0 running, 1 propagation stopped, 2 stopped at once. */
    declare $stopped: number;
    declare $prevented: boolean;

    "flash.events:Event::ctor"(type: Value, bubbles: Value, cancelable: Value): void {
      this.$type = String(type);
      this.$bubbles = !!bubbles;
      this.$cancelable = !!cancelable;
      this.$target = null;
      this.$currentTarget = null;
      this.$phase = AT_TARGET;
      this.$stopped = 0;
      this.$prevented = false;
    }

    get type(): string {
      return this.$type;
    }

    get bubbles(): boolean {
      return this.$bubbles;
    }

    get cancelable(): boolean {
      return this.$cancelable;
    }

    get target(): Value {
      return this.$target;
    }

    get currentTarget(): Value {
      return this.$currentTarget;
    }

    get eventPhase(): number {
      return this.$phase;
    }

    stopPropagation(): void {
      this.$stopped = Math.max(this.$stopped, 1);
    }

    stopImmediatePropagation(): void {
      this.$stopped = 2;
    }

    preventDefault(): void {
      if (this.$cancelable) {
        this.$prevented = true;
      }
    }

    isDefaultPrevented(): boolean {
      return this.$prevented;
    }
  }

  avm2.registerNativeClass(natives, "flash.events::Event", EventNatives);
  return natives;
}
