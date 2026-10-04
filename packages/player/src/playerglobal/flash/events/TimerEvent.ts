// flash.events.TimerEvent's one native: updateAfterEvent, which asks for a
// redraw before the next frame, as MouseEvent's and KeyboardEvent's do.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

export function timerEventNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class TimerEventNatives {
    updateAfterEvent(): void {
      s.updates++;
    }
  }

  avm2.registerNativeClass(natives, "flash.events::TimerEvent", TimerEventNatives);
  return natives;
}
