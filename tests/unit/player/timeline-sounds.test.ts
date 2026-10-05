import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../oracle/oracle.ts";
import { readSwf, type Sound, tags } from "../../../packages/format/dist/index.js";
import {
  type AudioHost,
  browserAudioHost,
  decodeAdpcm,
  type PlayShape,
  streamSound,
} from "../../../packages/player/dist/audio.js";
import { ButtonObject } from "../../../packages/player/dist/display.js";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { readLibrary } from "../../../packages/player/dist/timeline.js";
import { libraryAbcs } from "../../player/libraries.ts";
import { compileScripts } from "../../player/scripts.ts";
import * as w from "../../swf-writer.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../out/player-timeline-sounds/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** Silence at 5512.5 Hz, 8-bit mono: a second of Tone, a tenth of Beep, a frame of stream at 24 fps. */
const TONE = 5512;
const BEEP = 551;
const BLOCK = 230;
const silence = (n: number) => new Uint8Array(n).fill(128);

/**
 * The root places the sprite "streamer", whose four frames each hold a
 * block of its stream, and the button "button", whose over to up and up
 * to over play Beep and Tone. Frame 1 starts Tone from 100 to 500 ms, twice,
 * under an envelope; frame 2 starts Beep twice, SyncNoMultiple; frame 3
 * stops it, SyncStop, and starts Tone by its class, StartSound2; frame 10
 * takes the streamer off.
 */
