// AMF0 of AVM1's values in node: hostile bytes read back fail or end
// quickly, and the writer's remoting values stay bounded however long or
// deep a script makes them.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_DEPTH,
  MAX_VALUES,
  Reader,
  Writer,
} from "../../../../packages/player/dist/avm1/amf.js";
import { remotingValue } from "../../../../packages/player/dist/avm1/globals/NetConnection.js";
import { avm1 } from "../../../../packages/runtime/dist/index.js";

const rt = new avm1.Runtime();
const realm = rt.realm;
const h = (s: string) => Uint8Array.from(s.split(" ").map((x) => Number.parseInt(x, 16)));
const read = (bytes: Uint8Array) => new Reader(bytes, realm, 8).value();
const none = () => null;

test("bytes cut short, a marker it does not know and nesting past the bound are refused", () => {
  for (const bytes of [h("00 3f f0"), h("02 00 05 61 62"), h("03 00 01"), h("11"), h("07")]) {
    try {
      const v = read(bytes);
      // A reference to nothing reads as undefined.
      assert.equal(v, undefined);
    } catch (error) {
      assert.ok(error instanceof RangeError, String(error));
    }
  }

  // Strict arrays nested past the bound: refused, not a stack overflow.
  const deep = new Uint8Array((MAX_DEPTH + 10) * 5);
  for (let i = 0; i < MAX_DEPTH + 10; i++) {
    deep.set([0x0a, 0, 0, 0, 1], i * 5);
  }

  assert.throws(() => read(deep), RangeError);
});

test("a count past the bytes ends at their end at once", () => {
  const started = performance.now();
  assert.throws(() => read(h("0a ff ff ff ff 05")), RangeError);
  assert.throws(() => read(h("08 ff ff ff ff 00 01 61 05")), RangeError);
  assert.ok(performance.now() - started < 1000);
});

test("a boolean's byte and a date's timezone must be present", () => {
  assert.throws(() => read(h("01")), RangeError);
  assert.throws(() => read(h("0b 00 00 00 00 00 00 00 00")), RangeError);
  assert.throws(() => read(h("0b 00 00 00 00 00 00 00 00 00")), RangeError);
  assert.equal(read(h("01 00")), false);
  assert.ok(read(h("0b 00 00 00 00 00 00 00 00 00 00")) instanceof avm1.Avm1Object);
});

test("the reader bounds values across an object's entries and nested arrays", () => {
  // Repeated names keep the object small, while each value must still use its budget.
  const entries = new Uint8Array(1 + MAX_VALUES * 4 + 3);
  entries[0] = 0x03;
  for (let i = 0; i < MAX_VALUES; i++) {
    entries.set([0, 1, 97, 0x06], 1 + i * 4);
  }

  entries[entries.length - 1] = 0x09;
  assert.throws(() => read(entries), /AMF0 too many values/);

  const array = new Uint8Array(5);
  array[0] = 0x0a;
  new DataView(array.buffer).setUint32(1, MAX_VALUES);
  assert.throws(() => read(array), /AMF0 too many values/);

  const nested = new Uint8Array(10);
  nested.set([0x0a, 0, 0, 0, 1, 0x0a]);
  new DataView(nested.buffer).setUint32(6, MAX_VALUES - 1);
  assert.throws(() => read(nested), /AMF0 too many values/);
});

test("nested arrays share the writer's budget and keep their emitted counts", () => {
  const inner = realm.newArray([], 8);
  avm1.set(inner, "length", MAX_VALUES, 8);
  const outer = realm.newArray([inner], 8);
  avm1.set(outer, "length", MAX_VALUES, 8);
  const w = new Writer(none, 8, null, { xmlText: none, first: 0 });
  w.value(outer);
  const bytes = Buffer.concat(w.chunks);
  assert.ok(bytes.length <= MAX_VALUES + 10, String(bytes.length));
  assert.equal(bytes.readUInt32BE(1), 1);
  assert.equal(bytes.readUInt32BE(6), MAX_VALUES - 2);
});

test("properties spend the remaining writer budget, including getters written as undefined", () => {
  const array = realm.newArray([], 8);
  avm1.set(array, "length", MAX_VALUES - 3, 8);
  const o = realm.newObject(8);
  for (const key of ["a", "b", "c"]) {
    o.add(key, undefined, 0).get = realm.method(() => assert.fail("getter called"));
  }

  const w = new Writer(none, 8, null, { xmlText: none, first: 0 });
  w.value(array);
  const before = w.chunks.length;
  w.properties(o);
  const bytes = Buffer.concat(w.chunks.slice(before));
  assert.equal(bytes.length, 8);
  assert.equal(bytes[3], 0x06);
  assert.equal(bytes[7], 0x06);
});

test("the writer's depth limit alone produces a value the reader accepts", () => {
  let deep = realm.newObject(8);
  for (let i = 0; i < MAX_DEPTH + 10; i++) {
    const outer = realm.newObject(8);
    avm1.set(outer, "next", deep, 8);
    deep = outer;
  }

  const w = new Writer(none, 8, null, { xmlText: none, first: 0 });
  w.value(deep);
  assert.doesNotThrow(() => read(Buffer.concat(w.chunks)));
  assert.doesNotThrow(() => read(remotingValue([deep], none, 8, none, 1)));
});

test("the implicit call argument array shares the value budget with its arguments", () => {
  const array = realm.newArray([], 8);
  avm1.set(array, "length", MAX_VALUES, 8);
  const bytes = remotingValue([array, true], none, 8, none, 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(1), 1);
  assert.equal(view.getUint32(6), MAX_VALUES - 2);
});

test("a remoting value's huge length and deep nesting are written bounded, a cycle as a reference", () => {
  const a = realm.newArray([], 8);
  avm1.set(a, "length", 2147483647, 8);
  let deep = realm.newObject(8);
  for (let i = 0; i < 5000; i++) {
    const outer = realm.newObject(8);
    avm1.set(outer, "next", deep, 8);
    deep = outer;
  }

  const w = new Writer(none, 8, null, { xmlText: none, first: 1 });
  w.value(a);
  w.value(deep);
  assert.ok(w.size < 1.1 * 2 ** 20, String(w.size));

  const cyc = realm.newArray([1], 8);
  avm1.set(cyc, "1", cyc, 8);
  const c = new Writer(none, 8, null, { xmlText: none, first: 1 });
  c.value(cyc);
  const out = Buffer.concat(c.chunks).toString("hex");
  assert.equal(out, "0a00000002003ff0000000000000070001");
});
