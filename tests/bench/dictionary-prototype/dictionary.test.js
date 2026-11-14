// biome-ignore-all lint/suspicious/noPrototypeBuiltins: These tests exercise the AS3-shaped API.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Avm2Dictionary } from "./dictionary.js";

async function collect() {
  assert.equal(typeof global.gc, "function", "run with --expose-gc");
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
  }
}

for (const weak of [false, true]) {
  test(`trim preserves live entries and permits deletion/reinsertion (weak=${weak})`, () => {
    const dictionary = new Avm2Dictionary(weak);
    const keys = Array.from({ length: 1000 }, (_, id) => ({ id }));
    for (const key of keys) {
      dictionary.set(key, key.id);
    }
    for (let i = 0; i < 900; i++) {
      dictionary.delete(keys[i]);
    }
    dictionary.set("name", undefined);
    assert.equal(dictionary.trim(), dictionary);
    assert.equal(dictionary.size, 101);
    for (let i = 900; i < 1000; i++) {
      assert.equal(dictionary.get(keys[i]), i);
    }
    assert.equal(dictionary.containsKey("name"), true);
    assert.equal(dictionary.get("name"), undefined);
    const entries = [...dictionary.entries()];
    assert.equal(entries.length, 101);
    assert.equal(new Set(entries.map(([key]) => key)).size, 101);
    for (const [key] of entries) {
      dictionary.delete(key);
    }
    dictionary.trim();
    assert.equal(dictionary.size, 0);
    assert.deepEqual([...dictionary], []);
    dictionary.set(keys[0], 7);
    assert.equal(dictionary.get(keys[0]), 7);
    assert.deepEqual([...dictionary.keys()], [keys[0]]);
  });

  test(`identity, coercion, undefined and named keys (weak=${weak})`, () => {
    const d = new Avm2Dictionary(weak);
    let calls = 0;
    const a = {
      toString() {
        calls++;
        return "same";
      },
    };
    const b = {
      toString() {
        throw new Error("coerced");
      },
    };
    const fn = () => 1;
    d.set(a, undefined).set(b, 2).set(fn, 3).set("same", 9);
    assert.equal(d.get(a), undefined);
    assert.equal(d.containsKey(a), true);
    assert.equal(d.has(a), true);
    assert.equal(d.get(b), 2);
    assert.equal(d.get(fn), 3);
    assert.equal(calls, 0);
    assert.equal(d.hasOwnProperty(a), true);
    assert.equal(calls, 1);
    assert.throws(() => d.hasOwnProperty(b), /coerced/);
    assert.equal(d.delete(b), true);
    assert.equal(d.delete(b), true);
    assert.equal(d.get(b), undefined);
    assert.throws(() => d.has(b), /coerced/);
    for (const [key, name] of [
      [1, "1"],
      [true, "true"],
      [null, "null"],
      [undefined, "undefined"],
    ]) {
      d.set(key, name);
      assert.equal(d.get(name), name);
    }
    assert.equal(d.delete(1), true);
    assert.equal(d.get("1"), undefined);
    d.set("hidden", 1);
    d.setPropertyIsEnumerable("hidden", false);
    assert.equal([...d.keys()].includes("hidden"), true);
    d.delete("hidden");
    d.set("hidden", 2);
    assert.equal(d.propertyIsEnumerable("hidden"), true);
  });

  test(`reinsertion and nested walk use shared slots (weak=${weak})`, () => {
    for (const nested of [false, true]) {
      const d = new Avm2Dictionary(weak);
      const key = {};
      d.set(key, 1);
      let outer = 0;
      let inner = 0;
      for (const k of d.keys()) {
        assert.equal(k, key);
        outer++;
        if (outer === 1) {
          d.delete(k);
          d.set(k, 2);
          if (nested) {
            for (const _ignored of d.keys()) {
              inner++;
            }
          }
        }
        assert.ok(outer < 5);
      }
      assert.equal(outer, nested ? 1 : 2);
      assert.equal(inner, nested ? 1 : 0);
    }
  });

  test(`deleting current and future keys, and reading updated values (weak=${weak})`, () => {
    const d = new Avm2Dictionary(weak);
    const held = Array.from({ length: 100 }, (_, id) => ({ id }));
    for (const key of held) {
      d.set(key, key.id);
    }
    let count = 0;
    for (const key of d.keys()) {
      count++;
      d.delete(key);
    }
    assert.equal(count, 100);
    assert.equal(d.size, 0);
    for (const key of held) {
      d.set(key, key.id);
    }
    count = 0;
    for (const key of d.keys()) {
      count++;
      for (const other of held) {
        if (other !== key) {
          d.delete(other);
        }
      }
    }
    assert.equal(count, 1);
    d.set(held[0], 1);
    const index = d.nextNameIndex(0);
    const key = d.nextName(index);
    d.set(key, 123);
    assert.equal(d.nextValue(index), 123);
  });
}

