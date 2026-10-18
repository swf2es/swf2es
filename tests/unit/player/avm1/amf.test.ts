// AMF0 of AVM1's values in node: hostile bytes read back fail or end
// quickly, and the writer's remoting values stay bounded however long or
// deep a script makes them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DEPTH, Reader, Writer } from "../../../../packages/player/dist/avm1/amf.js";
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
