// flash.ui.ContextMenu: AS3 keeps the items; input/context-menu.ts snapshots them on opening.
// Links are kept for readback; link-specific built-in actions are not offered yet.
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
