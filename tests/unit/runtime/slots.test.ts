// A new object's slots, set by name (fillSlots, then a class's own
// slotFiller) or, past what is set by name, by key: every way gives each
// slot its value, and fillSlots and the filler give a class's objects one
// shape, their fields in one order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Traits } from "../../../packages/runtime/dist/avm2/traits.js";

function traits(slots: number[]): Traits {
  const t = new Traits("Case", null);
  t.describe({
    slots: slots.length,
    defaults: slots.map((slot) => [slot, `v${slot}`, null]),
    bindings: [],
    methods: [],
  });
  return t;
}

for (const [name, slots] of [
  ["a few slots", [0, 1, 2]],
  ["more than V8 sets by key and keeps fast", Array.from({ length: 40 }, (_, i) => i)],
  ["more than are set by name", Array.from({ length: 130 }, (_, i) => i)],
  ["slots not in order", [1, 0, 2]],
] as const) {
  test(`objects of ${name} have their slots' values, each in one shape`, () => {
    const t = traits([...slots]);
    const made = Array.from({ length: 40 }, () => t.instance());
    for (const o of made) {
      for (const slot of slots) {
        assert.equal(o[`$${slot}`], `v${slot}`);
      }

      assert.equal(o.$d, null);
      assert.deepEqual(Object.keys(o), Object.keys(made[0]));
    }
  });
}
