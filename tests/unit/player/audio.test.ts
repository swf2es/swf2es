import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createCodegen } from "@swf2es/codegen";
import { readSwf, type Sound, tags } from "../../../packages/format/dist/index.js";
import { browserAudioHost, type DecodedSound } from "../../../packages/player/dist/audio.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { readLibrary, type SoundCharacter } from "../../../packages/player/dist/timeline.js";
import { BitWriter, end, showFrame, swf, tag } from "../../swf-writer.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

test("browser audio decodes SWF PCM and plays through its four channel coefficients", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const gains: { gain: { value: number }; connect: () => void }[] = [];
  const started: number[] = [];
  const stopped: (number | undefined)[] = [];
  let disconnected = 0;
  const channels = [new Float32Array(2), new Float32Array(2)];
  const sourceNode = {
    buffer: null as unknown,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    onended: null as (() => void) | null,
    connect: () => {},
    disconnect: () => disconnected++,
    start: (_when: number, offset: number) => started.push(offset),
    stop: (when?: number) => stopped.push(when),
  };
  const node = { connect: () => {}, disconnect: () => disconnected++ };
  class FakeAudioContext {
    currentTime = 2;
    destination = {};
    createBuffer(count: number, samples: number, rate: number) {
      assert.equal(count, 2);
      assert.equal(samples, 2);
      return {
        duration: samples / rate,
        numberOfChannels: count,
        getChannelData: (channel: number) => channels[channel],
      };
    }
    createBufferSource() {
      return sourceNode;
    }
    createChannelSplitter() {
      return node;
    }
    createChannelMerger() {
      return node;
    }
    createGain() {
      const gain = { gain: { value: 0 }, connect: () => {}, disconnect: () => disconnected++ };
      gains.push(gain);
      return gain;
    }
    async resume() {}
  }

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  try {
    const host = browserAudioHost();
    assert.ok(host);
    const sound: Sound = {
      id: 1,
      format: 3,
      sampleRate: 11025,
      sampleSize: 16,
      channels: 2,
      sampleCount: 2,
      seekSamples: 0,
      data: new Uint8Array([0, 0x40, 0, 0xc0, 0, 0x20, 0, 0xe0]),
    };
    const clip = await host.decode(sound);
    assert.deepEqual([...channels[0]], [0.5, 0.25]);
    assert.deepEqual([...channels[1]], [-0.5, -0.25]);

    const playing = clip.play(0, 1, {
      volume: 0.5,
      leftToLeft: 1,
      leftToRight: 0.25,
      rightToLeft: 0.5,
      rightToRight: 1,
    });
    assert.ok(playing);
    assert.deepEqual(
      gains.map((g) => g.gain.value),
      [0.5, 0.125, 0.25, 0.5],
    );
    assert.deepEqual(started, [0]);
    assert.equal(sourceNode.loop, false);
    assert.equal(stopped.length, 0);
    playing.stop();
    assert.equal(stopped.length, 1);
    assert.equal(disconnected, 7);
    sourceNode.onended?.();
    assert.equal(disconnected, 7);

    const repeated = clip.play(0, 3, {
      volume: 1,
      leftToLeft: 1,
      leftToRight: 0,
      rightToLeft: 0,
      rightToRight: 1,
    });
    assert.ok(repeated);
    assert.equal(sourceNode.loop, true);
    assert.equal(stopped[1], 2 + (2 / 11025) * 3);
    sourceNode.onended?.();
    assert.equal(disconnected, 14);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "AudioContext", previous);
    } else {
      Reflect.deleteProperty(globalThis, "AudioContext");
    }
  }
});

test("identical sounds in separate SWF libraries share one decode per player", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const clip: DecodedSound = { durationMs: 1000, play: () => null };
  let decodes = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    audio: {
      async decode() {
        decodes++;
        return clip;
      },
    },
  });
  const definition: Sound = {
    id: 1,
    format: 2,
    sampleRate: 11025,
    sampleSize: 16,
    channels: 1,
    sampleCount: 11025,
    seekSamples: 0,
    data: new Uint8Array([1, 2, 3]),
  };
  const first: SoundCharacter = { type: "sound", id: 1, definition };
  const second: SoundCharacter = {
    type: "sound",
    id: 8,
    definition: { ...definition, id: 8, data: definition.data.slice() },
  };
  assert.equal(await scripting.soundClip(first), clip);
  assert.equal(await scripting.soundClip(second), clip);
  assert.equal(decodes, 1);

  const changed: SoundCharacter = {
    type: "sound",
    id: 9,
    definition: { ...definition, data: new Uint8Array([1, 2, 4]) },
  };
  await scripting.soundClip(changed);
  assert.equal(decodes, 2);
});

test("a live sound keeps its decoded audio across garbage collection", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  let decodes = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    audio: {
      async decode() {
        decodes++;
        return { durationMs: 1000, play: () => null };
      },
    },
  });
  const character: SoundCharacter = {
    type: "sound",
    id: 1,
    definition: {
      id: 1,
      format: 2,
      sampleRate: 11025,
      sampleSize: 16,
      channels: 1,
      sampleCount: 11025,
      seekSamples: 0,
      data: new Uint8Array([1, 2, 3]),
    },
  };

  await scripting.soundClip(character);
  // The decoded clip's first promise must have settled before collection.
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  await scripting.soundClip(character);
  assert.equal(decodes, 1);
});

test("a SWF with an unused embedded sound starts without decoding it", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  let decodes = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    audio: {
      async decode() {
        decodes++;
        return { durationMs: 1000, play: () => null };
      },
    },
  });
  const definition = new BitWriter()
    .u16(1)
    .u8(1 << 2)
    .u32(1)
    .raw([128])
    .done();
  const movie = readSwf(
    swf({
      width: 1,
      height: 1,
      frameRate: 24,
      frameCount: 1,
      tags: [tag(tags.DefineSound, definition), showFrame(), end()],
    }),
  );
  const library = readLibrary(movie);
  await scripting.loadSwf(movie, library);
  assert.equal(decodes, 0);

  const character = library.characters.get(1);
  assert.equal(character?.type, "sound");
  await scripting.soundClip(character as SoundCharacter);
  assert.equal(decodes, 1);
});

test("format-0 PCM is little-endian and a short tag pads missing samples with silence", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const samples = new Float32Array(3);
  class FakeAudioContext {
    createBuffer(_channels: number, count: number) {
      assert.equal(count, 3);
      return { duration: 3 / 44100, numberOfChannels: 1, getChannelData: () => samples };
    }
  }

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  try {
    const host = browserAudioHost();
    assert.ok(host);
    await host.decode({
      id: 1,
      format: 0,
      sampleRate: 44100,
      sampleSize: 16,
      channels: 1,
      sampleCount: 3,
      seekSamples: 0,
      data: new Uint8Array([0, 1, 255]),
    });
    assert.deepEqual([...samples], [256 / 32768, 0, 0]);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "AudioContext", previous);
    } else {
      Reflect.deleteProperty(globalThis, "AudioContext");
    }
  }
});
