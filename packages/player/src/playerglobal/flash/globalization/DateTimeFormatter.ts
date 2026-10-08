// flash.globalization.DateTimeFormatter. Flash formats by a pattern of
// LDML letters, the locale's or a script's own, which it interprets the way
// Windows' GetDateFormat does: a Gregorian calendar, European digits, the
// styles long and medium alike. The locale's patterns are read off Intl's
// parts, and its names come from Intl; the pattern is interpreted here.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import {
  availableLocales,
  ILLEGAL_ARGUMENT_ERROR,
  type Locale,
  NO_ERROR,
  nonNull,
  PATTERN_SYNTAX_ERROR,
  resolveLocale,
  stringVector,
  UNSUPPORTED_ERROR,
  USING_FALLBACK_WARNING,
} from "./locale.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const STYLES = ["long", "medium", "short", "none"];
const CUSTOM = "custom";

// Friday, 5 January 2024, 03:04:05 UTC: every field tells its width, being under ten.
const SAMPLE = Date.UTC(2024, 0, 5, 3, 4, 5);

/** A locale's names and patterns, as Windows has one set of each. */
interface DateData {
  months: string[];
  genitiveMonths: string[];
  shortMonths: string[];
  weekdays: string[];
  shortWeekdays: string[];
  shortestWeekdays: string[];
  periods: string[];
  eras: string[];
  firstWeekday: number;
  date: { long: string; short: string };
  time: { long: string; short: string };
}

const dateData = new Map<string, DateData>();

function localeData(locale: string): DateData {
  let data = dateData.get(locale);
  if (data) {
    return data;
  }

  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: "UTC",
      calendar: "gregory",
      numberingSystem: "latn",
    });
  const names = (options: Intl.DateTimeFormatOptions, dates: number[]) => {
    const f = format(options);
    return dates.map((t) => f.format(t));
  };
  const months = Array.from({ length: 12 }, (_, m) => Date.UTC(2024, m, 1));
  const weekdays = Array.from({ length: 7 }, (_, d) => Date.UTC(2024, 0, 7 + d));
  const long = names({ month: "long" }, months);
  // A month's name beside a day, where ICU has one: Finnish's "tammikuuta".
  const withDay = format({ day: "numeric", month: "long" });
  const genitive = months.map((t, m) => {
    const name = withDay.formatToParts(t).find((p) => p.type === "month")?.value ?? "";
    return /^\d*$/.test(name) ? long[m] : name;
  });
  const shortWeekdays = names({ weekday: "short" }, weekdays);
  const narrowWeekdays = names({ weekday: "narrow" }, weekdays);
  const periods = format({ hour: "numeric", hour12: true });
  const eras = format({ era: "short", year: "numeric" });
  const part = (f: Intl.DateTimeFormat, t: number, type: string) =>
    f.formatToParts(t).find((p) => p.type === type)?.value ?? "";
  const info = new Intl.Locale(locale) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  data = {
    months: long,
    genitiveMonths: genitive,
    shortMonths: names({ month: "short" }, months),
    weekdays: names({ weekday: "long" }, weekdays),
    shortWeekdays,
    shortestWeekdays: shortestNames(shortWeekdays, narrowWeekdays),
    periods: [
      part(periods, SAMPLE, "dayPeriod"),
      part(periods, SAMPLE + 12 * 3600000, "dayPeriod"),
    ],
    eras: [part(eras, Date.UTC(-1, 0, 1), "era"), part(eras, SAMPLE, "era")],
    firstWeekday: ((info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 7) % 7,
    date: {
      long: patternOf(format({ dateStyle: "full" })),
      short: patternOf(format({ year: "numeric", month: "numeric", day: "numeric" })),
    },
    time: {
      long: patternOf(format({ timeStyle: "medium" })),
      short: patternOf(format({ timeStyle: "short" })),
    },
  };
  dateData.set(locale, data);
  return data;
}

