import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collect } from "./collect.js";
import { Avm2Dictionary } from "./dictionary.js";

const args = process.argv.slice(2);
const runtimeAt = args.indexOf("--runtime");
const runtimePath = runtimeAt < 0 ? null : resolve(args[runtimeAt + 1]);

async function backend() {
  if (runtimePath === null) {
    return Avm2Dictionary;
  }
  const { avm2 } = await import(pathToFileURL(`${runtimePath}/index.js`).href);
  const { WeakKeys } = await import(pathToFileURL(`${runtimePath}/avm2/weak-keys.js`).href);
  const runtime = avm2.createRuntime();
  return class RuntimeDictionary {
    #object;
    constructor(weak) {
      this.#object = runtime.objectTraits.instance();
      this.#object.$keys = weak ? new WeakKeys() : new Map();
      this.#object.$weakKeys = weak;
    }
    set(key, value) {
      this.#object.$keys.set(key, value);
    }
    get(key) {
      return this.#object.$keys.get(key);
    }
    delete(key) {
      return this.#object.$keys.delete(key);
    }
    nextNameIndex(index) {
      return runtime.hasNext(this.#object, index);
    }
    nextValue(index) {
      return runtime.nextValue(this.#object, index);
    }
  };
}

if (args[0] === "--child") {
  const Dictionary = await backend();
  const copies = 100;
  const size = 1000;
  let keys = Array.from({ length: size }, (_, id) => ({ id }));
  const dictionaries = Array.from({ length: copies }, () => new Dictionary(args[1] === "weak"));
  (() => {
    const warm = new Dictionary(args[1] === "weak");
    for (const key of keys) {
      warm.set(key, { key });
    }
    for (let i = warm.nextNameIndex(0); i; i = warm.nextNameIndex(i)) {
      warm.nextValue(i);
    }
  })();
  await collect();
  const baseline = process.memoryUsage().heapUsed;
  const heap = () => process.memoryUsage().heapUsed - baseline;
  function fill() {
    for (const dictionary of dictionaries) {
      for (const key of keys) {
        dictionary.set(key, { key });
      }
    }
  }
  function walk(expected) {
    for (const dictionary of dictionaries) {
      let count = 0;
      for (let i = dictionary.nextNameIndex(0); i; i = dictionary.nextNameIndex(i)) {
        const value = dictionary.nextValue(i);
        if (expected && (value.key.id < 0 || value.key.id >= size)) {
          throw new Error("wrong value");
        }
        count++;
      }
      if (count !== expected) {
        throw new Error("wrong entry count");
      }
    }
  }
  fill();
  await collect();
  const populated = heap();
  walk(size);
  await collect();
  const walked = heap();
  (() => {
    for (const dictionary of dictionaries) {
      for (const key of keys) {
        dictionary.delete(key);
      }
    }
  })();
  await collect();
  const deleted = heap();
  walk(0);
  await collect();
  const refreshed = heap();
  const trimmable = typeof dictionaries[0].trim === "function";
  if (trimmable) {
    for (const dictionary of dictionaries) {
      dictionary.trim();
    }
  }
  await collect();
  const trimmed = trimmable ? heap() : null;
  keys = null;
  await collect();
  const droppedKeys = heap();
  if (dictionaries.length !== copies) {
    throw new Error("dictionary roots lost");
  }
  console.log(
    JSON.stringify({
      strength: args[1],
      copies,
      size,
      populated,
      walked,
      deleted,
      refreshed,
      trimmed,
      droppedKeys,
    }),
  );
} else {
  const samples = [];
  const runs = Number(args[0] ?? 5);
  for (let run = 0; run < runs; run++) {
    for (const strength of run % 2 ? ["weak", "strong"] : ["strong", "weak"]) {
      samples.push(
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--expose-gc",
              fileURLToPath(import.meta.url),
              "--child",
              strength,
              ...(runtimePath === null ? [] : ["--runtime", runtimePath]),
            ],
            { encoding: "utf8" },
          ),
        ),
      );
    }
  }
  const out = new URL("out/", import.meta.url);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    new URL(runtimePath === null ? "memory.json" : "memory-runtime.json", out),
    JSON.stringify({ runtimePath, samples }, null, 2),
  );
  console.log(
    "Retained KiB per 1,000-entry dictionary: median (min–max), above the empty baseline.",
  );
  for (const strength of ["strong", "weak"]) {
    for (const field of ["populated", "walked", "deleted", "refreshed", "trimmed", "droppedKeys"]) {
      const values = samples
        .filter((sample) => sample.strength === strength && sample[field] !== null)
        .map((sample) => sample[field] / sample.copies / 1024)
        .sort((a, b) => a - b);
      if (!values.length) {
        continue;
      }
      const middle = values.length >> 1;
      const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
      console.log(
        `${strength}/${field}: ${median.toFixed(3)} (${values[0].toFixed(3)}–${values.at(-1).toFixed(3)})`,
      );
    }
  }
}
