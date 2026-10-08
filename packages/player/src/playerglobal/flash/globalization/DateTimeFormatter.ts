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
    // Windows' shortest names are ICU's two-letter ones, which Intl does not give: in a Latin
    // script the short ones cut to two letters, "Su", "Mo"; in others the short ones.
    shortestWeekdays:
      info.maximize().script === "Latn"
        ? shortWeekdays.map((name) => [...name].slice(0, 2).join(""))
        : shortWeekdays,
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
        case "literal":
          // CLDR's narrow space before a day period, where Windows has a plain one.
          value = value.replaceAll("\u202f", " ");
          return /[A-Za-z]/.test(value)
            ? `'${value.replaceAll("'", "''")}'`
            : value.replaceAll("'", "''");
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

/**
 * A pattern's fields, the pattern as Flash keeps it and its status: a run
 * too long is shortened and an unclosed quote closed, with a fallback
 * warning; an unknown letter makes it a syntax error, and Flash keeps none of it.
 */
function parsePattern(pattern: string): { fields: Field[]; kept: string; status: string } {
  const fields: Field[] = [];
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

  return { fields, kept, status };
}

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

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
      if (Number.isNaN(time)) {
        f.status = ILLEGAL_ARGUMENT_ERROR;
        return "";
      }

      // Local time is the runtime's, as Date's own getters give it.
      const offset = utc
        ? 0
        : (s.rt.getProperty(date, s.rt.publicName("timezoneOffset")) as number);
      f.status = NO_ERROR;
      return formatDate(f.fields, new Date(time - offset * 60000), f.data);
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
