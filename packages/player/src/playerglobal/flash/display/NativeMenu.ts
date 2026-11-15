// flash.display.NativeMenu: AS3 keeps the items; these answer what needs the host,
// whether there are AIR's menus and showing one.
import { avm2 } from "@swf2es/runtime";
import { nativeMenuItems } from "../../../input/context-menu.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function nativeMenuNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class NativeMenuNatives {
    static get isSupported(): boolean {
      return s.air;
    }

    // Shown where the host shows the player's own menu, as a menu of buttons
    // (input/context-menu.ts); nothing shows it elsewhere, as in a hidden adl.
    "flash.display:NativeMenu::show"(shown: Value, stageX: Value, stageY: Value): void {
      const show = s.showMenu;
      if (!show || s.destroyed) {
        return;
      }

      const items = nativeMenuItems(s, this as unknown as avm2.AsObject, shown);
      show(items, s.rt.toNumber(stageX), s.rt.toNumber(stageY));
    }
  }

  avm2.registerNativeClass(natives, "flash.display::NativeMenu", NativeMenuNatives);
  return natives;
}
