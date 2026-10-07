import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sound } from "../../../../packages/format/dist/index.js";
import { browserAudioHost } from "../../../../packages/player/dist/media/audio.js";

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
