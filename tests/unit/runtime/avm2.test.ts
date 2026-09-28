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

test("for-ins over an object whose names come and go keep a slot for each at once", () => {
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

  // Each new name took the slot of the one before it.
  const e = (rt as unknown as { enumerating: WeakMap<object, { names: string[] }> }).enumerating;
  assert.equal(e.get(o)?.names.length, 1);
});

test("a for-in goes on through its own names however many for-ins inside it come and go", () => {
  // [10, 20, 30]: at 0, delete it, then 150 times add a name, go through
  // them all and delete it again; the outer for-in still finds 1 and 2.
  const rt = avm2.createRuntime();
  const o = { $a: [10, 20, 30], $d: new Map<string, unknown>() };
  const seen: string[] = [];
  for (let i = rt.hasNext(o, 0); i; i = rt.hasNext(o, i)) {
    const name = String(rt.nextName(o, i));
    seen.push(name);
    if (name === "0") {
      delete o.$a[0];
      for (let n = 0; n < 150; n++) {
        o.$d.set(`k${n}`, n);
        for (let j = rt.hasNext(o, 0); j; j = rt.hasNext(o, j)) {}
        o.$d.delete(`k${n}`);
      }
    }
  }

  assert.deepEqual(seen, ["0", "1", "2"]);
});

test("a name deleted and then back is in one slot, not its old one too", () => {
  // a = [10]; for-in; delete a[0]; for-in; a[0] = 20: a for-in finds 0 once.
  const rt = avm2.createRuntime();
  const o = { $a: [10] as number[] };
  const names = () => {
    const seen: string[] = [];
    for (let i = rt.hasNext(o, 0); i; i = rt.hasNext(o, i)) {
      seen.push(String(rt.nextName(o, i)));
    }

    return seen;
  };

  names();
  delete o.$a[0];
  assert.deepEqual(names(), []);
  o.$a[0] = 20;
  assert.deepEqual(names(), ["0"]);
});
