import assert from "node:assert/strict";
import { test } from "node:test";
import { mixOf } from "../../../../packages/player/dist/media/sounds.js";
import { browserStream } from "../../../../packages/player/dist/media/streaming-audio.js";

function context() {
  const gains: { gain: { value: number }; connect(): void; disconnect(): void }[] = [];
  const sources: {
    buffer: unknown;
    onended: (() => void) | null;
    starts: number[];
    stops: number;
    connect(): void;
    disconnect(): void;
    start(time: number): void;
    stop(): void;
  }[] = [];
  let disconnected = 0;
  const node = () => ({
    connect() {},
    disconnect() {
      disconnected++;
    },
  });
  const ctx = {
    currentTime: 3,
    destination: {},
    async resume() {},
    createChannelSplitter: node,
    createChannelMerger: node,
    createGain() {
      const gain = { ...node(), gain: { value: 0 } };
      gains.push(gain);
      return gain;
    },
    createBuffer(count: number, frames: number, rate: number) {
      assert.equal(count, 2);
      assert.equal(rate, 44100);
      const channels = [new Float32Array(frames), new Float32Array(frames)];
      return { channels, getChannelData: (c: number) => channels[c] };
    },
    createBufferSource() {
      const source = {
        ...node(),
        buffer: null as unknown,
        onended: null as (() => void) | null,
        starts: [] as number[],
        stops: 0,
        start(time: number) {
          this.starts.push(time);
        },
        stop() {
          this.stops++;
        },
      };
      sources.push(source);
      return source;
    },
  };
  return { ctx, gains, sources, disconnected: () => disconnected };
}

test("streamed PCM chunks share a clock and mixer, drain before completion, and release once", () => {
  const h = context();
  let releases = 0;
  const stream = browserStream(
    h.ctx as unknown as Parameters<typeof browserStream>[0],
    mixOf(null),
    () => {},
    () => releases++,
  );
  try {
    const left = new Float32Array(2048).fill(0.123456);
    const right = new Float32Array(2048).fill(-0.5);
    stream.append([left, right]);
    stream.append([left, right]);
    assert.deepEqual(
      h.sources.map((s) => s.starts),
      [[3], [3 + 2048 / 44100]],
    );
    const buffer = h.sources[0].buffer as { channels: Float32Array[] };
    left.fill(0);
    assert.equal(buffer.channels[0][0], Math.fround(0.123456));
    assert.equal(buffer.channels[1][0], -0.5);
    h.ctx.currentTime = 3.025;
    assert.ok(Math.abs(stream.positionMs - 25) < 0.000001);
    stream.setMix({
      volume: 0.5,
      leftToLeft: 1,
      leftToRight: 0.25,
      rightToLeft: 0.5,
      rightToRight: 1,
    });
    assert.deepEqual(
      h.gains.map((g) => g.gain.value),
      [0.5, 0.125, 0.25, 0.5],
    );
    stream.finish();
    assert.equal(stream.ended, false);
    h.ctx.currentTime = 3 + 4096 / 44100;
    h.sources[0].onended?.();
    assert.equal(stream.ended, false);
    h.sources[1].onended?.();
    assert.equal(stream.ended, true);
    assert.equal(releases, 1);
    assert.ok(Math.abs(stream.positionMs - 4096 / 44.1) < 0.000001);
    stream.stop();
    assert.equal(releases, 1);
    assert.equal(h.disconnected(), 8);
  } finally {
    stream.stop();
  }
});

test("stopping cancels pending buffers and refill timers; underruns do not count as played samples", async () => {
  const h = context();
  let requests = 0;
  const stream = browserStream(
    h.ctx as unknown as Parameters<typeof browserStream>[0],
    mixOf(null),
    () => requests++,
    () => {},
  );
  try {
    const samples = [new Float32Array(2048), new Float32Array(2048)];
    stream.append(samples);
    h.ctx.currentTime = 4;
    h.sources[0].onended?.();
    assert.equal(stream.positionMs, 2048 / 44.1);
    stream.append(samples);
    assert.equal(h.sources[1].starts[0], 4);
    h.ctx.currentTime = 4.01;
    const position = stream.positionMs;
    await new Promise((done) => setTimeout(done, 40));
    assert.ok(requests > 0);
    stream.stop();
    const before = requests;
    await new Promise((done) => setTimeout(done, 40));
    assert.equal(requests, before);
    assert.equal(h.sources[1].stops, 1);
    assert.equal(h.sources[1].onended, null);
    h.ctx.currentTime = 5;
    assert.equal(stream.positionMs, position);
    assert.equal(stream.ended, true);
  } finally {
    stream.stop();
  }
});
