// AVM1's sounds in node, through a device that logs what it is asked to
// play: the timeline's StartSound and Sound's start, under Sound's
// transforms, onSoundComplete with the frame its time ran out, and stops.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { Sound } from "../../../../../packages/format/dist/index.js";
import { Avm1, type Avm1Options } from "../../../../../packages/player/dist/avm1/avm1.js";
import type { AudioHost, SoundMix } from "../../../../../packages/player/dist/media/audio.js";
import { Player } from "../../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";
import { files } from "../network.ts";

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

/**
 * The SWF played `frames` frames on a device that logs its plays, mixes and
 * stops, and the traces; what it loads fetched by `fetch`.
 */
async function play(
  swf: Uint8Array,
  frames = 12,
  fetch?: Avm1Options["fetch"],
): Promise<{ log: Entry[]; lines: string[] }> {
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
    fetch,
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

test("a Sound keeps its target's path: a removed clip's names nothing, a level's from the level", async () => {
  const { lines } = await play(
    soundSwf(
      `createEmptyMovieClip("a", 1);
      a.createEmptyMovieClip("mc2", 1);
      var c = a.mc2;
      a.mc2.removeMovieClip();
      var dead = new Sound(c);
      createEmptyMovieClip("mc2", 7);
      new Sound(mc2).setVolume(55);
      a.createEmptyMovieClip("lk", 2);
      a.lk._lockroot = true;
      a.lk.createEmptyMovieClip("snd", 1);
      new Sound(a.lk.snd).setVolume(30);
      trace(dead.getVolume() + " " + new Sound("_level0.a.lk.snd").getVolume() + " " + new Sound("").getVolume());`,
    ),
  );
  // A clip made where the removed one was, or anywhere by its name, is not its clip (adl).
  assert.deepEqual(lines, ["1: undefined 30 undefined"]);
});

test("in a movie of its own, a string's _root under a _lockroot clip is the clip locked", async () => {
  // Flash Player 32's projector: code in `lk`, locked, finds its own `snd` by "_root.snd", and
  // nothing by "_root.lk.snd"; `_level0` is the level whatever is locked.
  const locker = as1(`this._lockroot = true;
createEmptyMovieClip("snd", 5);
new Sound(snd).setVolume(30);
_parent.createEmptyMovieClip("snd", 9);
new Sound(_parent.snd).setVolume(44);
_parent.rel = new Sound("snd");
_parent.r = "root=" + _root + " str=" + new Sound("_root.snd").getVolume() + " full=" + new Sound("_root.lk.snd").getVolume() + " lvl=" + new Sound("_level0.snd").getVolume() + " lvlfull=" + new Sound("_level0.lk.snd").getVolume() + " rel=" + new Sound("snd").getVolume() + " up=" + new Sound("../snd").getVolume() + " par=" + new Sound("_parent.snd").getVolume() + " sl=" + new Sound("/snd").getVolume() + " sl2=" + new Sound("/lk/snd").getVolume() + " clip=" + new Sound(snd).getVolume() + " rootclip=" + new Sound(_root.snd).getVolume();
stop();`);
  const swf = w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.sprite(10, 2, [w.showFrame(), locker, w.showFrame(), w.end()]),
      w.place({ depth: 20, character: 10, name: "lk" }),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      as1(`trace(r + " | later rel=" + rel.getVolume()); stop();`),
      w.showFrame(),
      w.end(),
    ],
  });
  const { lines } = await play(swf, 6);
  assert.deepEqual(lines, [
    "4: root=_level0.lk str=30 full=undefined lvl=44 lvlfull=30 rel=30 up=44 par=44 sl=30 sl2=undefined clip=30 rootclip=30 | later rel=44",
  ]);
});

test("a loaded movie's Sounds stop as it goes; a clip's of the movie that removes it plays on", async () => {
  // adl: the child's Sound on a clip of its own stops, and never completes, when the child is
  // removed, unloaded or replaced; the parent's Sound on a clip it removes completes.
  const child = w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.defineSound(1, { rate: 0, samples: TONE }, silence(TONE)),
      w.exportAssets([[1, "loop"]]),
      w.sprite(2, 1, [w.showFrame(), w.end()]),
      w.place({ depth: 1, character: 2, name: "inner" }),
      as1(`_root.inChild = new Sound(inner);
_root.inChild.attachSound("loop");
_root.inChild.start();`),
      w.showFrame(),
      w.end(),
    ],
  });
  const empty = w.swf({ version: 8, width: 20, height: 20, frameCount: 1, tags: [w.end()] });
  // How each takes it away, and the frame its sound stops: an unload empties the clip a frame
  // later, and a load into it when the new movie arrives.
  const takeAway: Record<string, [string, number]> = {
    removeMovieClip: ["holder.removeMovieClip();", 4],
    createEmptyMovieClip: ['createEmptyMovieClip("holder", 1);', 4],
    unloadMovie: ["holder.unloadMovie();", 5],
    unloadClip: ["new MovieClipLoader().unloadClip(holder);", 5],
    loadMovie: ['holder.loadMovie("empty.swf");', 5],
  };
  for (const [name, [source, stopped]] of Object.entries(takeAway)) {
    const parent = w.swf({
      version: 8,
      width: 20,
      height: 20,
      frameCount: 1,
      tags: [
        w.defineSound(2, { rate: 0, samples: BEEP }, silence(BEEP)),
        w.exportAssets([[2, "beep"]]),
        as1(`createEmptyMovieClip("holder", 1);
createEmptyMovieClip("local", 2);
new MovieClipLoader().loadClip("child.swf", holder);
var inParent = new Sound(local);
inParent.attachSound("beep");
inParent.onSoundComplete = function () { trace("parent's complete"); };
inParent.start(0, 3);
var n = 0;
onEnterFrame = function () {
  n++;
  if (n == 3) {
    inChild.onSoundComplete = function () { trace("child's complete"); };
    ${source}
    local.removeMovieClip();
  }
};`),
        w.showFrame(),
        w.end(),
      ],
    });
    const { log, lines } = await play(
      parent,
      40,
      files({ "child.swf": child, "empty.swf": empty }),
    );
    assert.deepEqual(lines, ["9: parent's complete"], name);
    assert.deepEqual(
      log.filter((entry) => entry[1] !== "mix"),
      [
        [1, "play", 0, "beep", 0, 3, 1, 1],
        [2, "play", 1, "tone", 0, 1, 1, 1],
        [stopped, "stop", 1],
        [12, "stop", 0],
      ],
      name,
    );
  }
});

