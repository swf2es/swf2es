// apiVersionOf: the API version a root SWF runs at, by its SWF version, in
// Flash Player's series by api-versions.h's names and in AIR's as adl runs
// a root of each version.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AIR_API_VERSION,
  API_VERSION,
  apiVersionOf,
  checkApiVersion,
  isAirApiVersion,
} from "@swf2es/format";

test("a Flash Player root runs at VM_ALLVERSIONS to SWF 9, FP_10_1, FP_10_2, then SWF_n", () => {
  const versions = [1, 8, 9, 10, 11, 12, 13, 27, 31, 32, 50, 255].map((v) => apiVersionOf(v));
  assert.deepEqual(versions, [0, 0, 0, 7, 10, 12, 14, 42, 50, 50, 50, 50]);
  assert.equal(apiVersionOf(31), API_VERSION);
});

test("an AIR root runs at AIR_1_0 to SWF 9, AIR_2_5, AIR_2_6, then from AIR_2_7 on", () => {
  const versions = [1, 9, 10, 11, 12, 13, 26, 31, 32, 255].map((v) => apiVersionOf(v, true));
  assert.deepEqual(versions, [1, 1, 9, 11, 13, 15, 41, 51, 51, 51]);
  assert.equal(apiVersionOf(31, true), AIR_API_VERSION);
});

test("every SWF version maps to a version ABCs run at, of its series, never lower for a later SWF", () => {
  let ok = true;
  for (const air of [false, true]) {
    let last = -1;
    for (let swf = 0; swf <= 255; swf++) {
      const version = apiVersionOf(swf, air);
      ok &&= checkApiVersion(version) === version && version >= last;
      ok &&= isAirApiVersion(version) === air;
      last = version;
    }
  }

  assert.equal(ok, true);
});

test("an AIR root never runs at 0, which the compiler and the cache read as Flash Player's", () => {
  const swfs = [-Infinity, -1, 0, 1, 8.9, 9, 9.5, 10, 31, 1e9, Infinity, Number.NaN];
  for (const swf of swfs) {
    assert.notEqual(apiVersionOf(swf, true), 0, `SWF ${swf}`);
    assert.ok(isAirApiVersion(apiVersionOf(swf, true)), `SWF ${swf}`);
  }
});
