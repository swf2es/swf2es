import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { AudioHost, SoundMix } from "../../../../../../packages/player/dist/media/audio.js";
import { outputMix } from "../../../../../../packages/player/dist/media/sounds.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { playerNatives } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { toneScript } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { type Compile, compileScripts } from "../../../../../player/scripts.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../../../out/player-sound-mixer/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

const mix = (
  volume: number,
  leftToLeft: number,
  leftToRight: number,
  rightToLeft: number,
  rightToRight: number,
): SoundMix => ({ volume, leftToLeft, leftToRight, rightToLeft, rightToRight });

test("SoundMixer keeps AIR's playback settings and the stream buffer time", async () => {
  const s = new Scripting(await createCodegen(wasm), { audio: null });
  const natives = playerNatives(s);
  const get = (name: string) => natives[`flash.media::SoundMixer.get:${name}`](s.rt).call(null);
  const set = (name: string, value: unknown) =>
    natives[`flash.media::SoundMixer.set:${name}`](s.rt).call(null, value);

  assert.equal(get("audioPlaybackMode"), "media");
  set("audioPlaybackMode", "voice");
  assert.equal(get("audioPlaybackMode"), "voice");
  assert.equal(get("useSpeakerphoneForVoice"), false);
  set("useSpeakerphoneForVoice", true);
  assert.equal(get("useSpeakerphoneForVoice"), true);
  assert.equal(get("bufferTime"), 5);
  set("bufferTime", 7.9);
  assert.equal(get("bufferTime"), 7);
  assert.equal(natives["flash.media::SoundMixer.areSoundsInaccessible"](s.rt).call(null), false);
});

test("SoundMixer's transform reaches playing and later channels, and stopAll stops them", {
  skip,
}, async () => {
  const source = readFileSync(new URL("./SoundMixerMain.as", import.meta.url), "utf8");
  const compile: Compile = (name, given) =>
    compileScripts([{ name, source: given ?? source }], out).get(name) as Uint8Array;
  const swf = toneScript("Main")(compile);

  const log: unknown[] = [];
  let plays = 0;
  const audio: AudioHost = {
    async decode() {
      return {
        durationMs: 1000,
        play(_start, _loops, played) {
          const id = plays++;
          log.push(["play", id, played]);
          return {
            stop: () => log.push(["stop", id]),
            setMix: (next) => log.push(["setMix", id, next]),
          };
        },
      };
    },
  };
  const scripting = new Scripting(await createCodegen(wasm), { audio });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  const decoded = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  await decoded();
  player.tick();
  await decoded();
  player.tick();

  const global = mix(0.5, 0.75, 0.25, 0.5, 0.5);
  assert.deepEqual(log, [
    ["play", 0, mix(0.5, 1, 0, 0, 1)],
    ["setMix", 0, mix(0.25, 0.75, 0.25, 0.5, 0.5)],
    ["play", 1, outputMix(mix(-0.5, 1, 0.5, 0, 1), global)],
    ["stop", 0],
    ["stop", 1],
  ]);
});
