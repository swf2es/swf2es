// avmshell's workers' shared memory under contention from real threads:
// workers that end, and a worker terminated while it writes, as the
// primordial writes its own properties, lose none of them, corrupt no
// table and leave no lock held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  newWorkersMemory,
  Workers,
} from "../../../packages/runtime/dist/avm2/natives/shell-workers.js";
import { newSyncMemory } from "../../../packages/runtime/dist/avm2/natives/sync.js";

const module = new URL(
  "../../../packages/runtime/dist/avm2/natives/shell-workers.js",
  import.meta.url,
).href;

const ITEM_NUMBER = 3;
const CANSTART = 2;
const RUNNING = 4;
const TERMINATED = 6;

const number = (n: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, n, true);
  return { kind: ITEM_NUMBER, bytes };
};

const numberOf = (bytes: Uint8Array) => new DataView(bytes.buffer).getFloat64(0, true);

/**
 * A thread that runs worker `init`: marks it running, sets its own
 * properties `count` times (for ever with -1), then ends it, as a
 * background worker's thread does. It posts "running", then the error
 * that stopped it, or "ended".
 */
function thread(init: object, count: number): Worker {
  const source = `(async () => {
    const { parentPort, workerData } = await import("node:worker_threads");
    const { Workers, startShellWorker, endShellWorker } = await import(${JSON.stringify(module)});
    const { init, count } = workerData;
    startShellWorker(init);
    parentPort.postMessage("running");
    const workers = new Workers(init.memory, init.id);
    const bytes = new Uint8Array(8);
    try {
      for (let i = 0; count < 0 || i < count; i++) {
        workers.set(init.id, "k" + (i % 7), { kind: 3, bytes });
      }
      endShellWorker(init, false);
      parentPort.postMessage("ended");
    } catch (e) {
      parentPort.postMessage(e.constructor.name + ": " + e.message);
    }
  })();`;
  return new Worker(source, { eval: true, workerData: { init, count } });
}

const first = (w: Worker) =>
  new Promise<string>((resolve, reject) => {
    w.once("message", resolve);
    w.once("error", reject);
  });

test("workers that end as the primordial writes lose and corrupt nothing", async () => {
  const memory = newWorkersMemory(newSyncMemory());
  const primordial = new Workers(memory, 0);
  const threads: { done: Promise<string>; exited: Promise<unknown>; id: number }[] = [];
  let key = 0;
  for (let round = 0; round < 20; round++) {
    const id = primordial.create();
    primordial.setState(id, CANSTART);
    const w = thread({ id, memory, code: null }, 200);
    const exited = new Promise((resolve) => w.once("exit", resolve));
    assert.equal(await first(w), "running");
    const done = first(w);
    for (let i = 0; i < 100; i++, key++) {
      primordial.set(0, `p${key}`, number(key));
    }

    threads.push({ done, exited, id });
  }

  for (const t of threads) {
    assert.equal(await t.done, "ended");
    await t.exited;
    assert.equal(primordial.state(t.id), TERMINATED);
  }

  for (let k = 0; k < key; k++) {
    const entry = primordial.get(0, `p${k}`);
    assert.ok(entry, `p${k}`);
    assert.equal(numberOf(entry.bytes), k);
  }

  for (const t of threads) {
    assert.equal(primordial.get(t.id, "k0"), undefined);
  }

  assert.equal(Atomics.load(primordial.control, 0), 0, "the lock is free");
});

test("a worker terminated as it writes stops at its next write, the lock left free", async () => {
  const memory = newWorkersMemory(newSyncMemory());
  const primordial = new Workers(memory, 0);
  const id = primordial.create();
  primordial.setState(id, CANSTART);
  const w = thread({ id, memory, code: null }, -1);
  assert.equal(await first(w), "running");
  const stopped = first(w);
  for (let i = 0; i < 200; i++) {
    primordial.set(0, `before${i}`, number(i));
  }

  assert.equal(primordial.state(id), RUNNING);
  assert.equal(primordial.terminate(id), true);
  assert.equal(primordial.terminate(id), false);
  assert.match(await stopped, /^WorkerTerminated/);
  for (let i = 0; i < 200; i++) {
    primordial.set(0, `after${i}`, number(i));
  }

  for (let i = 0; i < 200; i++) {
    assert.equal(numberOf(primordial.get(0, `before${i}`)?.bytes ?? new Uint8Array(8)), i);
    assert.equal(numberOf(primordial.get(0, `after${i}`)?.bytes ?? new Uint8Array(8)), i);
  }

  assert.equal(primordial.get(id, "k0"), undefined);
  await w.terminate();
  assert.equal(Atomics.load(primordial.control, 0), 0, "the lock is free");
});

test("terminating a worker terminates the workers it started", () => {
  const memory = newWorkersMemory(newSyncMemory());
  const primordial = new Workers(memory, 0);
  const child = primordial.create();
  primordial.setState(child, RUNNING);
  const grandchild = new Workers(memory, child).create();
  primordial.setState(grandchild, RUNNING);
  const unstarted = new Workers(memory, child).create();
  const other = primordial.create();
  primordial.setState(other, RUNNING);
  new Workers(memory, grandchild).set(grandchild, "x", number(1));

  assert.equal(primordial.terminate(child), true);
  assert.equal(primordial.state(child), TERMINATED);
  assert.equal(primordial.state(grandchild), TERMINATED);
  assert.equal(primordial.state(unstarted), 1);
  assert.equal(primordial.state(other), RUNNING);
  assert.equal(primordial.get(grandchild, "x"), undefined);
  assert.throws(() => new Workers(memory, grandchild).set(grandchild, "y", number(2)), {
    name: "Error",
    message: /terminated/,
  });
});
