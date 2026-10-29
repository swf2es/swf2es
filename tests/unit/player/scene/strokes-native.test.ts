// The native line builder (@swf2es/native's strokes.zig, through
// scene/strokes-native.ts) against layerStrokes on random layers, opaque and
// translucent: the same geometry bit for bit, as V8 runs both, or a refusal
// that leaves the layer to layerStrokes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/tessellate";
import type { ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";
import { layerStrokes } from "../../../../packages/player/dist/scene/strokes.js";
import { layerStrokesNative } from "../../../../packages/player/dist/scene/strokes-native.js";
import { curved, layerOf, random, randomLayer } from "./line-layers.ts";

const LAYERS = 3000;

/** The same numbers, NaN and zero's sign included, or where they part. */
function differs(name: string, x: ArrayLike<number>, y: ArrayLike<number>): string | null {
  if (x.length !== y.length) {
    return `${name}: ${x.length} vs ${y.length}`;
  }

  for (let i = 0; i < x.length; i++) {
    if (!Object.is(x[i], y[i])) {
      return `${name}[${i}]: ${x[i]} vs ${y[i]}`;
    }
  }

  return null;
}

test("the native line builder builds random layers as layerStrokes does, to the bit", () => {
  const tessellator = new Tessellator();
  const tessellate = tessellator.tessellate;
  const r = random(1);
  let refused = 0;
  let translucent = 0;
  for (let k = 0; k < LAYERS; k++) {
    const layer = randomLayer(r);
    const angle = r() * 2 * Math.PI;
    const scale = [0.05, 0.5, 1, 1, 2, 6][Math.floor(r() * 6)];
    const skew = r() < 0.2 ? r() : 0;
    const a = scale * Math.cos(angle);
    const b = scale * Math.sin(angle);
    const c = -scale * Math.sin(angle) + skew;
    const d = scale * Math.cos(angle);
    const least = [1, 0.5, 2][Math.floor(r() * 3)];
    const by = r() < 0.1 ? [1, 0, 0, 1] : null;
    const opaque = r() < 0.5;
    const native = layerStrokesNative(layer, a, b, c, d, least, tessellate.lines, by, opaque);
    let js: ReturnType<typeof layerStrokes>;
    try {
      js = layerStrokes(layer, a, b, c, d, least, tessellate, by, opaque);
    } catch {
      // Where the JS throws, the native builder refuses, and the JS throws in the player too.
      assert.equal(native, undefined, `layer ${k} built natively where JS throws`);
      continue;
    }

    if (!opaque || layer.strokes.some(({ line }) => line.color >>> 24 !== 255)) {
      translucent++;
    }

    if (native === undefined) {
      refused++;
      continue;
    }

    const where = () => JSON.stringify({ k, layer, a, b, c, d, least, by, opaque });
    if (!js || !native) {
      assert.equal(native, js, where());
      continue;
    }

    const part =
      differs("positions", js.positions, native.positions) ??
      differs("colors", js.colors, native.colors) ??
      differs("indices", js.indices, native.indices);
    assert.equal(part, null, `${part} in ${where()}`);
  }

  // Most layers have a translucent line, and few are left to JS.
  assert.ok(translucent > LAYERS / 2, `${translucent} layers with lines outlined`);
  assert.ok(refused < LAYERS / 50, `${refused} layers refused`);
  tessellator.dispose();
});

test("a layer the module refuses, or a builder unavailable, is left to layerStrokes", () => {
  const layer = randomLayer(random(2));
  const unavailable = { input: () => null, build: () => null };
  assert.equal(layerStrokesNative(layer, 1, 0, 0, 1, 1, unavailable), undefined);
  const refusing = { input: (n: number) => new Float64Array(n), build: () => undefined };
  assert.equal(layerStrokesNative(layer, 1, 0, 0, 1, 1, refusing), undefined);
  // A transform that collapses the plane draws no lines either way.
  assert.equal(layerStrokesNative(layer, 1, 1, 1, 1, 1, refusing), null);
});

test("a NaN position is left to layerStrokes, which writes it with bits of its own", () => {
  const tessellator = new Tessellator();
  const layer = randomLayer(random(3)) as ShapeLayer;
  layer.strokes[0].paths[0][1] = Number.NaN;
  const lines = tessellator.tessellate.lines;
  assert.equal(layerStrokesNative(layer, 1, 0, 0, 1, 1, lines, null, true), undefined);
  tessellator.dispose();
});

test("the line builder keeps to its tessellator's memory limit and what it retains", () => {
  const r = random(4);
  const layer = layerOf(r, { width: 200, join: 0, cap: 0, alpha: 128 }, 20, (r) =>
    curved(r, 16, true, 200),
  );
  const build = (tessellator: Tessellator) =>
    layerStrokesNative(layer, 1, 0, 0, 1, 1, tessellator.tessellate.lines, null, false);
  // Short of memory, the layer is left to layerStrokes, as a fill short of memory is to JS.
  const short = new Tessellator({ memoryLimit: 1 << 20 });
  assert.equal(build(short), undefined);
  const roomy = new Tessellator();
  assert.ok(build(roomy));
  assert.ok(roomy.capacity > 0, "the line builder's memory counts in the tessellator's");
  const keepsNone = new Tessellator({ retainMemory: 0 });
  assert.ok(build(keepsNone));
  assert.equal(keepsNone.capacity, 0);
});
