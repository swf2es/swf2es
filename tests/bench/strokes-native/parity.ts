// The native line builder against layerStrokes on random opaque layers: the
// same vertices and indices, positions within 1e-6 (or one f32 ulp).
import { LineBuilder } from "../../../packages/native/dist/strokes/index.js";
import { layerStrokes } from "../../../packages/player/dist/scene/strokes.js";
import { layerStrokesNative } from "../../../packages/player/dist/scene/strokes-native.js";
import { random, randomLayer } from "./layers.ts";

const cases = Number(process.argv[2] ?? 20000);
const seed = Number(process.argv[3] ?? 1);
const r = random(seed);
const builder = new LineBuilder();
const tessellator = (() => null) as unknown as Parameters<typeof layerStrokes>[6];

let failures = 0;
let skipped = 0;
let exact = 0;
let positionsCompared = 0;
let maxDiff = 0;
let maxRelative = 0;
let vertices = 0;
for (let k = 0; k < cases; k++) {
  const layer = randomLayer(r);
  const angle = r() * 2 * Math.PI;
  const scale = [0.05, 0.5, 1, 1, 2, 20][Math.floor(r() * 6)];
  const skew = r() < 0.2 ? r() : 0;
  const a = scale * Math.cos(angle);
  const b = scale * Math.sin(angle);
  const c = -scale * Math.sin(angle) + skew;
  const d = scale * Math.cos(angle);
  const least = [1, 0.5, 2][Math.floor(r() * 3)];
  const by = r() < 0.1 ? [1, 0, 0, 1] : null;
  let js: ReturnType<typeof layerStrokes>;
  try {
    js = layerStrokes(layer, a, b, c, d, least, tessellator, by, true);
  } catch {
    // JS throws on a NaN arc (length -= 2 of an empty array); not a case to compare.
    skipped++;
    continue;
  }

  const zig = layerStrokesNative(layer, a, b, c, d, least, builder, by);
  const fail = (why: string) => {
    failures++;
    if (failures <= 5) {
      console.log(`case ${k}: ${why}`);
      console.log(JSON.stringify({ layer, a, b, c, d, least, by }).slice(0, 2000));
    }
  };
  if (!js || !zig) {
    if (js !== zig) {
      fail(`js ${js ? "geometry" : js} vs zig ${zig ? "geometry" : zig}`);
    }

    continue;
  }

  if (js.positions.length !== zig.positions.length || js.indices.length !== zig.indices.length) {
    fail(
      `counts js ${js.positions.length / 2}/${js.indices.length} zig ${zig.positions.length / 2}/${zig.indices.length}`,
    );
    continue;
  }

  vertices += js.positions.length / 2;
  let bad = false;
  for (let i = 0; i < js.indices.length; i++) {
    if (js.indices[i] !== zig.indices[i]) {
      bad = true;
    }
  }

  for (let i = 0; i < js.colors.length; i++) {
    if (js.colors[i] !== zig.colors[i]) {
      bad = true;
    }
  }

  for (let i = 0; i < js.positions.length; i++) {
    const x = js.positions[i];
    const y = zig.positions[i];
    positionsCompared++;
    if (Object.is(x, y)) {
      exact++;
      continue;
    }

    const diff = Math.abs(x - y);
    const relative = diff / Math.max(1, Math.abs(x));
    maxDiff = Math.max(maxDiff, diff);
    maxRelative = Math.max(maxRelative, relative);
    // One f32 ulp of a large coordinate is more than 1e-6.
    if (!(diff <= 1e-6 || relative <= 2 ** -23)) {
      bad = true;
    }
  }

  if (bad) {
    fail("indices, colours or positions differ");
  }
}

console.log(
  `${cases} layers (seed ${seed}), ${vertices} vertices: ${failures} failures, ${skipped} skipped (JS threw); ` +
    `${exact}/${positionsCompared} coordinates bit-equal, largest difference ${maxDiff} (relative ${maxRelative})`,
);
process.exitCode = failures ? 1 : 0;
