import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { binary } from "../../packages/mp3/dist/binary.js";
import { Mp3Decoder, prepareMp3 } from "../../packages/mp3/dist/index.js";
import { mp3Frames } from "../../packages/player/dist/media/mp3.js";

await prepareMp3();
const tone = new Uint8Array(readFileSync(new URL("../player/sounds/tone.mp3", import.meta.url)));

test("the MP3 decoder imports nothing and uses a fixed 128 KiB workspace", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const instance = await WebAssembly.instantiate(module);
  const memory = instance.exports.memory as WebAssembly.Memory & { grow(pages: number): number };
  assert.equal(memory.buffer.byteLength, 131072);
  assert.throws(() => memory.grow(1), RangeError);
});

test("a frame decoder rejects oversized input and survives malformed frame payloads", () => {
  const decoder = new Mp3Decoder();
  assert.equal(decoder.read(new Uint8Array(4097)), 0);
  assert.equal(decoder.read(new Uint8Array()), 0);
  const mp3 = mp3Frames(tone);
  assert.ok(mp3);
  const original = tone.subarray(mp3.whole[0], mp3.whole[1]);
  let random = 1;
  for (let k = 0; k < 500; k++) {
    const bytes = original.slice();
    for (let i = 4; i < bytes.length; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      bytes[i] = random >>> 24;
    }

    const count = decoder.read(bytes);
    assert.ok(count === 0 || count === 1152);
    assert.equal(decoder.pcm.byteLength, 2304 * 4);
  }
});
