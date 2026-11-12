// flash.sensors.Accelerometer: none, as on a desktop's Flash Player and AIR,
// where one is still made, muted, and takes an interval it never uses.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function accelerometerNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class AccelerometerNatives {
    static get isSupported(): boolean {
      return false;
    }

    get muted(): boolean {
      return true;
    }

    // NaN passes, as in Flash.
    setRequestedUpdateInterval(interval: Value): void {
      if (s.rt.toNumber(interval) < 0) {
        throw s.rt.error("ArgumentError", 1508, "interval");
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.sensors::Accelerometer", AccelerometerNatives);
  return natives;
}
