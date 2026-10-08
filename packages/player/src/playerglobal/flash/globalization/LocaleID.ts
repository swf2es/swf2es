// flash.globalization.LocaleID: a locale name taken apart, the script and
// region it leaves out filled in with Intl's likely ones.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import {
  canonicalName,
  keywordsOf,
  NAME_PARTS,
  NO_ERROR,
  nonNull,
  stringVector,
  vectorStrings,
} from "./locale.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const UNKNOWN_LANGUAGES = ["und", "ji", "jw", "sh"];

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
  const base = canonical.split("@")[0];
  const keywords = keywordsOf(canonical);
  const m = keywords ? NAME_PARTS.exec(base) : null;
  if (!keywords || !m) {
    // Flash keeps a name it cannot take apart whole as its language, and a region after a
    // language it could read.
    const [first, second = ""] = canonical.split(/[-_. ]+/);
    return {
      name: canonical,
      language: canonical,
      script: "",
      region: /^[a-z]{2,8}$/.test(first) && /^[a-z]{2}$/.test(second) ? second : "",
      variant: "",
      keywords: {},
    };
  }

  const language = m[1].toLowerCase();
  const script = m[2] && m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  const region = m[3]?.toUpperCase();
  let likely: Intl.Locale | undefined;
  try {
    // The language as named, with its script and region; und has none, nor the deprecated
    // codes Windows does not know (it knows iw, in and tl).
    if (!UNKNOWN_LANGUAGES.includes(language)) {
      likely = new Intl.Locale([language, script, region].filter(Boolean).join("-")).maximize();
    }
  } catch {}

  return {
    name: canonical,
    language,
    script: script ?? likely?.script ?? "",
    region: region ?? likely?.region ?? "",
    variant: m[4]
      .split(/[-_. ]+/)
      .filter(Boolean)
      .map((v) => v.toUpperCase())
      .join("-"),
    keywords,
  };
}

interface Preference {
  name: string;
  /** As Windows names it: its script only where its region does not imply it. */
  named: string;
  maximized: string;
  language: string;
  regional: boolean;
}

function preference(name: string): Preference {
  const full = canonicalName(name).split("@")[0];
  try {
    const l = new Intl.Locale(full);
    // und, no language, matches only itself.
    if (l.language === "und") {
      return { name, named: full, maximized: full, language: full, regional: false };
    }

    const max = l.maximize();
    const implied = new Intl.Locale(l.region ? `${l.language}-${l.region}` : l.language).maximize();
    const script = l.script !== implied.script ? l.script : undefined;
    return {
      name,
      named: [l.language, script, l.region].filter(Boolean).join("-"),
      maximized: max.baseName,
      language: `${max.language}-${max.script}`,
      regional: l.region !== undefined,
    };
  } catch {
    return { name, named: full, maximized: full, language: full, regional: false };
  }
}

/**
 * Flash's order of preference: for each locale wanted, those it has of the
 * same language and script, the same locale first, then those its likely
 * locale is, then another locale wanted, then the language's in other
 * regions, then the language alone.
 */
function preferred(want: string[], have: string[]): string[] {
  const haves = have.map(preference);
  const wants = want.map(preference);
  const out: string[] = [];
  for (const w of wants) {
    const rank = (h: Preference) => {
      if (h.named === w.named) {
        return 0;
      }

      if (h.maximized === w.maximized) {
        return 1;
      }

      if (wants.some((other) => other.named === h.named)) {
        return 2;
      }

      return h.regional ? 3 : 4;
    };
    const same = haves.filter((h) => h.language === w.language);
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
