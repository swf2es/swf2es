// Date, as avmplus' DateClass and Date, its natives held to Date.decl.ts: the time a Date holds, its fields
// by the indices Date.as asks for, the setters, its strings in avmplus'
// formats, which are not JavaScript's, and its own parser of them for
// Date.parse and new Date(string).
//
// The calendar is avmplus' own arithmetic, not JavaScript's Date: avmplus
// clips only some results to the time domain, and casts years and seconds
// to 32-bit ints, which wrap where JavaScript would give NaN. Local time is
// avmshell's on a POSIX host: the standard offset of now, plus an hour
// where the host's time zone says daylight saving is in effect, asked of the
// host (here through JavaScript's Date) with the time in 32-bit seconds.
// So no zone's history beyond its daylight saving applies, and none after
// 2038. Flash on Windows (WinPortUtils) applies the zone's rule of today
// to every year instead, 1900 and 2050 alike; avmshell is the reference.
//
// The calendar, local time and parseDate are translated from avmplus'
// core/Date.cpp, core/DateClass.cpp and VMPI/PosixPortUtils.cpp, and so subject
// to the Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import type { Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { DateDecl } from "./Date.decl.js";

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
const DAYS = "SunMonTueWedThuFriSat";

const MS_PER_DAY = 86400000;
const MS_PER_HOUR = 3600000;
const MS_PER_MINUTE = 60000;
const MS_PER_SECOND = 1000;

/** A double cast to a C int on x86: INT_MIN for NaN and anything out of range. */
function cInt(x: number): number {
  return x >= -2147483648 && x < 2147483648 ? Math.trunc(x) | 0 : -2147483648;
}

/** As MathUtils::toInt: ToInteger, but infinities kept. */
function toInt(x: number): number {
  if (Number.isNaN(x)) {
    return 0;
  }

  return Number.isFinite(x) ? Math.trunc(x) : x;
}

/** As Date::TimeClip: NaN beyond 8.64e15 milliseconds, else an integer. */
function timeClip(t: number): number {
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) {
    return Number.NaN;
  }

  return Math.trunc(t) + 0;
}

const MONTH_OFFSET = [
  [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365],
  [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366],
];

const day = (t: number) => Math.floor(t / MS_PER_DAY);

const dayFromYear = (year: number) =>
  365 * (year - 1970) +
  Math.floor((year - 1969) / 4) -
  Math.floor((year - 1901) / 100) +
  Math.floor((year - 1601) / 400);

const timeFromYear = (year: number) => MS_PER_DAY * dayFromYear(year);

/** As IsLeapYear, of an int: 1 or 0, to index MONTH_OFFSET. */
const leap = (year: number) =>
  year % 4 !== 0 ? 0 : year % 100 !== 0 ? 1 : year % 400 !== 0 ? 0 : 1;

function yearFromTime(t: number): number {
  const d = day(t);
  let lo = (cInt(Math.floor(t < 0 ? d / 365 : d / 366)) + 1970) | 0;
  let hi = (cInt(Math.ceil(t < 0 ? d / 366 : d / 365)) + 1970) | 0;
  while (lo < hi) {
    const pivot = cInt((lo + hi) / 2);
    const pivotTime = timeFromYear(pivot);
    if (pivotTime <= t) {
      if (timeFromYear((pivot + 1) | 0) > t) {
        return pivot;
      }

      lo = (pivot + 1) | 0;
    } else {
      hi = (pivot - 1) | 0;
    }
  }

  return lo;
}

const dayWithinYear = (t: number) => cInt(day(t) - dayFromYear(yearFromTime(t)));

function monthFromTime(t: number): number {
  const d = dayWithinYear(t);
  const offsets = MONTH_OFFSET[leap(yearFromTime(t))];
  let i = 0;
  while (i < 11 && d >= offsets[i + 1]) {
    i++;
  }

  return i;
}

const dateFromTime = (t: number) =>
  dayWithinYear(t) - MONTH_OFFSET[leap(yearFromTime(t))][monthFromTime(t)] + 1;

/** C's (int) of a remainder, made non-negative by adding the divisor. */
function positive(r: number, n: number): number {
  const i = cInt(r);
  return i < 0 ? i + n : i;
}

const weekDay = (t: number) => positive((day(t) + 4) % 7, 7);
const hourFromTime = (t: number) => positive(Math.floor((t + 0.5) / MS_PER_HOUR) % 24, 24);
const minFromTime = (t: number) => positive(Math.floor(t / MS_PER_MINUTE) % 60, 60);
const secFromTime = (t: number) => positive(Math.floor(t / MS_PER_SECOND) % 60, 60);
const msecFromTime = (t: number) => positive(t % MS_PER_SECOND, MS_PER_SECOND);

