import assert from "node:assert/strict";
import { test } from "node:test";
import { abc, tables } from "./abc-builder.ts";
import { testing } from "./testing-module.ts";

test("comparison benchmark counts each round and rejects partial decoding", () => {
  const make = (code: number[]) =>
    abc({}, tables({ methods: [{}], scripts: [{ init: 0 }], bodies: [{ method: 0, code }] }));
  const bytes = make([0x02, 0x47]);
  assert.equal(testing.benchCompare(bytes, 3, false), 1);
  assert.equal(testing.benchCompare(bytes, 3, true), 2);
  assert.ok(testing.benchCompare(bytes.subarray(0, 6), 1, false) < 0);
  assert.ok(testing.benchCompare(make([0x02, 0xff]), 1, true) < 0);
});
