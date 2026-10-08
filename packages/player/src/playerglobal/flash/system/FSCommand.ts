// flash.system.fscommand: a message to the player's host, which a plug-in
// passed to its page and a projector acted on; here the host's, if it
// takes them, else nothing, as a plug-in whose page defines no handler.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function fsCommandNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class FSCommandNatives {
    static _fscommand(command: Value, args: Value): void {
      // With the calling SWF's URL, or every loaded SWF's where the caller
      // cannot be told, for a host that lets some SWFs command it and not others.
      s.fsCommand?.(s.rt.toString(command), s.rt.toString(args), s.code.securityUrls());
    }
  }

  avm2.registerNativeClass(natives, "flash.system::FSCommand", FSCommandNatives);
  return natives;
}