test("a sound of the movie that plays on: the parent's on the clip a load fills, one a movie removes from itself", async () => {
  // adl: a sound stops with the loaded movie whose own it is, and only then. The parent's Sound
  // on the clip it loads into completes through the load (or a failed one), the loaded movie's
  // unload and the clip's removal; so does one on a clip of its own that unloadMovie emptied
  // though nothing was loaded, and a loaded movie's sound on a clip it removes itself. A movie
  // loaded by a loaded movie goes with it.
  const childTags = (extra: string) => [
    w.defineSound(1, { rate: 0, samples: TONE }, silence(TONE)),
    w.exportAssets([[1, "loop"]]),
    w.sprite(2, 1, [w.showFrame(), w.end()]),
    w.place({ depth: 1, character: 2, name: "inner" }),
    as1(`_root.inChild = new Sound(inner);
_root.inChild.attachSound("loop");
_root.inChild.onSoundComplete = function () { trace("child's complete"); };
_root.inChild.start();
${extra}`),
  ];
  const movie = (tags: Uint8Array[]) =>
    w.swf({ version: 8, width: 20, height: 20, frameCount: 1, tags: [...tags, w.end()] });
  const byName = {
    "empty.swf": movie([w.showFrame()]),
    "child.swf": movie([...childTags(""), w.showFrame()]),
    "own.swf": movie([
      ...childTags(`var k = 0;
this.onEnterFrame = function () { k++; if (k == 3) { inner.swapDepths(10); inner.removeMovieClip(); } };`),
      w.showFrame(),
    ]),
    "middle.swf": movie([
      as1(`createEmptyMovieClip("deep", 1); deep.loadMovie("child.swf");`),
      w.showFrame(),
    ]),
  };
  const bgm = `bgm = new Sound(holder);
bgm.attachSound("ploop");
bgm.onSoundComplete = function () { trace("parent's complete"); };
bgm.start();`;
  const cases: Record<string, [string, string]> = {
    "a first load": [`${bgm} holder.loadMovie("empty.swf");`, ""],
    "a failed load": [`${bgm} holder.loadMovie("missing.swf");`, ""],
    "an unload": [`${bgm} holder.loadMovie("empty.swf");`, "holder.unloadMovie();"],
    "a removal": [`${bgm} holder.loadMovie("empty.swf");`, "holder.removeMovieClip();"],
    "an unload of what never loaded": [`holder.unloadMovie();`, `${bgm} holder.removeMovieClip();`],
    "a removal of a movie that loaded one": [
      `holder.loadMovie("middle.swf");`,
      "holder.removeMovieClip();",
    ],
    "a clip a loaded movie removes": [`holder.loadMovie("own.swf");`, ""],
  };
  const heard: Record<string, (string | Entry)[]> = {};
  for (const [name, [first, later]] of Object.entries(cases)) {
    const parent = movie([
      w.defineSound(2, { rate: 0, samples: TONE }, silence(TONE)),
      w.exportAssets([[2, "ploop"]]),
      as1(`createEmptyMovieClip("holder", 1);
${first}
var n = 0;
onEnterFrame = function () { n++; if (n == 4) { ${later} } };`),
      w.showFrame(),
    ]);
    const { lines, log } = await play(parent, 40, files(byName));
    heard[name] = [...lines, ...log.filter((entry) => entry[1] !== "mix")];
  }

  // The parent's sound starts with frame 1 and completes with frame 25; the device, told a
  // finished sound's stop a tenth of a second on, logs it 3 frames later.
  const parents: (string | Entry)[] = [
    "25: parent's complete",
    [1, "play", 0, "tone", 0, 1, 1, 1],
    [28, "stop", 0],
  ];
  assert.deepEqual(heard, {
    "a first load": parents,
    "a failed load": parents,
    "an unload": parents,
    "a removal": parents,
    "an unload of what never loaded": [
      "29: parent's complete",
      [5, "play", 0, "tone", 0, 1, 1, 1],
      [32, "stop", 0],
    ],
    // The child's sound starts as the movie the middle loads arrives, and stops with the middle.
    "a removal of a movie that loaded one": [
      [3, "play", 0, "tone", 0, 1, 1, 1],
      [5, "stop", 0],
    ],
    "a clip a loaded movie removes": [
      "26: child's complete",
      [2, "play", 0, "tone", 0, 1, 1, 1],
      [29, "stop", 0],
    ],
  });
});
