import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SIDE, place, scaleMode } from "../../../packages/web/dist/layout.js";

test("a scale attribute names a mode in any case, showAll otherwise", () => {
  assert.equal(scaleMode("NoBorder"), "noBorder");
  assert.equal(scaleMode("exactfit"), "exactFit");
  assert.equal(scaleMode("noScale"), "noScale");
  assert.equal(scaleMode("showall"), "showAll");
  assert.equal(scaleMode(null), "showAll");
  assert.equal(scaleMode("zoom"), "showAll");
});

test("showAll fits the stage whole, centred, and draws it at the device's pixels", () => {
  // 200 by 100 in 400 by 400: twice its size, 100 px above and below.
  assert.deepEqual(place(200, 100, 400, 400, "showAll", null, 1), {
    x: 0,
    y: 100,
    width: 400,
    height: 200,
    resolution: 2,
  });
  assert.equal(place(200, 100, 400, 400, "showAll", null, 1.5).resolution, 3);
});

test("salign holds the edges it names, in any order and case", () => {
  const at = (salign: string | null) => {
    const { x, y } = place(100, 100, 300, 200, "noScale", salign, 1);
    return [x, y];
  };
  assert.deepEqual(at(null), [100, 50]);
  assert.deepEqual(at("TL"), [0, 0]);
  assert.deepEqual(at("rb"), [200, 100]);
  assert.deepEqual(at("T"), [100, 0]);
  assert.deepEqual(at("R"), [200, 50]);
  // Both edges of an axis named: centred along it, as neither.
  assert.deepEqual(at("LR"), [100, 50]);
});

test("noBorder fills the box and crops; exactFit stretches at its finer axis's resolution", () => {
  assert.deepEqual(place(200, 100, 400, 400, "noBorder", null, 1), {
    x: -200,
    y: 0,
    width: 800,
    height: 400,
    resolution: 4,
  });
  assert.deepEqual(place(200, 100, 400, 400, "exactFit", "TL", 2), {
    x: 0,
    y: 0,
    width: 400,
    height: 400,
    resolution: 8,
  });
});

test("the canvas stays within MAX_SIDE device pixels, and has a size when the box has none", () => {
  const big = place(1000, 500, 100_000, 50_000, "showAll", null, 2);
  assert.equal(1000 * big.resolution, MAX_SIDE);
  assert.ok(place(100, 100, 0, 0, "showAll", null, 1).resolution > 0);
});
