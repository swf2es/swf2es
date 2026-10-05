// flash.accessibility.Accessibility: this player has no platform accessibility bridge.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function accessibilityNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class AccessibilityNatives {
    static get active(): boolean {
      return false;
    }

    static sendEvent(source: Value, _childId: Value, _eventType: Value, _nonHtml: Value): void {
      if (source === null || source === undefined) {
        throw s.rt.error("TypeError", 2007, "source");
      }

      // No platform accessibility bridge receives events.
    }

    static updateProperties(): void {
      // No platform accessibility bridge holds properties.
    }
  }

  avm2.registerNativeClass(natives, "flash.accessibility::Accessibility", AccessibilityNatives);
  return natives;
}
