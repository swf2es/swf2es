// flash.events.TimerEvent's one native: updateAfterEvent, which asks for a
// redraw, as MouseEvent's and KeyboardEvent's do. A timer that fires
// between frames has the stage render after its listeners, RENDER and all,
// as Flash does; in a frame, the frame's own drawing answers it.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

export function timerEventNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class TimerEventNatives {
    updateAfterEvent(): void {
      s.updates++;
      s.timers.renderAsked = true;
    }
  }

  avm2.registerNativeClass(natives, "flash.events::TimerEvent", TimerEventNatives);
  return natives;
}
