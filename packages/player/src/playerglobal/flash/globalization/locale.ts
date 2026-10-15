// What flash.globalization's classes share: the locale a class asks for
// resolved as Flash resolves it, onto JavaScript's Intl, and the statuses
// they report. Flash on Windows (AIR's adl is the reference) takes its
// locale data from the system; here it is ICU's, as the host's Intl has it.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

// LastOperationStatus's values.
export const NO_ERROR = "noError";
export const USING_FALLBACK_WARNING = "usingFallbackWarning";
export const USING_DEFAULT_WARNING = "usingDefaultWarning";
export const PARSE_ERROR = "parseError";
export const UNSUPPORTED_ERROR = "unsupportedError";
export const PATTERN_SYNTAX_ERROR = "patternSyntaxError";
export const ILLEGAL_ARGUMENT_ERROR = "illegalArgumentError";
export const INVALID_ATTR_VALUE = "invalidAttrValue";

/** A formatter's locale: the name it was asked for, the locale it uses and how it came to it. */
export interface Locale {
  requested: string;
  actual: string;
  status: string;
}

/**
 * A locale name's parts, as Flash takes it apart: a language, a script, a
 * region, variants of two to eight letters and digits, not digits alone;
 * any run of hyphens, underscores, dots or spaces between them.
 */
export const NAME_PARTS =
  /^([a-z]{2,8})(?:[-_. ]+([a-z]{4}))?(?:[-_. ]+([a-z]{2}|\d{3}))?((?:[-_. ]+(?=\d*[a-z])[a-z\d]{2,8})*)[-_. ]*$/i;

/** The keywords after "@" Flash knows; any other leaves a name one it cannot take apart. */
export const KEYWORDS = ["calendar", "collation", "currency", "numbers"];

/** A name's keywords, "@key=value;key=value", null for one Flash does not know. */
export function keywordsOf(name: string): Record<string, string> | null {
  const keywords: Record<string, string> = {};
  const list = name.split("@")[1];
  for (const pair of list ? list.split(";") : []) {
    const [key, value] = pair.split("=");
    if (!KEYWORDS.includes(key)) {
      return null;
    }

    keywords[key] = value ?? "";
  }

  return keywords;
}

/**
 * A locale name as Flash keeps what it was given: one it takes apart, its
 * subtags parted by single hyphens or underscores, with hyphens, the
 * language in lower case, a script capitalized, the region and variants in
 * upper case; one parted otherwise as it came; one it cannot take apart all
 * in lower case.
 */
export function canonicalName(name: string): string {
  const [base, ...keywords] = name.split("@");
  const m = NAME_PARTS.exec(base);
  if (!m) {
    return name.toLowerCase();
  }

  if (!/^[a-z\d]+(?:[-_][a-z\d]+)*$/i.test(base)) {
    return name;
  }

  const [, language, script, region, variants] = m;
  const named = [
    language.toLowerCase(),
    script && script[0].toUpperCase() + script.slice(1).toLowerCase(),
    region?.toUpperCase(),
    variants.slice(1).toUpperCase(),
  ];
  return [named.filter(Boolean).join("-").replaceAll("_", "-"), ...keywords].join("@");
}

// What Flash resolves: a language of two or three letters with the parts above.
const TAG =
  /^([a-z]{2,3})(?:[-_. ]+([a-z]{4}))?(?:[-_. ]+([a-z]{2}|\d{3}))?(?:[-_. ]+(?=\d*[a-z])[a-z\d]{2,8})*[-_. ]*$/i;

/**
 * The names resolved last, at most this many: a name is any string a SWF
 * makes, and every player shares the cache, so it must not keep them all.
 */
export const RESOLVED_MAX = 64;

const resolved = new Map<string, Locale>();

/** How many resolutions are kept, for tests. */
export function resolvedCount(): number {
  return resolved.size;
}

/** The locale Flash uses for a name: the name's own, its language's in its likely region, or the default. */
export function resolveLocale(s: Scripting, name: string): Locale {
  const key = `${name}@@${s.platform.locale}`;
  let locale = resolved.get(key);
  if (locale) {
    // The most recent last, so that the oldest goes first.
    resolved.delete(key);
  } else {
    const requested = canonicalName(name);
    const base = requested.split("@")[0];
    const named = base !== "" && base !== "i-default";
    const found = named && keywordsOf(requested) ? supported(base) : null;
    locale = {
      requested,
      actual: found?.actual ?? defaultLocale(s),
      status: found?.status ?? (named ? USING_DEFAULT_WARNING : NO_ERROR),
    };
    if (resolved.size >= RESOLVED_MAX) {
      resolved.delete(resolved.keys().next().value as string);
    }
  }

  resolved.set(key, locale);
  return { ...locale };
}

