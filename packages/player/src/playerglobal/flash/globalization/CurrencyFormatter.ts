// flash.globalization.CurrencyFormatter: NumberFormatter's settings and
// digits, placed with the currency by Windows' currency formats, which
// are Flash's. A locale's own formats are found in Intl's: its accounting
// format, which ICU gives the parentheses Windows uses, is its negative one.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import {
  availableLocales,
  currencyOf,
  ILLEGAL_ARGUMENT_ERROR,
  type Locale,
  NO_ERROR,
  nonNull,
  PARSE_ERROR,
  resolveLocale,
  UNSUPPORTED_ERROR,
} from "./locale.js";
import { digit, NumberSettings, partsPattern } from "./NumberFormatter.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

// Windows' positive and negative currency formats: "$" the currency, "-" the negative symbol, "n" the number.
const POSITIVE = ["$n", "n$", "$ n", "n $"];
const NEGATIVE = [
  "($n)",
  "-$n",
  "$-n",
  "$n-",
  "(n$)",
  "-n$",
  "n-$",
  "n$-",
  "-n $",
  "-$ n",
  "n $-",
  "$ n-",
  "$ -n",
  "n- $",
  "($ n)",
  "(n $)",
];

/** A locale's own currency settings, read off Intl once per locale. */
interface CurrencyData {
  code: string;
  symbol: string;
  digits: number;
  positive: number;
  negative: number;
}

const currencyData = new Map<string, CurrencyData>();

function localeCurrency(locale: string): CurrencyData {
  let data = currencyData.get(locale);
  if (data) {
    return data;
  }

  const code = currencyOf(locale);
  // A narrow symbol has ICU place it as the locale's pattern says, with no spacing of its own;
  // a region with no currency of its own (XDR) is placed as the dollar would be.
  const options = {
    style: "currency",
    currency: code === "XDR" ? "USD" : code,
    currencyDisplay: "narrowSymbol",
  } as const;
  const parts = new Intl.NumberFormat(locale, options).formatToParts(1234.5);
  const accounting = new Intl.NumberFormat(locale, { ...options, currencySign: "accounting" });
  const own = new Intl.NumberFormat(locale, { style: "currency", currency: code });
  data = {
    code,
    // Windows gives such a region's currency no symbol.
    symbol:
      code === "XDR"
        ? ""
        : (own.formatToParts(1).find((p) => p.type === "currency")?.value ?? code),
    digits: own.resolvedOptions().maximumFractionDigits ?? 2,
    positive: Math.max(0, POSITIVE.indexOf(partsPattern(parts))),
    negative: Math.max(0, NEGATIVE.indexOf(partsPattern(accounting.formatToParts(-1234.5)))),
  };
  currencyData.set(locale, data);
  return data;
}

class CurrencySettings extends NumberSettings {
  currencyISOCode: string;
  currencySymbol: string;
  positiveFormat: number;
  negativeCurrencyFormat: number;

  constructor(locale: Locale) {
    super(locale);
    const data = localeCurrency(locale.actual);
    this.currencyISOCode = data.code;
    this.currencySymbol = data.symbol;
    this.fractionalDigits = data.digits;
    this.positiveFormat = data.positive;
    this.negativeCurrencyFormat = data.negative;
  }

  /**
   * A currency amount filling `text` but for spaces, as the negative format
   * or the positive one places it: the currency is what stands where the
   * pattern has it, spaces allowed between it and the number.
   */
  parseCurrency(text: string): { value: number; symbol: string } {
    if (text === "") {
      this.status = ILLEGAL_ARGUMENT_ERROR;
      return { value: Number.NaN, symbol: "" };
    }

    for (const negative of [true, false]) {
      const pattern = negative
        ? NEGATIVE[this.negativeCurrencyFormat]
        : POSITIVE[this.positiveFormat];
      const groups = this.patternRegExp(pattern).exec(text)?.groups;
      if (groups) {
        const digits = groups.number;
        let number = "";
        for (let i = 0; i < digits.length; i++) {
          const d = digit(digits, i);
          number += d >= 0 ? d : digits.startsWith(this.decimalSeparator, i) ? "." : "";
        }

        this.status = NO_ERROR;
        return { value: negative ? -Number(number) : Number(number), symbol: groups.symbol ?? "" };
      }
    }

    this.status = PARSE_ERROR;
    return { value: Number.NaN, symbol: "" };
  }

  private patternRegExp(pattern: string): RegExp {
    const literal = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
    const sign = literal(this.negativeSymbol);
    // A currency neither begins nor ends with a space, nor holds a sign or parentheses; before
    // the number, as little as leaves it one, so that "$.5" is "$" and .5.
    const not = `()${this.negativeSymbol.replace(/[\\\]^-]/g, "\\$&")}`;
    const symbolBefore = `(?<symbol>[^\\p{Nd}\\p{Zs}${not}](?:[^\\p{Nd}${not}]*?[^\\p{Nd}\\p{Zs}${not}])??)?`;
    const symbolAfter = `(?<symbol>[^\\p{Zs}${not}](?:[^${not}]*[^\\p{Zs}${not}])?)?`;
    const group = this.groupingSeparator === "" ? "" : `(?:${literal(this.groupingSeparator)})?`;
    const decimal = literal(this.decimalSeparator);
    const number = `(?<number>\\p{Nd}(?:${group}\\p{Nd})*(?:${decimal}\\p{Nd}*)?|${decimal}\\p{Nd}+)`;
    const before = pattern.indexOf("$") < pattern.indexOf("n");
    let source = "";
    let previous = "";
    for (const c of pattern) {
      if (c === " " || (c === "$" && previous === "n") || (c === "n" && previous === "$")) {
        source += "\\p{Zs}*";
      }

      switch (c) {
        case "(":
        case ")":
          source += `\\${c}`;
          break;
        case "-":
          source += sign;
          break;
        case "$":
          source += before ? symbolBefore : symbolAfter;
          break;
        case "n":
          source += number;
          break;
      }

      if (c !== " ") {
        previous = c;
      }
    }

    return new RegExp(`^\\p{Zs}*${source}\\p{Zs}*$`, "u");
  }
}

