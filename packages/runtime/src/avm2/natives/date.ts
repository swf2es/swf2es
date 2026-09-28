// Date, as avmplus' DateClass and Date: the time a Date holds, its fields
// by the indices Date.as asks for, the setters, its strings in avmplus'
// formats, which are not JavaScript's, and its own parser of them for
// Date.parse and new Date(string). Local time is the host's, through
// JavaScript's Date, as avmplus' is the OS's.
//
// parseDate is translated from avmplus' core/DateClass.cpp, and so subject
// to the Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.
import type { AsObject, ClassHook, Runtime, Value } from "../runtime.js";

type Natives = Record<string, (rt: Runtime) => (...args: Value[]) => Value>;

const AS3 = "http://adobe.com/AS3/2006/builtin";
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
const DAYS = "SunMonTueWedThuFriSat";

/** As Date::TimeClip: NaN beyond 8.64e15 milliseconds, else an integer. */
function timeClip(t: number): number {
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) {
    return Number.NaN;
  }

  return Math.trunc(t) + 0;
}

const pad2 = (n: number) => `${Math.floor(n / 10)}${n % 10}`;

/** As Date::toString, by its format index. */
function format(t: number, index: number): string {
  if (Number.isNaN(t)) {
    return "Invalid Date";
  }

  const d = new Date(t);
  const utc = index === 6;
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  const month = utc ? d.getUTCMonth() : d.getMonth();
  const date = utc ? d.getUTCDate() : d.getDate();
  const day = utc ? d.getUTCDay() : d.getDay();
  const hour24 = utc ? d.getUTCHours() : d.getHours();
  const min = utc ? d.getUTCMinutes() : d.getMinutes();
  const sec = utc ? d.getUTCSeconds() : d.getSeconds();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 >= 12 ? "P" : "A";
  let delta = -d.getTimezoneOffset();
  const sign = delta < 0 ? "-" : "+";
  delta = Math.abs(delta);
  const zone = `GMT${sign}${pad2(Math.floor(delta / 60))}${pad2(delta % 60)}`;
  const dow = DAYS.substr(day * 3, 3);
  const mon = MONTHS.substr(month * 3, 3);
  const time = `${pad2(hour24)}:${pad2(min)}:${pad2(sec)}`;
  switch (index) {
    case 0:
      return `${dow} ${mon} ${date} ${time} ${zone} ${year}`;
    case 1:
    case 4:
      return `${dow} ${mon} ${date} ${year}`;
    case 2:
      return `${time} ${zone}`;
    case 3:
      return `${dow} ${mon} ${date} ${year} ${pad2(hour12)}:${pad2(min)}:${pad2(sec)} ${ampm}M`;
    case 5:
      return `${pad2(hour12)}:${pad2(min)}:${pad2(sec)} ${ampm}M`;
    default:
      return `${dow} ${mon} ${date} ${time} ${year} UTC`;
  }
}

/** A Date's field by Date.as' index: UTC fields 0 to 7, local 8 to 15, the offset 16, the time 17. */
function field(t: number, index: number): number {
  if (Number.isNaN(t)) {
    return Number.NaN;
  }

  const d = new Date(t);
  switch (index) {
    case 0:
      return d.getUTCFullYear();
    case 1:
      return d.getUTCMonth();
    case 2:
      return d.getUTCDate();
    case 3:
      return d.getUTCDay();
    case 4:
      return d.getUTCHours();
    case 5:
      return d.getUTCMinutes();
    case 6:
      return d.getUTCSeconds();
    case 7:
      return d.getUTCMilliseconds();
    case 8:
      return d.getFullYear();
    case 9:
      return d.getMonth();
    case 10:
      return d.getDate();
    case 11:
      return d.getDay();
    case 12:
      return d.getHours();
    case 13:
      return d.getMinutes();
    case 14:
      return d.getSeconds();
    case 15:
      return d.getMilliseconds();
    case 16:
      return d.getTimezoneOffset();
    default:
      return t;
  }
}

const timeOf = (o: AsObject): number => o.$time ?? Number.NaN;

const KEYWORDS = "JanFebMarAprMayJunJulAugSepOctNovDecSunMonTueWedThuFriSatGMTUTC";
const UTC_KEYWORD = 12 + 7 + 1;

/** What stringToDateDouble has parsed so far; -1 for a field not yet seen. */
interface DateFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  min: number;
  sec: number;
  zone: number;
}

