// flash.text.TextRenderer: settings for advanced anti-aliasing, kept for the
// SWF to read back, with the values adl takes and ignores; the player draws
// its text the same either way.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function textRendererNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  let displayMode = "default";
  let maxLevel = 4;
  let antiAliasType = "default";

  class TextRendererNatives {
    /** "default" reads as the mode it stands for, "crt" in adl. */
    static get displayMode(): string {
      return displayMode === "default" ? "crt" : displayMode;
    }

    /** "lcd" and "crt" set; null leaves it, anything else is "default". */
    static set displayMode(v: Value) {
      if (v === null || v === undefined) {
        return;
      }

      const mode = s.rt.toString(v);
      displayMode = mode === "lcd" || mode === "crt" ? mode : "default";
    }

    static get maxLevel(): number {
      return maxLevel;
    }

    /** Only 3, 4 and 7 are levels; others leave it. */
    static set maxLevel(v: Value) {
      const level = s.rt.toInt(v);
      if (level === 3 || level === 4 || level === 7) {
        maxLevel = level;
      }
    }

    static get antiAliasType(): string {
      return antiAliasType;
    }

    /** "on" and "default" set, anything else is "off"; null TypeError #2007. */
    static set antiAliasType(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "antiAliasType");
      }

      const type = s.rt.toString(v);
      antiAliasType = type === "on" || type === "default" ? type : "off";
    }

    static setAdvancedAntiAliasingTable(): void {
      // The player's text has no tables to tune.
    }
  }

  avm2.registerNativeClass(natives, "flash.text::TextRenderer", TextRendererNatives);
  return natives;
}
