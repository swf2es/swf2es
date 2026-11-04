// A weak-keyed Dictionary keeps no key alive, as Flash's does not, though a
// for-in over it has started and been left off; avmshell's output cannot
// show what its collector frees, so this collects in node.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { avm2 } from "@swf2es/runtime";
import { DictionaryKeys } from "../../../packages/runtime/dist/avm2/dictionary-keys.js";
import { CONSTANT_MultinameL, Multiname } from "../../../packages/runtime/dist/avm2/names.js";
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

test("lookups and nested walks do not retain a weak key through its own value", async () => {
  const rt = avm2.createRuntime();
  const dictionary = rt.objectTraits.instance();
  dictionary.$keys = new WeakKeys();
  const name = new Multiname(CONSTANT_MultinameL, [avm2.publicNs], [255], null, false);
  let gone: WeakRef<object> | null = null;
  (() => {
    const key = {};
    gone = new WeakRef(key);
    rt.setProperty(dictionary, rt.runtimeName(name, key), undefined);
    assert.equal(rt.hasProperty(dictionary, rt.runtimeName(name, key)), true);
    const value = { key };
    rt.setProperty(dictionary, rt.runtimeName(name, key), value);
    assert.equal(rt.getProperty(dictionary, rt.runtimeName(name, key)), value);

    const outer = rt.hasNext(dictionary, 0);
    const inner = rt.hasNext(dictionary, 0);
    const another = rt.hasNext(dictionary, 0);
    assert.equal(rt.nextName(dictionary, outer), key);
    assert.equal(rt.nextValue(dictionary, inner), value);
    assert.equal(rt.nextName(dictionary, another), key);
  })();

  await collect();
  assert.equal((gone as WeakRef<object> | null)?.deref(), undefined);
  assert.equal(dictionary.$keys.size, 0);
  assert.equal(rt.hasNext(dictionary, 0), 0);
});

test("repeated Dictionary walks follow keyed writes, deletes and string-key transitions", () => {
  for (const weak of [false, true]) {
    const rt = avm2.createRuntime();
    const dictionary = rt.objectTraits.instance();
    dictionary.$keys = weak ? new WeakKeys() : new DictionaryKeys();
    const template = new Multiname(CONSTANT_MultinameL, [avm2.publicNs], [255], null, false);
    const name = (key: object) => rt.runtimeName(template, key);
    const a = {};
    const b = {};
    const c = {};
    const names = () => {
      const result: unknown[] = [];
      for (let i = rt.hasNext(dictionary, 0); i; i = rt.hasNext(dictionary, i)) {
        result.push(rt.nextName(dictionary, i));
      }

      return new Set(result);
    };

    rt.setProperty(dictionary, name(a), 1);
    rt.setProperty(dictionary, name(b), 2);
    assert.deepEqual(names(), new Set([a, b]));
    assert.deepEqual(names(), new Set([a, b]));

    rt.setProperty(dictionary, name(a), undefined);
    rt.deleteProperty(dictionary, name(b));
    rt.setProperty(dictionary, name(c), 3);
    assert.deepEqual(names(), new Set([a, c]));
    assert.equal(rt.hasProperty(dictionary, name(a)), true);

    const note = rt.publicName("note");
    rt.setProperty(dictionary, note, "text");
    assert.deepEqual(names(), new Set([a, c, "note"]));
    rt.deleteProperty(dictionary, note);
    assert.deepEqual(names(), new Set([a, c]));
    assert.deepEqual(names(), new Set([a, c]));

    rt.deleteProperty(dictionary, name(a));
    rt.deleteProperty(dictionary, name(c));
    assert.deepEqual(names(), new Set());
    assert.deepEqual(names(), new Set());
  }
});

test("a cached walk is local to its runtime and preserves deleted names until restart", () => {
  for (const keys of [new DictionaryKeys(), new WeakKeys()]) {
    const first = avm2.createRuntime();
    const second = avm2.createRuntime();
    const dictionary = { $keys: keys };
    const a = {};
    const b = {};
    keys.set(a, 1);
    keys.set(b, 2);
    const index = first.hasNext(dictionary, 0);
    assert.equal(first.nextName(dictionary, index), a);
    assert.equal(second.hasNext(dictionary, 0), index);

    keys.delete(a);
    assert.equal(first.nextName(dictionary, index), a);
    assert.equal(first.nextValue(dictionary, index), undefined);
    assert.equal(first.nextName(dictionary, first.hasNext(dictionary, index)), b);

    keys.set(a, 3);
    const found = new Set();
    for (let i = first.hasNext(dictionary, 0); i; i = first.hasNext(dictionary, i)) {
      found.add(first.nextName(dictionary, i));
    }

    assert.deepEqual(found, new Set([a, b]));
    assert.equal(second.nextName(dictionary, second.hasNext(dictionary, 0)), a);
  }
});

test("clearing a strong Dictionary invalidates an unfinished cached walk", () => {
  const rt = avm2.createRuntime();
  const keys = new DictionaryKeys();
  const dictionary = { $keys: keys };
  keys.set({}, 1).set({}, 2);
  const index = rt.hasNext(dictionary, 0);
  assert.ok(index > 0);
  keys.clear();
  assert.equal(rt.hasNext(dictionary, index), 0);
  assert.equal(rt.hasNext(dictionary, 0), 0);
});

test("weak keys and self-referencing values collect after repeated reinsertion", async () => {
  const dictionaries = [new WeakKeys(), new WeakKeys()];
  const kept = {};
  (() => {
    for (let i = 0; i < 3000; i++) {
      const key = {};
      for (const dictionary of dictionaries) {
        dictionary.set(key, { key });
        dictionary.delete(key);
        dictionary.set(key, { key });
      }
    }
  })();
  for (const dictionary of dictionaries) {
    dictionary.set(kept, "kept");
  }

  await collect();
  for (const dictionary of dictionaries) {
    assert.equal(dictionary.size, 1);
    assert.deepEqual([...dictionary.keys()], [kept]);
    assert.equal(dictionary.get(kept), "kept");
  }
});
