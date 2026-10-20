import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameReader, FrameWriter, sharedFrames } from "./scene/frames.ts";

test("a copied frame survives producer reuse and occupied slots apply backpressure", () => {
  const frames = sharedFrames(16, 2),
    writer = new FrameWriter(frames),
    reader = new FrameReader(frames);
  const write = (value: number) =>
    writer.write((bytes) => {
      bytes.fill(value);
      return bytes.length;
    });
  assert.equal(write(1), 1);
  const first = reader.take();
  assert.ok(first);
  assert.equal(write(2), 2);
  let called = false;
  assert.equal(
    writer.write(() => {
      called = true;
      return 0;
    }),
    null,
  );
  assert.equal(called, false);
  assert.ok(first.bytes.every((value) => value === 1));
  const copied = first.bytes.slice();
  first.release();
  assert.equal(write(3), 3);
  assert.ok(copied.every((value) => value === 1));
  const newest = reader.take();
  assert.ok(newest);
  assert.equal(newest.sequence, 3);
  assert.ok(newest.bytes.every((value) => value === 3));
  newest.release();
  assert.throws(() => newest.release(), /already released/);
  assert.equal(reader.take(), null);
  assert.equal(write(4), 4);
});

test("failed encodes and invalid lengths release the writer slot without publishing", () => {
  const frames = sharedFrames(16, 2),
    writer = new FrameWriter(frames),
    reader = new FrameReader(frames);
  assert.throws(
    () =>
      writer.write(() => {
        throw new Error("capture failed");
      }),
    /capture failed/,
  );
  assert.equal(reader.take(), null);
  assert.throws(() => writer.write(() => 17), /exceeds its slot capacity/);
  assert.equal(reader.take(), null);
  assert.equal(
    writer.write((bytes) => {
      bytes.fill(7);
      return bytes.length;
    }),
    1,
  );
  const frame = reader.take();
  assert.ok(frame);
  assert.ok(frame.bytes.every((value) => value === 7));
  assert.throws(() => reader.take(), /release the previous shared frame/);
  frame.release();
});
