// flash.ui.ContextMenu: AS3 for its items (as3/playerglobal); the link it
// would offer is kept for the SWF to read back, as the player shows no
// context menu of a SWF's.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { coerceArgument } from "../display/InteractiveObject.js";

type Value = avm2.Value;

export function contextMenuNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class ContextMenuNatives {
    declare $link: Value;

    get link(): Value {
      return this.$link ?? null;
    }

    set link(v: Value) {
      this.$link = coerceArgument(s, v, "flash.net::URLRequest");
    }
  }

  avm2.registerNativeClass(natives, "flash.ui::ContextMenu", ContextMenuNatives);
  return natives;
}
