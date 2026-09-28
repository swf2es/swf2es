import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";

test("int() and uint() coerce like AS3", () => {
  assert.equal(avm2.toInt(2 ** 31), -(2 ** 31));
  assert.equal(avm2.toInt("12.9"), 12);
  assert.equal(avm2.toInt(undefined), 0);
  assert.equal(avm2.toInt(NaN), 0);
  assert.equal(avm2.toUint(-1), 4294967295);
  assert.equal(avm2.toUint(null), 0);
});

/** An empty module's descriptor, compiled after `linked`. */
const module = (hash: string, linked: string[]) => ({
  hash,
  linked,
  names: [],
  classes: [],
  scripts: [],
  activations: [],
});

test("a module loads only after the ABCs it was compiled against", () => {
  const rt = avm2.createRuntime();
  rt.abc(module("builtin", []));
  assert.throws(() => rt.abc(module("case", ["other"])), /compiled after \[other\]/);
  assert.throws(() => rt.abc(module("case", [])), /cannot load after \[builtin\]/);
  rt.abc(module("case", ["builtin"]));
});

test("error messages are the release player's, or the debugger player's with its text", () => {
  // With no builtins loaded, the runtime's errors are JavaScript errors naming them.
  assert.equal(avm2.createRuntime().error("TypeError", 1009).message, "TypeError: Error #1009");
  assert.equal(
    avm2.createRuntime({ debugger: true }).error("TypeError", 1009).message,
    "TypeError: Error #1009: Cannot access a property or method of a null object reference.",
  );
  assert.equal(
    avm2.createRuntime({ debugger: true }).errorMessage(1065, ["x"]),
    "Error #1065: Variable x is not defined.",
  );
});

test("domain memory loads and stores little-endian, and rejects addresses outside it", () => {
  const rt = avm2.createRuntime();
  rt.memory = new DataView(new ArrayBuffer(16));
  rt.si32(-2, 0);
  rt.si8(0x1ff, 4);
  rt.si16(0x12345, 6);
  rt.sf64(1.5, 8);
  assert.deepEqual(
    [rt.li32(0), rt.li8(0), rt.li8(4), rt.li16(6), rt.lf64(8)],
    [-2, 0xfe, 0xff, 0x2345, 1.5],
  );
  rt.sf32(0.1, 12);
  assert.equal(rt.lf32(12), Math.fround(0.1));
  assert.throws(() => rt.li32(13), /Error #1506/);
  assert.throws(() => rt.si8(0, -1), /Error #1506/);
});

test("domain memory with none set is 1024 bytes of scratch memory, as avmplus' DomainEnv's", () => {
  const rt = avm2.createRuntime();
  rt.si32(7, 1020);
  assert.equal(rt.li32(1020), 7);
  assert.throws(() => rt.li32(1021), /Error #1506/);
  assert.throws(() => rt.sf64(1, 1017), /Error #1506/);
});

test("for-ins over an object whose names come and go keep only a few of those gone", () => {
  const rt = avm2.createRuntime();
  const o = { $d: new Map<string, unknown>() };
  const names = () => {
    const seen: string[] = [];
    for (let i = rt.hasNext(o, 0); i; i = rt.hasNext(o, i)) {
      seen.push(rt.nextName(o, i));
    }

    return seen;
  };

  for (let n = 0; n < 2000; n++) {
    o.$d.set(`k${n}`, n);
    assert.deepEqual(names(), [`k${n}`]);
    o.$d.delete(`k${n}`);
  }

  // The lists the for-ins went through, the last 4 generations of them.
  const lists: string[][] =
    (rt as unknown as { enumerating: WeakMap<object, { lists: string[][] }> }).enumerating.get(o)
      ?.lists ?? [];
  assert.equal(lists.length, 4);
  assert.ok(
    lists.every((list) => list.length <= 20),
    `lists of ${lists.map((l) => l.length)}`,
  );
});

test("a for-in goes on through its own names when one inside it takes a new list", () => {
  const rt = avm2.createRuntime();
  const o = { $d: new Map<string, unknown>() };
  for (let n = 0; n < 40; n++) {
    o.$d.set(`k${n}`, n);
  }

  const seen: string[] = [];
  for (let i = rt.hasNext(o, 0); i; i = rt.hasNext(o, i)) {
    const name = rt.nextName(o, i);
    seen.push(name);
    if (name === "k0") {
      // Most names gone, then a for-in inside: it starts a new generation.
      for (let n = 10; n < 40; n++) {
        o.$d.delete(`k${n}`);
      }

      o.$d.set("late", 1);
      for (let j = rt.hasNext(o, 0); j; j = rt.hasNext(o, j)) {}
    }
  }

  // The rest of its names, then the one added, which the inner for-in put after them.
  assert.deepEqual(seen, ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "late"]);
  const e = (rt as unknown as { enumerating: WeakMap<object, { generation: number }> }).enumerating;
  assert.equal(e.get(o)?.generation, 1);
});
