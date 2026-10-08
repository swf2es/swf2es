// flash.globalization.Collator onto Intl.Collator. Intl has no options for
// character width or kana, so those fold the strings before comparing:
// full- and half-width forms to their plain ones, hiragana to katakana.
// Where ICU's order and Windows' differ in their data (kana, widths), ICU's stands.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import {
  availableLocales,
  type Locale,
  NO_ERROR,
  nonNull,
  resolveLocale,
  UNSUPPORTED_ERROR,
} from "./locale.js";

type Value = avm2.Value;

type Option =
  | "ignoreCase"
  | "ignoreDiacritics"
  | "ignoreKanaType"
  | "ignoreSymbols"
  | "ignoreCharacterWidth"
  | "numericComparison";

class CollatorSettings {
  status: string;
  readonly locale: Locale;
  ignoreCase: boolean;
  ignoreDiacritics: boolean;
  ignoreKanaType: boolean;
  ignoreSymbols: boolean;
  ignoreCharacterWidth: boolean;
  numericComparison = false;
  private collator: Intl.Collator | null = null;

  constructor(locale: Locale, matching: boolean) {
    this.locale = locale;
    this.status = locale.status;
    this.ignoreCase = matching;
    this.ignoreDiacritics = matching;
    this.ignoreKanaType = matching;
    this.ignoreSymbols = matching;
    this.ignoreCharacterWidth = matching;
  }

  set(option: Option, value: boolean): void {
    this[option] = value;
    this.collator = null;
    // Flash in adl reports numeric comparison unsupported, and compares as it would without it.
    this.status = option === "numericComparison" ? UNSUPPORTED_ERROR : NO_ERROR;
  }

  compare(a: string, b: string): number {
    this.collator ??= new Intl.Collator(this.locale.actual, {
      sensitivity: this.ignoreCase
        ? this.ignoreDiacritics
          ? "base"
          : "accent"
        : this.ignoreDiacritics
          ? "case"
          : "variant",
      ignorePunctuation: this.ignoreSymbols,
    });
    this.status = NO_ERROR;
    a = this.fold(a);
    b = this.fold(b);
    // Windows' word sort sets hyphens and apostrophes aside, so that "co-op" stays beside
    // "coop": compared without them, then by how many each has, after the same word without.
    const words = (text: string) => text.replace(/['-]/g, "");
    const count = (text: string) => text.length - words(text).length;
    if (this.ignoreSymbols) {
      return this.collator.compare(a, b);
    }

    return (
      this.collator.compare(words(a), words(b)) ||
      Math.sign(count(a) - count(b)) ||
      this.collator.compare(a, b)
    );
  }

  private fold(text: string): string {
    // Windows takes ß for ss at every strength, where ICU tells them apart.
    text = text.replaceAll("\u00df", "ss").replaceAll("\u1e9e", "SS");
    if (this.ignoreCharacterWidth) {
      text = text.replace(/[\uff01-\uffee]/g, (c) => c.normalize("NFKC"));
    }

    if (this.ignoreKanaType) {
      text = text.replace(/[\u3041-\u3096\u309d\u309e]/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) + 0x60),
      );
    }

    // ICU's ignorePunctuation leaves symbols ("$1" against "1"), which Windows ignores too.
    if (this.ignoreSymbols) {
      text = text.replace(/\p{S}/gu, "");
    }

    return text;
  }
}

export function collatorNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const settings = (o: CollatorNatives) => o.$settings;
  const strings = (a: string | null, b: string | null): [string, string] => [
    nonNull(s, a, "string1"),
    nonNull(s, b, "string2"),
  ];

  class CollatorNatives {
    declare $settings: CollatorSettings;

    static getAvailableLocaleIDNames(): Value {
      return availableLocales(s);
    }

    "flash.globalization:Collator::ctor"(name: string | null, mode: string | null): void {
      const locale = resolveLocale(s, nonNull(s, name, "requestedLocaleIDName"));
      if (nonNull(s, mode, "initialMode") !== "sorting" && mode !== "matching") {
        throw s.rt.error("ArgumentError", 1508, "initialMode");
      }

      this.$settings = new CollatorSettings(locale, mode === "matching");
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

    get ignoreCase(): boolean {
      return settings(this).ignoreCase;
    }

    set ignoreCase(v: boolean) {
      settings(this).set("ignoreCase", v);
    }

    get ignoreDiacritics(): boolean {
      return settings(this).ignoreDiacritics;
    }

    set ignoreDiacritics(v: boolean) {
      settings(this).set("ignoreDiacritics", v);
    }

    get ignoreKanaType(): boolean {
      return settings(this).ignoreKanaType;
    }

    set ignoreKanaType(v: boolean) {
      settings(this).set("ignoreKanaType", v);
    }

    get ignoreSymbols(): boolean {
      return settings(this).ignoreSymbols;
    }

    set ignoreSymbols(v: boolean) {
      settings(this).set("ignoreSymbols", v);
    }

    get ignoreCharacterWidth(): boolean {
      return settings(this).ignoreCharacterWidth;
    }

    set ignoreCharacterWidth(v: boolean) {
      settings(this).set("ignoreCharacterWidth", v);
    }

    get numericComparison(): boolean {
      return settings(this).numericComparison;
    }

    set numericComparison(v: boolean) {
      settings(this).set("numericComparison", v);
    }

    compare(a: string | null, b: string | null): number {
      return settings(this).compare(...strings(a, b));
    }

    equals(a: string | null, b: string | null): boolean {
      return settings(this).compare(...strings(a, b)) === 0;
    }
  }

  avm2.registerNativeClass(natives, "flash.globalization::Collator", CollatorNatives);
  return natives;
}
