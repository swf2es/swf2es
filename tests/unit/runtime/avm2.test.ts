import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";

test("int() and uint() coerce like AS3", () => {
  assert.equal(avm2.toInt(2 ** 31), -(2 ** 31));
  assert.equal(avm2.toInt("12.9"), 12);
  assert.equal(avm2.toInt(undefined), 0);
  assert.equal(avm2.toInt(NaN), 0);
  assert.equal(avm2.toUint(-1), 4294967295);
  assert.equal(avm2.toUint(null), 0);
});
