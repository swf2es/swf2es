// Streamed timelines catch up with the audio device, retaining their frame
// scripts and events. Native Flash 32 likewise runs overdue stream frames
// back to back after a stall, while ordinary timelines resume at normal pace.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { type avm2, avm1 as R } from "@swf2es/runtime";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Avm1 } from "../../../../packages/player/dist/avm1/avm1.js";
import type { MovieClip } from "../../../../packages/player/dist/display/display.js";
import type { AudioHost, PlayingSound } from "../../../../packages/player/dist/media/audio.js";
import { liveSounds } from "../../../../packages/player/dist/media/sounds.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { flashAssembler, script } from "../../../avm1-script.ts";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

const out = fileURLToPath(new URL("../../out/player-stream-sync/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (error) {
  skip = (error as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const actions = (source: string) =>
  w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]);

/** Ten seconds of silence at 25 fps, either on the root or a nested clip. */
function movie(nested = false, abc?: Uint8Array, event = false): Uint8Array {
  const frames: Uint8Array[] = [];
  if (!event) {
    frames.push(w.soundStreamHead({ rate: 1, samplesPerBlock: 441 }));
  }

  for (let i = 0; i < 250; i++) {
    if (!event) {
      frames.push(w.soundStreamBlock(new Uint8Array(441).fill(128)));
    }

    if (!abc) {
      frames.push(actions("_root.actions++;"));
    }

    frames.push(w.showFrame());
  }

  const tags: Uint8Array[] = [w.fileAttributes(!!abc)];
  if (abc) {
    tags.push(w.doAbc(abc, "StreamRoot"), w.symbolClass([[0, "StreamRoot"]]));
  } else {
    tags.push(actions("var actions=0; var events=0; onEnterFrame=function() { events++; };"));
  }

  if (event) {
    tags.push(w.defineSound(1, { rate: 1, samples: 110250 }, new Uint8Array(110250).fill(128)));
    tags.push(w.startSound(1));
  }

  if (nested) {
    tags.push(w.sprite(10, 250, [...frames, w.end()]));
    tags.push(w.place({ depth: 1, character: 10, name: "streamer" }));
    for (let i = 0; i < 250; i++) {
      tags.push(w.showFrame());
    }
  } else {
    tags.push(...frames);
  }

  tags.push(w.end());
  return w.swf({ version: 8, width: 20, height: 20, frameRate: 25, frameCount: 250, tags });
}

/** The device clock can advance independently of the host's clock, or be suspended. */
function device() {
  let now = 0;
  let cursor = 0;
  let suspended = false;
  const plays: { start: number; playing: PlayingSound }[] = [];
  const audio: AudioHost = {
    async decode(sound) {
      assert.ok(!(sound instanceof Uint8Array));
      const duration = (sound.sampleCount * 1000) / sound.sampleRate;
      return {
        durationMs: duration,
        play(start, _loops, _mix, shape) {
          const began = cursor;
          const at = shape?.atMs ?? 0;
          const length = (shape?.endMs ?? duration) - start;
          let stopped = false;
          const playing: PlayingSound = {
            stop() {
              stopped = true;
            },
            setMix() {},
            get ended() {
              return stopped || at + cursor - began >= length;
            },
            get positionMs() {
              return suspended ? Number.NaN : Math.min(length, at + cursor - began);
            },
          };
          plays.push({ start, playing });
          return playing;
        },
      };
    },
  };

  return {
    audio,
    plays,
    realTime: () => now,
    pass(ms: number, deviceMs = ms) {
      now += ms;
      cursor += deviceMs;
    },
    suspend(value: boolean) {
      suspended = value;
    },
  };
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

async function avm1(nested = false, event = false) {
  const clock = device();
  const vm = new Avm1(await createCodegen(wasm), clock);
  const player = new Player(movie(nested, undefined, event), null, vm);
  await player.start();
  await settle();
  const clip = nested ? (player.root.children[0] as MovieClip) : player.root;
  return { clock, vm, player, clip };
}

for (const nested of [false, true]) {
  test(`AVM1 ${nested ? "nested" : "root"} stream keeps up at 10 presentations/s, without losing actions or events`, async (t) => {
    const { clock, player, clip } = await avm1(nested);
    t.mock.method(performance, "now", () => 0);
    let ticks = 0;
    for (let i = 0; i < 80; i++) {
      clock.pass(100);
      const n = player.advance(100, 100);
      assert.ok(n <= 60);
      ticks += n;
      await settle();
    }

    assert.ok(clip.currentFrame >= 200 && clip.currentFrame <= 202, `${clip.currentFrame}`);
    const root = player.root.avm1;
    assert.ok(root);
    assert.equal(R.get(root, "actions", 8), ticks + 1);
    assert.equal(R.get(root, "events", 8), ticks);
    assert.equal(clock.plays.length, 1);
    player.destroy();
  });
}

test("an event sound does not change ordinary timeline pacing", async () => {
  const { clock, player } = await avm1(false, true);
  for (let i = 0; i < 80; i++) {
    clock.pass(100);
    assert.equal(player.advance(100, 100), 1);
  }

  assert.equal(player.root.currentFrame, 81);
  assert.equal(clock.plays.length, 1);
  player.destroy();
});

test("even a stream that has ended catches up in bounded batches without restarting", async () => {
  const { clock, player, clip } = await avm1();
  clock.pass(10000);
  assert.equal(clock.plays[0].playing.ended, true);
  const n = player.advance(10000);
  assert.ok(n > 0 && n <= 60);
  for (let i = 0; i < 3; i++) {
    assert.ok(player.advance(0) <= 60);
  }

  assert.ok(clip.currentFrame > 1 && clip.currentFrame <= 241);
  assert.equal(clock.plays.length, 1);
  player.destroy();
});

test("cheap stream frames keep up even when more than five are needed per presentation", async (t) => {
  const { clock, player, clip } = await avm1();
  t.mock.method(performance, "now", () => 0);
  for (let i = 0; i < 20; i++) {
    clock.pass(250);
    player.advance(250);
  }

  assert.ok(clip.currentFrame >= 125 && clip.currentFrame <= 127, `${clip.currentFrame}`);
  assert.equal(clock.plays.length, 1);
  player.destroy();
});

test("costly stream catch-up yields when its CPU budget is spent", async () => {
  const { clock, player, clip } = await avm1();
  const previous = Object.getOwnPropertyDescriptor(performance, "now");
  let cost = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => cost });
  const advance = clip.advance.bind(clip);
  clip.advance = () => {
    cost += 5;
    advance();
  };
  try {
    clock.pass(2000);
    assert.equal(player.advance(2000), 10);
    assert.equal(player.advance(0), 2, "the remaining debt survives for another bounded turn");
  } finally {
    if (previous) {
      Object.defineProperty(performance, "now", previous);
    } else {
      Reflect.deleteProperty(performance, "now");
    }

    player.destroy();
  }
});

