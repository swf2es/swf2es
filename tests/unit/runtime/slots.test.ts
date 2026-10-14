// A new object's slots: set by the fill its module compiled for its traits,
// with the initial values by slot, or by key where none did; either way
// each slot has its value and a class's objects one shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AsObject, SlotFill, Value } from "../../../packages/runtime/dist/avm2/descriptors.js";
import { Traits } from "../../../packages/runtime/dist/avm2/traits.js";

function traits(slots: number[], fill?: SlotFill, base: Traits | null = null): Traits {
  const t = new Traits("Case", base);
  t.describe({
    slots: slots.length,
    defaults: slots.map((slot) => [slot, `v${slot}`, null]),
    bindings: [],
    methods: [],
    fill,
  });
  return t;
}

/** A fill as codegen writes one: slots `count - 1` to 0, each from `values`. */
function fillOf(count: number, calls: number[] = []): SlotFill {
  return (o: AsObject, values: Value[]) => {
    calls.push(count);
    for (let i = count - 1; i >= 0; i--) {
      o[`$${i}`] = values[i];
    }
  };
}

for (const [name, slots] of [
  ["a few slots", [0, 1, 2]],
  ["more than V8 sets by key and keeps fast", Array.from({ length: 40 }, (_, i) => i)],
  ["slots not in order", [1, 0, 2]],
] as const) {
  for (const filled of [true, false]) {
    test(`objects of ${name}, ${filled ? "with" : "without"} a fill, have their slots' values, in one shape`, () => {
      const calls: number[] = [];
      const t = traits([...slots], filled ? fillOf(slots.length, calls) : undefined);
      const made = Array.from({ length: 40 }, () => t.instance());
      for (const o of made) {
        for (const slot of slots) {
          assert.equal(o[`$${slot}`], `v${slot}`);
        }

        assert.equal(o.$d, null);
        assert.deepEqual(Object.keys(o), Object.keys(made[0]));
      }

      assert.equal(calls.length, filled ? 40 : 0);
    });
  }
}

test("a fill sets a base's slots with the base's values", () => {
  const base = traits([0, 1], fillOf(2));
  const sub = traits([2, 3, 4], fillOf(5), base);
  const o = sub.instance();
  assert.deepEqual(Object.keys(o), ["$d", "$4", "$3", "$2", "$1", "$0"]);
  assert.deepEqual([o.$0, o.$1, o.$2, o.$3, o.$4], ["v0", "v1", "v2", "v3", "v4"]);
});

test("traits no module describes, as a Vector.<T>'s, use their base's fill", () => {
  const calls: number[] = [];
  const base = traits([0, 1, 2], fillOf(3, calls));
  const specialized = new Traits("Vector.<T>", base);
  const o = specialized.instance();
  assert.deepEqual(calls, [3]);
  assert.deepEqual([o.$0, o.$1, o.$2], ["v0", "v1", "v2"]);
});
