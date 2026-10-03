import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { Sound } from "../../../packages/format/dist/index.js";
import { browserAudioHost, type DecodedSound } from "../../../packages/player/dist/audio.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import type { SoundCharacter } from "../../../packages/player/dist/timeline.js";

test("browser audio decodes SWF PCM and plays through its four channel coefficients", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const gains: { gain: { value: number }; connect: () => void }[] = [];
  const started: number[] = [];
  const stopped: (number | undefined)[] = [];
  const channels = [new Float32Array(2), new Float32Array(2)];
  const sourceNode = {
    buffer: null as unknown,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    onended: null as (() => void) | null,
    connect: () => {},
    start: (_when: number, offset: number) => started.push(offset),
    stop: (when?: number) => stopped.push(when),
  };
  const node = { connect: () => {} };
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
      const gain = { gain: { value: 0 }, connect: () => {} };
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
    assert.equal(sourceNode.loop, true);
    assert.equal(stopped.length, 1);
    playing.stop();
    assert.equal(stopped.length, 2);
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
