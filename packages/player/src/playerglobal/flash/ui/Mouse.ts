// flash.ui.Mouse controls whether the host shows its system cursor.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

export function mouseNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class MouseNatives {
    static hide(): void {
      s.mouseVisible = false;
      s.pointer?.updateCursor();
    }

    static show(): void {
      s.mouseVisible = true;
      s.pointer?.updateCursor();
    }
  }

  avm2.registerNativeClass(natives, "flash.ui::Mouse", MouseNatives);
  return natives;
}
