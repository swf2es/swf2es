// flash.globalization.StringTools: case mapping in the locale's rules,
// character by character as Windows maps case: no context, as a final
// sigma's, and a character JavaScript expands left as it is, but for ß,
// which Flash makes SS, and İ, which it makes i.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { availableLocales, type Locale, NO_ERROR, nonNull, resolveLocale } from "./locale.js";

type Value = avm2.Value;

function mapCase(text: string, map: (c: string) => string, lower: boolean): string {
  let out = "";
  for (const c of text) {
    const mapped = [...map(c)];
    // Expanded, a lower case keeps its first character, the dotted I's i.
    out += mapped.length === 1 || c === "\u00df" ? mapped.join("") : lower ? mapped[0] : c;
  }

  return out;
}

export function stringToolsNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class StringToolsNatives {
    declare $locale: Locale;
    declare $status: string;

    static getAvailableLocaleIDNames(): Value {
      return availableLocales(s);
    }

    "flash.globalization:StringTools::ctor"(name: string | null): void {
      this.$locale = resolveLocale(s, nonNull(s, name, "requestedLocaleIDName"));
      this.$status = this.$locale.status;
    }

    get lastOperationStatus(): string {
      return this.$status;
    }

    get requestedLocaleIDName(): string {
      return this.$locale.requested;
    }

    get actualLocaleIDName(): string {
      return this.$locale.actual;
    }

    toLowerCase(text: string | null): string {
      this.$status = NO_ERROR;
      return mapCase(nonNull(s, text, "s"), (c) => c.toLocaleLowerCase(this.$locale.actual), true);
    }

    toUpperCase(text: string | null): string {
      this.$status = NO_ERROR;
      return mapCase(nonNull(s, text, "s"), (c) => c.toLocaleUpperCase(this.$locale.actual), false);
    }
  }

  avm2.registerNativeClass(natives, "flash.globalization::StringTools", StringToolsNatives);
  return natives;
}