function timeWithinDay(t: number): number {
  const r = t % MS_PER_DAY;
  return r < 0 ? r + MS_PER_DAY : r;
}

function makeDay(year: number, month: number, date: number): number {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) {
    return Number.NaN;
  }

  let y = toInt(year);
  let m = toInt(month);
  y += Math.floor(m / 12);
  m %= 12;
  if (m < 0) {
    m += 12;
  }

  const iMonth = cInt(Math.floor(m));
  if (iMonth < 0 || iMonth >= 12) {
    return Number.NaN;
  }

  const iYear = cInt(y);
  return dayFromYear(iYear) + MONTH_OFFSET[leap(iYear)][iMonth] + (toInt(date) - 1);
}

function makeTime(hour: number, min: number, sec: number, ms: number): number {
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(min) ||
    !Number.isFinite(sec) ||
    !Number.isFinite(ms)
  ) {
    return Number.NaN;
  }

  return (
    toInt(hour) * MS_PER_HOUR + toInt(min) * MS_PER_MINUTE + toInt(sec) * MS_PER_SECOND + toInt(ms)
  );
}

function makeDate(d: number, time: number): number {
  if (!Number.isFinite(d) || !Number.isFinite(time)) {
    return Number.NaN;
  }

  return toInt(d) * MS_PER_DAY + toInt(time);
}

/** The host's offset east of UTC at a time, in milliseconds, its zone's history included. */
const hostOffset = (ms: number) => -new Date(ms).getTimezoneOffset() * MS_PER_MINUTE;

const standardOffsets = new Map<number, number>();

/** The host's standard offset in a year: the lesser of January's and July's, whichever has daylight saving. */
function standardOffset(year: number): number {
  let offset = standardOffsets.get(year);
  if (offset === undefined) {
    const jan = new Date(0);
    jan.setUTCFullYear(year, 0, 1);
    const jul = new Date(0);
    jul.setUTCFullYear(year, 6, 1);
    offset = Math.min(hostOffset(jan.getTime()), hostOffset(jul.getTime()));
    standardOffsets.set(year, offset);
  }

  return offset;
}

let tza = 0;
let tzaUntil = Number.NEGATIVE_INFINITY;

/**
 * As VMPI_getLocalTimeOffset: the standard offset of now, whatever the time
 * asked about. Read again once a minute, as WinPortUtils does, since every
 * local field reads it.
 */
function localTZA(): number {
  const now = Date.now();
  if (now >= tzaUntil) {
    tza = standardOffset(yearFromTime(now));
    tzaUntil = now + MS_PER_MINUTE;
  }

  return tza;
}

// The last second daylightSavingTA was asked about: a Date's local getters ask about the same one.
let lastDstSecond = Number.NaN;
let lastDst = 0;

/**
 * As VMPI_getDaylightSavingsTA: an hour where localtime_r says daylight
 * saving is in effect, of the time in seconds in a 32-bit time_t. An offset
 * at least half an hour past the year's standard one is daylight saving;
 * a lesser change is the zone's own history, which avmshell does not see.
 */
function daylightSavingTA(t: number): number {
  const ms = cInt(t / MS_PER_SECOND) * MS_PER_SECOND;
  if (ms !== lastDstSecond) {
    lastDstSecond = ms;
    lastDst =
      hostOffset(ms) - standardOffset(yearFromTime(ms)) >= 30 * MS_PER_MINUTE ? MS_PER_HOUR : 0;
  }

  return lastDst;
}

const localTime = (t: number) => t + localTZA() + daylightSavingTA(t);

/** As Date.cpp's UTC: local time to UTC, a time in the spring-forward gap an hour later. */
function utc(t: number): number {
  const adj = localTZA();
  const dst = daylightSavingTA(t - adj);
  if (dst !== 0 && daylightSavingTA(t - adj - MS_PER_HOUR) === 0) {
    t += MS_PER_HOUR;
  }

  return t - adj - dst;
}

/** As Date::Date of fields: years below 100 are 1900's; the time is not clipped. */
function fromFields(n: number[], local: boolean): number {
  const year = n[0] < 100 ? n[0] + 1900 : n[0];
  const t = makeDate(makeDay(year, n[1], n[2]), makeTime(n[3], n[4], n[5], n[6]));
  return local ? utc(t) : t;
}

/** Format's %2: two digits, as characters from '0', whatever the value. */
const pad2 = (n: number) => String.fromCharCode(48 + Math.trunc(n / 10), 48 + (n % 10));

