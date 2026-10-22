import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("MP3 playback gives the browser the original file for its own gapless decode", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const bytes = new Uint8Array(
    readFileSync(new URL("../../../player/sounds/tone-tagged.mp3", import.meta.url)),
  );
  const decoded: Uint8Array[] = [];
  class FakeAudioContext {
    async decodeAudioData(data: ArrayBuffer) {
      decoded.push(new Uint8Array(data));
      return { duration: 0.25 };
    }
  }

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  try {
    const host = browserAudioHost();
    assert.ok(host);
    assert.equal((await host.decode(bytes)).durationMs, 250);
    assert.deepEqual(decoded, [new Uint8Array(bytes)]);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "AudioContext", previous);
    } else {
      Reflect.deleteProperty(globalThis, "AudioContext");
    }
  }
});

test("a closed browser audio host closes its context and decodes nothing more", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  let made = 0;
  let closed = 0;
  class FakeAudioContext {
    constructor() {
      made++;
    }
    createBuffer(count: number, samples: number, rate: number) {
      return {
        duration: samples / rate,
        numberOfChannels: count,
        getChannelData: () => new Float32Array(samples),
      };
    }
    async close() {
      closed++;
    }
  }

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  try {
    const host = browserAudioHost();
    assert.ok(host?.close);
    const sound: Sound = {
      id: 1,
      format: 3,
      sampleRate: 11025,
      sampleSize: 8,
      channels: 1,
      sampleCount: 1,
      seekSamples: 0,
      data: new Uint8Array([128]),
    };
    await host.decode(sound);
    host.close();
    assert.equal(closed, 1);
    await assert.rejects(host.decode(sound), /closed/);
    // No second context to outlive the player.
    assert.equal(made, 1);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "AudioContext", previous);
    } else {
      Reflect.deleteProperty(globalThis, "AudioContext");
    }
  }
});

test("embedded MP3 loops and cursors use the SWF origin at the source sample rate", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const starts: number[][] = [];
  const stops: number[] = [];
  const buffer = { duration: 1.2, sampleRate: 48000, numberOfChannels: 1 };
  const node = { connect() {}, disconnect() {} };
  const sources: {
    buffer: unknown;
    loop: boolean;
    loopStart: number;
    loopEnd: number;
    onended: (() => void) | null;
  }[] = [];
  class FakeAudioContext {
    currentTime = 2;
    destination = {};
    async decodeAudioData() {
      return buffer;
    }
    createBufferSource() {
      const source = {
        ...node,
        buffer: null as unknown,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null as (() => void) | null,
        start: (...args: number[]) => starts.push(args),
        stop: (when: number) => stops.push(when),
      };
      sources.push(source);
      return source;
    }
    createChannelSplitter() {
      return node;
    }
    createChannelMerger() {
      return node;
    }
    createGain() {
      return { ...node, gain: { value: 0 } };
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
    const clip = await host.decode({
      id: 1,
      format: 2,
      sampleRate: 11025,
      sampleSize: 16,
      channels: 1,
      sampleCount: 11025,
      seekSamples: 1661,
      data: new Uint8Array(),
    });
    assert.equal(clip.durationMs, 1000);
    const mix = { volume: 1, leftToLeft: 1, leftToRight: 0, rightToLeft: 0, rightToRight: 1 };
    const origin = 1661 / 11025;
    const playing = clip.play(10, 8, mix, { endMs: 70, atMs: 150 });
    assert.ok(playing);
    assert.equal(sources[0].buffer, buffer);
    assert.equal(sources[0].loopStart, origin + 0.01);
    assert.equal(sources[0].loopEnd, origin + 0.07);
    assert.ok(Math.abs(starts[0][1] - (origin + 0.04)) < 1e-12);
    assert.ok(Math.abs(stops[0] - 2.33) < 1e-12);
    assert.equal(playing.positionMs, 150);

    assert.ok(clip.play(0, 1, mix));
    assert.deepEqual(starts[1], [0, origin, 1]);
    assert.equal(sources[1].buffer, buffer);
    assert.equal(clip.play(1001, 1, mix), null);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "AudioContext", previous);
    } else {
      Reflect.deleteProperty(globalThis, "AudioContext");
    }
  }
});
