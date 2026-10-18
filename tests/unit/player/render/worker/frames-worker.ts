import { setImmediate } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import {
  FrameReader,
  type SharedFrames,
} from "../../../../../packages/player/dist/render/worker/frames.js";

const reader = new FrameReader(workerData as SharedFrames);
parentPort?.postMessage({ ready: true });
let reads = 0;
try {
  for (;;) {
    const frame = reader.take();
    if (frame) {
      try {
        const latest = new DataView(frame.bytes.buffer, frame.bytes.byteOffset).getUint32(0, true);
        await setImmediate();
        for (let i = 4; i < frame.bytes.length; i++) {
          if (frame.bytes[i] !== (latest & 255)) {
            throw new Error(`torn frame ${frame.sequence} at ${i}`);
          }
        }

        reads++;
        if (latest === 0xffffffff) {
          parentPort?.postMessage({ reads, latest });
          break;
        }
      } finally {
        frame.release();
      }
    }

    await setImmediate();
  }
} catch (error) {
  parentPort?.postMessage({ error: String(error) });
}
parentPort?.close();