/** As Date::toString, by its format index; empty if the time's fields are out of range. */
function format(t: number, index: number): string {
  if (Number.isNaN(t)) {
    return "Invalid Date";
  }

  const time = index === 6 ? t : localTime(t);
  const year = yearFromTime(time);
  const month = monthFromTime(time);
  const dow = weekDay(time);
  if (month < 0 || month >= 12 || dow < 0 || dow >= 7) {
    return "";
  }

  let delta = cInt((time - t) / MS_PER_MINUTE);
  const sign = delta < 0 ? "-" : "+";
  delta = Math.abs(delta);
  const zone = `GMT${sign}${pad2(Math.trunc(delta / 60))}${pad2(delta % 60)}`;
  const date = dateFromTime(time);
  const hour24 = hourFromTime(time);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 >= 12 ? "P" : "A";
  const min = minFromTime(time);
  const sec = secFromTime(time);
  const dayName = DAYS.substr(dow * 3, 3);
  const mon = MONTHS.substr(month * 3, 3);
  const clock = `${pad2(hour24)}:${pad2(min)}:${pad2(sec)}`;
  switch (index) {
    case 0:
      return `${dayName} ${mon} ${date} ${clock} ${zone} ${year}`;
    case 1:
    case 4:
      return `${dayName} ${mon} ${date} ${year}`;
    case 2:
      return `${clock} ${zone}`;
    case 3:
      return `${dayName} ${mon} ${date} ${year} ${pad2(hour12)}:${pad2(min)}:${pad2(sec)} ${ampm}M`;
    case 5:
      return `${pad2(hour12)}:${pad2(min)}:${pad2(sec)} ${ampm}M`;
    default:
      return `${dayName} ${mon} ${date} ${clock} ${year} UTC`;
  }
}

/** A Date's field by Date.as' index: UTC fields 0 to 7, local 8 to 15, the offset 16, the time 17. */
function field(t: number, index: number): number {
  if (Number.isNaN(t)) {
    return Number.NaN;
  }

  if (index === 16) {
    return (t - localTime(t)) / MS_PER_MINUTE;
  }

  if (index >= 17) {
    return t;
  }

  const time = index >= 8 ? localTime(t) : t;
  switch (index & 7) {
    case 0:
      return yearFromTime(time);
    case 1:
      return monthFromTime(time);
    case 2:
      return dateFromTime(time);
    case 3:
      return weekDay(time);
    case 4:
      return hourFromTime(time);
    case 5:
      return minFromTime(time);
    case 6:
      return secFromTime(time);
    default:
      return msecFromTime(time);
  }
}

/**
 * As DateObject::_set: the fields from setter `index`'s on, NaN for those
 * not given; a NaN given makes the time NaN. Indices 1 to 3 set the date,
 * 4 to 7 the time, negative ones in UTC.
 */
function set(rt: Runtime, time: number, index: number, args: Value[]): number {
  const n = [Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  const local = index > 0;
  const first = Math.abs(index) - 1;
  for (let i = 0; i < args.length && first + i < 7; i++) {
    n[first + i] = rt.toNumber(args[i]);
    if (Number.isNaN(n[first + i])) {
      return Number.NaN;
    }
  }

  let t = local ? localTime(time) : time;
  if (first < 3) {
    // As Date::setDate: a NaN time stays NaN unless a year is set, from 0.
    if (Number.isNaN(time)) {
      if (Number.isNaN(n[0])) {
        return time;
      }

      t = 0;
    }

    const year = Number.isNaN(n[0]) ? yearFromTime(t) : n[0];
    const month = Number.isNaN(n[1]) ? monthFromTime(t) : n[1];
    const date = Number.isNaN(n[2]) ? dateFromTime(t) : n[2];
    t = makeDate(makeDay(year, month, date), timeWithinDay(t));
  } else {
    const hour = Number.isNaN(n[3]) ? hourFromTime(t) : n[3];
    const min = Number.isNaN(n[4]) ? minFromTime(t) : n[4];
    const sec = Number.isNaN(n[5]) ? secFromTime(t) : n[5];
    const ms = Number.isNaN(n[6]) ? msecFromTime(t) : n[6];
    t = makeDate(day(t), makeTime(hour, min, sec, ms));
  }

  return timeClip(local ? utc(t) : t);
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
function parseDate(s: string): number {
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
  const fields = [f.year, f.month, f.day, hour, min, sec, 0];
  if (f.zone === -1) {
    return fromFields(fields, true);
  }

  return fromFields(fields, false) + f.zone * 60000;
}

/** As DateClass::construct: now, a time, a string, a Date, or local fields. */
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
      // makes it, an object's string from valueOf too. Either is clipped,
      // though Date.parse leaves its result unclipped.
      o.$time = timeClip(typeof v === "string" ? parseDate(v) : rt.toNumber(v));
    }
  } else {
    const n = [0, 0, 1, 0, 0, 0, 0];
    for (let i = 0; i < args.length && i < 7; i++) {
      n[i] = rt.toNumber(args[i]);
    }

    o.$time = fromFields(n, true);
  }

  return o;
}