/**
 * Windows' shortest weekday names are CLDR's short width ("Su", "DO", "周日"),
 * which Intl does not give: in a cased script the short names cut to two
 * letters; in others the short ones of two characters at most, else the
 * narrow ones; the short ones wherever that would name two days alike
 * (Vietnamese "Th", Portuguese "qu").
 */
function shortestNames(short: string[], narrow: string[]): string[] {
  const names = short.map((name, d) => {
    const chars = [...name];
    if (/^[\p{Lu}\p{Ll}]/u.test(name)) {
      return chars.slice(0, 2).join("");
    }

    return chars.length <= 2 ? name : narrow[d];
  });
  return new Set(names).size === names.length ? names : short;
}

const HOURS: Record<string, string> = { h12: "h", h23: "H", h11: "K", h24: "k" };

/** The pattern of Intl's format, read off its parts for the sample. */
function patternOf(f: Intl.DateTimeFormat): string {
  const hour = HOURS[f.resolvedOptions().hourCycle ?? "h23"];
  const twice = (letter: string, value: string) => letter.repeat(value.length > 1 ? 2 : 1);
  return f
    .formatToParts(SAMPLE)
    .map(({ type, value }) => {
      switch (type) {
        case "weekday":
          return "EEEE";
        case "month":
          return /^\d+$/.test(value) ? twice("M", value) : "MMMM";
        case "day":
          return twice("d", value);
        case "year":
          return value.length === 2 ? "yy" : "yyyy";
        case "hour":
          return twice(hour, value);
        case "minute":
          return "mm";
        case "second":
          return "ss";
        case "dayPeriod":
          return "a";
        case "era":
          return "G";
        case "literal":
          // CLDR's narrow space before a day period, where Windows has a plain one; Windows
          // quotes the cased letters (" 'de' ", " 'г'."), not those of scripts without case.
          return value
            .replaceAll("\u202f", " ")
            .replaceAll("'", "''")
            .replace(/[\p{Lu}\p{Ll}\p{Lt}]+/gu, (letters) => `'${letters}'`);
        default:
          return "";
      }
    })
    .join("");
}

/** A pattern's run of one letter, or its literal text. */
interface Field {
  letter: string;
  count: number;
  text: string;
}

// The letters Flash formats, with the longest run of each it keeps and what a longer one becomes.
const LETTERS: Record<string, [number, number]> = {
  y: [5, 5],
  M: [5, 4],
  d: [2, 2],
  E: [5, 4],
  a: [1, 1],
  h: [2, 2],
  H: [2, 2],
  K: [2, 2],
  k: [2, 2],
  m: [2, 2],
  s: [2, 2],
  G: [1, 1],
};
// Letters Flash knows but cannot format: they come out empty.
const UNSUPPORTED = "DSzZvQwWF";

const STATUS_RANK = [NO_ERROR, USING_FALLBACK_WARNING, UNSUPPORTED_ERROR];

const BUFFER_OVERFLOW_ERROR = "bufferOverflowError";

// The letters that make a pattern one of the date, which formats only Windows' dates.
const DATE_LETTERS = "yMdEGDQwF";
const TIME_LETTERS = "hHkKmsaS";

// The longest pattern Flash takes.
const PATTERN_MAX = 255;

/**
 * A pattern's fields, the pattern as Flash keeps it and its status: a run
 * too long is shortened and an unclosed quote closed, with a fallback
 * warning, and the pattern so kept is what formats; an unknown letter or a
 * pattern too long makes it a syntax error, and Flash keeps none of it. A
 * NUL ends it, Flash's being a C string.
 */
