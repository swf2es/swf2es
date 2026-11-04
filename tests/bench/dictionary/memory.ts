// What a Dictionary of 1,000 object keys keeps, in KiB of heap and ArrayBuffer
// storage above an empty one, collected between phases: filled, walked three
// times, emptied, walked again and its keys dropped; strong and weak keys,
// each Dictionary keyed by the same objects (shared) or by its own (unique).
// Snapshots are tests/programs/ab.ts's, from before dictionary-keys.ts too.
//
//   node tests/bench/dictionary/memory.ts <snapshot A> <snapshot B> [runs, 5] [copies, 100]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv[2] === "--child") {
  const dir = resolve(process.argv[3], "runtime/avm2");
  const { createRuntime } = await import(pathToFileURL(`${dir}/index.js`).href);
  const store = `${dir}/dictionary-keys.js`;
  const DictionaryKeys = existsSync(store)
    ? (await import(pathToFileURL(store).href)).DictionaryKeys
    : null;
  const { WeakKeys } = DictionaryKeys
    ? { WeakKeys: null }
    : await import(pathToFileURL(`${dir}/weak-keys.js`).href);
  const make = (weak: boolean) =>
    DictionaryKeys ? new DictionaryKeys(weak) : weak ? new WeakKeys() : new Map();
  const rt = createRuntime();
  const copies = Number(process.argv[6] ?? 100);
  const size = 1000;
  const unique = process.argv[5] === "unique";
  const keyCount = size * (unique ? copies : 1);
  let keys: { id: number }[] | null = null;
  const dictionaries = Array.from({ length: copies }, () => {
    const dictionary = rt.objectTraits.instance();
    dictionary.$keys = make(process.argv[4] === "weak");
    return dictionary;
  });
  const collect = async () => {
    for (let i = 0; i < 3; i++) {
      globalThis.gc?.();
      await new Promise((done) => setImmediate(done));
    }
  };
  const walk = (expected: number) => {
    for (let d = 0; d < copies; d++) {
      const dictionary = dictionaries[d];
      let count = 0;
      let sum = 0;
      for (let i = rt.hasNext(dictionary, 0); i; i = rt.hasNext(dictionary, i)) {
        sum += rt.nextValue(dictionary, i).key.id;
        count++;
      }

      assert.equal(count, expected);
      assert.equal(sum, expected ? (size * (size - 1)) / 2 + (unique ? d * size * size : 0) : 0);
    }
  };
  await collect();
  const retained = () => {
    const { heapUsed, arrayBuffers } = process.memoryUsage();
    return heapUsed + arrayBuffers;
  };
  const baseline = retained();
  const measure = () => (retained() - baseline) / copies / 1024;
  keys = Array.from({ length: keyCount }, (_, id) => ({ id }));
  for (let d = 0; d < copies; d++) {
    for (let k = 0; k < size; k++) {
      const key = keys[(unique ? d * size : 0) + k];
      dictionaries[d].$keys.set(key, { key });
    }
  }

  await collect();
  const populated = measure();
  walk(size);
  walk(size);
  walk(size);
  await collect();
  const walked = measure();
  for (let d = 0; d < copies; d++) {
    for (let k = 0; k < size; k++) {
      dictionaries[d].$keys.delete(keys[(unique ? d * size : 0) + k]);
    }
  }

  await collect();
  const deleted = measure();
  walk(0);
  await collect();
  const refreshed = measure();
  // Keep every external key observably live through the preceding measurements.
  assert.equal(new Set(keys).size, keyCount);
  keys = null;
  await collect();
  const droppedKeys = measure();
  assert.equal(dictionaries.length, copies);
  console.log(JSON.stringify({ populated, walked, deleted, refreshed, droppedKeys }));
} else {
  const [a, b, count, copies = "100"] = process.argv.slice(2);
  assert.ok(a && b, "provide two snapshot directories");
  const runs = Number(count ?? 5);
  const samples: Record<string, Record<string, number>[]> = {};
  for (let run = 0; run < runs; run++) {
    const builds = [
      ["A", a],
      ["B", b],
    ];
    for (const [name, dir] of run % 2 ? builds.reverse() : builds) {
      for (const strength of ["strong", "weak"]) {
        for (const identity of ["shared", "unique"]) {
          const result = execFileSync(
            process.execPath,
            [
              "--expose-gc",
              fileURLToPath(import.meta.url),
              "--child",
              dir,
              strength,
              identity,
              copies,
            ],
            { encoding: "utf8" },
          );
          const key = `${name}-${strength}-${identity}`;
          samples[key] ??= [];
          samples[key].push(JSON.parse(result));
        }
      }
    }
  }

  for (const [name, values] of Object.entries(samples)) {
    for (const phase of Object.keys(values[0])) {
      const sorted = values.map((value) => value[phase]).sort((x, y) => x - y);
      const mid = sorted.length >> 1;
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      console.log(
        `${name} ${phase}: ${median.toFixed(2)} KiB (${sorted[0].toFixed(2)}–${sorted.at(-1)?.toFixed(2)})`,
      );
    }
  }
}
