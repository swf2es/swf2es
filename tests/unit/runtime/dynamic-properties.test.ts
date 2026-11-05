// A dynamic object's properties keep the slots a for-in goes through them
// by, which must stay as few as the names at once however the names come
// and go between walks; avmshell's output shows only what a walk gives.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DynamicProperties } from "../../../packages/runtime/dist/avm2/dynamic-properties.js";

/** The names a walk starting now would go through, in their slots' order. */
function walked(d: DynamicProperties): string[] {
  const walk = d.startWalk(true);
  return walk.slots.filter((name, i): name is string => name !== null && walk.live[i] !== 0);
}

interface Internals {
  deleted: number[];
  added: string[];
  slots: (string | null)[];
}

test("a name deleted and set again over and over between walks keeps one slot, queued once", () => {
  const d = new DynamicProperties();
  d.set("a", 1);
  d.set("b", 2);
  assert.deepEqual(walked(d), ["a", "b"]);
  for (let i = 0; i < 10000; i++) {
    d.delete("a");
    d.set("a", i);
  }

  const walk = d.walk as unknown as Internals;
  assert.equal(walk.deleted.length, 1);
  assert.equal(walk.added.length, 0);
  assert.deepEqual(walked(d), ["a", "b"]);
  assert.equal(walk.slots.length, 2);
});

test("names added and deleted between walks pile up no more than twice those there", () => {
  const d = new DynamicProperties();
  d.set("kept", 0);
  walked(d);
  for (let i = 0; i < 10000; i++) {
    d.set(`n${i}`, i);
    d.delete(`n${i}`);
  }

  const walk = d.walk as unknown as Internals;
  assert.ok(walk.added.length <= 64, `${walk.added.length} names kept to place`);
  assert.deepEqual(walked(d), ["kept"]);
});

test("names added since a walk take the slots freed, lowest first, in the order last added", () => {
  const d = new DynamicProperties();
  for (const name of ["a", "b", "c", "d"]) {
    d.set(name, name);
  }

  walked(d);
  d.delete("a");
  d.delete("c");
  d.set("x", 1);
  d.set("y", 2);
  d.delete("x");
  d.set("z", 3);
  d.set("x", 4);
  assert.deepEqual(walked(d), ["y", "b", "z", "d", "x"]);
  assert.equal((d.walk as unknown as Internals).slots.length, 5);
});

test("a name deleted during a walk is passed over, and one set again before the next keeps its slot", () => {
  const d = new DynamicProperties();
  d.set("a", 1);
  d.set("b", 2);
  const walk = d.startWalk(true);
  d.delete("b");
  assert.equal(walk.live[1], 0);
  d.set("b", 3);
  assert.notEqual(walk.live[1], 0);
  assert.deepEqual(walked(d), ["a", "b"]);
  d.clear();
  assert.deepEqual(walked(d), []);
});
