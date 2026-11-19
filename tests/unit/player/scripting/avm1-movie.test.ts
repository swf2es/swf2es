// AVM1 movies an AS3 Loader holds, with the player around them: one mixer
// for both VMs' sounds. The host is scripts/LoadedAvm1Lifecycle.as, the
// movies tests/avm1-lifecycle.ts. What each test expects was measured in
// Flash Player 32 (adl) with probes that do the same.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { AudioHost } from "../../../../packages/player/dist/media/audio.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { soundMovie } from "../../../avm1-lifecycle.ts";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/loaded-avm1-lifecycle/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A device that plays nothing: every sound holds a channel until stopped. */
const audio: AudioHost = {
  async decode() {
    return {
      durationMs: 1000,
      play: () => ({ stop() {}, setMix() {} }),
    };
  },
};

async function play(movie: Uint8Array, url = "http://example.test/swf/main.swf") {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    url,
    audio,
    fetch: async () => ({ bytes: movie, status: 200, headers: [] }),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(
    bare(compiler(out)("LoadedAvm1Lifecycle"), 1, "LoadedAvm1Lifecycle", 200, 150),
    scripting,
  );
  await player.start();
  const host = player.root.object;
  const control = (command: string) =>
    scripting.rt.callProperty(host, scripting.rt.publicName("control"), command);
  const later = (type: "enterFrame" | "exitFrame", commands: string) =>
    scripting.rt.callProperty(host, scripting.rt.publicName("later"), type, commands);
  const tick = async () => {
    await scripting.settled();
    player.tick();
  };
  let seen = 0;
  /** Frames played until `line` comes, after the last it waited for. */
  const until = async (line: string) => {
    for (let i = 0; i < 40 && lines.indexOf(line, seen) < 0; i++) {
      await tick();
    }

    const at = lines.indexOf(line, seen);
    assert.ok(at >= 0, `no ${line}`);
    seen = at + 1;
  };
  return { player, scripting, lines, control, later, tick, until };
}

test("a loaded movie's sounds play under SoundMixer: one transform, one stop, 32 channels", {
  skip,
}, async () => {
  const p = await play(soundMovie());
  try {
    // Kept in hundredths, which the movie reads as whole percents.
    p.control("setMixer 0.333 0.25");
    p.control("load");
    await p.until("avm1:g 33 14 86 0 0 111");
    await p.until("avm1:setVolume 33 14 86 0 0 111");
    p.control("mixer");
    await p.until("avm1:setPan 33 -50 100 0 0 50");
    p.control("mixer");
    await p.until("avm1:setTransform 33 40 60 20 10 70");
    p.control("mixer");
    await p.until("avm1:setVolume 250 40 60 20 10 70");
    p.control("mixer");
    // An AS3 pan past 1 leaves a right to right of NaN, which Flash keeps as -2^31.
    p.control("setMixer 1.7 -2");
    p.control("mixer");
    await p.until("avm1:g 170 -73 173 0 0 -2147483648");
    p.control("setMixer 1 0");

    // The movie's 32 sounds leave AS3 none, until its global Sound stops them.
    await p.until("avm1:started");
    p.control("play");
    await p.until("avm1:stop");
    p.control("play");
    p.control("position");
    // The global Sound's stop, and stopAllSounds, stop AS3's channels too.
    await p.until("avm1:started");
    await p.until("avm1:stopAllSounds");
    p.control("position");
    await p.tick();
    p.control("position");
    // And SoundMixer.stopAll stops the movie's.
    await p.until("avm1:started");
    p.control("play");
    p.control("stopAll");
    p.control("play");
    assert.deepEqual(p.lines, [
      "avm1:g 33 14 86 0 0 111",
      "avm1:setVolume 33 14 86 0 0 111",
      "as3:mixer 0.33 0.86 0 0 1.11",
      "avm1:setPan 33 -50 100 0 0 50",
      "as3:mixer 0.33 1 0 0 0.5",
      // lr is right to left, rl left to right.
      "avm1:setTransform 33 40 60 20 10 70",
      "as3:mixer 0.33 0.6 0.1 0.2 0.7",
      "avm1:setVolume 250 40 60 20 10 70",
      "as3:mixer 2.5 0.6 0.1 0.2 0.7",
      "as3:mixer 1.7 1.73 0 0 -21474836.48",
      "avm1:g 170 -73 173 0 0 -2147483648",
      "avm1:started",
      "as3:play null",
      "avm1:stop",
      "as3:play channel",
      "as3:position on",
      "avm1:started",
      "avm1:stopAllSounds",
      "as3:position on",
      "as3:position stopped",
      "avm1:started",
      "as3:play null",
      "as3:play channel",
    ]);
  } finally {
    p.player.destroy();
  }
});
