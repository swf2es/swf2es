// flash.ui.Multitouch: the host's touch screen, and how the player hands
// its touches to scripts (input/touch.ts). Gestures are not recognized, so
// the player reports none, as Flash does where the system has none.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

const MODES: ReadonlySet<string> = new Set(["none", "gesture", "touchPoint"]);

export function multitouchNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class MultitouchNatives {
    static get inputMode(): string {
      return s.inputMode;
    }

    // Flash checks the value, then keeps "none" where the system has no touch screen.
    static set inputMode(value: Value) {
      if (value === null || value === undefined) {
        throw s.rt.error("TypeError", 2007, "inputMode");
      }

      const mode = s.rt.toString(value);
      if (!MODES.has(mode)) {
        throw s.rt.error("ArgumentError", 2008, "inputMode");
      }

      if (s.maxTouchPoints > 0) {
        s.inputMode = mode as typeof s.inputMode;
      }
    }

    static get supportsTouchEvents(): boolean {
      return s.maxTouchPoints > 0;
    }

    static get supportsGestureEvents(): boolean {
      return false;
    }

    static get supportedGestures(): Value {
      return null;
    }

    static get maxTouchPoints(): number {
      return s.maxTouchPoints;
    }

    static get mapTouchToMouse(): boolean {
      return s.mapTouchToMouse;
    }

    static set mapTouchToMouse(value: Value) {
      s.mapTouchToMouse = !!value;
    }
  }

  avm2.registerNativeClass(natives, "flash.ui::Multitouch", MultitouchNatives);
  return natives;
}
