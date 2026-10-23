// The memory Mutexes, Conditions and channels' queues share between
// workers, under contention from real threads: many threads on one mutex
// lose no update, a condition wakes its waiters in the order they came and
// passes over those that ended, a wait's result tells a timeout from a
// notify, a mutex held by a thread that ended is free to take, a queue
// loses and reorders nothing, and a thread that must spin gives up after
// its script timeout. A terminated worker's thread, which may run on until
// it is stopped, gets nothing more of the memory, and keeps the locks it
// holds until it has stopped, at its next wait or for good.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  newSyncMemory,
  Sync,
  type SyncMemory,
  SyncTimeout,
} from "../../../packages/runtime/dist/avm2/natives/sync.js";

const module = new URL("../../../packages/runtime/dist/avm2/natives/sync.js", import.meta.url).href;

/**
 * A thread that runs `body` as worker `id`, with `sync`, its Sync over
 * `memory`, `data`, and `post` to tell the test; it posts "done" when the
 * body returns, or the error that stopped it.
 */
function thread(memory: SyncMemory, id: number, body: string, data: unknown = null): Worker {
  const source = `(async () => {
    const { parentPort, workerData } = await import("node:worker_threads");
    const { Sync } = await import(${JSON.stringify(module)});
    const { memory, id, data } = workerData;
    const sync = new Sync(memory, id);
    const post = (m) => parentPort.postMessage(m);
    try {
      await (async () => { ${body} })();
      post("done");
    } catch (e) {
      post(e.constructor.name + ": " + e.message);
    }
  })();`;
  return new Worker(source, { eval: true, workerData: { memory, id, data } });
}

/** The messages a thread posts, as they come. */
function messages(w: Worker): () => Promise<unknown> {
  const queue: unknown[] = [];
  const waiting: ((m: unknown) => void)[] = [];
  w.on("message", (m) => {
    const next = waiting.shift();
    if (next) {
      next(m);
    } else {
      queue.push(m);
    }
  });
  w.on("error", (e) => {
    const next = waiting.shift();
    next?.(`error: ${e}`);
  });
  return () =>
    queue.length > 0
      ? Promise.resolve(queue.shift())
      : new Promise((resolve) => waiting.push(resolve));
}

/** Wait, without blocking the event loop, until `f` holds. */
async function until(f: () => boolean): Promise<void> {
  const start = Date.now();
  while (!f()) {
    if (Date.now() - start > 20000) {
      throw new Error("timed out");
    }

    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("threads contending one mutex lose no update", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const m = sync.newMutex();
  const counter = sync.alloc(1);
  const threads = 8;
  const rounds = 5000;
  const workers = [];
  for (let id = 1; id <= threads; id++) {
    sync.addThread(id);
    // Not atomic: only the mutex keeps the increments whole.
    const w = thread(
      memory,
      id,
      `const { m, counter, rounds } = data;
      for (let i = 0; i < rounds; i++) {
        sync.lock(m);
        if (i % 3 === 0) { sync.lock(m); }
        const v = sync.words[counter];
        for (let j = 0; j < 5; j++) {}
        sync.words[counter] = v + 1;
        if (i % 3 === 0) { sync.unlock(m); }
        sync.unlock(m);
      }`,
      { m, counter, rounds },
    );
    workers.push(messages(w));
  }

  for (const next of workers) {
    assert.equal(await next(), "done");
  }

  assert.equal(sync.words[counter], threads * rounds);
  assert.ok(sync.tryLock(m));
  assert.ok(sync.unlock(m));
});

test("a condition wakes its waiters in the order they came, true only for a timeout", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const m = sync.newMutex();
  const c = sync.newCondition(m);
  const order = sync.alloc(8);
  const waiting = sync.alloc(1);
  const workers = [];
  for (let id = 1; id <= 4; id++) {
    sync.addThread(id);
    const w = thread(
      memory,
      id,
      `const { m, c, order, waiting } = data;
      sync.lock(m);
      Atomics.add(sync.words, waiting, 1);
      const timedOut = sync.wait(c, -1);
      const at = Atomics.add(sync.words, order, 1);
      sync.words[order + 1 + at] = id * (timedOut ? -1 : 1);
      sync.unlock(m);`,
      { m, c, order, waiting },
    );
    workers.push(messages(w));
    // Each waits before the next comes.
    await until(() => Atomics.load(sync.words, waiting) === id);
    sync.lock(m);
    sync.unlock(m);
  }

  sync.lock(m);
  sync.notify(c, false);
  sync.notify(c, false);
  sync.unlock(m);
  await until(() => Atomics.load(sync.words, order) === 2);
  sync.lock(m);
  sync.notify(c, true);
  sync.unlock(m);
  for (const next of workers) {
    assert.equal(await next(), "done");
  }

  assert.deepEqual([...sync.words.subarray(order + 1, order + 5)], [1, 2, 3, 4]);

  // No waiter: the notify is lost, and a wait runs its time out.
  sync.lock(m);
  sync.notify(c, false);
  sync.notify(c, true);
  const start = Date.now();
  assert.equal(sync.wait(c, 30), true);
  assert.ok(Date.now() - start >= 29);
  assert.ok(sync.holds(m));
  sync.unlock(m);
});