function parsePattern(given: string): { fields: Field[]; kept: string; status: string } {
  if (given.length > PATTERN_MAX) {
    return { fields: [], kept: "", status: PATTERN_SYNTAX_ERROR };
  }

  const pattern = given.split("\0")[0];
  const fields: Field[] = [];
  let unclosed = false;
  let kept = "";
  let status = NO_ERROR;
  const raise = (to: string) => {
    if (STATUS_RANK.indexOf(to) > STATUS_RANK.indexOf(status)) {
      status = to;
    }
  };

  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i];
    if (c === "'") {
      let text = "";
      let j = i + 1;
      if (pattern[j] === "'") {
        text = "'";
        j++;
      } else {
        for (;;) {
          if (j >= pattern.length) {
            raise(USING_FALLBACK_WARNING);
            unclosed = true;
            break;
          }

          if (pattern[j] === "'") {
            if (pattern[j + 1] !== "'") {
              j++;
              break;
            }

            j++;
          }

          text += pattern[j];
          j++;
        }
      }

      fields.push({ letter: "", count: 0, text });
      kept += text === "'" && j === i + 2 ? "''" : `'${text.replaceAll("'", "''")}'`;
      i = j;
      continue;
    }

    if (!/[A-Za-z]/.test(c)) {
      fields.push({ letter: "", count: 0, text: c });
      kept += c;
      i++;
      continue;
    }

    let count = 1;
    while (pattern[i + count] === c) {
      count++;
    }

    i += count;
    const limits = LETTERS[c];
    if (limits) {
      if (count > limits[0]) {
        count = limits[1];
        raise(USING_FALLBACK_WARNING);
      }

      // Windows has no lone y, nor hours counted from zero to eleven or one to twenty-four.
      if ((c === "y" && count === 1) || c === "K" || c === "k") {
        raise(USING_FALLBACK_WARNING);
      }
    } else if (UNSUPPORTED.includes(c)) {
      raise(UNSUPPORTED_ERROR);
    } else {
      return { fields: [], kept: "", status: PATTERN_SYNTAX_ERROR };
    }

    fields.push({ letter: c, count, text: "" });
    kept += c.repeat(count);
  }

  // Closing a quote can take the pattern past what Flash holds: it keeps none of it.
  if (kept.length > PATTERN_MAX) {
    return { fields: [], kept: "", status: BUFFER_OVERFLOW_ERROR };
  }

  return { fields: unclosed ? parsePattern(kept).fields : fields, kept, status };
}

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

// Windows' dates: from 1601, its first FILETIME, to 30828, its last year, a year past 65535
// wrapping as a 16-bit SYSTEMTIME's does; the last is its last FILETIME's day, 14 September.
const FIRST_YEAR = 1601;
const LAST_YEAR = 30828;

// Four hundred Gregorian years, after which dates, weekdays and times repeat.
const CYCLE_MS = 146097 * 86400000;
const CYCLE_YEARS = 400;

/**
 * A time's fields, as a JavaScript Date and its year: a local time past
 * JavaScript's range is moved by whole cycles into it, its year kept apart.
 */
function fieldsOf(t: number): { date: Date; year: number } {
  const cycles = Math.abs(t) > 8.64e15 ? Math.trunc(t / CYCLE_MS) : 0;
  const date = new Date(t - cycles * CYCLE_MS);
  return { date, year: date.getUTCFullYear() + cycles * CYCLE_YEARS };
}

/** The date as Windows takes it, or null for one it refuses. */
function windowsDate({ date, year }: { date: Date; year: number }): Date | null {
  const wrapped = year % 65536;
  const last =
    wrapped === LAST_YEAR &&
    (date.getUTCMonth() > 8 || (date.getUTCMonth() === 8 && date.getUTCDate() > 14));
  if (year < 0 || wrapped < FIRST_YEAR || wrapped > LAST_YEAR || last) {
    return null;
  }

  const day = new Date(date.getTime());
  day.setUTCFullYear(wrapped);
  return day;
}

