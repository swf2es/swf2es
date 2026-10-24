import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SIDE, place, scaleMode, viewport } from "../../../packages/web/dist/layout.js";

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
  assert.deepEqual(at("LR"), [100, 50]);
  assert.deepEqual(at("TB"), [100, 50]);
  assert.deepEqual(at("TBLR"), [100, 50]);
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

test("opt-in Stage3D layout gives AIR's top and left edges precedence", () => {
  for (const salign of ["LR", "TB", "TBLR"]) {
    const at = place(100, 100, 300, 200, "noScale", salign, 1, true);
    assert.equal(at.x, salign.includes("L") ? 0 : 100);
    assert.equal(at.y, salign.includes("T") ? 0 : 50);
  }
});

test("the canvas covers the box: showAll's margins are the stage's coordinates past its edges", () => {
  // 100 by 100 in 600 by 200, twice its size: 100 stage pixels of margin each side.
  const placed = place(100, 100, 600, 200, "showAll", null, 1);
  assert.deepEqual(viewport(100, 100, 600, 200, "showAll", placed, 1), {
    x: -100,
    y: 0,
    width: 300,
    height: 100,
    resolution: 2,
    css: { x: 0, y: 0, width: 600, height: 200 },
  });
  const left = viewport(
    100,
    100,
    600,
    200,
    "showAll",
    place(100, 100, 600, 200, "showAll", "L", 1),
    1,
  );
  assert.deepEqual([left.x, left.width], [0, 300]);
  // noBorder's canvas is only the part of the stage the box shows.
  const cropped = viewport(
    200,
    100,
    400,
    400,
    "noBorder",
    place(200, 100, 400, 400, "noBorder", null, 1),
    1,
  );
  assert.deepEqual([cropped.x, cropped.y, cropped.width, cropped.height], [50, 0, 100, 100]);
  // noScale's margins are the box's pixels.
  const unscaled = viewport(
    100,
    100,
    300,
    200,
    "noScale",
    place(100, 100, 300, 200, "noScale", "TL", 2),
    2,
  );
  assert.deepEqual(
    [unscaled.x, unscaled.y, unscaled.width, unscaled.height, unscaled.resolution],
    [0, 0, 300, 200, 2],
  );
});

test("exactFit, which leaves no margin, and an empty box keep the stage's own canvas", () => {
  const placed = place(200, 100, 400, 400, "exactFit", null, 1);
  assert.deepEqual(viewport(200, 100, 400, 400, "exactFit", placed, 1), {
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    resolution: placed.resolution,
    css: { x: 0, y: 0, width: 400, height: 400 },
  });
  const empty = viewport(100, 100, 0, 0, "showAll", place(100, 100, 0, 0, "showAll", null, 1), 1);
  assert.deepEqual([empty.width, empty.height], [100, 100]);
  assert.ok(empty.resolution > 0);
});

test("a canvas over a large box stays within MAX_SIDE device pixels", () => {
  const placed = place(100, 100, 20_000, 1000, "showAll", null, 2);
  const view = viewport(100, 100, 20_000, 1000, "showAll", placed, 2);
  assert.ok(Math.abs(view.width * view.resolution - MAX_SIDE) < 1e-6);
});
