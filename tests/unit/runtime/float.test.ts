import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";

// AIR's traces for these cases are also held by the air-float player case.
const rt = avm2.createRuntime();

test("float coercion preserves binary32, signed zero, and an existing float", () => {
  const f = rt.float(16777217);
  assert.equal(f.value, 16777216);
  assert.equal(rt.float(f), f);
  assert.equal(rt.toNumber(f), 16777216);
  assert.equal(rt.toString(rt.float(0.1)), "0.10000000149011612");
  assert.ok(Object.is(rt.float(-0).value, -0));
  assert.ok(Number.isNaN(rt.float(undefined).value));
  assert.equal(rt.float(null).value, 0);
  assert.equal(rt.float(1e40).value, Infinity);
});

test("float equality and Boolean conversion use their primitive semantics", () => {
  assert.equal(rt.equals(rt.float(1), 1), true);
  assert.equal(rt.strictEquals(rt.float(1), 1), false);
  assert.equal(rt.strictEquals(rt.float(1), rt.float(1)), true);
  assert.equal(rt.strictEquals(rt.float(NaN), rt.float(NaN)), false);
  assert.equal(rt.toBoolean(rt.float(0)), false);
  assert.equal(rt.toBoolean(rt.float(-0)), false);
  assert.equal(rt.toBoolean(rt.float(NaN)), false);
  assert.equal(rt.toBoolean(rt.float(1)), true);
  assert.equal(rt.typeOf(rt.float(1)), "number");
});

test("dynamic numeric operations keep float results only when both operands are floats", () => {
  const a = rt.float(16777216),
    b = rt.float(1);
  assert.equal(rt.add(a, b).value, 16777216);
  assert.equal(rt.add(a, 1), 16777217);
  assert.equal(rt.subtract(a, b).value, 16777215);
  assert.equal(rt.multiply(a, b).value, 16777216);
  assert.equal(rt.divide(a, b).value, 16777216);
  assert.equal(rt.modulo(a, b).value, 0);
  assert.equal(rt.negate(a).value, -16777216);
  assert.equal(rt.increment(a).value, 16777216);
  assert.equal(rt.decrement(a).value, 16777215);
  assert.equal(rt.multiply(a, 1), 16777216);
});
