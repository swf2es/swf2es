// AVM1's Date in local time, in a zone with daylight saving, which the
// player's cases cannot pin, run in whatever zone the host has: what adl
// traces in TZ=Europe/Helsinki (Flash on Windows), today's standard offset
// and daylight saving rule in every year, 1900, 1938 and 2050 alike.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Avm1Function,
  Avm1Object,
  Host,
  Property,
  Value,
} from "../../../packages/runtime/dist/avm1/index.js";

// Before the runtime reads a date: node takes the zone from TZ when it first needs one.
process.env.TZ = "Europe/Helsinki";
const { avm1 } = await import("@swf2es/runtime");
const { dateString } = await import("../../../packages/runtime/dist/avm1/globals/date.js");

const rt = new avm1.Runtime();
const host: Host = { trace() {}, play() {}, stop() {}, halt() {} };
rt.realm.current = rt.activation([], [], {}, rt.newObject(), host);

/** `new Date(...args)` in a SWF of `version`, and its time. */
function date(args: Value[], version = 6): Avm1Object {
  return rt.realm.construct(rt.realm.Date.constr, args, version) as Avm1Object;
}

const getTime = (rt.realm.Date.proto.own("getTime", 6) as Property).value as Avm1Function;
const time = (d: Avm1Object) => getTime.call(d, [], 6);

test("local fields are taken back to UTC by today's offsets", () => {
  const d = date([2026, 9, 15, 12, 34, 56, 789]);
  assert.equal(time(d), 1792056896789);
  assert.equal(dateString(1792056896789), "Thu Oct 15 12:34:56 GMT+0300 2026");
  assert.equal(time(date([2026, 0, 15])), 1768428000000);
  assert.equal(dateString(1768428000000), "Thu Jan 15 00:00:00 GMT+0200 2026");
});

test("every year has today's standard offset and daylight saving rule", () => {
  assert.equal(time(date([1900, 0, 1])), -2208996000000);
  assert.equal(time(date([1960, 6, 1])), -299905200000);
  assert.equal(time(date([2050, 6, 1])), 2540235600000);
  assert.equal(dateString(-1e12), "Mon Apr 25 01:13:20 GMT+0300 1938");
  assert.equal(dateString(0), "Thu Jan 1 02:00:00 GMT+0200 1970");
  assert.equal(dateString(1e17), "Sat Nov 7 11:46:40 GMT+0200 3170843");
});

test("a local time is read back by the offset at it as UTC: the gap an hour earlier", () => {
  assert.equal(time(date([2026, 2, 29, 3, 30])), 1774744200000);
  assert.equal(dateString(1774744200000), "Sun Mar 29 02:30:00 GMT+0200 2026");
  assert.equal(time(date([2026, 9, 25, 3, 30])), 1792891800000);
  assert.equal(time(date([2026, 9, 25, 4, 30])), 1792895400000);
});
