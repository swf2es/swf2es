// flash.globalization.NumberFormatter, and the number formatting and
// parsing it shares with CurrencyFormatter. Flash on Windows formats with
// its own rules from the locale's settings, which a script may change one
// by one, so only those settings come from Intl: the digits, separators and
// patterns are applied here as Flash applies them.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import {
  availableLocales,
  ILLEGAL_ARGUMENT_ERROR,
  INVALID_ATTR_VALUE,
  type Locale,
  NO_ERROR,
  nonNull,
  PARSE_ERROR,
  resolveLocale,
  UNSUPPORTED_ERROR,
} from "./locale.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

// NumberFormatter's negativeNumberFormat: where the negative symbol goes, "n" the number.
const NEGATIVE_NUMBER = ["(n)", "-n", "- n", "n-", "n -"];

// The bidi marks ICU sets around signs and symbols, which Windows has not.
const BIDI = /[\u061c\u200e\u200f]/g;

/** The pattern of Intl's parts: the number as "n", its sign as "-", the currency as "$". */
export function partsPattern(parts: Intl.NumberFormatPart[]): string {
  let pattern = "";
  for (const { type, value } of parts) {
    const token =
      type === "literal"
        ? value
            .replace(BIDI, "")
            .replace(/\s+/g, " ")
            .replace(/[^() ]/g, "")
        : type === "minusSign"
          ? "-"
          : type === "currency"
            ? "$"
            : "n";
    if (!(token === "n" && pattern.endsWith("n"))) {
      pattern += token;
    }
  }

  return pattern;
}

type Setting =
  | "fractionalDigits"
  | "useGrouping"
  | "groupingPattern"
  | "digitsType"
  | "decimalSeparator"
  | "groupingSeparator"
  | "leadingZero"
  | "trailingZeros";

// Group sizes, the last repeated with a "*": five fields at most.
const GROUPING = /^(?=.{1,9}$)([1-9](;[1-9])*(;\*)?|\*)$/;

/** A locale's number settings, as a NumberFormatter or CurrencyFormatter holds them, and its status. */
export class NumberSettings {
  status: string;
  readonly locale: Locale;
  fractionalDigits = 2;
  useGrouping = true;
  groupingPattern: string;
  digitsType: number;
  decimalSeparator: string;
  groupingSeparator: string;
  readonly negativeSymbol: string;
  negativeFormat: number;
  leadingZero = true;
  trailingZeros = true;

  constructor(locale: Locale) {
    this.locale = locale;
    this.status = locale.status;
    const nf = new Intl.NumberFormat(locale.actual);
    const parts = nf.formatToParts(-1234567890.5);
    const value = (type: string, otherwise: string) =>
      parts.find((p) => p.type === type)?.value.replace(BIDI, "") ?? otherwise;
    this.decimalSeparator = value("decimal", ".");
    this.groupingSeparator = value("group", ",");
    // Flash's negative symbol is one character; ICU gives some locales U+2212 where Windows has "-".
    this.negativeSymbol = value("minusSign", "-").replace("\u2212", "-");
    this.digitsType = nf.format(0).codePointAt(0) ?? 48;
    const groups = parts.filter((p) => p.type === "integer").map((p) => p.value.length);
    const primary = groups[groups.length - 1];
    const secondary = groups[groups.length - 2] ?? primary;
    this.groupingPattern = secondary === primary ? `${primary};*` : `${primary};${secondary};*`;
    this.negativeFormat = Math.max(0, NEGATIVE_NUMBER.indexOf(partsPattern(parts)));
  }

  /** A setting's new value kept if valid; Flash's status says which. */
  set<K extends Setting>(key: K, value: NumberSettings[K], valid = true): void {
    if (valid) {
      (this as NumberSettings)[key] = value;
    }

    this.status = valid ? NO_ERROR : ILLEGAL_ARGUMENT_ERROR;
  }

  setFractionalDigits(n: number): void {
    this.set("fractionalDigits", n, n >= 0);
  }

  setGroupingPattern(pattern: string): void {
    this.set("groupingPattern", pattern, GROUPING.test(pattern));
  }

  setDecimalSeparator(separator: string): void {
    this.set("decimalSeparator", separator, separator !== "");
  }