test("an absent object key checks only the prototype after coercion", () => {
  const proto = Object.create(Avm2Dictionary.prototypeProperties);
  proto.inherited = 8;
  const d = new Avm2Dictionary(false, proto);
  const key = { toString: () => "inherited" };
  assert.equal(d.has(key), true);
  assert.equal(d.get(key), undefined);
  const own = { toString: () => "own" };
  d.set("own", 3);
  assert.equal(d.has(own), false);
  assert.equal(d.has("own"), true);
});

test("Dictionary visibility changes are ignored after property-name coercion", () => {
  const dictionary = new Avm2Dictionary();
  dictionary.set("name", 1);
  let calls = 0;
  const key = {
    toString() {
      calls++;
      return "name";
    },
  };
  dictionary.setPropertyIsEnumerable(key, false);
  assert.equal(calls, 1);
  assert.equal(dictionary.propertyIsEnumerable("name"), true);
  assert.deepEqual([...dictionary.keys()], ["name"]);
  assert.throws(
    () =>
      dictionary.setPropertyIsEnumerable(
        {
          toString() {
            throw new Error("coercion");
          },
        },
        false,
      ),
    /coercion/,
  );
});

test("numeric names match the 29-bit enumeration boundary", () => {
  const d = new Avm2Dictionary();
  for (const key of ["0", "1", "01", "268435455", "268435456", "4294967295"]) {
    d.set(key, 1);
  }
  const names = [...d.keys()];
  assert.ok(names.includes(0));
  assert.ok(names.includes(1));
  assert.ok(names.includes(268435455));
  assert.ok(names.includes("01"));
  assert.ok(names.includes("268435456"));
});

test("unfinished key/value/entry iterators do not retain weak self-referencing values", async () => {
  assert.equal(typeof global.gc, "function", "run with --expose-gc");
  for (const mode of ["keys", "values", "entries"]) {
    const d = new Avm2Dictionary(true);
    let reference;
    const iterator = (() => {
      const key = {};
      reference = new WeakRef(key);
      d.set(key, { key });
      const it = d[mode]();
      it.next();
      return it;
    })();
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      global.gc();
    }
    assert.equal(reference.deref(), undefined, mode);
    assert.equal(d.size, 0);
    assert.equal(iterator.next().done, true);
  }
});

test("numeric cursors and nested unfinished walks do not retain weak records", async () => {
  const dictionary = new Avm2Dictionary(true);
  const references = [];
  const iterators = [];
  const cursor = (() => {
    for (let i = 0; i < 33; i++) {
      const key = { id: i };
      dictionary.set(key, { key });
      references.push(new WeakRef(key));
    }
    for (const mode of ["keys", "values", "entries"]) {
      const iterator = dictionary[mode]();
      iterator.next();
      iterators.push(iterator);
    }
    const index = dictionary.nextNameIndex(0);
    dictionary.nextName(index);
    dictionary.nextValue(index);
    return index;
  })();
  await collect();
  for (const reference of references) {
    assert.equal(reference.deref(), undefined);
  }
  assert.equal(dictionary.nextName(cursor), undefined);
  assert.equal(dictionary.nextValue(cursor), undefined);
  assert.equal(dictionary.nextNameIndex(cursor), 0);
  assert.equal(dictionary.size, 0);
  for (const iterator of iterators) {
    assert.equal(iterator.next().done, true);
  }
});

for (const weak of [false, true]) {
  test(`deleting an entry releases key and value with unfinished iterators (weak=${weak})`, async () => {
    for (const mode of ["keys", "values", "entries"]) {
      const dictionary = new Avm2Dictionary(weak);
      let keyReference;
      let valueReference;
      const iterator = (() => {
        const key = {};
        const value = { key };
        keyReference = new WeakRef(key);
        valueReference = new WeakRef(value);
        dictionary.set(key, value);
        const iterator = dictionary[mode]();
        iterator.next();
        dictionary.delete(key);
        return iterator;
      })();
      await collect();
      assert.equal(keyReference.deref(), undefined, mode);
      assert.equal(valueReference.deref(), undefined, mode);
      assert.equal(iterator.next().done, true);
    }
  });
}

test("returning an iterator releases its dictionary", async () => {
  for (const mode of ["keys", "values", "entries"]) {
    let reference;
    const iterator = (() => {
      const dictionary = new Avm2Dictionary();
      dictionary.set({}, 1);
      reference = new WeakRef(dictionary);
      const iterator = dictionary[mode]();
      iterator.next();
      iterator.return();
      return iterator;
    })();
    await collect();
    assert.equal(reference.deref(), undefined, mode);
    assert.equal(iterator.next().done, true);
  }
});

test("growth prunes dead weak records before adding a live entry", async () => {
  const dictionary = new Avm2Dictionary(true);
  (() => {
    for (let i = 0; i < 23; i++) {
      const key = {};
      dictionary.set(key, { key });
    }
  })();
  await collect();
  const key = {};
  dictionary.set(key, 1);
  assert.equal(dictionary.size, 1);
  assert.deepEqual([...dictionary.keys()], [key]);
  assert.equal(dictionary.get(key), 1);
});

