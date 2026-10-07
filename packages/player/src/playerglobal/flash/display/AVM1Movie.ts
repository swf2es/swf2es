// flash.display.AVM1Movie: an AVM1 SWF's root as an AS3 Loader's content
// (Loads.requestLoad), a display object AS3 cannot script into. Its
// `call` and `addCallback` are playerglobal's own code, which throws Error
// #2014 while interop is unavailable; with no AVM1 interpreter it always
// is, so nothing ever crosses to the AVM1 side.
import { avm2 } from "@swf2es/runtime";

export function avm1MovieNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class AVM1MovieNatives {
    get "flash.display:AVM1Movie::_interopAvailable"(): boolean {
      return false;
    }

    "flash.display:AVM1Movie::_callAS2"(): void {}

    // Its constructor hands over the closure an AVM1 call would reach AS3 by; no AVM1 code calls it.
    "flash.display:AVM1Movie::_setCallAS3"(): void {}
  }

  avm2.registerNativeClass(natives, "flash.display::AVM1Movie", AVM1MovieNatives);
  return natives;
}
