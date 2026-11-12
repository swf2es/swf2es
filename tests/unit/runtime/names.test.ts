import assert from "node:assert/strict";
import { test } from "node:test";
import { AIR_API_VERSION, API_VERSION } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { DictionaryKeys } from "../../../packages/runtime/dist/avm2/dictionary-keys.js";
import {
  CONSTANT_MultinameL,
  CONSTANT_MultinameLA,
  CONSTANT_RTQnameL,
  MADE_Unknown,
  MADE_Value,
  Multiname,
} from "../../../packages/runtime/dist/avm2/names.js";
import { NO_CACHE } from "../../../packages/runtime/dist/avm2/property-cache.js";

test("repeated string names keep bindings, not values, and release them on invalidation", () => {
  const rt = avm2.createRuntime();
  const base = rt.name([avm2.publicNs], [255], CONSTANT_MultinameL, [0], null);
  const o = rt.objectTraits.instance();
  const name = rt.runtimeName(base, "value");
  rt.setProperty(o, name, 11);
  assert.equal(rt.getProperty(o, rt.runtimeName(base, "value")), 11);
  rt.setProperty(o, name, 23);
  assert.equal(rt.getProperty(o, rt.runtimeName(base, "value")), 23);
  assert.equal(rt.deleteProperty(o, name), true);
  assert.equal(rt.getProperty(o, rt.runtimeName(base, "value")), undefined);
  rt.forgetCaches();
  assert.notEqual(rt.runtimeName(base, "value"), name);
  assert.equal(rt.getProperty(o, rt.runtimeName(base, "value")), undefined);
});

test("distinct or long string keys do not create unbounded retained lookup caches", () => {
  const rt = avm2.createRuntime();
  const base = rt.name([avm2.publicNs], [255], CONSTANT_MultinameL, [0], null);
  const retained = [];
  for (let i = 0; i < 1000; i++) {
    const name = rt.runtimeName(base, `key${i}`);
    if (name.cache !== NO_CACHE) {
      retained.push(name);
    }
  }

  assert.equal(retained.length, 64);
  assert.equal(rt.runtimeName(base, "key0").cache, NO_CACHE);
  assert.equal(rt.runtimeName(base, "x".repeat(129)).cache, NO_CACHE);
  assert.equal(rt.runtimeName(base, 42).cache, NO_CACHE);
  rt.forgetCaches();
  assert.notEqual(rt.runtimeName(base, "key0").cache, NO_CACHE);
});

test("cached string names keep their template's namespace and attribute restrictions", () => {
  const rt = avm2.createRuntime();
  const o = rt.objectTraits.instance();
  const publicBase = rt.name([avm2.publicNs], [255], CONSTANT_MultinameL, [0], null);
  rt.setProperty(o, rt.runtimeName(publicBase, "value"), 11);
  const privateBase = rt.name([rt.privateNs("hidden")], [255], CONSTANT_MultinameL, [0], null);
  const attributeBase = rt.name([avm2.publicNs], [255], CONSTANT_MultinameLA, [0], null);
  for (let i = 0; i < 3; i++) {
    assert.equal(rt.getProperty(o, rt.runtimeName(publicBase, "value")), 11);
    assert.throws(() => rt.getProperty(o, rt.runtimeName(privateBase, "value")));
    assert.throws(() => rt.getProperty(o, rt.runtimeName(attributeBase, "value")));
  }
});

test("indexed access respects namespaces and attributes, including resolved runtime namespaces", () => {
  const rt = avm2.createRuntime();
  const o = rt.objectTraits.instance();
  o.$a = [7];
  const hidden = rt.privateNs("hidden");
  const qualified = rt.ns(0, "qualified");
  const runtime = new Multiname(CONSTANT_RTQnameL, [], [], null, false);
  const publicName = rt.runtimeName(runtime, avm2.publicNs, 0);
  rt.setIndexed(o, publicName, 0, 11);
  assert.equal(rt.getIndexed(o, publicName, 0), 11);

  for (const namespaces of [[null], [hidden], [qualified], []]) {
    const name = new Multiname(
      CONSTANT_MultinameL,
      namespaces,
      namespaces.map(() => 255),
      null,
      false,
    );
    assert.throws(() => rt.getIndexed(o, name, 0));
    assert.throws(() => rt.setIndexed(o, name, 0, 99));
    assert.deepEqual(o.$a, [11]);
  }

  const attribute = new Multiname(CONSTANT_MultinameL, [avm2.publicNs], [255], null, true);
  const privateName = rt.runtimeName(runtime, hidden, 0);
  for (const name of [attribute, privateName]) {
    assert.throws(() => rt.getIndexed(o, name, 0));
    assert.throws(() => rt.setIndexed(o, name, 0, 99));
    assert.deepEqual(o.$a, [11]);
  }
});

