// biome-ignore-all lint/suspicious/noPrototypeBuiltins: These adapters exercise the AS3-shaped API.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const source = read("scenarios.as");
const fixture = JSON.parse(read("reference.json"));
assert.equal(
  digest(read("oracle-adapter.as") + source),
  fixture.sourceSha256,
  "Reference source changed; regenerate the Adobe results with oracle.ts",
);

function matches(expected, actual) {
  return typeof expected === "string"
    ? expected === actual
    : expected.sha256 === digest(actual) && expected.length === actual.length;
}

for (const cursor of [false, true]) {
  const { Avm2Dictionary } = await import(`./dictionary.js?${cursor ? "cursor" : "iterator"}`);
  const lines = [];
  const walk = (dictionary, action, values) => {
    if (cursor) {
      for (let i = dictionary.nextNameIndex(0); i; i = dictionary.nextNameIndex(i)) {
        if (action(values ? dictionary.nextValue(i) : dictionary.nextName(i)) === false) {
          break;
        }
      }
    } else {
      for (const value of values ? dictionary.values() : dictionary.keys()) {
        if (action(value) === false) {
          break;
        }
      }
    }
  };
  runInNewContext(
    source.replaceAll("catch (error:*)", "catch (error)"),
    {
      makeDictionary: (weak) => new Avm2Dictionary(weak),
      put: (dictionary, key, value) => {
        dictionary.set(key, value);
      },
      read: (dictionary, key) => dictionary.get(key),
      remove: (dictionary, key) => dictionary.delete(key),
      member: (dictionary, key) => dictionary.has(key),
      own: (dictionary, key) => dictionary.hasOwnProperty(key),
      enumerable: (dictionary, key) => dictionary.propertyIsEnumerable(key),
      hide: (dictionary, key, flag) => dictionary.setPropertyIsEnumerable(key, flag),
      walk: (dictionary, action) => walk(dictionary, action, false),
      walkValues: (dictionary, action) => walk(dictionary, action, true),
      emit: (line) => lines.push(line),
    },
    { timeout: 10000 },
  );
  const records = new Map(
    lines
      .filter((line) => !line.startsWith("total\t"))
      .map((line) => {
        const [category, name, ...rest] = line.split("\t");
        return [name, { category, result: rest.join("\t") }];
      }),
  );
  const count = Object.keys(fixture.stable).length + Object.keys(fixture.layout).length;
  assert.equal(records.size, count);
  assert.equal(lines.at(-1), `total\t${count}`);
  for (const [name, expected] of Object.entries(fixture.stable)) {
    const actual = records.get(name);
    assert.equal(actual?.category, "stable", name);
    assert.ok(matches(expected, actual.result), `${name}: ${actual.result}`);
  }
  const differences = { avmshell: 0, adl: 0 };
  for (const [name, expected] of Object.entries(fixture.layout)) {
    const actual = records.get(name);
    assert.equal(actual?.category, "layout", name);
    const [visits, final] = actual.result.split(";final=");
    assert.ok(matches(expected.final, final), `${name}: wrong final dictionary contents`);
    for (const engine of ["avmshell", "adl"]) {
      if (!expected.visits[engine].includes(visits)) {
        differences[engine]++;
      }
    }
  }
  console.log(
    `${cursor ? "cursor" : "iterator"}: ${Object.keys(fixture.stable).length} stable matches, ` +
      `${Object.keys(fixture.layout).length} final-content matches; known visit-count differences ` +
      `avmshell=${differences.avmshell}, ADL=${differences.adl}`,
  );
}
