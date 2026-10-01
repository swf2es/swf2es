// flash.system.Security: one sandbox, a remote SWF's, which allows what a
// browser's would and is told nothing it has to keep.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function securityNatives(_s: Scripting): avm2.Natives {
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
      return "remote";
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

    static loadPolicyFile(_url: Value): void {
      // No policy applies.
    }

    static showSettings(_panel: Value): void {
      // There is no settings panel.
    }
  }

  avm2.registerNativeClass(natives, "flash.system::Security", SecurityNatives);
  return natives;
}
