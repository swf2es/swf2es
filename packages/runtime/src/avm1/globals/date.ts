// Date, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/date.rs has it: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. Where adl parts from
// Ruffle, adl decides (docs/avm1.md, "Date").
//
// The calendar is ECMA-262's, in Ruffle's arithmetic (its int casts
// included). Local time is Flash's on Windows, as adl has it: today's
// standard offset in every year, and today's daylight saving rule applied
// to every year, 1900 and 2050 alike, by its month, weekday and time, not
// the zone's history (Ruffle adds a constant offset, no daylight saving).
// A local time is taken back to UTC by the offset at it read as UTC, so a
// time in the spring-forward gap is an hour earlier.

import {
  type Avm1Function,
  Avm1Object,
  DONT_DELETE,
  DONT_ENUM,
  type Native,
  READ_ONLY,
} from "../objects.js";
import { clampInt } from "../operators.js";
import type { Class, Realm } from "../realm.js";
import { toNumber, type Value } from "../values.js";

/** What a Date object holds, in its `primitive`: the time, in ms since 1970 UTC, or NaN. */
export class DateCell {
  constructor(public time: number) {}
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

const MONTH_OFFSETS = [
  [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365],
  [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366],
];

/** `a mod n` taken non-negative, then cast as Ruffle casts it. */
function remEuclid(a: number, n: number): number {
  const r = clampInt(a % n);
  return r < 0 ? r + n : r;
}

const day = (t: number) => Math.floor(t / MS_PER_DAY);

const dayFromYear = (year: number) =>
  365 * (year - 1970) +
  Math.floor((year - 1969) / 4) -
  Math.floor((year - 1901) / 100) +
  Math.floor((year - 1601) / 400);

const timeFromYear = (year: number) => MS_PER_DAY * dayFromYear(year);

const isLeap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

function yearOf(t: number): number {
  const d = day(t);
  let low = clampInt(Math.floor(d / (t < 0 ? 365 : 366))) + 1970;
  let high = clampInt(Math.ceil(d / (t < 0 ? 366 : 365))) + 1970;
  while (low < high) {
    const pivot = clampInt((low + high) / 2);
    if (timeFromYear(pivot) <= t) {
      if (timeFromYear(pivot + 1) > t) {
        return pivot;
      }

      low = pivot + 1;
    } else {
      high = pivot - 1;
    }
  }

  return low;
}

const dayWithinYear = (t: number) => clampInt(day(t) - dayFromYear(yearOf(t)));

function monthOf(t: number): number {
  const d = dayWithinYear(t);
  const offsets = MONTH_OFFSETS[isLeap(yearOf(t)) ? 1 : 0];
  for (let i = 0; i < 11; i++) {
    if (d < offsets[i + 1]) {
      return i;
    }
  }

  return 11;
}

const dateOf = (t: number) =>
  dayWithinYear(t) - MONTH_OFFSETS[isLeap(yearOf(t)) ? 1 : 0][monthOf(t)] + 1;
const weekDay = (t: number) => remEuclid(day(t) + 4, 7);
const hoursOf = (t: number) => remEuclid(Math.floor((t + 0.5) / MS_PER_HOUR), 24);
const minutesOf = (t: number) => remEuclid(Math.floor(t / MS_PER_MINUTE), 60);
const secondsOf = (t: number) => remEuclid(Math.floor(t / MS_PER_SECOND), 60);
const msOf = (t: number) => remEuclid(t, MS_PER_SECOND);

/** Up to SWF 7 the remainder takes the sign of the time, as Ruffle has it. */
const timeWithinDay = (t: number, version: number) =>
  version > 7 ? ((t % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY : t % MS_PER_DAY;

function makeTime(h: number, m: number, s: number, ms: number): number {
  return (
    Math.floor(h) * MS_PER_HOUR +
    Math.floor(m) * MS_PER_MINUTE +
    Math.floor(s) * MS_PER_SECOND +
    Math.floor(ms)
  );
}

function dayFromMonth(year: number, month: number): number {
  const y = clampInt(year);
  const m = clampInt(Math.floor(month));
  if (m < 0 || m > 11) {
    return Number.NaN;
  }

  return dayFromYear(y) + MONTH_OFFSETS[isLeap(y) ? 1 : 0][m];
}

function makeDay(year: number, month: number, date: number): number {
  let y = Math.floor(year);
  const m = Math.floor(month);
  y += Math.floor(m / 12);
  return dayFromMonth(y, ((m % 12) + 12) % 12) + Math.floor(date) - 1;
}

const makeDate = (d: number, time: number) => d * MS_PER_DAY + time;

/** TimeClip: NaN past 100 million days either side of 1970, else whole. */
function clip(t: number): number {
  return !Number.isFinite(t) || Math.abs(t) > 1e8 * MS_PER_DAY ? Number.NaN : Math.floor(t);
}

/** A date's fields, a year below 100 taken as 1900's. */
function fromFields(args: number[]): number {
  let year = args[0];
  if (year < 100) {
    year += 1900;
  }

  return makeDate(
    makeDay(year, args[1], args.length > 2 ? args[2] : 1),
    makeTime(
      args.length > 3 ? args[3] : 0,
      args.length > 4 ? args[4] : 0,
      args.length > 5 ? args[5] : 0,
      args.length > 6 ? args[6] : 0,
    ),
  );
}

/** A daylight saving transition as Windows keeps one: the nth weekday of a month (5 the last), at a standard time. */
interface Transition {
  month: number;
  weekday: number;
  week: number;
  time: number;
}

interface Zone {
  /** The year it was read in. */
  year: number;
  /** Today's standard offset east of UTC, in ms. */
  standard: number;
  /** What daylight saving adds, 0 for a zone without it. */
  saving: number;
  start: Transition | null;
  end: Transition | null;
}

let zone: Zone | null = null;

const hostOffset = (t: number) => -new Date(t).getTimezoneOffset() * MS_PER_MINUTE;

/** The first instant of `[from, to)` whose offset is not `from`'s, to the minute. */
function transition(from: number, to: number): number {
  const before = hostOffset(from);
  while (to - from > MS_PER_MINUTE) {
    const mid = from + Math.floor((to - from) / MS_PER_MINUTE / 2) * MS_PER_MINUTE;
    if (hostOffset(mid) === before) {
      from = mid;
    } else {
      to = mid;
    }
  }

  return to;
}

/** A transition at `t` as a rule, its standard local time's month, weekday and week. */
function ruleOf(t: number, standard: number): Transition {
  const local = t + standard;
  const date = dateOf(local);
  const length = MONTH_OFFSETS[isLeap(yearOf(local)) ? 1 : 0];
  const month = monthOf(local);
  const last = date + 7 > length[month + 1] - length[month];
  return {
    month,
    weekday: weekDay(local),
    week: last ? 5 : Math.floor((date - 1) / 7) + 1,
    time: remEuclid(local, MS_PER_DAY),
  };
}

/** The host's zone, read from its offsets this year, again as the year changes. */
function hostZone(): Zone {
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  if (zone !== null && zone.year === year) {
    return zone;
  }

  const months: number[] = [];
  for (let m = 0; m <= 12; m++) {
    months.push(Date.UTC(year, m, 1));
  }

  const offsets = months.map(hostOffset);
  const standard = Math.min(...offsets);
  const saving = Math.max(...offsets) - standard;
  let start: Transition | null = null;
  let end: Transition | null = null;
  for (let m = 0; m < 12; m++) {
    if (offsets[m] !== offsets[m + 1]) {
      const t = transition(months[m], months[m + 1]);
      if (hostOffset(t) > offsets[m]) {
        start = ruleOf(t, standard);
      } else {
        end = ruleOf(t, standard);
      }
    }
  }

  zone = { year, standard, saving, start, end };
  return zone;
}

/** The instant a rule falls on in `year`. */
function instant(rule: Transition, year: number, standard: number): number {
  const first = makeDay(year, rule.month, 1);
  let date = 1 + ((rule.weekday - weekDay(first * MS_PER_DAY) + 7) % 7) + (rule.week - 1) * 7;
  const length = makeDay(year, rule.month + 1, 1) - first;
  while (date > length) {
    date -= 7;
  }

  return makeDate(first + date - 1, rule.time) - standard;
}

/** The offset east of UTC at `t`, in ms: the standard offset, and daylight saving's by today's rule. */
function offsetAt(t: number): number {
  const z = hostZone();
  if (z.start === null || z.end === null || !Number.isFinite(t)) {
    return z.standard;
  }

  const year = yearOf(t + z.standard);
  const start = instant(z.start, year, z.standard);
  const end = instant(z.end, year, z.standard);
  const saving = start < end ? t >= start && t < end : !(t >= end && t < start);
  return saving ? z.standard + z.saving : z.standard;
}

const localTime = (t: number) => t + offsetAt(t);
const utcOf = (local: number) => local - offsetAt(local);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const two = (n: number) => (n < 10 ? `0${n}` : String(n));

/** As Flash writes a date: "Thu Oct 15 12:34:56 GMT+0300 2026", local. */
export function dateString(time: number): string {
  if (!Number.isFinite(time)) {
    return "Invalid Date";
  }

  const t = localTime(time);
  const offset = clampInt((t - time) / MS_PER_MINUTE);
  const abs = Math.abs(offset);
  return `${DAYS[weekDay(t)]} ${MONTHS[monthOf(t)]} ${dateOf(t)} ${two(hoursOf(t))}:${two(
    minutesOf(t),
  )}:${two(secondsOf(t))} GMT${offset < 0 ? "-" : "+"}${two(Math.floor(abs / 60))}${two(
    abs % 60,
  )} ${yearOf(t)}`;
}

// The methods' ASnative(103, i) indices, a UTC method 128 past its local one.
const GET_FULL_YEAR = 0;
const GET_YEAR = 1;
const GET_MONTH = 2;
const GET_DATE = 3;
const GET_DAY = 4;
const GET_HOURS = 5;
const GET_MINUTES = 6;
const GET_SECONDS = 7;
const GET_MILLISECONDS = 8;
const SET_FULL_YEAR = 9;
const SET_MONTH = 10;
const SET_DATE = 11;
const SET_HOURS = 12;
const SET_MINUTES = 13;
const SET_SECONDS = 14;
const SET_MILLISECONDS = 15;
const GET_TIME = 16;
const SET_TIME = 17;
const GET_TIMEZONE_OFFSET = 18;
const TO_STRING = 19;
const SET_YEAR = 20;
const CONSTRUCTOR = 256;
const UTC = 257;
const UTC_OFFSET = 128;

/** The arguments as Date's natives take them: numbers, up to 7, to the first undefined. */
function numbers(args: Value[], version: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < args.length && i < 7; i++) {
    if (args[i] === undefined) {
      break;
    }

    out.push(toNumber(args[i], version));
  }

  return out;
}

function now(version: number): number {
  const t = Date.now();
  return version > 7 ? Math.round(t) : t;
}

/** ASnative(103, index): a Date method, the constructor, or Date.UTC. */
export function dateNative(index: number): Native {
  return (self, rawArgs, version) => {
    const args = numbers(rawArgs, version);
    if (index === CONSTRUCTOR) {
      let time: number;
      if (args.length === 0) {
        time = now(version);
      } else if (args.length === 1) {
        time = args[0];
      } else {
        time = utcOf(fromFields(args));
      }

      self.primitive = new DateCell(time);
      return self;
    }

    if (index === UTC) {
      return args.length < 2 ? undefined : fromFields(args);
    }

    const cell = self.primitive;
    if (!(cell instanceof DateCell)) {
      return undefined;
    }

    const time = cell.time;
    switch (index) {
      case GET_TIME:
        return time;
      case SET_TIME:
        cell.time = clip(args.length > 0 ? args[0] : Number.NaN);
        return cell.time;
      case GET_TIMEZONE_OFFSET:
        return (time - localTime(time)) / MS_PER_MINUTE;
    }

    const utc = index >= UTC_OFFSET;
    let i = utc ? index - UTC_OFFSET : index;
    if (i <= GET_MILLISECONDS && Number.isNaN(time)) {
      return Number.NaN;
    }

    const setYear = i === SET_YEAR;
    if (setYear) {
      i = SET_FULL_YEAR;
    }

    const arg = (field: number): number | undefined =>
      field >= i && field - i < args.length
        ? args[field - i]
        : field === i
          ? Number.NaN
          : undefined;
    const t = utc ? time : localTime(time);
    const store = (d: number, within: number): number => {
      let value = makeDate(d, within);
      if (!utc) {
        value = utcOf(value);
      }

      cell.time = clip(value);
      return cell.time;
    };

    switch (i) {
      case GET_FULL_YEAR:
        return yearOf(t);
      case GET_YEAR:
        return yearOf(t) - 1900;
      case GET_MONTH:
        return monthOf(t);
      case GET_DATE:
        return dateOf(t);
      case GET_DAY:
        return weekDay(t);
      case GET_HOURS:
        return hoursOf(t);
      case GET_MINUTES:
        return minutesOf(t);
      case GET_SECONDS:
        return secondsOf(t);
      case GET_MILLISECONDS:
        return msOf(t);
      case SET_FULL_YEAR:
      case SET_MONTH:
      case SET_DATE: {
        let year = arg(SET_FULL_YEAR) ?? yearOf(t);
        if (setYear && year >= 0 && year <= 99) {
          year += 1900;
        }

        let month = arg(SET_MONTH) ?? monthOf(t);
        // setMonth() of nothing is January.
        if (i === SET_MONTH && Number.isNaN(month)) {
          month = 0;
        }

        let date = arg(SET_DATE);
        if (date === undefined) {
          date = dateOf(t);
          // From SWF 7, setMonth keeps the day within the month it sets (adl).
          const m = Math.floor(month);
          if (i === SET_MONTH && version > 6 && m >= 0 && m <= 11) {
            const length = MONTH_OFFSETS[isLeap(clampInt(year)) ? 1 : 0];
            date = Math.min(date, length[m + 1] - length[m]);
          }
        }

        return store(makeDay(year, month, date), timeWithinDay(t, version));
      }
      case SET_HOURS:
      case SET_MINUTES:
      case SET_SECONDS:
      case SET_MILLISECONDS: {
        const hours = arg(SET_HOURS) ?? hoursOf(t);
        let minutes = arg(SET_MINUTES) ?? minutesOf(t);
        let seconds = arg(SET_SECONDS) ?? secondsOf(t);
        let ms = arg(SET_MILLISECONDS) ?? msOf(t);
        if (i === SET_MINUTES) {
          minutes = clampInt(minutes);
          seconds = clampInt(seconds);
          ms = clampInt(ms);
        }

        return store(day(t), makeTime(hours, minutes, seconds, ms));
      }
      case TO_STRING:
        return dateString(time);
      default:
        return undefined;
    }
  };
}

const PROTO: [string, number][] = [
  ["getFullYear", GET_FULL_YEAR],
  ["getYear", GET_YEAR],
  ["getMonth", GET_MONTH],
  ["getDate", GET_DATE],
  ["getDay", GET_DAY],
  ["getHours", GET_HOURS],
  ["getMinutes", GET_MINUTES],
  ["getSeconds", GET_SECONDS],
  ["getMilliseconds", GET_MILLISECONDS],
  ["setFullYear", SET_FULL_YEAR],
  ["setMonth", SET_MONTH],
  ["setDate", SET_DATE],
  ["setHours", SET_HOURS],
  ["setMinutes", SET_MINUTES],
  ["setSeconds", SET_SECONDS],
  ["setMilliseconds", SET_MILLISECONDS],
  ["getTime", GET_TIME],
  ["setTime", SET_TIME],
  ["getTimezoneOffset", GET_TIMEZONE_OFFSET],
  ["toString", TO_STRING],
  ["setYear", SET_YEAR],
  ["getUTCFullYear", UTC_OFFSET + GET_FULL_YEAR],
  ["getUTCYear", UTC_OFFSET + GET_YEAR],
  ["getUTCMonth", UTC_OFFSET + GET_MONTH],
  ["getUTCDate", UTC_OFFSET + GET_DATE],
  ["getUTCDay", UTC_OFFSET + GET_DAY],
  ["getUTCHours", UTC_OFFSET + GET_HOURS],
  ["getUTCMinutes", UTC_OFFSET + GET_MINUTES],
  ["getUTCSeconds", UTC_OFFSET + GET_SECONDS],
  ["getUTCMilliseconds", UTC_OFFSET + GET_MILLISECONDS],
  ["setUTCFullYear", UTC_OFFSET + SET_FULL_YEAR],
  ["setUTCMonth", UTC_OFFSET + SET_MONTH],
  ["setUTCDate", UTC_OFFSET + SET_DATE],
  ["setUTCHours", UTC_OFFSET + SET_HOURS],
  ["setUTCMinutes", UTC_OFFSET + SET_MINUTES],
  ["setUTCSeconds", UTC_OFFSET + SET_SECONDS],
  ["setUTCMilliseconds", UTC_OFFSET + SET_MILLISECONDS],
  ["valueOf", GET_TIME],
];

export function dateClass(realm: Realm): Class {
  const proto = new Avm1Object();
  const constr: Avm1Function = realm.classOf(proto, dateNative(CONSTRUCTOR), (_, __, version) =>
    dateString(now(version)),
  );
  proto.define("__proto__", realm.objectProto, DONT_ENUM | DONT_DELETE);
  for (const [name, index] of PROTO) {
    proto.define(name, realm.method(dateNative(index)), DONT_ENUM | DONT_DELETE);
  }

  constr.define("UTC", realm.method(dateNative(UTC)), DONT_ENUM | DONT_DELETE | READ_ONLY);
  realm.natives.set(103, (i) =>
    i <= SET_YEAR ||
    i === CONSTRUCTOR ||
    i === UTC ||
    (i >= UTC_OFFSET && i <= UTC_OFFSET + SET_MILLISECONDS)
      ? dateNative(i)
      : null,
  );
  return { constr, proto };
}
