// flash.printing.PrintJob: the player prints nothing, so it says so, as
// Flash does where there is no printing (mobile AIR); Flash Player 32 and
// AIR on a desktop say they can.
import { avm2 } from "@swf2es/runtime";

export function printJobNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class PrintJobNatives {
    static get isSupported(): boolean {
      return false;
    }
  }

  avm2.registerNativeClass(natives, "flash.printing::PrintJob", PrintJobNatives);
  return natives;
}
