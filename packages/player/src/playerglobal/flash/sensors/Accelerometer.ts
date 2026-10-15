// flash.sensors.Accelerometer: none, as on a desktop's Flash Player.
import { avm2 } from "@swf2es/runtime";

export function accelerometerNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class AccelerometerNatives {
    static get isSupported(): boolean {
      return false;
    }
  }

  avm2.registerNativeClass(natives, "flash.sensors::Accelerometer", AccelerometerNatives);
  return natives;
}