test("render lag gives affordable catch-up frames a larger CPU budget", async (t) => {
  const { clock, player, clip } = await avm1();
  let cost = 0;
  t.mock.method(performance, "now", () => cost);
  const advance = clip.advance.bind(clip);
  clip.advance = () => {
    cost += 3;
    advance();
  };
  for (let i = 0; i < 20; i++) {
    clock.pass(250);
    player.advance(250);
  }

  assert.ok(clip.currentFrame >= 125 && clip.currentFrame <= 127, `${clip.currentFrame}`);
  assert.equal(clock.plays.length, 1);
  player.destroy();
});

test("stopping the stream in a catch-up frame cancels the rest of the batch", async () => {
  const { clock, player, clip } = await avm1();
  const frame = clip.advance.bind(clip);
  clip.advance = () => {
    frame();
    clip.playing = false;
  };
  clock.pass(1000);
  assert.equal(player.advance(1000), 1);
  assert.equal(clip.stream, null);
  player.destroy();
});

test("a suspended audio device does not request catch-up for time it has not played", async () => {
  const { clock, player } = await avm1();
  clock.suspend(true);
  clock.pass(5000, 0);
  assert.equal(player.advance(5000), 1);
  clock.suspend(false);
  assert.equal(player.advance(0), 0);
  clock.pass(100);
  assert.ok(player.advance(100) <= 2);
  player.destroy();
});

test("seeking starts a new stream cursor and discards the old catch-up target", async () => {
  const { clock, vm, player, clip } = await avm1();
  clock.pass(4000);
  player.advance(4000);
  vm.timeline(clip).goto(101, true);
  await settle();
  assert.equal(clock.plays.length, 2);
  assert.equal(clock.plays[1].start, 4000);
  assert.equal(player.advance(0), 0);
  clock.pass(80);
  assert.equal(player.advance(80), 2);
  player.destroy();
});

test("a host without a device cursor retains ordinary pacing without restarting an ended stream", async () => {
  const { clock, player } = await avm1();
  Object.defineProperty(clock.plays[0].playing, "positionMs", { value: undefined });
  for (let i = 0; i < 120; i++) {
    clock.pass(100);
    assert.equal(player.advance(100), 1);
  }

  assert.equal(clock.plays[0].playing.ended, true);
  assert.equal(clock.plays.length, 1);
  player.destroy();
});

