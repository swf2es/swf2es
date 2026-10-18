import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  FrameReader,
  FrameWriter,
  sharedFrames,
} from "../../../../../packages/player/dist/render/worker/frames.js";

test("shared frames keep an acquired payload stable and retain the newest pending snapshot", () => {
  const frames = sharedFrames(32);
  const writer = new FrameWriter(frames);
  const reader = new FrameReader(frames);
  const publish = (value: number) =>
    writer.write((bytes) => {
      bytes.fill(value);
      return bytes.length;
    });

  assert.equal(reader.take(), null);
  assert.equal(publish(1), 1);
  const first = reader.take();
  assert.ok(first);
  assert.equal(publish(2), 2);
  assert.equal(publish(3), 3);
  assert.equal(
    writer.write(() => {
      assert.fail("a busy writer must not encode");
    }),
    null,
  );
  assert.ok(first.bytes.every((x) => x === 1));
  assert.throws(() => reader.take(), /release/);
  first.release();
  assert.throws(() => first.release(), /already released/);

  const newest = reader.take();
  assert.equal(newest?.sequence, 3);
  assert.ok(newest?.bytes.every((x) => x === 3));
  newest?.release();
  assert.equal(reader.take(), null);
  assert.equal(publish(4), 4);
});

test("failed encoding and capacity errors release their slot without publishing partial bytes", () => {
  const frames = sharedFrames(8, 2);
  const writer = new FrameWriter(frames);
  const reader = new FrameReader(frames);

  assert.throws(
    () =>
      writer.write((bytes) => {
        bytes.fill(99);
        throw new Error("encode");
      }),
    /encode/,
  );
  for (const length of [-1, 9, NaN, 0.5]) {
    assert.throws(() => writer.write(() => length), /capacity/);
  }

  assert.equal(reader.take(), null);
  assert.equal(
    writer.write(() => 0),
    1,
  );
  const empty = reader.take();
  assert.equal(empty?.bytes.length, 0);
  empty?.release();

  new Int32Array(frames.control)[0] = 0x7fffffff;
  assert.throws(() => writer.write(() => 0), /sequence exhausted/);
  assert.equal(reader.take(), null);
});

test("invalid shared frame descriptors are rejected", () => {
  assert.throws(() => sharedFrames(0), RangeError);
  assert.throws(() => sharedFrames(32, 1), RangeError);
  const frames = sharedFrames(32);
  assert.throws(() => new FrameReader({ ...frames, slots: 2 }), RangeError);
  assert.throws(() => new FrameWriter({ ...frames, capacity: 16 }), RangeError);
});

test("concurrent production never tears a slow reader's payload and eventually presents the latest state", {
  timeout: 20_000,
}, async (t) => {
  const frames = sharedFrames(16_384);
  const writer = new FrameWriter(frames);
  const worker = new Worker(new URL("./frames-worker.ts", import.meta.url), { workerData: frames });
  const yieldThread = () => {
    t.signal.throwIfAborted();
    return new Promise<void>((resolve) => setImmediate(resolve));
  };

  try {
    await once(worker, "message", { signal: t.signal });
    for (let value = 0; value < 2000; value++) {
      writer.write((bytes) => {
        bytes.fill(value & 255);
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(0, value, true);
        return bytes.length;
      });
      if (value % 16 === 0) {
        await yieldThread();
      }
    }

    const result = once(worker, "message", { signal: t.signal });
    result.catch(() => {});
    while (
      writer.write((bytes) => {
        bytes.fill(255);
        return bytes.length;
      }) === null
    ) {
      await yieldThread();
    }

    const [message] = await result;
    assert.equal(message.error, undefined);
    assert.ok(message.reads > 1);
    assert.equal(message.latest, 0xffffffff);
  } finally {
    await worker.terminate();
  }
});
