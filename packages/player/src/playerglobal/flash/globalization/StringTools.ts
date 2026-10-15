// flash.globalization.StringTools: case mapping character by character, as
// Windows maps case: no context, as a final sigma's, and no locale's rules
// but Turkish, Azerbaijani and Lithuanian ones, so Greek keeps its accents.
// A character whose full mapping expands takes its simple one where its
// decomposition gives one (ᾳ to ᾼ) and stays as it is otherwise (ﬁ, ŉ),
// but for ß, which Flash makes SS, and İ, which it lowers to i.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { availableLocales, type Locale, NO_ERROR, nonNull, resolveLocale } from "./locale.js";

type Value = avm2.Value;

const CASED_LOCALES = /^(tr|az|lt)\b/;

function mapCase(text: string, locale: string, lower: boolean): string {
  const rules = CASED_LOCALES.test(locale) ? locale : "und";
  const map = (c: string) => (lower ? c.toLocaleLowerCase(rules) : c.toLocaleUpperCase(rules));
  let out = "";
  for (const c of text) {
    const mapped = [...map(c)];
    if (mapped.length === 1 || c === "\u00df") {
      out += mapped.join("");
      continue;
    }

    // The base letter mapped, its marks kept: the simple mapping, if it is one character
    // (Lithuanian's Ì lowers to ì); else a lower case keeps its first character, the dotted
    // I's i, and an upper case the character as it is.
    const [base, ...marks] = [...c.normalize("NFD")];
    const simple = [...(map(base) + marks.join("")).normalize("NFC")];
    out += simple.length === 1 ? simple[0] : lower ? mapped[0] : c;
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
      return mapCase(nonNull(s, text, "s"), this.$locale.actual, true);
    }

    toUpperCase(text: string | null): string {
      this.$status = NO_ERROR;
      return mapCase(nonNull(s, text, "s"), this.$locale.actual, false);
    }
  }

  avm2.registerNativeClass(natives, "flash.globalization::StringTools", StringToolsNatives);
  return natives;
}
