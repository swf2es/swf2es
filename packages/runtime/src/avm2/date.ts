// Date, as avmplus' DateClass and Date: the time a Date holds, its fields
// by the indices Date.as asks for, the setters, and its strings in
// avmplus' formats, which are not JavaScript's. Local time is the host's,
// through JavaScript's Date, as avmplus' is the OS's. Date.parse is
// JavaScript's for now, not avmplus' own parser.
import type { AsObject, ClassHook, Runtime, Value } from "./runtime.js";

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
      const p = v !== null && typeof v === "object" ? rt.toPrimitive(v, "number") : v;
      o.$time = timeClip(typeof p === "string" ? Date.parse(p) : rt.toNumber(p));
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
    "Date.parse": (rt) => (s: Value) => timeClip(Date.parse(rt.toString(s))),
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
