// A weak-keyed Dictionary keeps no key alive, as Flash's does not, though a
// for-in over it has started and been left off; avmshell's output cannot
// show what its collector frees, so this collects in node.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { avm2 } from "@swf2es/runtime";
import { DictionaryKeys } from "../../../packages/runtime/dist/avm2/dictionary-keys.js";

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
  const keys = new DictionaryKeys(true);
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

  // Deleted, and set again before a for-in gave it a slot: back in its place.
  assert.equal(keys.delete(kept[0]), true);
  assert.equal(keys.delete(kept[0]), false);
  assert.deepEqual([...keys.keys()], [kept[1]]);
  keys.set(kept[0], "again");
  assert.deepEqual(
    [...keys],
    [
      [kept[0], "again"],
      [kept[1], "last"],
    ],
  );
});

test("a for-in left off over a weak Dictionary keeps none of its keys alive", async () => {
  const rt = avm2.createRuntime();
  const dictionary = { $keys: new DictionaryKeys(true) } as unknown as avm2.AsObject;
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

test("a value that refers to its own weak key does not keep the key", async () => {
  const keys = new DictionaryKeys(true);
  let gone: WeakRef<object> | null = null;
  (() => {
    const key = {};
    gone = new WeakRef(key);
    keys.set(key, { key });
  })();

  await collect();
  assert.equal((gone as WeakRef<object> | null)?.deref(), undefined);
  assert.equal(keys.size, 0);
});

test("a Dictionary filled and drained over and over keeps only as many slots as keys at once", () => {
  const rt = avm2.createRuntime();
  for (const keys of [new DictionaryKeys(false), new DictionaryKeys(true)]) {
    const dictionary = { $keys: keys } as unknown as avm2.AsObject;
    const held = Array.from({ length: 100 }, (_, i) => ({ i }));
    for (let round = 0; round < 50; round++) {
      for (const key of held) {
        keys.set(key, round);
      }

      let walked = 0;
      for (let i = rt.hasNext(dictionary, 0); i; i = rt.hasNext(dictionary, i)) {
        keys.delete(rt.nextName(dictionary, i) as object);
        walked++;
      }

      assert.equal(walked, 100);
    }

    assert.equal((keys as unknown as { slots: unknown[] }).slots.length, 100);
  }
});

/** The names and values a for-in over `dictionary` goes through. */
function walk(rt: avm2.Runtime, dictionary: avm2.AsObject): [unknown, unknown][] {
  const met: [unknown, unknown][] = [];
  for (let i = rt.hasNext(dictionary, 0); i; i = rt.hasNext(dictionary, i)) {
    met.push([rt.nextName(dictionary, i), rt.nextValue(dictionary, i)]);
  }

  return met;
}

test("a weak Dictionary's walks read each key's WeakRef once a job, and keep no key past it", async () => {
  const rt = avm2.createRuntime();
  const keys = new DictionaryKeys(true);
  const dictionary = { $keys: keys } as unknown as avm2.AsObject;
  const kept = Array.from({ length: 50 }, (_, i) => ({ kept: i }));
  const gone: WeakRef<object>[] = [];
  (() => {
    for (let i = 0; i < 50; i++) {
      const key = { gone: i };
      gone.push(new WeakRef(key));
      keys.set(key, -1 - i);
      keys.set(kept[i], i);
    }
  })();

  // Counted on the prototype: the slots' WeakRefs are the only ones read here.
  const deref = WeakRef.prototype.deref;
  let reads = 0;
  WeakRef.prototype.deref = function (this: WeakRef<object>) {
    reads++;
    return deref.call(this);
  };

  // In a function, so that the names it met are held by nothing after it.
  const walks = () => {
    const first = walk(rt, dictionary);
    const settled = reads;
    assert.equal(first.length, 100);

    // The step's name and value, and the walks after it in the job, read none again.
    reads = 0;
    assert.deepEqual(walk(rt, dictionary), first);
    assert.equal(rt.nextValue(dictionary, rt.hasNext(dictionary, 0)), -1);
    assert.equal(reads, 0);
    assert.ok(settled <= 200, `${settled} reads to give 100 keys their slots and walk them`);

    // A walk left off part-way, as one that breaks.
    rt.hasNext(dictionary, rt.hasNext(dictionary, 0));
  };

  try {
    walks();
  } finally {
    WeakRef.prototype.deref = deref;
  }

  await collect();
  assert.equal((keys as unknown as { opened: unknown }).opened, null);
  assert.equal(
    gone.filter((ref) => ref.deref() !== undefined).length,
    0,
    "keys walked in a job that is over are collected",
  );
  assert.deepEqual(
    walk(rt, dictionary),
    kept.map((key, i) => [key, i]),
  );

  // Their slots are free for keys added then, which the walk in that job goes through.
  const later = Array.from({ length: 60 }, (_, i) => ({ later: i }));
  for (let i = 0; i < later.length; i++) {
    keys.set(later[i], `later ${i}`);
  }

  const names = walk(rt, dictionary).map(([name]) => name);
  assert.equal(names.length, 110);
  assert.deepEqual(new Set(names), new Set([...kept, ...later]));
  assert.equal((keys as unknown as { slots: unknown[] }).slots.length, 110);
});

test("a weak Dictionary's walks go as a strong one's through sets, deletes and nested walks", async () => {
  const rt = avm2.createRuntime();
  // Deterministic: a failure names the step it came to.
  let seed = 1;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };

  const held = Array.from({ length: 40 }, (_, i) => ({ i }));
  const dictionaries = [false, true].map(
    (weak) => ({ $keys: new DictionaryKeys(weak) }) as unknown as avm2.AsObject,
  );

  /** A walk, with now and then a change or a walk inside between its steps. */
  const steps = (dictionary: avm2.AsObject, log: unknown[], depth: number): void => {
    for (let i = rt.hasNext(dictionary, 0); i; i = rt.hasNext(dictionary, i)) {
      log.push(rt.nextName(dictionary, i));
      switch (random(7)) {
        case 0:
          dictionary.$keys.delete(held[random(held.length)]);
          break;
        case 1:
          dictionary.$keys.set(held[random(held.length)], random(1000));
          break;
        case 2:
          if (depth < 2) {
            steps(dictionary, log, depth + 1);
          }

          break;
        case 3:
          dictionary.$keys.delete(rt.nextName(dictionary, i) as object);
          break;
        default:
          break;
      }

      // After a change, as a deleted key's name and value read back.
      log.push(rt.nextName(dictionary, i), rt.nextValue(dictionary, i));
    }
  };

  for (let round = 0; round < 60; round++) {
    const from = seed;
    const logs = dictionaries.map((dictionary) => {
      seed = from;
      const log: unknown[] = [];
      for (let n = random(30); n > 0; n--) {
        dictionary.$keys.set(held[random(held.length)], random(1000));
      }

      steps(dictionary, log, 0);
      log.push([...dictionary.$keys]);
      return log;
    });

    assert.deepEqual(logs[1], logs[0], `round ${round}, seed ${from}`);

    // Some rounds in one job, some in a job of their own.
    if (round % 3 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
});
