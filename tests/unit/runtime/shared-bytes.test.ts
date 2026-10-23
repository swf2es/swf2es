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

test("a lowered length leaves what another worker grew and wrote again meanwhile", () => {
  // Past 24 MB a lower length means a smaller buffer, which drops what is past it: shared, nothing is
  // zeroed, as without avmplus' safepoint the zeroing would race with a worker growing it again.
  for (const via of ["setter", "swap"]) {
    const [a, b] = shared(60 * MB);
    const regrow = () => {
      assert.equal(b.compareAndSwapLength(30 * MB, 60 * MB), 30 * MB);
      b.buffer[55 * MB] = 0xab;
    };
    const own = Object.getOwnPropertyDescriptor(a, "length") as PropertyDescriptor;
    let armed = via === "setter";
    Object.defineProperty(a, "length", {
      configurable: true,
      get: own.get,
      set(length: number) {
        own.set?.call(a, length);
        if (armed) {
          armed = false;
          regrow();
        }
      },
    });
    if (via === "setter") {
      a.setLength(30 * MB, true);
    } else {
      // Right after its swap succeeds.
      const swap = Atomics.compareExchange;
      Atomics.compareExchange = ((...args: Parameters<typeof swap>) => {
        const previous = swap(...args);
        Atomics.compareExchange = swap;
        regrow();
        return previous;
      }) as typeof swap;
      assert.equal(a.compareAndSwapLength(60 * MB, 30 * MB), 60 * MB);
    }

    assert.equal(b.buffer[55 * MB], 0xab, via);
    assert.equal(b.length, 60 * MB, via);
  }
});

test("a ByteArray that shares nothing drops what a smaller buffer drops, as avmplus does", () => {
  const a = new Bytes(rt, {});
  a.setLength(60 * MB, true);
  a.buffer[59 * MB] = 7;
  a.buffer[29 * MB] = 9;
  assert.equal(a.compareAndSwapLength(60 * MB, 30 * MB), 60 * MB);
  // A new buffer each time, with the bytes within the length and zeroes past it.
  a.setLength(60 * MB, true);
  assert.equal(a.buffer[59 * MB], 0);
  assert.equal(a.buffer[29 * MB], 9);
});

test("a worker that grows a cleared ByteArray keeps what it writes", () => {
  const [a, b] = shared(64);
  b.buffer[10] = 1;
  const own = Object.getOwnPropertyDescriptor(a, "length") as PropertyDescriptor;
  Object.defineProperty(a, "length", {
    configurable: true,
    get: own.get,
    set(length: number) {
      own.set?.call(a, length);
      // Right after the cleared length is told, another worker grows it and writes.
      if (length === 0) {
        assert.equal(b.compareAndSwapLength(0, 32), 0);
        b.buffer[20] = 0xab;
      }
    },
  });
  a.clear();
  assert.equal(b.buffer[20], 0xab);
  assert.equal(b.buffer[10], 0);
  assert.equal(b.length, 32);
});