/** A date's fields formatted by a pattern's; `fields` hold the time's fields as UTC's. */
function formatDate(fields: Field[], t: Date, data: DateData): string {
  const year = t.getUTCFullYear();
  const hours = t.getUTCHours();
  const number = (n: number, count: number) => (count > 1 ? pad(n) : `${n}`);
  // Windows names a month by its genitive beside a day: the nearest field either way is one.
  const besideDay = (i: number) =>
    [-1, 1].some((step) => {
      let j = i + step;
      while (fields[j] && fields[j].letter === "") {
        j += step;
      }

      return fields[j]?.letter === "d";
    });

  return fields
    .map(({ letter, count, text }, i) => {
      switch (letter) {
        case "":
          return text;
        case "y":
          return count === 2 ? pad(year % 100) : `${year}`;
        case "M":
          return count < 3
            ? number(t.getUTCMonth() + 1, count)
            : count === 3
              ? data.shortMonths[t.getUTCMonth()]
              : (besideDay(i) ? data.genitiveMonths : data.months)[t.getUTCMonth()];
        case "d":
          return number(t.getUTCDate(), count);
        case "E":
          return (count < 4 ? data.shortWeekdays : data.weekdays)[t.getUTCDay()];
        case "a":
          return data.periods[hours < 12 ? 0 : 1];
        case "h":
        case "K":
          return number(hours % 12 || 12, count);
        case "H":
        case "k":
          return number(hours, count);
        case "m":
          return number(t.getUTCMinutes(), count);
        case "s":
          return number(t.getUTCSeconds(), count);
        case "G":
          return data.eras[year > 0 ? 1 : 0];
        default:
          return "";
      }
    })
    .join("");
}

class DateSettings {
  status: string;
  readonly locale: Locale;
  readonly data: DateData;
  dateStyle = "long";
  timeStyle = "long";
  pattern = "";
  fields: Field[] = [];

  constructor(locale: Locale) {
    this.locale = locale;
    this.status = locale.status;
    this.data = localeData(locale.actual);
  }

  setStyles(dateStyle: string, timeStyle: string): void {
    this.dateStyle = dateStyle;
    this.timeStyle = timeStyle;
    const pick = (style: string, patterns: { long: string; short: string }) =>
      style === "none" ? "" : style === "short" ? patterns.short : patterns.long;
    this.pattern = [pick(dateStyle, this.data.date), pick(timeStyle, this.data.time)]
      .filter((p) => p !== "")
      .join(" ");
    this.fields = parsePattern(this.pattern).fields;
  }
}

