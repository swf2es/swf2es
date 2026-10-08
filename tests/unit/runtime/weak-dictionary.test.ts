// A weak-keyed Dictionary keeps no key alive, as Flash's does not, though a
// for-in over it has started and been left off; avmshell's output cannot
// show what its collector frees, so this collects in node.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { avm2 } from "@swf2es/runtime";
import { WeakKeys } from "../../../packages/runtime/dist/avm2/weak-keys.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Collect, and let a turn pass, as WeakRefs are cleared only between jobs. */
async function collect(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a weak Dictionary's keys go once nothing else holds them, and the rest stay in order", async () => {
  const keys = new WeakKeys();
  const kept = [{ k: 0 }, { k: 2 }];
  keys.set(kept[0], "first");
  // Made in a function, so that nothing here still holds them.
  (() => {
    for (let i = 0; i < 100; i++) {
      keys.set({ i }, i);
    }
  })();
  keys.set(kept[1], "last");

  await collect();
  assert.deepEqual([...keys.keys()], kept);
  assert.deepEqual(
    [...keys],
    [
      [kept[0], "first"],
      [kept[1], "last"],
    ],
  );
  assert.equal(keys.size, 2);

  // Deleted, and set again: last in order.
  assert.equal(keys.delete(kept[0]), true);
  assert.equal(keys.delete(kept[0]), false);
  keys.set(kept[0], "again");
  assert.deepEqual([...keys.keys()], [kept[1], kept[0]]);
});

test("a for-in left off over a weak Dictionary keeps none of its keys alive", async () => {
  const rt = avm2.createRuntime();
  const dictionary = { $keys: new WeakKeys() } as unknown as avm2.AsObject;
  const kept = { kept: true };
  let gone: WeakRef<object> | null = null;
  (() => {
    const key = { gone: true };
    gone = new WeakRef(key);
    dictionary.$keys.set(key, "gone");
  })();
  dictionary.$keys.set(kept, "kept");

  // A for-in started, its first name read, and left: its names stay for the next to keep its order.
  const first = rt.hasNext(dictionary, 0);
  assert.ok(first > 0);
  assert.equal(typeof rt.nextName(dictionary, first), "object");

  await collect();
  assert.equal((gone as WeakRef<object> | null)?.deref(), undefined);

  // The next for-in finds the one left, by itself.
  const names: unknown[] = [];
  for (let i = rt.hasNext(dictionary, 0); i; i = rt.hasNext(dictionary, i)) {
    names.push(rt.nextName(dictionary, i));
  }

  assert.deepEqual(names, [kept]);
  assert.equal(rt.nextValue(dictionary, rt.hasNext(dictionary, 0)), "kept");
});