export function currencyFormatterNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const settings = (o: CurrencyFormatterNatives) => o.$settings;

  class CurrencyFormatterNatives {
    declare $settings: CurrencySettings;

    static getAvailableLocaleIDNames(): Value {
      return availableLocales(s);
    }

    "flash.globalization:CurrencyFormatter::ctor"(name: string | null): void {
      this.$settings = new CurrencySettings(
        resolveLocale(s, nonNull(s, name, "requestedLocaleIDName")),
      );
    }

    get lastOperationStatus(): string {
      return settings(this).status;
    }

    get requestedLocaleIDName(): string {
      return settings(this).locale.requested;
    }

    get actualLocaleIDName(): string {
      return settings(this).locale.actual;
    }

    get currencyISOCode(): string {
      return settings(this).currencyISOCode;
    }

    get currencySymbol(): string {
      return settings(this).currencySymbol;
    }

    setCurrency(code: string | null, symbol: string | null): void {
      const f = settings(this);
      nonNull(s, code, "currencyISOCode");
      nonNull(s, symbol, "currencySymbol");
      const valid = /^[A-Z]{3}$/.test(code as string);
      if (valid) {
        f.currencyISOCode = code as string;
        f.currencySymbol = symbol as string;
      }

      f.status = valid ? NO_ERROR : ILLEGAL_ARGUMENT_ERROR;
    }

    "flash.globalization:CurrencyFormatter::formatImplementation"(
      value: number,
      withSymbol: boolean,
    ): string {
      const f = settings(this);
      return f.format(
        value,
        (negative) => (negative ? NEGATIVE[f.negativeCurrencyFormat] : POSITIVE[f.positiveFormat]),
        withSymbol ? f.currencySymbol : f.currencyISOCode,
      );
    }

    formattingWithCurrencySymbolIsSafe(code: string | null): boolean {
      const f = settings(this);
      f.status = NO_ERROR;
      return nonNull(s, code, "requestedISOCode") === f.currencyISOCode;
    }

    parse(text: string | null): AsObject {
      const { value, symbol } = settings(this).parseCurrency(nonNull(s, text, "value"));
      return s.rt.construct(
        s.rt.classNamed("flash.globalization::CurrencyParseResult"),
        value,
        symbol,
      ) as AsObject;
    }

    get fractionalDigits(): number {
      return settings(this).fractionalDigits;
    }

    set fractionalDigits(n: number) {
      settings(this).setFractionalDigits(n);
    }

    get useGrouping(): boolean {
      return settings(this).useGrouping;
    }

    set useGrouping(v: boolean) {
      settings(this).set("useGrouping", v);
    }

    get groupingPattern(): string {
      return settings(this).groupingPattern;
    }

    set groupingPattern(v: string | null) {
      settings(this).setGroupingPattern(nonNull(s, v, "value"));
    }

    get digitsType(): number {
      return settings(this).digitsType;
    }

    set digitsType(v: number) {
      settings(this).setDigitsType(v);
    }

    get decimalSeparator(): string {
      return settings(this).decimalSeparator;
    }

    set decimalSeparator(v: string | null) {
      settings(this).setDecimalSeparator(nonNull(s, v, "value"));
    }

    get groupingSeparator(): string {
      return settings(this).groupingSeparator;
    }

    set groupingSeparator(v: string | null) {
      settings(this).setGroupingSeparator(nonNull(s, v, "value"));
    }

    get negativeSymbol(): string {
      return settings(this).negativeSymbol;
    }

    // Windows keeps the locale's.
    set negativeSymbol(v: string | null) {
      nonNull(s, v, "value");
      settings(this).status = UNSUPPORTED_ERROR;
    }

    get negativeCurrencyFormat(): number {
      return settings(this).negativeCurrencyFormat;
    }

    set negativeCurrencyFormat(n: number) {
      const f = settings(this);
      if (f.setFormat(n, NEGATIVE.length)) {
        f.negativeCurrencyFormat = n;
      }
    }

    get positiveCurrencyFormat(): number {
      return settings(this).positiveFormat;
    }

    set positiveCurrencyFormat(n: number) {
      const f = settings(this);
      if (f.setFormat(n, POSITIVE.length)) {
        f.positiveFormat = n;
      }
    }

    get leadingZero(): boolean {
      return settings(this).leadingZero;
    }

    set leadingZero(v: boolean) {
      settings(this).set("leadingZero", v);
    }

    get trailingZeros(): boolean {
      return settings(this).trailingZeros;
    }

    set trailingZeros(v: boolean) {
      settings(this).set("trailingZeros", v);
    }
  }

  avm2.registerNativeClass(
    natives,
    "flash.globalization::CurrencyFormatter",
    CurrencyFormatterNatives,
  );
  return natives;
}
