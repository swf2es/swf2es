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

/** A locale name's parts, as Flash takes it apart: a language, a script, a region, variants. */
export const NAME_PARTS =
  /^([a-z]{2,8})(?:-+([a-z]{4}))?(?:-+([a-z]{2}|\d{3}))?((?:-+[a-z0-9]{5,8})*)-*$/i;

/**
 * A locale name as Flash keeps what it was given: underscores as hyphens,
 * the language in lower case, a script capitalized and a region in upper
 * case, the rest as it came; a name it cannot take apart all in lower case.
 */
export function canonicalName(name: string): string {
  const canonical = casedName(name);
  return NAME_PARTS.test(canonical.split("@")[0]) ? canonical : canonical.toLowerCase();
}

function casedName(name: string): string {
  const [base, ...keywords] = name.replaceAll("_", "-").split("@");
  const tags = base.split("-");
  let i = 0;
  const named = tags.map((tag, n) => {
    if (n === 0) {
      return tag.toLowerCase();
    }

    if (tag === "" || i > 1) {
      return tag;
    }

    if (i === 0 && /^[a-z]{4}$/i.test(tag)) {
      i = 1;
      return tag[0].toUpperCase() + tag.slice(1).toLowerCase();
    }

    i = 2;
    return /^([a-z]{2}|\d{3})$/i.test(tag) ? tag.toUpperCase() : tag;
  });
  return [named.join("-"), ...keywords].join("@");
}

// A language, a script, a region and variants of letters; any other tag is one Flash cannot use.
const TAG = /^([a-z]{2,3})(?:-+([a-z]{4}))?(?:-+([a-z]{2}|\d{3}))?(?:-+[a-z]{5,8})*-*$/i;

/** The locale Flash uses for a name: the name's own, its language's in its likely region, or the default. */
export function resolveLocale(s: Scripting, name: string): Locale {
  const requested = canonicalName(name);
  const base = requested.split("@")[0];
  if (base === "" || base === "i-default") {
    return { requested, actual: defaultLocale(s), status: NO_ERROR };
  }

  const found = supported(base);
  return found
    ? { requested, ...found }
    : { requested, actual: defaultLocale(s), status: USING_DEFAULT_WARNING };
}

function supported(base: string): { actual: string; status: string } | null {
  const m = TAG.exec(base);
  if (!m || Intl.DateTimeFormat.supportedLocalesOf(m[1]).length === 0) {
    return null;
  }

  const [, language, script, region] = m;
  const likely = new Intl.Locale(script ? `${language}-${script}` : language).maximize();
  // ICU resolves a region it has no data for to the language alone.
  const known =
    region !== undefined &&
    new Intl.Locale(new Intl.NumberFormat(`${language}-${region}`).resolvedOptions().locale)
      .region === region.toUpperCase();
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

export function vectorStrings(v: Value): string[] {
  return ((v as AsObject).$a as string[]).map(String);
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
  "RE SI SK SM TF VA XK YT;USD:AS BQ EC FM GU IO MH MP PR PW SV TC TL UM US VG VI;" +
  "AUD:AU CC CX HM KI NF NR TV;NZD:CK NU NZ PN TK;XOF:BF BJ CI GW ML NE SN TG;" +
  "XAF:CF CG CM GA GQ TD;XCD:AG AI DM GD KN LC MS VC;XPF:NC PF WF;DKK:DK FO GL;" +
  "NOK:BV NO SJ;CHF:CH LI;GBP:GB GG GS IM JE;MAD:EH MA;ILS:IL PS;ANG:CW SX";

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

/** A locale's currency, by its region; ISO's "no currency" for a region without one, as 419. */
export function currencyOf(locale: string): string {
  return currencyTable().get(new Intl.Locale(locale).maximize().region ?? "") ?? "XXX";
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
