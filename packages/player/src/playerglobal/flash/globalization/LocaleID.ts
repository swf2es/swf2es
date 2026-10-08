// flash.globalization.LocaleID: a locale name taken apart, the script and
// region it leaves out filled in with Intl's likely ones.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import {
  canonicalName,
  NAME_PARTS,
  NO_ERROR,
  nonNull,
  stringVector,
  vectorStrings,
} from "./locale.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const RTL_SCRIPTS = /^(Adlm|Arab|Hebr|Mand|Nkoo|Rohg|Syrc|Thaa)$/;

interface Parts {
  name: string;
  language: string;
  script: string;
  region: string;
  variant: string;
  keywords: Record<string, string>;
}

function parseName(given: string): Parts {
  const canonical = canonicalName(given);
  const [base, keywordList = ""] = canonical.split("@");
  const keywords: Record<string, string> = {};
  for (const pair of keywordList.split(";")) {
    const [key, value] = pair.split("=");
    if (key && value !== undefined) {
      keywords[key] = value;
    }
  }

  const m = NAME_PARTS.exec(base);
  if (!m) {
    // Flash keeps a name it cannot take apart whole as its language.
    const second = canonical.split("-")[1] ?? "";
    return {
      name: canonical,
      language: canonical,
      script: "",
      region: /^[a-z]{2}$/.test(second) ? second : "",
      variant: "",
      keywords,
    };
  }

  const [, language, script, region, variants] = m;
  let likely: Intl.Locale | null = null;
  try {
    likely = new Intl.Locale(script ? `${language}-${script}` : language).maximize();
  } catch {}

  return {
    name: canonical,
    language,
    script: script ?? likely?.script ?? "",
    region: region ?? likely?.region ?? "",
    variant: variants.replace(/^-+/, "").replace(/-+/g, "-"),
    keywords,
  };
}

/**
 * Flash's order of preference: for each locale wanted, those it has of the
 * same language and script, the same locale first, then the language's own,
 * then the language's in other regions.
 */
function preferred(want: string[], have: string[]): string[] {
  const key = (name: string) => {
    const full = canonicalName(name);
    try {
      const l = new Intl.Locale(full.split("@")[0]);
      const likely = l.maximize();
      return {
        full,
        language: `${likely.language}-${likely.script}`,
        regional: l.region !== undefined,
      };
    } catch {
      return { full, language: full, regional: false };
    }
  };
  const haves = have.map((name) => ({ name, ...key(name) }));
  const out: string[] = [];
  for (const w of want.map(key)) {
    const same = haves.filter((h) => h.language === w.language);
    const rank = (h: (typeof haves)[number]) => (h.full === w.full ? 0 : h.regional ? 2 : 1);
    for (const h of same.sort((a, b) => rank(a) - rank(b))) {
      if (!out.includes(h.name)) {
        out.push(h.name);
      }
    }
  }

  return out;
}

export function localeIDNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class LocaleIDNatives {
    declare $parts: Parts;

    static determinePreferredLocales(
      want: Value,
      have: Value,
      keyword: string | null = "userinterface",
    ): Value {
      nonNull(s, want, "want");
      nonNull(s, have, "have");
      nonNull(s, keyword, "keyword");
      return stringVector(s, preferred(vectorStrings(want), vectorStrings(have)));
    }

    "flash.globalization:LocaleID::ctor"(name: string | null): void {
      this.$parts = parseName(nonNull(s, name, "name"));
    }

    get name(): string {
      return this.$parts.name;
    }

    get lastOperationStatus(): string {
      return NO_ERROR;
    }

    getLanguage(): string {
      return this.$parts.language;
    }

    getScript(): string {
      return this.$parts.script;
    }

    getRegion(): string {
      return this.$parts.region;
    }

    getVariant(): string {
      return this.$parts.variant;
    }

    getKeysAndValues(): AsObject {
      return s.rt.newObject(Object.entries(this.$parts.keywords).flat());
    }

    isRightToLeft(): boolean {
      return RTL_SCRIPTS.test(this.$parts.script);
    }
  }

  avm2.registerNativeClass(natives, "flash.globalization::LocaleID", LocaleIDNatives);
  return natives;
}
