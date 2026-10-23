// A shareable ByteArray's memory as two workers' ByteArrays share it, one
// preempted at its worst moment: just after it read the shared length,
// the other changes it, as another thread may at any time. Neither undoes
// what the other did, and a swap that did not happen is not reported.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bytes } from "../../../packages/runtime/dist/avm2/natives/bytearray.js";
import type { Runtime } from "../../../packages/runtime/dist/avm2/runtime.js";

const rt = {
  defaultObjectEncoding: 3,
  error: (cls: string, id: number) => new Error(`${cls} ${id}`),
} as unknown as Runtime;
const MB = 1 << 20;

/** Two ByteArrays over one shared memory of `length`, set as the length setter sets it. */
function shared(length: number): [Bytes, Bytes] {
  const a = new Bytes(rt, {});
  a.shareable = true;
  a.setLength(length, true);
  const b = new Bytes(rt, {});
  b.adopt(a.share());
  return [a, b];
}

/** Run `meanwhile` right after `bytes` first reads its length. */
function preempt(bytes: Bytes, meanwhile: () => void): void {
  const own = Object.getOwnPropertyDescriptor(bytes, "length") as PropertyDescriptor;
  let first = true;
  Object.defineProperty(bytes, "length", {
    configurable: true,
    set: own.set,
    get() {
      const length = own.get?.call(bytes);
      if (first) {
        first = false;
        meanwhile();
      }

      return length;
    },
  });
}

test("a length swap that fails leaves what another worker grew and wrote", () => {
  // Past 24 MB the setter's growth reallocates to a multiple of 24 MB, a smaller one for a shorter length.
  const [a, b] = shared(30 * MB);
  assert.equal(a.buffer.length, 48 * MB);
  preempt(a, () => {
    assert.equal(b.compareAndSwapLength(30 * MB, 60 * MB), 30 * MB);
    b.buffer[55 * MB] = 0xab;
  });

  assert.equal(a.compareAndSwapLength(30 * MB, 31 * MB), 60 * MB);
  assert.equal(b.buffer[55 * MB], 0xab);
  assert.equal(b.length, 60 * MB);
});

test("a length swap reports the length it found, read once", () => {
  const [a, b] = shared(200);
  // Another worker sets it to what this one expects only after this one read it.
  preempt(a, () => b.setLength(100, true));
  assert.equal(a.compareAndSwapLength(100, 4096), 200);
  assert.equal(b.length, 100);
});

test("a write past the end never lowers a length another worker raised", () => {
  const [a, b] = shared(16);
  a.position = 16;
  preempt(a, () => b.setLength(64, true));
  a.write(new Uint8Array([1, 2, 3, 4]));
  assert.equal(b.length, 64);
  assert.deepEqual([...b.buffer.subarray(16, 20)], [1, 2, 3, 4]);
});

test("a length swap that lowers it zeroes what a smaller buffer drops, once it is swapped", () => {
  const [a, b] = shared(60 * MB);
  b.buffer[59 * MB] = 7;
  b.buffer[30 * MB] = 9;
  assert.equal(a.compareAndSwapLength(60 * MB, 30 * MB), 60 * MB);
  assert.equal(b.length, 30 * MB);
  // Kept up to 48 MB, as avmplus' reallocation keeps it: below, back as it was when it grows again.
  b.setLength(60 * MB, true);
  assert.equal(b.buffer[59 * MB], 0);
  assert.equal(b.buffer[30 * MB], 9);
});
