// flash.ui.GameInput without game controllers: none are found, so there is
// no device to get, RangeError 1506 as Flash's for an index past them.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function gameInputNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class GameInputNatives {
    static get isSupported(): boolean {
      return false;
    }

    static get numDevices(): number {
      return 0;
    }

    static getDeviceAt(_index: Value): Value {
      throw s.rt.error("RangeError", 1506);
    }
  }

  avm2.registerNativeClass(natives, "flash.ui::GameInput", GameInputNatives);
  return natives;
}