test("MP3 block gaps do not turn sample offsets into jumps past intervening frames", async (t) => {
  const frames = [w.soundStreamHead({ format: 2, rate: 1, samplesPerBlock: 441 })];
  for (let i = 0; i < 100; i++) {
    if (i < 10 || (i >= 40 && i < 50)) {
      frames.push(w.soundStreamBlock(new Uint8Array([185, 1, 0, 0])));
    }

    frames.push(w.showFrame());
  }

  const clock = device();
  const vm = new Avm1(await createCodegen(wasm), clock);
  const player = new Player(
    w.swf({
      version: 8,
      width: 20,
      height: 20,
      frameRate: 25,
      frameCount: 100,
      tags: [...frames, w.end()],
    }),
    null,
    vm,
  );
  await player.start();
  await settle();
  t.mock.method(performance, "now", () => 0);
  clock.pass(400);
  player.advance(400);
  assert.equal(player.root.currentFrame, 11);
  clock.pass(1600);
  player.advance(1600);
  assert.equal(player.root.currentFrame, 21);
  for (let i = 0; i < 29; i++) {
    clock.pass(100);
    player.advance(100);
  }

  assert.equal(player.root.currentFrame, 50);
  assert.equal(clock.plays.length, 1, "the ended stream remains attached through its last block");
  clock.pass(100);
  player.advance(100);
  assert.equal(player.root.stream, null);
  player.destroy();
});

async function as3(nested = false, loaded = false) {
  const clock = device();
  const compile = compiler(out);
  const abc = compile(
    "StreamRoot",
    `package {
      import flash.display.MovieClip;
      import flash.events.Event;
      public dynamic class StreamRoot extends MovieClip {
        public var events:int = 0;
        public function StreamRoot() {
          addEventListener(Event.ENTER_FRAME, function(event:Event):void { events++; });
        }
      }
    }`,
  );
  const scripting = new Scripting(await createCodegen(wasm), clock);
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const bytes = loaded ? bare(abc, 1, "StreamRoot", 20, 20) : movie(nested, abc);
  const player = new Player(bytes, scripting);
  player.frameRate = scripting.frameRate = 25;
  await player.start();
  let clip = nested ? (player.root.children[0] as MovieClip) : player.root;
  if (loaded) {
    const rt = scripting.rt;
    const loader = rt.construct(rt.classNamed("flash.display::Loader")) as avm2.AsObject;
    rt.callProperty(player.root.object, rt.publicName("addChild"), loader);
    scripting.loads.requestLoad(loader, movie(true));
    await scripting.settled();
    player.tick();
    const content = rt.getProperty(loader, rt.publicName("content")) as avm2.AsObject;
    clip = (content.$display as MovieClip).children[0] as MovieClip;
  }

  await settle();
  return { clock, player, clip, scripting, bytes };
}

for (const [nested, loaded] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  test(`AS3 stream catches up: nested=${nested}, loaded AVM1=${loaded}`, { skip }, async (t) => {
    const { clock, player, clip, scripting } = await as3(nested, loaded);
    t.mock.method(performance, "now", () => 0);
    const rt = scripting.rt;
    const eventsBefore = rt.getProperty(player.root.object, rt.publicName("events")) as number;
    let ticks = 0;
    for (let i = 0; i < 60; i++) {
      clock.pass(100);
      ticks += player.advance(100, 100);
      await settle();
    }

    assert.ok(clip.currentFrame >= 150 && clip.currentFrame <= 152, `${clip.currentFrame}`);
    assert.equal(rt.getProperty(player.root.object, rt.publicName("events")), eventsBefore + ticks);
    assert.equal(clock.plays.length, 1);
    player.destroy();
  });
}

test("AS3 stream time follows changes to the stage frame rate", { skip }, async (t) => {
  const { clock, player, clip, scripting } = await as3();
  t.mock.method(performance, "now", () => 0);
  for (let i = 0; i < 20; i++) {
    clock.pass(40);
    player.advance(40);
  }

  player.frameRate = scripting.frameRate = 50;
  for (let i = 0; i < 20; i++) {
    clock.pass(100);
    player.advance(100);
  }

  assert.ok(clip.currentFrame >= 120 && clip.currentFrame <= 122, `${clip.currentFrame}`);
  assert.equal(clock.plays.length, 1);
  player.destroy();
});

test("an ended stream still supplies catch-up without holding an audio channel", {
  skip,
}, async () => {
  const { clock, player, clip, scripting } = await as3();
  clock.pass(10000);
  player.advance(10000);
  assert.ok(clip.stream);
  assert.equal(liveSounds(scripting), 0);
  player.destroy();
});

test("a load begun during stream catch-up holds further frames until its content is ready", {
  skip,
}, async () => {
  const { clock, player, scripting, bytes } = await as3();
  const rt = scripting.rt;
  const loader = rt.construct(rt.classNamed("flash.display::Loader")) as avm2.AsObject;
  const tick = player.tick.bind(player);
  let requested = false;
  player.tick = () => {
    tick();
    if (!requested) {
      requested = true;
      scripting.loads.requestLoad(loader, bytes);
    }
  };
  clock.pass(2000);
  assert.equal(player.advance(2000), 1);
  assert.equal(player.advance(0), 0);
  await scripting.settled();
  assert.equal(player.advance(40), 1, "the ready content gets its own resume frame");
  assert.ok(player.advance(0) > 1, "the old stream can catch up again after the load's frame");
  player.destroy();
});
