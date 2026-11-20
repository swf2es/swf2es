// All content in this player shares one browser security sandbox. Flash's
// SecurityDomain.currentDomain is the stable object for that sandbox.
import { avm2 } from "@swf2es/runtime";
import { hex, sha256Here } from "../../../scripting/sha256.js";
import type { Scripting } from "../../../scripting.js";

const textEncoder = new TextEncoder();

export function securityDomainNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  let current: avm2.AsObject | null = null;

  class SecurityDomainNatives {
    static get currentDomain(): avm2.AsObject {
      // Its construct hook refuses a script's `new`; the player makes the singleton directly.
      if (!current) {
        current = s.rt.classNamed("flash.system::SecurityDomain").$it.instance();
      }

      return current;
    }

    /**
     * The main SWF's URL as SHA-256, in upper-case hex: adl gives that of its
     * application's SWF, which the SWFs it loads share.
     */
    get domainID(): string {
      return hex(sha256Here(textEncoder.encode(s.url))).toUpperCase();
    }
  }

  avm2.registerNativeClass(natives, "flash.system::SecurityDomain", SecurityDomainNatives);
  return natives;
}
