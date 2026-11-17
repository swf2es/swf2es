import assert from "node:assert/strict";
import { test } from "node:test";

test("capture worklet keeps only one unacknowledged block while the page is stalled", async () => {
  const messages: { samples: Float32Array; rate: number }[] = [];
  class Processor {
    port = {
      onmessage: null as (() => void) | null,
      postMessage(data: { samples: Float32Array; rate: number }) {
        messages.push({ samples: data.samples.slice(), rate: data.rate });
      },
    };
  }
  let registered: (new () => Processor & { process(inputs: Float32Array[][]): boolean }) | null =
    null;
  const globals = globalThis as typeof globalThis & {
    AudioWorkletProcessor?: typeof Processor;
    sampleRate?: number;
    registerProcessor?: (name: string, klass: NonNullable<typeof registered>) => void;
  };
  globals.AudioWorkletProcessor = Processor;
  globals.sampleRate = 48000;
  globals.registerProcessor = (name, klass) => {
    assert.equal(name, "swf2es-capture");
    registered = klass;
  };
  try {
    await import("../../../packages/player-hosts/dist/capture-worklet.js");
    const Worklet = registered as unknown as new () => Processor & {
      process(inputs: Float32Array[][]): boolean;
    };
    assert.ok(Worklet);
    const processor = new Worklet();
    const input = [[new Float32Array(128).fill(0.25)]];
    for (let i = 0; i < 10000; i++) {
      assert.equal(processor.process(input), true);
    }
    assert.equal(messages.length, 1);
    assert.equal(messages[0].rate, 48000);
    assert.deepEqual(messages[0].samples, new Float32Array(2048).fill(0.25));
    processor.port.onmessage?.();
    for (let i = 0; i < 16; i++) {
      processor.process(input);
    }
    assert.equal(messages.length, 2);
  } finally {
    delete globals.AudioWorkletProcessor;
    delete globals.sampleRate;
    delete globals.registerProcessor;
  }
});
