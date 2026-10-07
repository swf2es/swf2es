// Date's local time in a zone with daylight saving, which the oracle, in
// UTC, never shows: avmshell's in TZ=EET-2EEST,M3.5.0/3,M10.5.0/4, Helsinki's
// rule now. The standard offset is now's, whatever the year, plus an hour
// in daylight saving, which a 32-bit time_t ends in 2038.
import assert from "node:assert/strict";
import { test } from "node:test";

// Before the runtime reads a date: node takes the zone from TZ when it first needs one.
process.env.TZ = "Europe/Helsinki";
const { avm2 } = await import("@swf2es/runtime");

const rt = avm2.createRuntime();
const natives = avm2.builtinNatives(rt);
const native = (key: string) => {
  const make = natives[key];
  assert.ok(make, `no native ${key}`);
  return make(rt) as (this: unknown, ...args: unknown[]) => unknown;
};

const parse = native("Date.parse");
const get = native("Date#Date::_get");
const format = native("Date#Date::_toString");
const setMonth = native("Date#Date::_setMonth");
const OFFSET = 16;
const HOURS = 12;

const date = (s: string) => ({ $time: parse(s) as number });

test("the offset is daylight saving's from March to October, until 2038", () => {
  assert.equal(get.call(date("Jan 1 2026"), OFFSET), -120);
  assert.equal(get.call(date("Jul 1 2026"), OFFSET), -180);
  assert.equal(get.call(date("Jul 1 2037"), OFFSET), -180);
  assert.equal(get.call(date("Jul 1 2050"), OFFSET), -120);
});

test("a year before the zone's standard time has today's offset, not its local mean time", () => {
  const d = date("Jul 1 1900");
  assert.equal(d.$time, Date.UTC(1900, 6, 1) - 2 * 3600000);
  assert.equal(get.call(d, OFFSET), -120);
  assert.equal(get.call(d, HOURS), 0);

  // A setter keeps the local time of day.
  const jan = date("Jan 1 1900");
  setMonth.call(jan, 6);
  assert.equal(get.call(jan, HOURS), 0);
  assert.equal(jan.$time, d.$time);
});

test("a time in the spring-forward gap is an hour later, one in the fall-back hour standard", () => {
  assert.equal(parse("Mar 29 2026 03:30:00"), 1774747800000);
  assert.equal(format.call({ $time: 1774747800000 }, 0), "Sun Mar 29 04:30:00 GMT+0300 2026");
  assert.equal(parse("Oct 25 2026 03:30:00"), 1792891800000);
  assert.equal(format.call({ $time: 1792891800000 }, 0), "Sun Oct 25 03:30:00 GMT+0200 2026");
  assert.equal(parse("Oct 25 2026 04:30:00"), 1792895400000);
});