const dateHook: ClassHook = {
  construct,
  // Date.prototype is a Date, of no time.
  prototype: (_rt, cls) => {
    const o = cls.$it.instance();
    o.$time = Number.NaN;
    return o;
  },
  // Date() called is the time now, as a string.
  call: () => format(Date.now(), 0),
};

/** Set field `index` of `o`'s time from `args`, as DateObject's setters by index: 1 to 7 local, negated in UTC. */
function setField(rt: Runtime, o: AsObject, index: number, args: Value[]): number {
  o.$time = set(rt, timeOf(o), index, args);
  return o.$time;
}

export const DateBuiltin = bindNatives(
  DateDecl,
  (rt) =>
    class DateNatives {
      // Its class hook makes the Date: this runs only as a subclass's super().
      Date() {}

      static parse(s: Value) {
        return parseDate(rt.toString(s));
      }

      static UTC(
        year: Value,
        month: Value,
        date: Value,
        hours: Value,
        minutes: Value,
        seconds: Value,
        ms: Value,
      ) {
        const n = [year, month, date, hours, minutes, seconds, ms].map((v) => rt.toNumber(v));
        return fromFields(n, false);
      }

      "AS3::valueOf"(this: AsObject) {
        return timeOf(this);
      }

      "AS3::getTime"(this: AsObject) {
        return timeOf(this);
      }

      "AS3::getTimezoneOffset"(this: AsObject) {
        return field(timeOf(this), 16);
      }

      "private::_get"(this: AsObject, index: number) {
        return field(timeOf(this), index);
      }

      "private::_toString"(this: AsObject, index: number) {
        return format(timeOf(this), index);
      }

      "private::_setTime"(this: AsObject, t: number) {
        this.$time = timeClip(t);
        return this.$time;
      }

      "AS3::setTime"(this: AsObject, t: Value) {
        this.$time = timeClip(rt.toNumber(t));
        return this.$time;
      }

      "AS3::getUTCFullYear"(this: AsObject) {
        return field(timeOf(this), 0);
      }

      "AS3::getUTCMonth"(this: AsObject) {
        return field(timeOf(this), 1);
      }

      "AS3::getUTCDate"(this: AsObject) {
        return field(timeOf(this), 2);
      }

      "AS3::getUTCDay"(this: AsObject) {
        return field(timeOf(this), 3);
      }

      "AS3::getUTCHours"(this: AsObject) {
        return field(timeOf(this), 4);
      }

      "AS3::getUTCMinutes"(this: AsObject) {
        return field(timeOf(this), 5);
      }

      "AS3::getUTCSeconds"(this: AsObject) {
        return field(timeOf(this), 6);
      }

      "AS3::getUTCMilliseconds"(this: AsObject) {
        return field(timeOf(this), 7);
      }

      "AS3::getFullYear"(this: AsObject) {
        return field(timeOf(this), 8);
      }

      "AS3::getMonth"(this: AsObject) {
        return field(timeOf(this), 9);
      }

      "AS3::getDate"(this: AsObject) {
        return field(timeOf(this), 10);
      }

      "AS3::getDay"(this: AsObject) {
        return field(timeOf(this), 11);
      }

      "AS3::getHours"(this: AsObject) {
        return field(timeOf(this), 12);
      }

      "AS3::getMinutes"(this: AsObject) {
        return field(timeOf(this), 13);
      }

      "AS3::getSeconds"(this: AsObject) {
        return field(timeOf(this), 14);
      }

      "AS3::getMilliseconds"(this: AsObject) {
        return field(timeOf(this), 15);
      }

      "AS3::toString"(this: AsObject) {
        return format(timeOf(this), 0);
      }

      "AS3::toDateString"(this: AsObject) {
        return format(timeOf(this), 1);
      }

      "AS3::toTimeString"(this: AsObject) {
        return format(timeOf(this), 2);
      }

      "AS3::toLocaleString"(this: AsObject) {
        return format(timeOf(this), 3);
      }

      "AS3::toLocaleDateString"(this: AsObject) {
        return format(timeOf(this), 4);
      }

      "AS3::toLocaleTimeString"(this: AsObject) {
        return format(timeOf(this), 5);
      }

      "AS3::toUTCString"(this: AsObject) {
        return format(timeOf(this), 6);
      }

      "private::_setFullYear"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 1, args);
      }

      "AS3::setFullYear"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 1, args);
      }

      "private::_setUTCFullYear"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -1, args);
      }

      "AS3::setUTCFullYear"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -1, args);
      }

      "private::_setMonth"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 2, args);
      }

      "AS3::setMonth"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 2, args);
      }

      "private::_setUTCMonth"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -2, args);
      }

      "AS3::setUTCMonth"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -2, args);
      }

      "private::_setDate"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 3, args);
      }

      "AS3::setDate"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 3, args);
      }

      "private::_setUTCDate"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -3, args);
      }

      "AS3::setUTCDate"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -3, args);
      }

      "private::_setHours"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 4, args);
      }

      "AS3::setHours"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 4, args);
      }

      "private::_setUTCHours"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -4, args);
      }

      "AS3::setUTCHours"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -4, args);
      }

      "private::_setMinutes"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 5, args);
      }

      "AS3::setMinutes"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 5, args);
      }

      "private::_setUTCMinutes"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -5, args);
      }

      "AS3::setUTCMinutes"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -5, args);
      }

      "private::_setSeconds"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 6, args);
      }

      "AS3::setSeconds"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 6, args);
      }

      "private::_setUTCSeconds"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -6, args);
      }

      "AS3::setUTCSeconds"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -6, args);
      }

      "private::_setMilliseconds"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 7, args);
      }

      "AS3::setMilliseconds"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, 7, args);
      }

      "private::_setUTCMilliseconds"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -7, args);
      }

      "AS3::setUTCMilliseconds"(this: AsObject, ...args: Value[]) {
        return setField(rt, this, -7, args);
      }

      get fullYear(): number {
        return field(timeOf(this), 8);
      }

      set fullYear(value: number) {
        setField(rt, this, 1, [value]);
      }

      get month(): number {
        return field(timeOf(this), 9);
      }

      set month(value: number) {
        setField(rt, this, 2, [value]);
      }

      get date(): number {
        return field(timeOf(this), 10);
      }

      set date(value: number) {
        setField(rt, this, 3, [value]);
      }

      get hours(): number {
        return field(timeOf(this), 12);
      }

      set hours(value: number) {
        setField(rt, this, 4, [value]);
      }

      get minutes(): number {
        return field(timeOf(this), 13);
      }

      set minutes(value: number) {
        setField(rt, this, 5, [value]);
      }

      get seconds(): number {
        return field(timeOf(this), 14);
      }

      set seconds(value: number) {
        setField(rt, this, 6, [value]);
      }

      get milliseconds(): number {
        return field(timeOf(this), 15);
      }

      set milliseconds(value: number) {
        setField(rt, this, 7, [value]);
      }

      get fullYearUTC(): number {
        return field(timeOf(this), 0);
      }

      set fullYearUTC(value: number) {
        setField(rt, this, -1, [value]);
      }

      get monthUTC(): number {
        return field(timeOf(this), 1);
      }

      set monthUTC(value: number) {
        setField(rt, this, -2, [value]);
      }

      get dateUTC(): number {
        return field(timeOf(this), 2);
      }

      set dateUTC(value: number) {
        setField(rt, this, -3, [value]);
      }

      get hoursUTC(): number {
        return field(timeOf(this), 4);
      }

      set hoursUTC(value: number) {
        setField(rt, this, -4, [value]);
      }

      get minutesUTC(): number {
        return field(timeOf(this), 5);
      }

      set minutesUTC(value: number) {
        setField(rt, this, -5, [value]);
      }

      get secondsUTC(): number {
        return field(timeOf(this), 6);
      }

      set secondsUTC(value: number) {
        setField(rt, this, -6, [value]);
      }

      get millisecondsUTC(): number {
        return field(timeOf(this), 7);
      }

      set millisecondsUTC(value: number) {
        setField(rt, this, -7, [value]);
      }

      get time(): number {
        return timeOf(this);
      }

      set time(value: number) {
        (this as AsObject).$time = timeClip(value);
      }

      get timezoneOffset(): number {
        return field(timeOf(this), 16);
      }

      get day(): number {
        return field(timeOf(this), 11);
      }

      get dayUTC(): number {
        return field(timeOf(this), 3);
      }
    },
  dateHook,
);