function timelineSwf(
  script: string,
  main: Uint8Array,
  tone: Uint8Array,
  extra: Uint8Array[],
): Uint8Array {
  const root: Uint8Array[][] = Array.from({ length: 12 }, () => []);
  root[0].push(
    ...extra,
    w.place({ depth: 1, character: 10, name: "streamer" }),
    w.place({ depth: 2, character: 4, name: "button" }),
    w.startSound(1, {
      inPoint: 4410,
      outPoint: 22050,
      loops: 2,
      envelope: [
        { sample: 0, left: 32768, right: 16384 },
        { sample: 44100, left: 0, right: 32768 },
      ],
    }),
  );
  root[1].push(w.startSound(2, { noMultiple: true }), w.startSound(2, { noMultiple: true }));
  root[2].push(w.startSound(2, { stop: true }), w.startSound2("Tone"));
  root[9].push(w.remove(1));
  const streamer: Uint8Array[] = [w.soundStreamHead({ rate: 0, samplesPerBlock: BLOCK })];
  for (let f = 0; f < 4; f++) {
    streamer.push(w.soundStreamBlock(silence(BLOCK)), w.showFrame());
  }

  return w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: root.length,
    tags: [
      w.fileAttributes(true),
      w.defineSound(1, { rate: 0, samples: TONE }, silence(TONE)),
      w.defineSound(2, { rate: 0, samples: BEEP }, silence(BEEP)),
      w.shape({
        id: 3,
        bounds: [0, 200, 0, 200],
        fills: [0xff0000],
        paths: [
          {
            fill1: 1,
            commands: [
              { move: [0, 0] },
              { line: [200, 0] },
              { line: [200, 200] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.button2(4, 3),
      w.buttonSound(4, [{ id: 2 }, { id: 1 }, null, null]),
      w.sprite(10, 4, [...streamer, w.end()]),
      w.doAbc(tone, "Tone"),
      w.doAbc(main, script),
      w.symbolClass([
        [0, script],
        [1, "Tone"],
      ]),
      ...root.flatMap((frame) => [...frame, w.showFrame()]),
      w.end(),
    ],
  });
}

type Entry = (string | number | object | undefined)[];

/**
 * What the timeline plays over `frames` frames, through a device that logs:
 * `between` runs after each frame, `extra` are more tags for the root's
 * first frame, and the device's decodes finish only from frame `decodedAt`.
 */
async function played(
  body: string,
  frames: number,
  options: { between?: (player: Player) => void; extra?: Uint8Array[]; decodedAt?: number } = {},
) {
  const source = `package {
  import flash.display.*;
  import flash.events.*;
  import flash.media.*;
  public dynamic class Main extends MovieClip {
    private var n:int = 0;
    public function Main() {
      addEventListener(Event.ENTER_FRAME, onFrame);
    }
    private function onFrame(event:Event):void {
      n++;
      var streamer:MovieClip = getChildByName("streamer") as MovieClip;
      ${body}
    }
  }
}`;
  const abcs = compileScripts(
    [
      { name: "Main", source },
      {
        name: "Tone",
        source: "package { import flash.media.Sound; public class Tone extends Sound {} }",
      },
    ],
    out,
  );
  const swf = timelineSwf(
    "Main",
    abcs.get("Main") as Uint8Array,
    abcs.get("Tone") as Uint8Array,
    options.extra ?? [],
  );
  const waiting: (() => void)[] = [];
  const log: Entry[] = [];
  let plays = 0;
  let frame = 0;
  const name = (sound: Sound | Uint8Array) =>
    sound instanceof Uint8Array
      ? "bytes"
      : sound.sampleCount === TONE
        ? "tone"
        : sound.sampleCount === BEEP
          ? "beep"
          : `stream ${sound.sampleCount}`;
  const audio: AudioHost = {
    async decode(sound) {
      const label = name(sound);
      if (frame < (options.decodedAt ?? 0)) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }

      return {
        durationMs: (sound as Sound).sampleCount / 5.5125,
        play(start, loops, mix, shape?: PlayShape) {
          const id = plays++;
          log.push([frame, "play", id, label, Math.round(start), loops, mix.volume, shape]);
          return {
            stop: () => log.push([frame, "stop", id]),
            setMix: (next) => log.push([frame, "mix", id, next.volume]),
          };
        },
      };
    },
  };
  const scripting = new Scripting(await createCodegen(wasm), { audio, realTime: null });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
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
    if (frame >= (options.decodedAt ?? 0)) {
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    }

    await settle();
    options.between?.(player);
    await settle();
  }

  return log;
}

/** The stream's entries: its plays, and the stops and mixes of those. */
function streamOnly(log: Entry[]): Entry[] {
  const ids = new Set(log.filter((e) => e[3] === "stream 920").map((e) => e[2]));
  return log.filter((e) => ids.has(e[2]));
}

const envelope = [
  { ms: 0, left: 1, right: 0.5 },
  { ms: 1000, left: 0, right: 1 },
];

test("StartSound plays its in to out point, loops and envelope; NoMultiple and Stop; StartSound2", {
  skip,
}, async () => {
  const log = await played("", 4);
  assert.deepEqual(log, [
    // Tone from 100 ms to 500 ms twice, then the stream, all four blocks, from its first.
    [1, "play", 0, "tone", 100, 2, 1, { endMs: 500, envelope }],
    [1, "play", 1, "stream 920", 0, 1, 1, { endMs: (920 * 1000) / 5512.5 }],
    // One Beep of the two: the second finds it playing.
    [2, "play", 2, "beep", 0, 1, 1, {}],
    // SyncStop stops it; StartSound2 finds Tone by its class.
    [3, "stop", 2],
    [3, "play", 3, "tone", 0, 1, 1, {}],
  ]);
});

test("a stream stops with its clip and starts again at the block it plays on to", {
  skip,
}, async () => {
  // Frames are counted as ENTER_FRAME does, after the timelines advanced.
  const log = await played(
    `if (n == 1) streamer.stop();
      else if (n == 2) streamer.play();
      else if (n == 4) streamer.gotoAndPlay(2);
      else if (n == 5) streamer.gotoAndStop(4);
      else if (n == 6) streamer.gotoAndPlay(1);`,
    8,
  );
  const ms = (samples: number) => Math.round((samples * 1000) / 5512.5);
  const shape = { endMs: (920 * 1000) / 5512.5 };
  assert.deepEqual(streamOnly(log), [
    [1, "play", 1, "stream 920", 0, 1, 1, shape],
    [2, "stop", 1],
    // Played again, it starts at the block of the frame it plays on to, its third.
    [4, "play", 4, "stream 920", ms(2 * BLOCK), 1, 1, shape],
    // A goto stops it, and the frame it lands on starts it.
    [5, "stop", 4],
    [5, "play", 5, "stream 920", ms(BLOCK), 1, 1, shape],
    // gotoAndStop stops it, and starts none.
    [6, "stop", 5],
    [7, "play", 6, "stream 920", 0, 1, 1, shape],
  ]);
});

test("a sprite's transform and the mixer's mix its timeline sounds; stopAll stops them", {
  skip,
}, async () => {
  const log = await played(
    `if (n == 1) streamer.soundTransform = new SoundTransform(0.5);
      else if (n == 2) SoundMixer.soundTransform = new SoundTransform(0.5);
      else if (n == 3) SoundMixer.stopAll();`,
    5,
  );
  const shape = { endMs: (920 * 1000) / 5512.5 };
  assert.deepEqual(log, [
    [1, "play", 0, "tone", 100, 2, 1, { endMs: 500, envelope }],
    [1, "play", 1, "stream 920", 0, 1, 1, shape],
    // The sprite's half, for its stream; Tone is the root's.
    [2, "mix", 0, 1],
    [2, "mix", 1, 0.5],
    [2, "play", 2, "beep", 0, 1, 1, {}],
    [3, "stop", 2],
    // The mixer's half over the sprite's: a quarter, for the stream; for the root's, a half.
    [3, "mix", 0, 0.5],
    [3, "mix", 1, 0.25],
    [3, "play", 3, "tone", 0, 1, 0.5, {}],
    // stopAll stops them all, and the stream starts again at the block it plays on to.
    [4, "stop", 0],
    [4, "stop", 1],
    [4, "stop", 3],
    [5, "play", 4, "stream 920", 0, 1, 0.25, shape],
  ]);
});

test("a button's change of state plays DefineButtonSound's sound for it", { skip }, async () => {
  const log = await played("", 3, {
    between: (player) => {
      const button = player.root.children.find((c) => c instanceof ButtonObject) as ButtonObject;
      if (button.state === "up") {
        button.setState("over");
      } else {
        button.setState("down");
        button.setState("up");
        button.releasedOutside();
      }
    },
  });
  const buttons = log.filter((entry) => entry[1] === "play" && entry[3] !== "stream 920");
  assert.deepEqual(
    buttons.map((entry) => [entry[0], entry[3]]),
    [
      [1, "tone"],
      [2, "beep"],
      // Up to over plays Tone; over to down, and a drag off, down to up, none; a release outside, Beep.
      [2, "tone"],
      [3, "tone"],
      [3, "beep"],
    ],
  );
});

test("a clip a script takes off plays its stream on; one the timeline takes off stops it", {
  skip,
}, async () => {
  const log = await played(
    "if (n == 1) { this.kept = streamer; removeChild(streamer); } else if (n == 2) { addChild(this.kept); }",
    4,
  );
  const shape = { endMs: (920 * 1000) / 5512.5 };
  assert.deepEqual(streamOnly(log), [[1, "play", 1, "stream 920", 0, 1, 1, shape]]);

  // Each loop of its four frames starts it again, from its first block, and frame 10 takes it off.
  assert.deepEqual(streamOnly(await played("", 11)), [
    [1, "play", 1, "stream 920", 0, 1, 1, shape],
    [5, "stop", 1],
    [5, "play", 4, "stream 920", 0, 1, 1, shape],
    [9, "stop", 4],
    [9, "play", 5, "stream 920", 0, 1, 1, shape],
    [10, "stop", 5],
  ]);
});

test("ADPCM decodes as Ruffle's decoder, and a stream's blocks join into one sound", () => {
  // 2-bit codes; a mono packet: sample 0, step index 0, then codes 01, 11, 00 and 10, sign first.
  const bits = "00" + "0000000000000000" + "000000" + "01" + "11" + "00" + "10";
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    bytes[i >> 3] |= Number(bits[i]) << (7 - (i & 7));
  }

  // Step 7: +(3 + 7), index +2; step 9: -(4 + 9), +2; step 11: +5, -1; step 10: -5.
  assert.deepEqual([...decodeAdpcm(bytes, 1)], [10, -3, 2, -3]);

  const { sound, starts } = streamSound(
    { format: 3, sampleRate: 11025, sampleSize: 16, channels: 2, samplesPerBlock: 2 },
    [
      { sampleCount: null, data: new Uint8Array(8) },
      { sampleCount: null, data: new Uint8Array(9) },
    ],
  );
  assert.deepEqual(starts, [0, 2, 4]);
  assert.equal(sound.sampleCount, 4);
  assert.equal(sound.data.length, 16);
});

test("a timeline keeps its StartSound tags by frame, its stream's blocks and its buttons' sounds", () => {
  const swf = readSwf(
    w.swf({
      width: 10,
      height: 10,
      frameCount: 2,
      tags: [
        w.defineSound(1, { rate: 0, samples: 4 }, silence(4)),
        w.button2(4, 1),
        w.buttonSound(4, [null, { id: 1, info: { loops: 3 } }]),
        w.soundStreamHead({ rate: 1, sixteen: true, samplesPerBlock: 459 }),
        w.showFrame(),
        w.startSound(1, { noMultiple: true }),
        w.soundStreamBlock(new Uint8Array(4)),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  const library = readLibrary(swf);
  const info = {
    stop: false,
    noMultiple: true,
    inPoint: null,
    outPoint: null,
    loops: 1,
    envelope: null,
  };
  assert.deepEqual(library.root.sounds, new Map([[2, [{ id: 1, className: null, info }]]]));
  assert.deepEqual(library.root.stream?.head, {
    format: 3,
    sampleRate: 11025,
    sampleSize: 16,
    channels: 1,
    samplesPerBlock: 459,
  });
  assert.deepEqual(library.root.stream?.byFrame, new Map([[2, 0]]));
  const button = library.characters.get(4);
  assert.equal(button?.type, "button");
  assert.deepEqual(button?.type === "button" ? button.sounds?.[1]?.info.loops : null, 3);
  assert.equal(
    swf.tags.some((t) => t.code === tags.SoundStreamHead2),
    true,
  );
});

test("browser audio plays to an out point and scales each channel by the envelope", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const started: number[][] = [];
  const automation: [string, number, number][][] = [];
  const param = () => {
    const calls: [string, number, number][] = [];
    automation.push(calls);
    return {
      value: 1,
      setValueAtTime: (v: number, t: number) => calls.push(["set", v, t]),
      linearRampToValueAtTime: (v: number, t: number) => calls.push(["ramp", v, t]),
    };
  };
  const node = () => ({ connect: () => {}, disconnect: () => {}, gain: param() });
  let decoded: number[] = [];
  class FakeAudioContext {
    currentTime = 1;
    destination = {};
    createBuffer(_count: number, samples: number, rate: number) {
      const data = new Float32Array(samples);
      decoded = [];
      return {
        duration: samples / rate,
        numberOfChannels: 1,
        getChannelData: () =>
          new Proxy(data, {
            set: (target, key, value) => {
              decoded.push(value);
              return Reflect.set(target, key, value);
            },
          }),
      };
    }
    createBufferSource() {
      return {
        ...node(),
        start: (...args: number[]) => started.push(args),
        stop: () => {},
      };
    }
    createChannelSplitter() {
      return node();
    }
    createChannelMerger() {
      return node();
    }
    createGain() {
      return node();
    }
    async resume() {}
  }

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  try {
    automation.length = 0;
    const host = browserAudioHost();
    assert.ok(host);
    // An ADPCM sound decodes to its samples: two of 2-bit codes, as the decoder's own test.
    const clip = await host.decode({
      id: 1,
      format: 1,
      sampleRate: 11025,
      sampleSize: 16,
      channels: 1,
      sampleCount: 4,
      seekSamples: 0,
      data: new Uint8Array([0, 0, 0, 0b01110010]),
    });
    assert.deepEqual(
      decoded.map((v) => Math.round(v * 32768)),
      [10, -3, 2, -3],
    );

    automation.length = 0;
    const mix = { volume: 1, leftToLeft: 1, leftToRight: 0, rightToLeft: 0, rightToRight: 1 };
    clip.play(0, 1, mix, {
      endMs: 0.25,
      envelope: [
        { ms: 0, left: 1, right: 0.5 },
        { ms: 1000, left: 0, right: 1 },
      ],
    });
    assert.deepEqual(started, [[0, 0, 0.25 / 1000]]);
    // Only the envelope's levels move: the first point's from the start, then lines to each.
    const levels = automation.filter((calls) => calls.length > 0);
    assert.deepEqual(levels, [
      [
        ["set", 1, 1],
        ["ramp", 1, 1],
        ["ramp", 0, 2],
      ],
      [
        ["set", 0.5, 1],
        ["ramp", 0.5, 1],
        ["ramp", 1, 2],
      ],
    ]);

    // Started late, a quarter of the envelope's second in: its levels by then, then on to its end.
    automation.length = 0;
    started.length = 0;
    clip.play(0, 1, mix, {
      atMs: 0.125,
      envelope: [
        { ms: 0, left: 1, right: 0.5 },
        { ms: 0.5, left: 0, right: 1 },
      ],
    });
    assert.deepEqual(started, [[0, 0.125 / 1000]]);
    assert.deepEqual(
      automation.filter((calls) => calls.length > 0),
      [
        [
          ["set", 0.75, 1],
          ["ramp", 0, 1 + 0.375 / 1000],
        ],
        [
          ["set", 0.625, 1],
          ["ramp", 1, 1 + 0.375 / 1000],
        ],
      ],
    );
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "AudioContext", previous);
    } else {
      Reflect.deleteProperty(globalThis, "AudioContext");
    }
  }
});

test("a goto to the frame a clip is on leaves its stream playing", { skip }, async () => {
  const log = await played("if (n == 2) streamer.gotoAndPlay(streamer.currentFrame);", 5);
  const shape = { endMs: (920 * 1000) / 5512.5 };
  assert.deepEqual(streamOnly(log), [
    [1, "play", 1, "stream 920", 0, 1, 1, shape],
    // The loop to its first frame stops it and starts it again.
    [5, "stop", 1],
    [5, "play", 4, "stream 920", 0, 1, 1, shape],
  ]);
});

test("a goto plays the sounds of the frame it lands on, not of those it passes", {
  skip,
}, async () => {
  // Frame 2's Beeps play as the root plays on to it; the rewind to frame 1
  // starts Tone again; the jump to frame 4 passes frame 3's StartSound2 by.
  const log = await played(
    "if (n == 1) { gotoAndStop(1); } else if (n == 2) { gotoAndStop(4); }",
    3,
  );
  assert.deepEqual(
    log.filter((e) => e[1] === "play" && e[3] !== "stream 920").map((e) => [e[0], e[3], e[4]]),
    [
      [1, "tone", 100],
      // Tone's decode is done, Beep's first takes a moment longer.
      [2, "tone", 100],
      [2, "beep", 0],
    ],
  );
});

test("a decode that takes frames starts its sounds as far in as the clock has run", {
  skip,
}, async () => {
  const log = await played("", 3, { decodedAt: 3 });
  const frameMs = 1000 / 24;
  const near = (entry: Entry) => [
    entry[0],
    entry[3],
    Math.round(((entry[7] as PlayShape).atMs ?? 0) * 100) / 100,
  ];
  // Tone and the stream were due at frame 1, and start two frames in; frame
  // 2's Beep, still decoding, is stopped by frame 3's SyncStop before it
  // starts; frame 3's Tone, by its class, is on time.
  assert.deepEqual(log.filter((e) => e[1] === "play").map(near), [
    [3, "tone", Math.round(2 * frameMs * 100) / 100],
    [3, "tone", 0],
    [3, "stream 920", Math.round(2 * frameMs * 100) / 100],
  ]);
});

test("a sound over by the clock still stops, and stops for good soon after", {
  skip,
}, async () => {
  // Tone, 400 ms twice from frame 1, is over by the clock at frame 21; the
  // mixer's stopAll at frame 22 still reaches it on the device.
  const stopped = await played("if (n == 21) SoundMixer.stopAll();", 22);
  assert.deepEqual(
    stopped.filter((e) => e[2] === 0),
    [
      [1, "play", 0, "tone", 100, 2, 1, { endMs: 500, envelope }],
      [22, "stop", 0],
    ],
  );

  // Left alone, it is stopped once its tail has passed.
  const left = await played("", 25);
  assert.deepEqual(
    left.filter((e) => e[2] === 0 && e[1] === "stop"),
    [[24, "stop", 0]],
  );
});

test("no more than 32 sounds play at once", { skip }, async () => {
  const beeps = Array.from({ length: 40 }, () => w.startSound(2));
  const log = await played("", 1, { extra: beeps });
  // Frame 1's 40 Beeps come before Tone; the stream, the streamer's, after them all.
  assert.equal(log.filter((e) => e[1] === "play").length, 32);
  assert.equal(log.filter((e) => e[3] === "stream 920").length, 0);
});

test("an MP3 stream joins its blocks' frames, counted by the blocks' sample counts", () => {
  const block = (count: number, frames: number[]) =>
    w.soundStreamBlock(new Uint8Array([count & 0xff, count >> 8, 0, 0, ...frames]));
  const swf = readSwf(
    w.swf({
      width: 10,
      height: 10,
      frameCount: 3,
      tags: [
        w.soundStreamHead({ format: 2, rate: 3, sixteen: true, samplesPerBlock: 1152 }),
        block(1152, [1, 2]),
        w.showFrame(),
        block(0, []),
        w.showFrame(),
        block(2304, [3, 4, 5]),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  const stream = readLibrary(swf).root.stream;
  assert.ok(stream);
  const { sound, starts } = streamSound(stream.head, stream.blocks);
  assert.deepEqual(starts, [0, 1152, 1152, 3456]);
  assert.deepEqual([...sound.data], [1, 2, 3, 4, 5]);
  assert.equal(sound.format, 2);
  assert.equal(sound.sampleCount, 3456);
});