export function dateTimeFormatterNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const settings = (o: DateTimeFormatterNatives) => o.$settings;
  const style = (value: string | null, name: string): string => {
    if (!STYLES.includes(nonNull(s, value, name)) && value !== CUSTOM) {
      throw s.rt.error("ArgumentError", 2008, "DateTimeFormatterStyle");
    }

    return value as string;
  };
  const names = (o: DateTimeFormatterNatives, nameStyle: string | null, context: string | null) => {
    const f = settings(o);
    nonNull(s, nameStyle, "nameStyle");
    nonNull(s, context, "context");
    if (
      !["full", "longAbbreviation", "shortAbbreviation"].includes(nameStyle as string) ||
      !["format", "standalone"].includes(context as string)
    ) {
      throw s.rt.error("ArgumentError", 2008, "invalid style or context");
    }

    f.status = NO_ERROR;
    return { data: f.data, full: nameStyle === "full", short: nameStyle === "shortAbbreviation" };
  };

  class DateTimeFormatterNatives {
    declare $settings: DateSettings;

    static getAvailableLocaleIDNames(): Value {
      return availableLocales(s);
    }

    "flash.globalization:DateTimeFormatter::ctor"(
      name: string | null,
      dateStyle: string | null,
      timeStyle: string | null,
    ): void {
      const locale = resolveLocale(s, nonNull(s, name, "requestedLocaleIDName"));
      const date = style(dateStyle, "dateStyle");
      const time = style(timeStyle, "timeStyle");
      if (date === CUSTOM || time === CUSTOM) {
        throw s.rt.error("TypeError", 2007, "Constructor Failed");
      }

      this.$settings = new DateSettings(locale);
      this.$settings.setStyles(date, time);
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

    setDateTimeStyles(dateStyle: string | null, timeStyle: string | null): void {
      const f = settings(this);
      const date = style(dateStyle, "dateStyle");
      const time = style(timeStyle, "timeStyle");
      if (date === CUSTOM || time === CUSTOM) {
        f.status = ILLEGAL_ARGUMENT_ERROR;
        return;
      }

      f.setStyles(date, time);
      f.status = NO_ERROR;
    }

    getDateStyle(): string {
      settings(this).status = NO_ERROR;
      return settings(this).dateStyle;
    }

    getTimeStyle(): string {
      settings(this).status = NO_ERROR;
      return settings(this).timeStyle;
    }

    getDateTimePattern(): string {
      settings(this).status = NO_ERROR;
      return settings(this).pattern;
    }

    setDateTimePattern(pattern: string | null): void {
      const f = settings(this);
      const parsed = parsePattern(nonNull(s, pattern, "pattern"));
      f.status = parsed.status;
      if (parsed.status === PATTERN_SYNTAX_ERROR) {
        return;
      }

      f.pattern = parsed.kept;
      f.fields = parsed.fields;
      f.dateStyle = CUSTOM;
      f.timeStyle = CUSTOM;
    }

    "flash.globalization:DateTimeFormatter::formatImplementation"(
      date: Value,
      utc: boolean,
    ): string {
      const f = settings(this);
      const time = (nonNull(s, date, "dateTime") as AsObject).$time as number;
      // Local time is the runtime's, as Date's own getters give it.
      const asked =
        utc || Number.isNaN(time)
          ? 0
          : (s.rt.getProperty(date, s.rt.publicName("timezoneOffset")) as number);
      const offset = Number.isNaN(asked) ? new Date(time).getTimezoneOffset() : asked;
      // A pattern with the date formats only Windows' dates; one of the time alone any. An
      // invalid date is, as adl has it, midnight of 1 January 1970 to a pattern without the
      // date in UTC and to one of the date alone in local time, and refused otherwise.
      const has = (letters: string) =>
        f.fields.some(({ letter }) => letter !== "" && letters.includes(letter));
      const dated = has(DATE_LETTERS);
      const invalid = Number.isNaN(time);
      const fields = fieldsOf(invalid ? 0 : time - offset * 60000);
      const refused = invalid && (utc ? dated : !dated || has(TIME_LETTERS));
      const day = refused ? null : dated ? windowsDate(fields) : fields.date;
      if (!day) {
        f.status = ILLEGAL_ARGUMENT_ERROR;
        return "";
      }

      f.status = NO_ERROR;
      return formatDate(f.fields, day, f.data);
    }

    // ASC keeps no defaults for natives: these are Flash's.
    getMonthNames(nameStyle: string | null = "full", context: string | null = "standalone"): Value {
      const { data, full } = names(this, nameStyle, context);
      return stringVector(
        s,
        (full
          ? context === "format"
            ? data.genitiveMonths
            : data.months
          : data.shortMonths
        ).slice(),
      );
    }

    getWeekdayNames(
      nameStyle: string | null = "full",
      context: string | null = "standalone",
    ): Value {
      const { data, full, short } = names(this, nameStyle, context);
      return stringVector(
        s,
        (full ? data.weekdays : short ? data.shortestWeekdays : data.shortWeekdays).slice(),
      );
    }

    getFirstWeekday(): number {
      settings(this).status = NO_ERROR;
      return settings(this).data.firstWeekday;
    }
  }

  avm2.registerNativeClass(
    natives,
    "flash.globalization::DateTimeFormatter",
    DateTimeFormatterNatives,
  );
  return natives;
}