test("a wait lets go of a mutex held many times, and holds it as often after", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const m = sync.newMutex();
  const c = sync.newCondition(m);
  sync.addThread(1);
  const w = messages(
    thread(
      memory,
      1,
      `const { m, c } = data;
      sync.lock(m);
      post("locked");
      sync.notify(c, false);
      sync.unlock(m);`,
      { m, c },
    ),
  );
  sync.lock(m);
  sync.lock(m);
  sync.lock(m);
  // The thread can take it only while this one waits.
  assert.equal(sync.wait(c, 10000), false);
  assert.equal(await w(), "locked");
  assert.equal(await w(), "done");
  assert.ok(sync.unlock(m));
  assert.ok(sync.unlock(m));
  assert.ok(sync.unlock(m));
  assert.equal(sync.unlock(m), false);
});

test("a mutex held by a thread that ended is free to take, and a notify passes over a waiter that ended", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const m = sync.newMutex();
  const c = sync.newCondition(m);
  sync.addThread(1);
  const holder = thread(
    memory,
    1,
    `sync.lock(data.m);
    post("locked");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
    { m },
  );
  assert.equal(await messages(holder)(), "locked");
  assert.equal(sync.tryLock(m), false);
  await holder.terminate();
  sync.end(1);
  assert.equal(sync.tryLock(m), true);
  sync.unlock(m);

  // Thread 2 waits first and is stopped; thread 3 waits after it.
  const waits = sync.alloc(1);
  const ids = [2, 3];
  const workers = [];
  for (const id of ids) {
    sync.addThread(id);
    const w = thread(
      memory,
      id,
      `const { m, c, waits } = data;
      sync.lock(m);
      Atomics.add(sync.words, waits, 1);
      post("waiting");
      post(sync.wait(c, -1));
      sync.unlock(m);`,
      { m, c, waits },
    );
    const next = messages(w);
    assert.equal(await next(), "waiting");
    sync.lock(m);
    sync.unlock(m);
    workers.push({ w, next });
  }

  await workers[0].w.terminate();
  sync.end(2);
  sync.lock(m);
  sync.notify(c, false);
  sync.unlock(m);
  assert.equal(await workers[1].next(), false);
  assert.equal(await workers[1].next(), "done");
});

test("a thread blocked on a mutex takes it once its holder is stopped", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const m = sync.newMutex();
  sync.addThread(1);
  sync.addThread(2);
  const holder = thread(
    memory,
    1,
    `sync.lock(data.m);
    post("locked");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
    { m },
  );
  assert.equal(await messages(holder)(), "locked");
  const blocked = messages(thread(memory, 2, "sync.lock(data.m); post('took');", { m }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await holder.terminate();
  sync.end(1);
  assert.equal(await blocked(), "took");
  assert.equal(await blocked(), "done");
});

test("a queue fed by many threads loses and reorders nothing, and a close wakes its reader", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const q = sync.newQueue();
  const producers = 4;
  const each = 2000;
  const workers = [];
  for (let id = 1; id <= producers; id++) {
    sync.addThread(id);
    const w = thread(
      memory,
      id,
      `for (let i = 0; i < data.each; i++) {
        const bytes = new Uint8Array(2 + (i % 37));
        bytes[0] = data.id;
        new DataView(bytes.buffer).setUint16(0, data.id * 1000 + (i % 1000));
        sync.push(data.q, bytes.subarray(0, 2 + (i % 30)));
      }`,
      { q, each, id },
    );
    workers.push(messages(w));
  }

  // A reader on its own thread, blocking until each comes.
  sync.addThread(9);
  const reader = messages(
    thread(
      memory,
      9,
      `const last = new Map();
      let n = 0;
      for (;;) {
        sync.waitFor(data.q);
        const bytes = sync.shift(data.q);
        if (bytes === null) { break; }
        const v = new DataView(bytes.buffer).getUint16(0);
        const p = Math.floor(v / 1000);
        const prev = last.get(p) ?? -1;
        if ((prev + 1) % 1000 !== v % 1000) { throw new Error("out of order " + p + " " + prev + " " + v); }
        last.set(p, v % 1000);
        n++;
      }
      post(n);`,
      { q },
    ),
  );
  for (const next of workers) {
    assert.equal(await next(), "done");
  }

  await until(() => sync.queued(q) === 0);
  sync.close(q);
  assert.equal(await reader(), producers * each);
  assert.equal(await reader(), "done");
});