function supported(base: string): { actual: string; status: string } | null {
  const m = TAG.exec(base);
  // A language Intl does not know, or knows by another code (iw for he, tl for fil), is none.
  if (
    !m ||
    m[1].toLowerCase() === "und" ||
    Intl.DateTimeFormat.supportedLocalesOf(m[1]).length === 0 ||
    Intl.getCanonicalLocales(m[1])[0] !== m[1].toLowerCase()
  ) {
    return null;
  }

  const language = m[1].toLowerCase();
  const [, , script, region] = m;
  const likely = new Intl.Locale(script ? `${language}-${script}` : language).maximize();
  // A region ICU has data for is one its own data resolves to; one it has none for resolves
  // to the language's (en-ZZ to en, the US), while nb-NO's data is nb's, Norway's.
  const known =
    region !== undefined &&
    new Intl.Locale(
      new Intl.NumberFormat(`${language}-${region}`).resolvedOptions().locale,
    ).maximize().region === region.toUpperCase();
  // Windows names Chinese by its region alone: zh-TW, not zh-Hant-TW.
  const named = script && language !== "zh" ? `${language}-${likely.script}` : language;
  const place = known ? region.toUpperCase() : likely.region;
  return {
    actual: place ? `${named}-${place}` : named,
    status: region === undefined || known ? NO_ERROR : USING_FALLBACK_WARNING,
  };
}

/** The user's locale, a host's platform's, or en-US where it names none Flash could use. */
export function defaultLocale(s: Scripting): string {
  const found = supported(canonicalName(s.platform.locale));
  return found && found.status === NO_ERROR ? found.actual : "en-US";
}

/** Flash's TypeError for a null argument. */
export function nonNull<T>(s: Scripting, value: T | null, name: string): T {
  if (value === null || value === undefined) {
    throw s.rt.error("TypeError", 2007, name);
  }

  return value;
}

export function stringVector(s: Scripting, strings: string[]): AsObject {
  const o = s.rt.resolve(s.rt.vector("String")).$it.instance();
  o.$a = strings;
  return o;
}

/** A Vector.<String>'s strings, a null one as Flash's empty one. */
export function vectorStrings(v: Value): string[] {
  return ((v as AsObject).$a as (string | null)[]).map((x) => x ?? "");
}

// Each region's currency, which Intl does not give: most currencies' codes begin with their
// region's, the rest are listed with the regions that share them.
const NATIONAL =
  "AED AFN ALL AMD AOA ARS AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD " +
  "CAD CDF CLP CNY COP CRC CUP CVE CZK DJF DOP DZD EGP ERN ETB FJD FKP GEL GHS GIP GMD GNF " +
  "GTQ GYD HKD HNL HTG HUF IDR INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD " +
  "KZT LAK LBP LKR LRD LSL LYD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN " +
  "NIO NPR OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP " +
  "SLE SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX UYU UZS VES VND " +
  "VUV WST YER ZAR ZMW ZWG";
const SHARED =
  "EUR:AD AT AX BE BG BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT " +
  "RE SI SK SM TF VA XK YT EA IC;USD:AS BQ DG EC FM GU IO MH MP PR PW SV TC TL UM US VG VI;" +
  "AUD:AU CC CX HM KI NF NR TV;NZD:CK NU NZ PN TK;XOF:BF BJ CI GW ML NE SN TG;" +
  "XAF:CF CG CM GA GQ TD;XCD:AG AI DM GD KN LC MS VC;XPF:NC PF WF;DKK:DK FO GL;" +
  "NOK:BV NO SJ;CHF:CH LI;GBP:GB GG GS IM JE TA;MAD:EH MA;ILS:IL PS;XCG:CW SX;SHP:AC";

let currencies: Map<string, string> | undefined;

function currencyTable(): Map<string, string> {
  if (!currencies) {
    currencies = new Map(NATIONAL.split(" ").map((code) => [code.slice(0, 2), code]));
    for (const group of SHARED.split(";")) {
      const [code, regions] = group.split(":");
      for (const region of regions.split(" ")) {
        currencies.set(region, code);
      }
    }
  }

  return currencies;
}

/**
 * A locale's currency, by its region: Windows' XDR, with no symbol, for an
 * area of several countries (419, 150), ISO's "no currency" for any other
 * region without one.
 */
export function currencyOf(locale: string): string {
  const region = new Intl.Locale(locale).maximize().region ?? "";
  return /^\d{3}$/.test(region) ? "XDR" : (currencyTable().get(region) ?? "XXX");
}

let available: string[] | undefined;

/**
 * The locales the classes can use. Intl lists none, so these are each
 * region's likely locale, where the host's Intl supports it; Flash on
 * Windows lists the system's, 801 of them.
 */
export function availableLocales(s: Scripting): AsObject {
  if (!available) {
    const names = new Set<string>();
    for (const region of currencyTable().keys()) {
      const likely = new Intl.Locale(`und-${region}`).maximize();
      names.add(`${likely.language}-${likely.region}`);
    }

    available = Intl.DateTimeFormat.supportedLocalesOf([...names]).sort();
  }

  return stringVector(s, available.slice());
}
