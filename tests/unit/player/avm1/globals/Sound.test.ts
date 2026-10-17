// AVM1's sounds in node, through a device that logs what it is asked to
// play: the timeline's StartSound and Sound's start, under Sound's
// transforms, onSoundComplete with the frame its time ran out, and stops.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { Sound } from "../../../../../packages/format/dist/index.js";
import { Avm1 } from "../../../../../packages/player/dist/avm1/avm1.js";
import type { AudioHost, SoundMix } from "../../../../../packages/player/dist/media/audio.js";
import { Player } from "../../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

/** Silence at 5512.5 Hz, 8-bit mono: a second of Tone, a tenth of Beep. */
const TONE = 5512;
const BEEP = 551;
const silence = (n: number) => new Uint8Array(n).fill(128);
const as1 = (source: string) => w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]);

/** Frame 1 starts Tone on the timeline and runs `first`; each later frame `n` runs `frames[n]`. */
function soundSwf(first: string, frames: Record<number, string> = {}): Uint8Array {
  const count = 12;
  const root: Uint8Array[][] = Array.from({ length: count }, () => []);
  root[0].push(w.startSound(1), as1(first));
  for (const [n, source] of Object.entries(frames)) {
    root[Number(n) - 1].push(as1(source));
  }

  return w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: count,
    tags: [
      w.defineSound(1, { rate: 0, samples: TONE }, silence(TONE)),
      w.defineSound(2, { rate: 0, samples: BEEP }, silence(BEEP)),
      w.exportAssets([[2, "beep"]]),
      w.sprite(3, 1, [w.showFrame(), w.end()]),
      w.exportAssets([[3, "clip"]]),
      ...root.flatMap((frame) => [...frame, w.showFrame()]),
      w.end(),
    ],
  });
}

type Entry = (string | number)[];

/** The SWF played `frames` frames on a device that logs its plays, mixes and stops, and the traces. */
async function play(swf: Uint8Array, frames = 12): Promise<{ log: Entry[]; lines: string[] }> {
  const log: Entry[] = [];
  const lines: string[] = [];
  let frame = 0;
  let plays = 0;
  const audio: AudioHost = {
    async decode(sound) {
      const label = (sound as Sound).sampleCount === TONE ? "tone" : "beep";
      return {
        durationMs: (sound as Sound).sampleCount / 5.5125,
        play(start, loops, mix) {
          const id = plays++;
          log.push([
            frame,
            "play",
            id,
            label,
            Math.round(start),
            loops,
            mix.volume,
            mix.leftToLeft,
          ]);
          return {
            stop: () => log.push([frame, "stop", id]),
            setMix: (next: SoundMix) => log.push([frame, "mix", id, next.volume, next.leftToLeft]),
          };
        },
      };
    },
  };
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(`${frame}: ${line}`),
    realTime: null,
    audio,
  });
  const player = new Player(swf, null, avm1);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  frame = 1;
  await player.start();
  await settle();
  for (frame = 2; frame <= frames; frame++) {
    player.tick();
    await settle();
  }

  return { log, lines };
}

test("Sound plays an exported sound under its transform, and hears its end with the frame", async () => {
  const { log, lines } = await play(
    soundSwf(
      `var s = new Sound();
      trace(s.duration + " " + s.getVolume() + " " + s.getPan());
      s.attachSound("beep");
      trace(s.duration + " " + s.position + " " + s.getDuration());
      s.onSoundComplete = function () { trace("complete " + this.position); };
      s.setVolume(50);
      s.start(0, 2);`,
      {
        3: `s.setPan(-40); trace(s.getPan() + " " + s.getTransform().ll + " " + s.getTransform().rr);`,
      },
    ),
  );
  assert.deepEqual(lines, [
    "1: undefined 100 0",
    "1: 100 0 100",
    "3: -40 100 60",
    // Two loops of a tenth of a second, over by the fifth frame at 24 fps.
    "6: complete 100",
  ]);
  assert.deepEqual(log, [
    // The global transform is over every sound, the timeline's too.
    [1, "play", 0, "tone", 0, 1, 0.5, 1],
    [1, "play", 1, "beep", 0, 2, 0.5, 1],
    [3, "mix", 0, 0.5, 1],
    [3, "mix", 1, 0.5, 1],
    // Over by the clock, the device, which cannot tell its end, is told a tenth of a second on.
    [9, "stop", 1],
  ]);
});

test("a clip's Sound sets the clip's transform, and stop() stops what plays under it", async () => {
  const { log, lines } = await play(
    soundSwf(
      `var mc = attachMovie("clip", "mc", 1);
      var s = new Sound(mc);
      s.attachSound("beep");
      s.setVolume(30);
      s.start(0.05, 4);
      var all = new Sound();
      all.attachSound("beep");
      all.start();
      trace(new Sound(mc).getVolume() + " " + all.getVolume() + " " + new Sound("nothing").getVolume());`,
      {
        3: "s.stop(); trace(s.position);",
        4: 'all.stop("beep");',
        5: 'all.attachSound("beep"); all.start(); all.start(); new Sound().stop();',
      },
    ),
  );
  // Started 50 ms in, each loop plays the last 50 ms again: 83 ms on, it is at 83.
  assert.deepEqual(lines, ["1: 30 100 undefined", "3: 83"]);
  assert.deepEqual(log, [
    [1, "play", 0, "tone", 0, 1, 1, 1],
    [1, "play", 1, "beep", 50, 4, 0.3, 1],
    [1, "play", 2, "beep", 0, 1, 1, 1],
    [3, "stop", 1],
    [4, "stop", 2],
    // The global Sound's stop stops all, the timeline's too, and the two it started that frame
    // before their decodes come, so they never reach the device.
    [5, "stop", 0],
  ]);
});
