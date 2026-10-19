// CPU-only scene encoding benchmark. Run the same command at each revision.
import assert from "node:assert/strict";
import { Container, ShapeObject } from "../../packages/player/dist/display/display.js";
import { SceneMirror, SceneSnapshot } from "./scene/scene.ts";
import { sceneFixture } from "./scene-fixture.ts";

const count = Number(process.argv[2] ?? 8000),
  frames = Number(process.argv[3] ?? 120);
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 30000, "nodes must be 1..30000");
assert.ok(
  Number.isSafeInteger(frames) && frames >= 1 && frames <= 10000,
  "frames must be 1..10000",
);
const fixture = sceneFixture(),
  shape = fixture.libraries[0].library.characters.get(1);
assert.ok(shape?.type === "shape");
for (let i = 0; i < count; i++) {
  const object = new ShapeObject(shape);
  object.matrix = { a: 1, b: 0, c: 0, d: 1, tx: i % 128, ty: Math.floor(i / 128) };
  fixture.root.addChildAt(object, fixture.root.children.length);
}
const encoder = new SceneSnapshot(fixture.assets),
  buffer = new Uint8Array(new ArrayBuffer(8 * 1024 * 1024));
let length = 0;
for (let i = 0; i < 20; i++) {
  fixture.step(i);
  length = encoder.encode(fixture.root, buffer);
}
const timings: number[] = [];
for (let i = 0; i < frames; i++) {
  fixture.step(i);
  const start = performance.now();
  length = encoder.encode(fixture.root, buffer);
  timings.push(performance.now() - start);
}
const actual = new SceneMirror(fixture.assets).apply(buffer.subarray(0, length));
assert.ok(actual instanceof Container);
assert.equal(actual.children.length, fixture.root.children.length);
timings.sort((a, b) => a - b);
const quantile = (q: number) => timings[Math.max(0, Math.ceil(timings.length * q) - 1)];
console.log(
  JSON.stringify(
    {
      objects: new Float64Array(buffer.buffer)[1],
      frames,
      bytes: length,
      medianMs: quantile(0.5),
      p95Ms: quantile(0.95),
      scope:
        "CPU encoding only; no VM or renderer; compare repeated runs under similar machine load.",
    },
    null,
    2,
  ),
);