  /** A format among `count`: above them invalid, past int's range an illegal argument. */
  setFormat(n: number, count: number): boolean {
    this.status =
      n > 0x7fffffff ? ILLEGAL_ARGUMENT_ERROR : n >= count ? INVALID_ATTR_VALUE : NO_ERROR;
    return this.status === NO_ERROR;
  }

  setNegativeFormat(n: number): void {
    if (this.setFormat(n, NEGATIVE_NUMBER.length)) {
      this.negativeFormat = n;
    }
  }

  /**
   * The digits of a number's magnitude, grouped. Flash prints the number
   * with nine decimals and rounds that half up to the digits asked for.
   */
  digits(magnitude: number): string {
    const fractionalDigits = this.fractionalDigits;
    const fixed = magnitude < 1e21 ? magnitude.toFixed(9) : `${BigInt(magnitude)}.000000000`;
    let [whole, fraction] = fixed.split(".");
    if (fractionalDigits < 9) {
      const up = fraction.charCodeAt(fractionalDigits) >= 53;
      fraction = fraction.slice(0, fractionalDigits);
      if (up) {
        const sum = (BigInt(whole + fraction) + 1n)
          .toString()
          .padStart(whole.length + fraction.length, "0");
        whole = sum.slice(0, sum.length - fraction.length);
        fraction = sum.slice(whole.length);
      }
    } else {
      fraction = fraction.padEnd(fractionalDigits, "0");
    }

    if (!this.trailingZeros) {
      fraction = fraction.replace(/0+$/, "");
    }

    if (!this.leadingZero && whole === "0") {
      whole = "";
    }

    const grouped = this.useGrouping ? this.group(whole) : whole;
    const text = fraction === "" ? grouped : grouped + this.decimalSeparator + fraction;
    return this.digitsType === 48 ? text : this.localDigits(text);
  }

  private group(whole: string): string {
    const pattern = this.groupingPattern.split(";");
    const repeat = pattern[pattern.length - 1] === "*";
    const sizes = (repeat ? pattern.slice(0, -1) : pattern).map(Number);
    const chunks: string[] = [];
    let end = whole.length;
    for (let i = 0; end > 0; i++) {
      const size =
        i < sizes.length ? sizes[i] : repeat && sizes.length > 0 ? sizes[sizes.length - 1] : end;
      chunks.unshift(whole.slice(Math.max(0, end - size), end));
      end -= size;
    }

    return chunks.join(this.groupingSeparator);
  }

  private localDigits(text: string): string {
    return text.replace(/[0-9]/g, (d) => String.fromCodePoint(this.digitsType + Number(d)));
  }

  /** A number formatted, `pattern` placing its sign and digits: Flash's infinities and NaN keep none. */
  format(value: number, pattern: (negative: boolean) => string, symbol = ""): string {
    this.status = NO_ERROR;
    if (Number.isNaN(value)) {
      return "NaN";
    }

    if (!Number.isFinite(value)) {
      return value > 0 ? "\u221e" : `${this.negativeSymbol}\u221e`;
    }

    const negative = value < 0 || Object.is(value, -0);
    let out = "";
    for (const c of pattern(negative)) {
      out +=
        c === "n"
          ? this.digits(Math.abs(value))
          : c === "-"
            ? this.negativeSymbol
            : c === "$"
              ? symbol
              : c;
    }

    return out;
  }

  /**
   * The first number in `text` as Flash finds it: digits of any script,
   * group separators between digits, one decimal separator; its sign by
   * the negative format around it. Null where there is none.
   */
  findNumber(text: string): { value: number; start: number; end: number } | null {
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      if (
        digit(text, i) >= 0 ||
        (text.startsWith(this.decimalSeparator, i) &&
          digit(text, i + this.decimalSeparator.length) >= 0)
      ) {
        start = i;
        break;
      }
    }

    if (start < 0) {
      return null;
    }

    let number = "";
    let i = start;
    for (;;) {
      const d = digit(text, i);
      if (d >= 0) {
        number += d;
        i += 1;
      } else if (
        this.groupingSeparator !== "" &&
        !number.includes(".") &&
        number !== "" &&
        text.startsWith(this.groupingSeparator, i) &&
        digit(text, i + this.groupingSeparator.length) >= 0
      ) {
        i += this.groupingSeparator.length;
      } else if (!number.includes(".") && text.startsWith(this.decimalSeparator, i)) {
        number += ".";
        i += this.decimalSeparator.length;
      } else {
        break;
      }
    }

