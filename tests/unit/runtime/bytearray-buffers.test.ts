// A ByteArray given a codec's output: a whole buffer taken as it is, a view
// of part of one copied, so that the ByteArray's DataView and the domain
// memory's, both over its buffer from offset 0, read its bytes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { replaceBytes } from "../../../packages/runtime/dist/avm2/natives/bytearray.js";
import { Bytes } from "../../../packages/runtime/dist/avm2/natives/bytes.js";
import type { Runtime } from "../../../packages/runtime/dist/avm2/runtime.js";

function runtime(): Runtime {
  const memory = new DataView(new ArrayBuffer(1024));
  return {
    defaultObjectEncoding: 3,
    error: (cls: string, id: number) => new Error(`${cls} ${id}`),
    memory,
    memoryLength: memory.byteLength,
  } as unknown as Runtime;
}

function counting(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = i + 1;
  }

  return bytes;
}

test("a codec's whole buffer becomes the ByteArray's own", () => {
  const b = new Bytes(runtime(), {});
  const out = counting(8);
  replaceBytes(b, out, 8);
  assert.equal(b.buffer, out);
  assert.equal(b.length, 8);
  assert.equal(b.position, 8);
  assert.equal(b.view.getUint32(4), 0x05060708);
});

test("a view of part of a buffer is copied into one of its own", () => {
  for (const [begin, end] of [
    [4, 12],
    [0, 8],
    [8, 16],
  ]) {
    const b = new Bytes(runtime(), {});
    const backing = counting(16);
    const out = backing.subarray(begin, end);
    replaceBytes(b, out, 3);
    assert.notEqual(b.buffer.buffer, backing.buffer);
    assert.equal(b.buffer.byteOffset, 0);
    assert.equal(b.buffer.buffer.byteLength, 8);
    assert.deepEqual([...b.buffer], [...out]);
    assert.equal(b.length, 8);
    assert.equal(b.position, 3);
    assert.equal(b.view.getUint8(0), begin + 1);
    assert.equal(b.view.getUint32(4), new DataView(out.buffer, out.byteOffset).getUint32(4));

    backing.fill(0);
    assert.equal(b.buffer[0], begin + 1);
  }
});

test("the domain memory reads a copied view's bytes from its start", () => {
  const rt = runtime();
  const b = new Bytes(rt, {});
  b.subscribed = true;
  const backing = counting(2048);
  replaceBytes(b, backing.subarray(300, 1324), 0);
  assert.equal(rt.memory.byteLength, 1024);
  assert.equal(rt.memory.byteOffset, 0);
  assert.equal(rt.memory.buffer, b.buffer.buffer);
  assert.equal(rt.memory.getUint8(0), 301 & 255);
  assert.equal(rt.memory.getUint8(1023), 1324 & 255);
});
