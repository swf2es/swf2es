// flash.system.Security: the sandbox the host placed the SWF in, a remote
// SWF's by default, which allows what a browser's would; the policy files
// a SWF names go to the host, which judges its requests by them.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function securityNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  // Kept as set, nothing reads them: a data field is not a native.
  let exactSettings = true;
  let disableAVM1Loading = false;

  class SecurityNatives {
    static get exactSettings(): boolean {
      return exactSettings;
    }

    static set exactSettings(v: Value) {
      exactSettings = !!v;
    }

    static get disableAVM1Loading(): boolean {
      return disableAVM1Loading;
    }

    static set disableAVM1Loading(v: Value) {
      disableAVM1Loading = !!v;
    }

    static get sandboxType(): string {
      return s.sandboxType;
    }

    static get pageDomain(): Value {
      return null;
    }

    static allowDomain(): void {
      // Every domain is allowed already.
    }

    static allowInsecureDomain(): void {
      // Every domain is allowed already.
    }

    static loadPolicyFile(url: Value): void {
      if (url !== null && url !== undefined) {
        s.loads.policyFile(s.rt.toString(url));
      }
    }

    static showSettings(_panel: Value): void {
      // There is no settings panel.
    }
  }

  avm2.registerNativeClass(natives, "flash.system::Security", SecurityNatives);
  return natives;
}
