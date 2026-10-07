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

test("an MP3 plays from the browser's decode of the whole file; extract's is its own, Flash's way", async () => {
  const tagged = new Uint8Array(
    readFileSync(new URL("../../../player/sounds/tone-tagged.mp3", import.meta.url)),
  );
  const saved = ["AudioContext", "OfflineAudioContext"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const played: number[] = [];
  const decoded: { rate: number; bytes: number }[] = [];
  let failTrimmed = false;
  const buffer = (rate: number) => ({
    duration: 1,
    length: 2,
    sampleRate: rate,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array([0.5, -0.5]),
  });
  class FakeAudioContext {
    async decodeAudioData(data: ArrayBuffer) {
      played.push(data.byteLength);
      return buffer(48000);
    }
  }
  class FakeOfflineAudioContext {
    readonly rate: number;
    constructor(_channels: number, _length: number, rate: number) {
      this.rate = rate;
    }

    async decodeAudioData(data: ArrayBuffer) {
      decoded.push({ rate: this.rate, bytes: data.byteLength });
      if (failTrimmed && data.byteLength !== tagged.length) {
        throw new Error("EncodingError");
      }

      return buffer(this.rate);
    }
  }

  for (const [name, value] of [
    ["AudioContext", FakeAudioContext],
    ["OfflineAudioContext", FakeOfflineAudioContext],
  ] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }

  try {
    const host = browserAudioHost();
    assert.ok(host?.extractSamples);
    await host.decode(tagged);
    assert.deepEqual(played, [tagged.length]);
    assert.deepEqual(decoded, []);

    // Its own rate, the LAME header frame (313 bytes) out of sight and silence in its place.
    const samples = await host.extractSamples(tagged);
    assert.deepEqual(decoded, [{ rate: 44100, bytes: tagged.length - 313 }]);
    assert.equal(samples.rate, 44100);
    assert.equal(samples.channels[0].length, 1152 + 2);

    // Frames the browser cannot decode alone: the whole file, as it is.
    failTrimmed = true;
    decoded.length = 0;
    const whole = await host.extractSamples(tagged);
    assert.deepEqual(decoded, [
      { rate: 44100, bytes: tagged.length - 313 },
      { rate: 44100, bytes: tagged.length },
    ]);
    assert.equal(whole.channels[0].length, 2);
  } finally {
    for (const [name, previous] of saved) {
      if (previous) {
        Object.defineProperty(globalThis, name, previous);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
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
