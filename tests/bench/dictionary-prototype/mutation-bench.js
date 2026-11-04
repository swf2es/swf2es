const { Avm2Dictionary } = await import(process.env.DICTIONARY_MODULE ?? "./dictionary.js");

const results = [];
let checksum = 0;
const size = 1000;
const rounds = 200;
function drainIterator(dictionary, keys) {
  for (let i = 0; i < keys.length; i++) {
    dictionary.set(keys[i], i);
  }
  let n = 0;
  for (const key of dictionary.keys()) {
    dictionary.delete(key);
    n++;
  }
  return n;
}
function drainCursor(dictionary, keys) {
  for (let i = 0; i < keys.length; i++) {
    dictionary.set(keys[i], i);
  }
  let n = 0;
  for (let i = dictionary.nextNameIndex(0); i; i = dictionary.nextNameIndex(i)) {
    dictionary.delete(dictionary.nextName(i));
    n++;
  }
  return n;
}
function measure(name, action, dictionary, keys) {
  if (action(dictionary, keys) !== size) {
    throw new Error("incorrect drain count");
  }
  for (let i = 0; i < rounds / 10; i++) {
    checksum += action(dictionary, keys);
  }
  const start = performance.now();
  for (let i = 0; i < rounds; i++) {
    checksum += action(dictionary, keys);
  }
  results.push({ name, ms: performance.now() - start });
  if (dictionary.size !== 0) {
    throw new Error("dictionary was not emptied");
  }
}
const mapOnly = process.argv.includes("--map");
const cases = mapOnly ? [false] : [false, true];
for (const weak of process.argv.includes("--reverse") ? cases.reverse() : cases) {
  const keys = Array.from({ length: size }, (_, id) => ({ id }));
  const label = `${weak ? "weak" : "strong"}${size}`;
  if (mapOnly) {
    measure("map1000-drain", drainIterator, new Map(), keys);
  } else {
    measure(`${label}-drain-iterator`, drainIterator, new Avm2Dictionary(weak), keys);
    measure(`${label}-drain-cursor`, drainCursor, new Avm2Dictionary(weak), keys);
  }
  if (keys.length !== size || keys[0].id !== 0) {
    throw new Error("keys must stay live");
  }
}
console.log(JSON.stringify({ results, checksum }));
