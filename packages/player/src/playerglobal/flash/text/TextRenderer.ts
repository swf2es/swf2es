// flash.text.TextRenderer: settings for advanced anti-aliasing, kept for the
// SWF to read back, with the values adl takes and ignores, and the tables
// of cutoffs a font's advanced text is drawn by (text/csm.ts).
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { setCsmTable } from "../../../text/csm.js";

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
        // adl spells the parameter so.
        throw s.rt.error("TypeError", 2007, "antialiasType");
      }

      const type = s.rt.toString(v);
      antiAliasType = type === "on" || type === "default" ? type : "off";
    }

    /** Checked as adl checks it; then the font's table, for its light and dark text alike, as adl takes it. */
    static setAdvancedAntiAliasingTable(
      fontName: Value,
      fontStyle: Value,
      colorType: Value,
      table: Value,
    ): void {
      for (const [name, v] of [
        ["fontName", fontName],
        ["fontStyle", fontStyle],
        ["colorType", colorType],
      ]) {
        if (v === null || v === undefined) {
          throw s.rt.error("TypeError", 2007, name);
        }
      }

      const entries = (table as avm2.AsObject | null)?.$a as Value[] | undefined;
      if (!entries) {
        return;
      }

      const settings = s.rt.classNamed("flash.text::CSMSettings");
      for (const entry of entries) {
        if (!s.rt.isInstance(entry, settings)) {
          throw s.rt.error("TypeError", 2005, 4, "CSMSettings");
        }
      }

      const read = (entry: Value, k: string) =>
        s.rt.toNumber(s.rt.getProperty(entry as avm2.AsObject, s.rt.publicName(k)));
      setCsmTable(
        s.rt.toString(fontName),
        s.rt.toString(fontStyle),
        entries.map((entry) => [
          read(entry, "fontSize"),
          read(entry, "insideCutoff"),
          read(entry, "outsideCutoff"),
        ]),
      );
    }
  }

  avm2.registerNativeClass(natives, "flash.text::TextRenderer", TextRendererNatives);
  return natives;
}
