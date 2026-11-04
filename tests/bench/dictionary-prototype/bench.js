const { Avm2Dictionary } = await import(process.env.DICTIONARY_MODULE ?? "./dictionary.js");

const sizes = [16, 32, 1000];
const results = [];
let checksum = 0;
function measure(name, rounds, action, expected) {
  if (action() !== expected) {
    throw new Error(`${name}: incorrect result`);
  }
  for (let i = 0; i < Math.max(100, rounds / 10); i++) {
    checksum += action();
  }
  const start = performance.now();
  for (let i = 0; i < rounds; i++) {
    checksum += action();
  }
  results.push({ name, ms: performance.now() - start });
}
function run(size, weak) {
  const keys = Array.from({ length: size }, (_, id) => ({ id }));
  const dictionary = new Avm2Dictionary(weak);
  const map = new Map();
  for (let i = 0; i < size; i++) {
    dictionary.set(keys[i], i);
    map.set(keys[i], i);
  }
  const rounds = size === 1000 ? 2000 : 100000;
  const label = `${weak ? "weak" : "strong"}${size}`;
  const sum = (size * (size - 1)) / 2;
  measure(
    `${label}-cursor-keys`,
    rounds,
    () => {
      let n = 0;
      for (let i = dictionary.nextNameIndex(0); i; i = dictionary.nextNameIndex(i)) {
        dictionary.nextName(i);
        n++;
      }
      return n;
    },
    size,
  );
  measure(
    `${label}-cursor-values`,
    rounds,
    () => {
      let n = 0;
      for (let i = dictionary.nextNameIndex(0); i; i = dictionary.nextNameIndex(i)) {
        dictionary.nextValue(i);
        n++;
      }
      return n;
    },
    size,
  );
  measure(
    `${label}-cursor-sum`,
    rounds,
    () => {
      let n = 0;
      for (let i = dictionary.nextNameIndex(0); i; i = dictionary.nextNameIndex(i)) {
        n += dictionary.nextValue(i);
      }
      return n;
    },
    sum,
  );
  measure(
    `${label}-iterator-keys`,
    rounds,
    () => {
      let n = 0;
      for (const _key of dictionary.keys()) {
        n++;
      }
      return n;
    },
    size,
  );
  measure(
    `${label}-iterator-values`,
    rounds,
    () => {
      let n = 0;
      for (const _value of dictionary.values()) {
        n++;
      }
      return n;
    },
    size,
  );
  measure(
    `${label}-sum-values`,
    rounds,
    () => {
      let n = 0;
      for (const value of dictionary.values()) {
        n += value;
      }
      return n;
    },
    sum,
  );
  measure(
    `${label}-map-keys`,
    rounds,
    () => {
      let n = 0;
      for (const _key of map.keys()) {
        n++;
      }
      return n;
    },
    size,
  );
  measure(
    `${label}-map-sum`,
    rounds,
    () => {
      let n = 0;
      for (const value of map.values()) {
        n += value;
      }
      return n;
    },
    sum,
  );
  if (keys.length !== size) {
    throw new Error("keys must stay strongly held");
  }
}
const cases = sizes.flatMap((size) => [false, true].map((weak) => [size, weak]));
for (const [size, weak] of process.argv.includes("--reverse") ? cases.reverse() : cases) {
  run(size, weak);
}
console.log(JSON.stringify({ results, checksum }));
