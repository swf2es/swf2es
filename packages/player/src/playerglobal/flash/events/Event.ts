// flash.events.Event: its constructor's private native ctor keeps the type
// and flags; dispatch sets the target, current target and phase.
import { avm2 } from "@swf2es/runtime";

const { plain } = avm2;
type AsObject = avm2.AsObject;

export const CAPTURING_PHASE = 1;
export const AT_TARGET = 2;
export const BUBBLING_PHASE = 3;

export function eventNatives(): avm2.Natives {
  return {
    "flash.events::Event#flash.events:Event::ctor": plain(function (
      this: AsObject,
      type: avm2.Value,
      bubbles: avm2.Value,
      cancelable: avm2.Value,
    ) {
      this.$type = String(type);
      this.$bubbles = !!bubbles;
      this.$cancelable = !!cancelable;
      this.$target = null;
      this.$currentTarget = null;
      this.$phase = AT_TARGET;
      // 0 running, 1 propagation stopped, 2 stopped at once.
      this.$stopped = 0;
      this.$prevented = false;
    }),
    "flash.events::Event#get:type": plain(function (this: AsObject) {
      return this.$type;
    }),
    "flash.events::Event#get:bubbles": plain(function (this: AsObject) {
      return this.$bubbles;
    }),
    "flash.events::Event#get:cancelable": plain(function (this: AsObject) {
      return this.$cancelable;
    }),
    "flash.events::Event#get:target": plain(function (this: AsObject) {
      return this.$target;
    }),
    "flash.events::Event#get:currentTarget": plain(function (this: AsObject) {
      return this.$currentTarget;
    }),
    "flash.events::Event#get:eventPhase": plain(function (this: AsObject) {
      return this.$phase;
    }),
    "flash.events::Event#stopPropagation": plain(function (this: AsObject) {
      this.$stopped = Math.max(this.$stopped, 1);
    }),
    "flash.events::Event#stopImmediatePropagation": plain(function (this: AsObject) {
      this.$stopped = 2;
    }),
    "flash.events::Event#preventDefault": plain(function (this: AsObject) {
      if (this.$cancelable) {
        this.$prevented = true;
      }
    }),
    "flash.events::Event#isDefaultPrevented": plain(function (this: AsObject) {
      return this.$prevented;
    }),
  };
}