test("a key of unknown type is an index, a Dictionary's key or a name by what it is", () => {
  const rt = avm2.createRuntime();
  const base = rt.name([avm2.publicNs], [255], CONSTANT_MultinameL, [0], null);
  const array = rt.objectTraits.instance();
  array.$a = [7, 8];
  assert.equal(rt.getKeyed(array, base, 1), 8);
  assert.equal(rt.getKeyed(array, base, "1"), 8);
  rt.setKeyed(array, base, 3, 9);
  assert.equal(array.$a.length, 4);
  assert.equal(array.$a[3], 9);
  assert.equal(2 in array.$a, false);
  rt.setKeyed(array, base, 1.5, "half");
  assert.equal(array.$d.get("1.5"), "half");
  assert.equal(rt.getKeyed(array, base, 1.5), "half");

  // A number on an object with no elements is its dynamic property, by the number's string.
  const plain = rt.objectTraits.instance();
  rt.setKeyed(plain, base, 4278392, "handle");
  assert.equal(plain.$d.get("4278392"), "handle");
  assert.equal(rt.getKeyed(plain, base, 4278392), "handle");
  assert.equal(rt.getKeyed(plain, base, "4278392"), "handle");
  assert.equal(rt.getKeyed(plain, base, 5), undefined);

  // An object keys a Dictionary by itself: another object is another key.
  const dictionary = rt.objectTraits.instance();
  dictionary.$keys = new DictionaryKeys(false);
  const key = rt.objectTraits.instance();
  const twin = rt.objectTraits.instance();
  rt.setKeyed(dictionary, base, key, "first");
  assert.equal(dictionary.$keys.get(key), "first");
  assert.equal(dictionary.$d.size, 0);
  rt.setKeyed(dictionary, base, key, "second");
  assert.equal(rt.getKeyed(dictionary, base, key), "second");
  assert.equal(rt.getKeyed(dictionary, base, twin), undefined);
  assert.equal(dictionary.$keys.size, 1);

  // A name with no public namespace is no index.
  const hidden = new Multiname(CONSTANT_MultinameL, [rt.privateNs("hidden")], [255], null, false);
  assert.throws(() => rt.getKeyed(array, hidden, 1));
  assert.equal(dictionary.$keys.get(key), "second");
});

test("a name made at run time records whether a number or another value made it", () => {
  const rt = avm2.createRuntime();
  const base = rt.name([avm2.publicNs], [255], CONSTANT_MultinameL, [0], null);
  assert.equal(base.made, MADE_Unknown);
  assert.equal(rt.runtimeName(base, "0").made, MADE_Value);
  assert.equal(rt.runtimeName(base, "x".repeat(129)).made, MADE_Value);
  assert.equal(rt.runtimeName(base, {}).made, MADE_Value);
  assert.equal(rt.runtimeName(base, true).made, MADE_Value);
  // A number's own name is told by its string: only an element's read or write says it was one.
  assert.equal(rt.runtimeName(base, 0).made, MADE_Unknown);
});

test("determining an indexed name leaves an object key's string conversion deferred", () => {
  let conversions = 0;
  const key = {};
  const name = Multiname.keyed(CONSTANT_MultinameL, [avm2.publicNs], [255], key, false, () => {
    conversions++;
    return "key";
  });
  assert.equal(name.elementName, true);
  assert.equal(name.key, key);
  assert.equal(conversions, 0);
  assert.equal(name.name, "key");
  assert.equal(name.name, "key");
  assert.equal(conversions, 1);
});

test("a runtime runs only at an API version ABCs run at, and makes its names at it", () => {
  for (const apiVersion of [0, 52, 256 + API_VERSION, 1.5]) {
    assert.throws(() => avm2.createRuntime({ apiVersion }), RangeError, `${apiVersion}`);
  }

  const rt = avm2.createRuntime({ apiVersion: AIR_API_VERSION });
  assert.deepEqual(
    [rt.apiVersion, rt.userVersions, rt.toJSONName.versions],
    [AIR_API_VERSION, [AIR_API_VERSION], [AIR_API_VERSION]],
  );
  assert.equal(avm2.createRuntime().apiVersion, API_VERSION);
});
