import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mp3Bytes, mp3Frames } from "../../../../packages/player/dist/media/mp3.js";

const sound = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../player/sounds/${name}`, import.meta.url)));
const tone = sound("tone.mp3");

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
};

/** About three seconds: the tone's frames ten times over. */
const long = concat(...Array.from({ length: 10 }, () => tone));
const middle = mp3Frames(tone)?.whole[8] ?? 0;

/** An ID3v2 tag of `body`. */
const id3 = (body: Uint8Array) =>
  concat(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, body.length]), body);

test("an MP3's frames are counted by their headers, a frame cut short too", () => {
  const all = mp3Frames(tone);
  assert.deepEqual(
    [all?.rate, all?.channels, all?.samplesPerFrame, all?.frames, all?.end, all?.header],
    [44100, 2, 1152, 11, tone.length, null],
  );
  const cut = mp3Frames(tone.subarray(0, 1000));
  assert.deepEqual([cut?.frames, cut?.end, cut?.whole.length], [4, 940, 6]);
  assert.equal(mp3Frames(new TextEncoder().encode("not an mp3")), null);

  // A LAME header frame is found, for the decode to keep from the browser.
  assert.deepEqual(mp3Frames(sound("tone-tagged.mp3"))?.header, [0, 313]);
});

test("bytes added read on from where the frames before stopped, as the whole would read", () => {
  const first = mp3Frames(long.subarray(0, 1000));
  const more = mp3Frames(long, first);
  assert.deepEqual(more, mp3Frames(long));
  assert.equal(more?.frames, 110);
});

test("frames run on past bytes between them, and past a tag with a header in it", () => {
  const junk = concat(
    long.subarray(0, middle),
    new Uint8Array(7).fill(0x55),
    long.subarray(middle),
  );
  assert.equal(mp3Frames(junk)?.frames, 110);

  // A header a tag holds is no frame: the tag is passed over, and left out of what is decoded.
  const fake = id3(new Uint8Array([0xff, 0xfb, 0x70, 0x04, 1, 2, 3, 4]));
  const tagged = concat(long.subarray(0, middle), fake, long.subarray(middle));
  const frames = mp3Frames(tagged);
  assert.equal(frames?.frames, 110);
  assert.deepEqual(frames && mp3Bytes(tagged, frames), long);
});

test("bytes of another format, a header-like run in them or not, have no frames", () => {
  const wav = concat(
    new TextEncoder().encode("RIFF\x24\x10\x00\x00WAVEfmt "),
    new Uint8Array(64),
    new Uint8Array([0xff, 0xfb, 0x70, 0x04]),
    new Uint8Array(4000).map((_, i) => (i * 37) & 0x7f),
  );
  assert.equal(mp3Frames(wav), null);
});
