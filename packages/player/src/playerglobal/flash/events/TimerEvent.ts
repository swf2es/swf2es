// flash.events.TimerEvent's one native: updateAfterEvent, which asks for a
// redraw, as MouseEvent's and KeyboardEvent's do. Timers fire as a frame
// starts here, so the frame's own drawing mostly answers it already.
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
