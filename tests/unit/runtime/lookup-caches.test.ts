// The runtime's lookup caches against what a full lookup finds, as the
// bindings and properties a lookup found change after it was cached.
import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";
import { CONSTANT_Qname } from "../../../packages/runtime/dist/avm2/names.js";
import type { Runtime } from "../../../packages/runtime/dist/avm2/runtime.js";
import { BIND_Var, Traits } from "../../../packages/runtime/dist/avm2/traits.js";

const name = (rt: Runtime, local: string) =>
  rt.name([avm2.publicNs], [255], CONSTANT_Qname, [0], local);

/** Sealed traits with a public slot for each of `names`, holding `value`, from slot `first`. */
function slots(base: Traits | null, names: string[], value: unknown, first = 0): Traits {
  const traits = new Traits(`T${names.join("")}`, base);
  traits.describe({
    slots: first + names.length,
    defaults: names.map((_, i) => [first + i, value, null]),
    bindings: names.map((n, i) => [avm2.publicNs, 0, n, ((first + i) << 3) | BIND_Var]),
    methods: [],
  });
  return traits;
}

/** The error `f` throws, as the runtime words it without builtins: "ReferenceError: Error #1069". */
const thrown = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return String((e as Error).message);
  }

  return "no error";
};

test("a name looked up on more traits than its cache keeps finds each one's own", () => {
  const rt = avm2.createRuntime();
  const x = name(rt, "x");
  // Described first: describing traits empties every cache.
  const base = slots(rt.objectTraits, ["x"], 1);
  const late = slots(rt.objectTraits, ["a", "x"], 2);
  const without = slots(rt.objectTraits, ["y"], 3);
  const many = [base, ...Array.from({ length: 30 }, () => new Traits("Sub", base))];
  for (const t of many) {
    assert.equal(rt.getProperty(t.instance(), x), 1);
  }

  // Past every entry the name keeps: x in another slot, on another class.
  const o = late.instance();
  for (let i = 0; i < 3; i++) {
    assert.equal(rt.getProperty(o, x), 2);
  }

  rt.setProperty(o, x, 7);
  assert.equal(rt.getProperty(o, x), 7);
  assert.equal(rt.getProperty(many[30].instance(), x), 1);
  assert.equal(late.manyTraitsEntries?.has(x), true);
  for (let i = 0; i < 2; i++) {
    assert.equal(
      thrown(() => rt.getProperty(without.instance(), x)),
      "ReferenceError: Error #1069",
    );
  }

  const other = slots(rt.objectTraits, ["x"], 4);
  assert.equal(late.manyTraitsEntries, null);
  assert.equal(rt.getProperty(other.instance(), x), 4);
  assert.equal(rt.getProperty(o, x), 7);
});
