import assert from "node:assert/strict";
import { test } from "node:test";

test("capture worklet absorbs delayed acknowledgements and bounds suspended-page storage", async () => {
  type Block = { samples: Float32Array<ArrayBuffer>; rate: number };
  class Processor {
    messages: Block[] = [];
    port = {
      onmessage: null as ((event: { data: Float32Array<ArrayBuffer> }) => void) | null,
      postMessage: (data: Block, transfer: ArrayBuffer[]) => {
        this.messages.push(structuredClone(data, { transfer }));
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
    const input = [[new Float32Array(128).fill(0.25)]];
    for (const delay of [0, 1, 3, 7]) {
      const processor = new Worklet();
      let delivered = 0;
      for (let block = 0; block < 10000; block++) {
        for (let quantum = 0; quantum < 16; quantum++) {
          assert.equal(processor.process(input), true);
        }
        while (processor.messages.length > delay) {
          const message = processor.messages.shift() as Block;
          assert.equal(message.rate, 48000);
          assert.equal(message.samples.length, 2048);
          assert.ok(message.samples.every((value) => value === 0.25));
          const data = structuredClone(message.samples, { transfer: [message.samples.buffer] });
          processor.port.onmessage?.({ data });
          delivered++;
        }
      }
      assert.equal(delivered + processor.messages.length, 10000, `lost blocks at delay ${delay}`);
    }

    const suspended = new Worklet();
    for (let block = 0; block < 10000; block++) {
      for (let quantum = 0; quantum < 16; quantum++) {
        suspended.process(input);
      }
    }
    assert.equal(suspended.messages.length, 8);
    const message = suspended.messages.shift() as Block;
    suspended.port.onmessage?.({
      data: structuredClone(message.samples, { transfer: [message.samples.buffer] }),
    });
    for (let quantum = 0; quantum < 16; quantum++) {
      suspended.process(input);
    }
    assert.equal(suspended.messages.length, 8, "capture resumes when a buffer returns");
  } finally {
    delete globals.AudioWorkletProcessor;
    delete globals.sampleRate;
    delete globals.registerProcessor;
  }
});
