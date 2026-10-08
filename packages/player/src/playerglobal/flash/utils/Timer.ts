// flash.utils.Timer: playerglobal counts, checks the delay and completes
// in AS3; the player keeps the started timers and fires them in its frames
// and between them (scripting/timers.ts), each firing dispatching the
// timer event here.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function timerNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class TimerNatives {
    get running(): boolean {
      return s.timers.timerRunning(this as unknown as AsObject);
    }

    "flash.utils:Timer::_start"(delay: Value, closure: Value): void {
      s.timers.startTimer(this as unknown as AsObject, Number(delay), closure);
    }

    stop(): void {
      s.timers.stopTimer(this as unknown as AsObject);
    }

    "flash.utils:Timer::_timerDispatch"(): void {
      dispatchEvent(
        s,
        this as unknown as AsObject,
        s.rt.construct(s.rt.classNamed("flash.events::TimerEvent"), "timer") as AsObject,
      );
    }
  }

  avm2.registerNativeClass(natives, "flash.utils::Timer", TimerNatives);
  return natives;
}