/** As parseDateKeyword: a month, UTC, AM or PM, or a day or GMT, which say nothing; false if none. */
function dateKeyword(word: string, f: DateFields): boolean {
  if (word.length > 3) {
    return false;
  }

  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (c < 65 || c > 122 || (c > 90 && c < 97)) {
      return false;
    }
  }

  if (word.length === 3) {
    for (let x = 0; x < 7 + 12 + 2; x++) {
      if (KEYWORDS.substr(x * 3, 3) === word) {
        if (x < 12) {
          f.month = x;
        } else if (x === UTC_KEYWORD) {
          f.zone = 0;
        }

        return true;
      }
    }

    return false;
  }

  if (word === "AM" || word === "PM") {
    const valid = f.hour <= 12 && f.hour >= 0;
    if (word === "AM" && f.hour === 12) {
      f.hour = 0;
    } else if (word === "PM" && f.hour !== 12) {
      f.hour += 12;
    }

    return valid;
  }

  return false;
}

/**
 * As DateClass::stringToDateDouble: the formats its toString writes and a
 * few others ("1/1/1999 13:30 PM"), by numbers and the separators before
 * and after them, and three-letter keywords; NaN for anything else.
 */
export function parseDate(s: string): number {
  const f: DateFields = { year: -1, month: -1, day: -1, hour: -1, min: -1, sec: -1, zone: -1 };
  const length = s.length;
  const code = (k: number) => s.charCodeAt(k);
  const digit = (c: number) => c >= 48 && c <= 57;
  const alpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  let prevc = 0;
  let i = 0;
  while (i < length) {
    let c = code(i);
    i++;
    if (c <= 32 || c === 44 || c === 45) {
      // Whitespace and delimiters; a '-' before a number is a zone's sign.
      if (i < length && c === 45 && digit(code(i))) {
        prevc = c;
      }
    } else if (c === 47 || c === 58 || c === 43 || c === 45) {
      prevc = c;
    } else if (digit(c)) {
      // As parseDateNumber: a zone offset, a year, a month or day, a time unit.
      // c is left the character after the digits, or the last digit at the end.
      let n = c - 48;
      while (i < length) {
        c = code(i);
        if (!digit(c)) {
          break;
        }

        n = n * 10 + c - 48;
        i++;
      }

      let valid = true;
      if (prevc === 43 || prevc === 45) {
        n = n < 24 ? n * 60 : (n % 100) + Math.trunc(n / 100) * 60;
        if (prevc === 43) {
          n = -n;
        }

        if (f.zone === 0 || f.zone === -1) {
          f.zone = n;
        } else {
          valid = false;
        }
      } else if (n >= 70 || (prevc === 47 && f.month >= 0 && f.day >= 0 && f.year < 0)) {
        if (f.year >= 0) {
          valid = false;
        } else if (c <= 32 || c === 44 || c === 47 || i >= length) {
          f.year = n < 100 ? n + 1900 : n;
        } else {
          valid = false;
        }
      } else if (c === 47) {
        if (f.month < 0) {
          f.month = n - 1;
        } else if (f.day < 0) {
          f.day = n;
        } else {
          valid = false;
        }
      } else if (c === 58) {
        if (f.hour < 0) {
          f.hour = n;
        } else if (f.min < 0) {
          f.min = n;
        } else {
          valid = false;
        }
      } else if (i < length && c !== 44 && c > 32 && c !== 45) {
        valid = false;
      } else if (f.hour >= 0 && f.min < 0) {
        f.min = n;
      } else if (f.min >= 0 && f.sec < 0) {
        f.sec = n;
      } else if (f.day < 0) {
        f.day = n;
      } else {
        valid = false;
      }

      if (!valid) {
        return Number.NaN;
      }

      prevc = 0;
    } else {
      // A keyword, of letters.
      const start = i - 1;
      while (i < length && alpha(code(i))) {
        i++;
      }

      if (i <= start + 1 || !dateKeyword(s.slice(start, i), f)) {
        return Number.NaN;
      }

      prevc = 0;
    }
  }

  if (f.year < 0 || f.month < 0 || f.day < 0) {
    return Number.NaN;
  }

  const sec = Math.max(f.sec, 0);
  const min = Math.max(f.min, 0);
  const hour = Math.max(f.hour, 0);
  // No zone: local time. Else UTC, and the offset east of it in minutes.
  if (f.zone === -1) {
    return timeClip(new Date(f.year, f.month, f.day, hour, min, sec, 0).getTime());
  }

  return timeClip(Date.UTC(f.year, f.month, f.day, hour, min, sec, 0) + f.zone * 60000);
}

