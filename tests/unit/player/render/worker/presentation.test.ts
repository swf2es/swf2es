import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FrameReader,
  FrameWriter,
  sharedFrames,
} from "../../../../../packages/player/dist/render/worker/frames.js";
import {
  PRESENTATION_BYTES,
  type RenderState,
  readPresentation,
  writePresentation,
} from "../../../../../packages/player/dist/render/worker/presentation.js";

test("taking the newest slot keeps resize, quality and asset generation with its scene", () => {
  const frames = sharedFrames(PRESENTATION_BYTES + 8);
  const writer = new FrameWriter(frames);
  const reader = new FrameReader(frames);
  const state: RenderState = {
    width: 100,
    height: 80,
    resolution: 1,
    background: 0xffffff,
    quality: "HIGH",
    antialias: true,
    samples: 8,
    layerSamples: 4,
  };
  writer.write((bytes) => {
    writePresentation(bytes, state, 1);
    return PRESENTATION_BYTES;
  });
  state.width = 200;
  state.resolution = 1.5;
  state.quality = "LOW";
  state.antialias = false;
  writer.write((bytes) => {
    writePresentation(bytes, state, 3);
    return PRESENTATION_BYTES;
  });
  const frame = reader.take();
  assert.ok(frame);
  const decoded = readPresentation(frame.bytes);
  assert.deepEqual(decoded.state, state);
  assert.equal(decoded.libraries, 3);
  const data = new Float64Array(frame.bytes.buffer, frame.bytes.byteOffset, 11);
  data[4] = NaN;
  assert.throws(() => readPresentation(frame.bytes), /dimensions/);
  assert.throws(() => readPresentation(frame.bytes.subarray(0, 8)), /truncated/);
  frame.release();
});