test("deleted weak metadata releases values even when its key remains live", async () => {
  const dictionary = new Avm2Dictionary(true);
  const key = { id: 7 };
  const reference = (() => {
    const value = { key };
    dictionary.set(key, value);
    dictionary.delete(key);
    return new WeakRef(value);
  })();
  await collect();
  assert.equal(reference.deref(), undefined);
  assert.equal(dictionary.get(key), undefined);
  assert.equal(dictionary.containsKey(key), false);
  assert.equal(dictionary.has(key), false);
  dictionary.set(key, 123);
  assert.equal(dictionary.get(key), 123);
  assert.equal(dictionary.has(key), true);
  assert.deepEqual([...dictionary.keys()], [key]);
});

test("reinserted weak records belong to their own dictionaries", () => {
  const first = new Avm2Dictionary(true);
  const second = new Avm2Dictionary(true);
  const key = {};
  for (let i = 0; i < 100; i++) {
    first.set(key, i);
    second.set(key, i + 1000);
    first.delete(key);
    assert.equal(first.containsKey(key), false);
    assert.equal(second.get(key), i + 1000);
    assert.deepEqual([...first.keys()], []);
    assert.deepEqual([...second.keys()], [key]);
    second.delete(key);
    first.set(key, -i);
    assert.equal(first.get(key), -i);
  }
});

test("a strong named value keeps a weak key alive until the name is deleted", async () => {
  const dictionary = new Avm2Dictionary(true);
  const reference = (() => {
    const key = {};
    dictionary.set(key, { key });
    dictionary.set("root", { key });
    return new WeakRef(key);
  })();
  await collect();
  assert.notEqual(reference.deref(), undefined);
  assert.equal(dictionary.size, 2);
  dictionary.delete("root");
  await collect();
  assert.equal(reference.deref(), undefined);
  assert.equal(dictionary.size, 0);
});

test("a live weak key keeps its value and enumerable record alive", async () => {
  const dictionary = new Avm2Dictionary(true);
  const key = { id: 17 };
  const value = new WeakRef(
    (() => {
      const stored = { key, number: 23 };
      dictionary.set(key, stored);
      return stored;
    })(),
  );
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
  }
  assert.equal(dictionary.get(key), value.deref());
  assert.equal(dictionary.get(key).number, 23);
  assert.deepEqual([...dictionary.keys()], [key]);
  assert.equal([...dictionary.values()][0].key, key);
});

test("trim releases deleted values without losing weak live values", async () => {
  const dictionary = new Avm2Dictionary(true);
  const deleted = {};
  const kept = {};
  const reference = (() => {
    const value = { key: deleted };
    dictionary.set(deleted, value);
    dictionary.set(kept, { key: kept });
    dictionary.delete(deleted);
    dictionary.trim();
    return new WeakRef(value);
  })();
  await collect();
  assert.equal(reference.deref(), undefined);
  assert.equal(dictionary.containsKey(deleted), false);
  assert.equal(dictionary.get(kept).key, kept);
  assert.deepEqual([...dictionary.keys()], [kept]);
});

test("trim does not turn weak self-referencing values into GC roots", async () => {
  const dictionary = new Avm2Dictionary(true);
  const reference = (() => {
    const key = {};
    dictionary.set(key, { key });
    dictionary.trim();
    return new WeakRef(key);
  })();
  await collect();
  assert.equal(reference.deref(), undefined);
  dictionary.trim();
  assert.equal(dictionary.size, 0);
  assert.equal(dictionary.nextNameIndex(0), 0);
});

for (const weak of [false, true]) {
  test(`mixed-key randomized operations and complete walks (weak=${weak})`, () => {
    const dictionary = new Avm2Dictionary(weak);
    const reference = new Map();
    const keys = [
      undefined,
      null,
      false,
      true,
      NaN,
      -0,
      0,
      1,
      "1",
      "01",
      "",
      "null",
      "undefined",
      "true",
      "toString",
      "__proto__",
      Infinity,
      ...Array.from({ length: 150 }, (_, id) => ({ id })),
      () => 1,
    ];
    let state = 0x12345678;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    const normalize = (key) =>
      key !== null && (typeof key === "object" || typeof key === "function") ? key : String(key);
    const check = () => {
      assert.equal(dictionary.size, reference.size);
      const seen = new Set();
      for (const [key, value] of dictionary) {
        const normalized = normalize(key);
        assert.equal(seen.has(normalized), false);
        seen.add(normalized);
        assert.equal(reference.has(normalized), true);
        assert.equal(value, reference.get(normalized));
      }
      assert.equal(seen.size, reference.size);
    };
    for (let i = 0; i < 10000; i++) {
      const key = keys[random() % keys.length];
      const normalized = normalize(key);
      switch (random() % 4) {
        case 0: {
          const value = i % 7 ? i : undefined;
          dictionary.set(key, value);
          reference.set(normalized, value);
          break;
        }
        case 1:
          dictionary.delete(key);
          reference.delete(normalized);
          break;
        case 2:
          assert.equal(dictionary.containsKey(key), reference.has(normalized));
          break;
        default:
          if (reference.has(normalized)) {
            assert.equal(dictionary.get(key), reference.get(normalized));
          }
      }
      if (i % 113 === 0) {
        check();
      }
    }
    check();
  });
}
