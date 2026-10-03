import assert from "node:assert/strict";
import { test } from "node:test";
import { readSound, readSwf, tags } from "../../../packages/format/dist/index.js";
import { BitWriter, end, showFrame, swf, tag } from "../../swf-writer.ts";

test("DefineSound keeps its sample metadata and excludes the MP3 seek word", () => {
  const body = new BitWriter()
    .u16(7)
    .u8((2 << 4) | (3 << 2) | 3)
    .u32(46080)
    .u16(0xfffe)
    .raw([1, 2, 3])
    .done();
  const movie = readSwf(
    swf({
      width: 10,
      height: 10,
      frameRate: 24,
      frameCount: 1,
      tags: [tag(tags.DefineSound, body), showFrame(), end()],
    }),
  );
  const definition = readSound(movie.bytes, movie.tags[0]);
  assert.deepEqual(definition, {
    id: 7,
    format: 2,
    sampleRate: 44100,
    sampleSize: 16,
    channels: 2,
    sampleCount: 46080,
    seekSamples: -2,
    data: new Uint8Array([1, 2, 3]),
  });
  assert.equal(definition.data.buffer, movie.bytes.buffer);
});
