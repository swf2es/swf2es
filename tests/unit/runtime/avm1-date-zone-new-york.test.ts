// AVM1's Date in local time west of UTC, which the player's cases cannot
// pin: what adl traces in TZ=America/New_York (Flash on Windows, under
// Wine, which takes the zone from TZ). Windows compares a local time with
// the daylight saving rule's local times, so the spring-forward gap goes
// an hour back and the hour that repeats is the later, standard one, as
// in Helsinki, though here the offsets are negative.
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
process.env.TZ = "America/New_York";
const { avm1 } = await import("@swf2es/runtime");
const { dateString } = await import("../../../packages/runtime/dist/avm1/globals/date.js");

const rt = new avm1.Runtime();
const host: Host = { trace() {}, play() {}, stop() {}, halt() {} };
rt.realm.current = rt.activation([], [], {}, rt.newObject(), host);

/** `new Date(...args)` in a SWF of `version`. */
function date(args: Value[], version = 7): Avm1Object {
  return rt.realm.construct(rt.realm.Date.constr, args, version) as Avm1Object;
}

const method = (name: string) =>
  (rt.realm.Date.proto.own(name, 7) as Property).value as Avm1Function;
const time = (d: Avm1Object) => method("getTime").call(d, [], 7);

test("local times west of UTC, by today's offsets in every year", () => {
  assert.equal(dateString(0), "Wed Dec 31 19:00:00 GMT-0500 1969");
  assert.equal(dateString(1e12), "Sat Sep 8 21:46:40 GMT-0400 2001");
  assert.equal(dateString(-1e12), "Sun Apr 24 18:13:20 GMT-0400 1938");
  assert.equal(time(date([1900, 0, 1])), -2208970800000);
  assert.equal(time(date([1938, 6, 1])), -994190400000);
  assert.equal(time(date([2026, 0, 1, 0, 0])), 1767243600000);
});

test("the gap goes an hour back, the repeated hour is standard time's", () => {
  assert.equal(time(date([2026, 2, 8, 2, 30])), 1772951400000);
  assert.equal(dateString(1772951400000), "Sun Mar 8 01:30:00 GMT-0500 2026");
  assert.equal(time(date([2026, 10, 1, 1, 30])), 1793514600000);
  assert.equal(dateString(1793514600000), "Sun Nov 1 01:30:00 GMT-0500 2026");
});

test("a setter's local fields go back to UTC by the same rule", () => {
  assert.equal(method("setMonth").call(date([0]), [Number.NaN], 7), -28944000000);
  const d = date([2026, 0, 31, 10]);
  assert.equal(method("setMonth").call(d, [1], 7), 1772290800000);
  assert.equal(method("setHours").call(d, [25], 7), 1772344800000);
});
