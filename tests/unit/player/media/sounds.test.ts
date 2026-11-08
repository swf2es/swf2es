import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../packages/player/dist/avm1/avm1.js";
import type { AudioHost, SoundMix } from "../../../../packages/player/dist/media/audio.js";
import { outputMix } from "../../../../packages/player/dist/media/sounds.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import * as w from "../../../swf-writer.ts";
import { files, play, take } from "../avm1/network.ts";

const mix = (
  volume: number,
  leftToLeft: number,
  leftToRight: number,
  rightToLeft: number,
  rightToRight: number,
): SoundMix => ({ volume, leftToLeft, leftToRight, rightToLeft, rightToRight });

test("a channel's output is its own transform followed by the mixer's, as Ruffle's concat", () => {
  const identity = mix(1, 1, 0, 0, 1);
  const global = mix(0.5, 0.75, 0.25, 0.5, 0.5);
  assert.deepEqual(outputMix(identity, global), global);
  assert.deepEqual(outputMix(global, identity), global);

  // Ruffle's integer formula over percents, here in fractions.
  assert.deepEqual(outputMix(mix(-0.5, 1, 0.5, 0, 1), global), mix(0.25, 0.75, 0.625, 0.5, 0.75));
});

// The audio device opens before a movie plays, not at its first sound:
// opening it (new AudioContext) can block the main thread for half a
// second under Linux, which mid-play is a dropped frame. A movie with a
// sound or a stream warms the host as the player is made, a load that
// brings one as it is read, before the frame that shows it; one with
// neither opens no device.

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

const silence = (n: number) => new Uint8Array(n).fill(128);

/** A host that counts its warmings and refuses to decode, so no sound opens it instead. */
function countingHost() {
  const host = {
    warmed: 0,
    decoded: 0,
    warm() {
      host.warmed++;
    },
    decode() {
      host.decoded++;
      return Promise.reject(new Error("no decode expected"));
    },
  };
  return host satisfies AudioHost;
}

/** A SWF of one frame of `tags`, of `version`. */
function swf(tags: Uint8Array[], version = 8): Uint8Array {
  return w.swf({
    version,
    width: 10,
    height: 10,
    frameCount: 1,
    tags: [...tags, w.showFrame(), w.end()],
  });
}

const SOUND = w.defineSound(1, { rate: 0, samples: 4 }, silence(4));
const STREAMING_SPRITE = w.sprite(2, 1, [
  w.soundStreamHead({ rate: 0, samplesPerBlock: 4 }),
  w.soundStreamBlock(silence(4)),
  w.showFrame(),
  w.end(),
]);

function avm1(audio: AudioHost): Avm1 {
  return new Avm1(codegen, { print: () => {}, realTime: null, audio });
}

test("an AVM1 movie with a DefineSound or a sprite's stream warms its host as the player is made", () => {
  for (const tags of [[SOUND], [STREAMING_SPRITE]]) {
    const host = countingHost();
    new Player(swf(tags), null, avm1(host));
    assert.equal(host.warmed, 1);
    assert.equal(host.decoded, 0);
  }
});

test("a movie without sounds opens no device", () => {
  const host = countingHost();
  new Player(swf([w.doAction([0])]), null, avm1(host));
  assert.equal(host.warmed, 0);
});

test("an AS3 movie with a DefineSound warms its host as the player is made", () => {
  const host = countingHost();
  const scripting = new Scripting(codegen, { print: () => {}, audio: host });
  new Player(swf([w.fileAttributes(true), SOUND], 10), scripting);
  assert.equal(host.warmed, 1);
  assert.equal(host.decoded, 0);
});

test("loadMovie of a SWF with a sound warms the host as it arrives, before the frame that shows it", async () => {
  const host = countingHost();
  const played = await play(`createEmptyMovieClip("a", 1).loadMovie("sounds.swf");`, {
    url: "http://example.test/t/test.swf",
    audio: host,
    fetch: files({ "sounds.swf": swf([SOUND]), "quiet.swf": swf([]) }),
  });
  assert.equal(host.warmed, 0, "the root has no sounds");

  await played.deliver();
  assert.equal(host.warmed, 1);
  played.player.tick();
  assert.deepEqual(take(played), []);
  assert.equal(host.decoded, 0);

  const quiet = countingHost();
  const other = await play(`createEmptyMovieClip("a", 1).loadMovie("quiet.swf");`, {
    url: "http://example.test/t/test.swf",
    audio: quiet,
    fetch: files({ "quiet.swf": swf([]) }),
  });
  await other.deliver();
  other.player.tick();
  assert.equal(quiet.warmed, 0);
});