/** As DateClass::construct: now, a time, a string, a Date, or local fields; years 0 to 99 are 1900's. */
function construct(rt: Runtime, cls: AsObject, args: Value[]): AsObject {
  const o = cls.$it.instance();
  if (args.length === 0) {
    o.$time = Date.now();
  } else if (args.length === 1) {
    const v = args[0];
    if (v?.$time !== undefined) {
      o.$time = v.$time;
    } else {
      // A string is parsed; anything else is a number, as AvmCore::number
      // makes it, an object's string from valueOf too.
      o.$time = typeof v === "string" ? parseDate(v) : timeClip(rt.toNumber(v));
    }
  } else {
    const n = args.map((a) => rt.toNumber(a));
    const year = n[0] >= 0 && n[0] <= 99 ? 1900 + Math.trunc(n[0]) : n[0];
    o.$time = timeClip(
      new Date(year, n[1], n[2] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0, n[6] ?? 0).getTime(),
    );
  }

  return o;
}

export const dateHook: ClassHook = {
  construct,
  // Date() called is the time now, as a string.
  call: () => format(Date.now(), 0),
};

export function dateNatives(): Natives {
  const natives: Natives = {
    "Date.parse": (rt) => (s: Value) => parseDate(rt.toString(s)),
    "Date.UTC":
      (rt) =>
      (...args: Value[]) => {
        const n = args.map((a) => rt.toNumber(a));
        return timeClip(
          Date.UTC(n[0], n[1], n[2] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0, n[6] ?? 0),
        );
      },
    "Date#Date::_get": () =>
      function (this: AsObject, index: number) {
        return field(timeOf(this), index);
      },
    "Date#Date::_toString": () =>
      function (this: AsObject, index: number) {
        return format(timeOf(this), index);
      },
    "Date#Date::_setTime": (rt) =>
      function (this: AsObject, v: Value) {
        this.$time = timeClip(rt.toNumber(v));
        return this.$time;
      },
    [`Date#${AS3}::getTime`]: () =>
      function (this: AsObject) {
        return timeOf(this);
      },
    [`Date#${AS3}::valueOf`]: () =>
      function (this: AsObject) {
        return timeOf(this);
      },
    [`Date#${AS3}::getTimezoneOffset`]: () =>
      function (this: AsObject) {
        return field(timeOf(this), 16);
      },
  };

  // The getters by field, as their native names ask for them.
  const getters: [string, number][] = [
    ["getUTCFullYear", 0],
    ["getUTCMonth", 1],
    ["getUTCDate", 2],
    ["getUTCDay", 3],
    ["getUTCHours", 4],
    ["getUTCMinutes", 5],
    ["getUTCSeconds", 6],
    ["getUTCMilliseconds", 7],
    ["getFullYear", 8],
    ["getMonth", 9],
    ["getDate", 10],
    ["getDay", 11],
    ["getHours", 12],
    ["getMinutes", 13],
    ["getSeconds", 14],
    ["getMilliseconds", 15],
  ];
  for (const [name, index] of getters) {
    natives[`Date#${AS3}::${name}`] = () =>
      function (this: AsObject) {
        return field(timeOf(this), index);
      };
  }

  // The setters, as ECMA-262's: JavaScript's, on the time the Date holds.
  for (const name of [
    "FullYear",
    "Month",
    "Date",
    "Hours",
    "Minutes",
    "Seconds",
    "Milliseconds",
    "UTCFullYear",
    "UTCMonth",
    "UTCDate",
    "UTCHours",
    "UTCMinutes",
    "UTCSeconds",
    "UTCMilliseconds",
  ]) {
    natives[`Date#Date::_set${name}`] = (rt) =>
      function (this: AsObject, ...args: Value[]) {
        const d = new Date(timeOf(this));
        const set = (d as unknown as Record<string, (...n: number[]) => number>)[`set${name}`];
        this.$time = timeClip(
          set.apply(
            d,
            args.map((a) => rt.toNumber(a)),
          ),
        );
        return this.$time;
      };
  }

  return natives;
}