test("a thread that must spin gives up after its script timeout", async () => {
  const memory = newSyncMemory();
  const holder = new Sync(memory, 1);
  const spinner = new Sync(memory, 0, { spin: true, timeout: 150 });
  const m = holder.newMutex();
  holder.lock(m);
  const start = Date.now();
  assert.throws(() => spinner.lock(m), SyncTimeout);
  assert.ok(Date.now() - start >= 150);
  // Back in its event loop, the thread may spin again.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // A wait that spins times out as asked, well before the script timeout.
  const own = spinner.newMutex();
  const c = spinner.newCondition(own);
  spinner.lock(own);
  assert.equal(spinner.wait(c, 20), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(() => spinner.wait(c, -1), SyncTimeout);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Short waits, one after another without returning to the event loop,
  // as Crossbridge's startup waits, are timed together.
  const loop = Date.now();
  assert.throws(() => {
    for (;;) {
      spinner.wait(c, 1);
    }
  }, SyncTimeout);
  assert.ok(Date.now() - loop >= 150);
});

test("threads allocating from the shared heap at once never share a block", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const body = `const t = Date.now();
    let bad = 0;
    while (Date.now() - t < 500) {
      const a = sync.alloc(6);
      for (let i = 0; i < 6; i++) { sync.words[a + i] = data.mark; }
      for (let j = 0; j < 20; j++) {}
      for (let i = 0; i < 6; i++) { if (sync.words[a + i] !== data.mark) { bad++; break; } }
      sync.free(a);
    }
    post(bad);`;
  const workers = [1, 2, 3].map((id) => {
    sync.addThread(id);
    return messages(thread(memory, id, body, { mark: 0x1000 + id }));
  });
  for (const next of workers) {
    assert.equal(await next(), 0);
    assert.equal(await next(), "done");
  }
});

test("a terminated worker's thread that runs on gets nothing more of the shared memory", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  sync.addThread(1);
  const w = messages(
    thread(
      memory,
      1,
      `post("running");
      for (;;) {
        const a = sync.alloc(6);
        for (let i = 0; i < 6; i++) { sync.words[a + i] = 0x11111111; }
        sync.free(a);
      }`,
    ),
  );
  assert.equal(await w(), "running");
  sync.stop(1);
  assert.equal(await w(), "SyncTerminated: swf2es: the worker was terminated");
  // Its code stopped there: what it held is free to take.
  assert.ok(sync.stopped(1));

  // The heap is whole: blocks come and go with none overwritten.
  for (let n = 0; n < 1000; n++) {
    const a = sync.alloc(6);
    sync.words.fill(0x22222222, a, a + 6);
    assert.ok(sync.words.subarray(a, a + 6).every((v) => v === 0x22222222));
    sync.free(a);
  }
});

test("a Mutex held by a terminated worker is let go only once its thread has stopped", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const m = sync.newMutex();
  const counter = sync.alloc(1);
  sync.addThread(1);
  const worker = thread(
    memory,
    1,
    `sync.lock(data.m);
    post("locked");
    for (;;) { Atomics.add(sync.words, data.counter, 1); }`,
    { m, counter },
  );
  assert.equal(await messages(worker)(), "locked");

  // Terminated, and still writing what the Mutex guards: not to be taken.
  sync.stop(1);
  assert.equal(sync.tryLock(m), false);
  const before = Atomics.load(sync.words, counter);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual(Atomics.load(sync.words, counter), before);
  assert.equal(sync.tryLock(m), false);

  // Stopped: free to take, and nothing writes any more.
  await worker.terminate();
  sync.end(1);
  assert.equal(sync.tryLock(m), true);
  const after = Atomics.load(sync.words, counter);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(Atomics.load(sync.words, counter), after);
  sync.unlock(m);
});

test("a terminated worker that waits stops there, letting go of its Mutex, and a notify reaches the next waiter", async () => {
  const memory = newSyncMemory();
  const sync = new Sync(memory, 0);
  const m = sync.newMutex();
  const c = sync.newCondition(m);
  const other = sync.newMutex();
  sync.addThread(1);
  sync.addThread(2);
  // Thread 1 holds `other` and waits on c; thread 2 waits on c after it.
  const first = messages(
    thread(
      memory,
      1,
      `sync.lock(data.other);
      sync.lock(data.m);
      post("waiting");
      sync.wait(data.c, -1);
      post("woke");`,
      { m, c, other },
    ),
  );
  assert.equal(await first(), "waiting");
  sync.lock(m);
  sync.unlock(m);
  const second = messages(
    thread(
      memory,
      2,
      `sync.lock(data.m);
      post("waiting");
      post(sync.wait(data.c, -1));
      sync.unlock(data.m);`,
      { m, c },
    ),
  );
  assert.equal(await second(), "waiting");
  sync.lock(m);
  sync.unlock(m);

  // Its thread is not stopped: it stops itself at its wait, within a step.
  sync.stop(1);
  assert.equal(await first(), "SyncTerminated: swf2es: the worker was terminated");
  assert.ok(sync.waitStopped(1, 1000));
  assert.equal(sync.tryLock(other), true);
  sync.unlock(other);

  sync.lock(m);
  sync.notify(c, false);
  sync.unlock(m);
  assert.equal(await second(), false);
  assert.equal(await second(), "done");
});
