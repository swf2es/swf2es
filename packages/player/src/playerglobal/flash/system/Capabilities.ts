// flash.system.Capabilities: the screen values the host captured for this player.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

export function capabilitiesNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class CapabilitiesNatives {
    static get screenResolutionX(): number {
      return s.screenCapabilities.screenResolutionX;
    }

    static get screenResolutionY(): number {
      return s.screenCapabilities.screenResolutionY;
    }

    static get pixelAspectRatio(): number {
      return s.screenCapabilities.pixelAspectRatio;
    }

    static get screenDPI(): number {
      return s.screenCapabilities.screenDPI;
    }
  }

  avm2.registerNativeClass(natives, "flash.system::Capabilities", CapabilitiesNatives);
  return natives;
}
