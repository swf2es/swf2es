import assert from "node:assert/strict";
import { test } from "node:test";
import { AIR_API_VERSION, API_VERSION } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import {
  CONSTANT_MultinameL,
  CONSTANT_RTQnameL,
  Multiname,
} from "../../../packages/runtime/dist/avm2/names.js";

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
