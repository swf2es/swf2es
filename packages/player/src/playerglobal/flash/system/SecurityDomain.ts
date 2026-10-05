// All content in this player shares one browser security sandbox. Flash's
// SecurityDomain.currentDomain is the stable object for that sandbox.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

export function securityDomainNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  let current: avm2.AsObject | null = null;

  class SecurityDomainNatives {
    static get currentDomain(): avm2.AsObject {
      // Its public constructor throws; the player creates the singleton directly.
      if (!current) {
        current = s.rt.classNamed("flash.system::SecurityDomain").$it.instance();
      }

      return current;
    }

    "flash.system:SecurityDomain::ctor_impl"(): void {
      throw s.rt.error("ArgumentError", 2012, "SecurityDomain");
    }
  }

  avm2.registerNativeClass(natives, "flash.system::SecurityDomain", SecurityDomainNatives);
  return natives;
}