    let value = Number(number);
    let end = i;
    const sign = this.negativeSymbol;
    const before = skipSpaces(text, start, -1);
    const after = skipSpaces(text, end, 1);
    switch (this.negativeFormat) {
      case 0:
        if (text[before - 1] === "(" && text[after] === ")") {
          value = -value;
          start = before - 1;
          end = after + 1;
        }
        break;
      case 1:
      case 2:
        if (text.slice(0, before).endsWith(sign)) {
          value = -value;
          start = before - sign.length;
        }
        break;
      default:
        if (text.startsWith(sign, after)) {
          value = -value;
          end = after + sign.length;
        }
    }

    return { value, start, end };
  }

  parse(text: string): { value: number; start: number; end: number } {
    if (text === "") {
      this.status = ILLEGAL_ARGUMENT_ERROR;
      return { value: Number.NaN, start: 0x7fffffff, end: 0x7fffffff };
    }

    const found = this.findNumber(text);
    this.status = found ? NO_ERROR : PARSE_ERROR;
    return found ?? { value: Number.NaN, start: 0x7fffffff, end: 0x7fffffff };
  }

  /** A number filling `text` but for spaces; NaN otherwise. */
  parseNumber(text: string): number {
    const { value, start, end } = this.parse(text);
    if (this.status !== NO_ERROR) {
      return value;
    }

    if (skipSpaces(text, start, -1) > 0 || skipSpaces(text, end, 1) < text.length) {
      this.status = PARSE_ERROR;
      return Number.NaN;
    }

    return value;
  }
}

/** The value of the decimal digit at `i`, of any script, or -1. */
export function digit(text: string, i: number): number {
  const c = text.codePointAt(i);
  if (c === undefined || !/\p{Nd}/u.test(String.fromCodePoint(c))) {
    return -1;
  }

  // Unicode's decimal digits come in runs of ten from zero.
  let zero = c;
  while (zero > 0 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) {
    zero--;
  }

  return (c - zero) % 10;
}

/** The index past the spaces from `i` on in direction `step`: Flash's spaces are Unicode's space separators. */
export function skipSpaces(text: string, i: number, step: 1 | -1): number {
  const at = step > 0 ? (j: number) => text[j] : (j: number) => text[j - 1];
  while (at(i) !== undefined && /\p{Zs}/u.test(at(i))) {
    i += step;
  }

  return i;
}

export function numberFormatterNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const settings = (o: NumberFormatterNatives) => o.$settings;
  const format = (o: NumberFormatterNatives, value: number) => {
    const f = settings(o);
    return f.format(value, (negative) => (negative ? NEGATIVE_NUMBER[f.negativeFormat] : "n"));
  };

  class NumberFormatterNatives {
    declare $settings: NumberSettings;

    static getAvailableLocaleIDNames(): Value {
      return availableLocales(s);
    }

    "flash.globalization:NumberFormatter::ctor"(name: string | null): void {
      this.$settings = new NumberSettings(
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
      settings(this).set("digitsType", v);
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
      settings(this).set("groupingSeparator", nonNull(s, v, "value"));
    }

    get negativeSymbol(): string {
      return settings(this).negativeSymbol;
    }

    // Windows keeps the locale's.
    set negativeSymbol(v: string | null) {
      nonNull(s, v, "value");
      settings(this).status = UNSUPPORTED_ERROR;
    }

    get negativeNumberFormat(): number {
      return settings(this).negativeFormat;
    }

    set negativeNumberFormat(n: number) {
      settings(this).setNegativeFormat(n);
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

    formatInt(value: number): string {
      return format(this, value);
    }

    formatUint(value: number): string {
      return format(this, value);
    }

    formatNumber(value: number): string {
      return format(this, value);
    }

    parse(text: string | null): AsObject {
      const { value, start, end } = settings(this).parse(nonNull(s, text, "parseString"));
      return s.rt.construct(
        s.rt.classNamed("flash.globalization::NumberParseResult"),
        value,
        start,
        end,
      ) as AsObject;
    }

    parseNumber(text: string | null): number {
      return settings(this).parseNumber(nonNull(s, text, "parseString"));
    }
  }

  avm2.registerNativeClass(natives, "flash.globalization::NumberFormatter", NumberFormatterNatives);
  return natives;
}
