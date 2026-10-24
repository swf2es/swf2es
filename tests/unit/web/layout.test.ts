import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SIDE,
  place,
  type ScaleMode,
  scaleMode,
  viewport,
} from "../../../packages/web/dist/layout.js";

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

/** The viewport of a stage of `w` by `h` placed in a box of `bw` by `bh`. */
const shown = (
  w: number,
  h: number,
  bw: number,
  bh: number,
  mode: ScaleMode,
  salign: string | null,
  dpr = 1,
) => viewport(w, h, bw, bh, mode, place(w, h, bw, bh, mode, salign, dpr));

test("the canvas covers the box: showAll's margins are the stage's coordinates past its edges", () => {
  // 100 by 100 in 600 by 200, twice its size: 100 stage pixels of margin each side.
  assert.deepEqual(shown(100, 100, 600, 200, "showAll", null), {
    x: -100,
    y: 0,
    width: 300,
    height: 100,
    resolution: 2,
    css: { x: 0, y: 0, width: 600, height: 200 },
  });
  const left = shown(100, 100, 600, 200, "showAll", "L");
  assert.deepEqual([left.x, left.width], [0, 300]);
  const right = shown(100, 100, 600, 200, "showAll", "R");
  assert.deepEqual([right.x, right.width], [-200, 300]);
});

test("noBorder's canvas is the part of the stage the box shows, by salign", () => {
  const view = (salign: string | null) => {
    const v = shown(200, 100, 400, 400, "noBorder", salign);
    return [v.x, v.y, v.width, v.height];
  };
  assert.deepEqual(view(null), [50, 0, 100, 100]);
  assert.deepEqual(view("L"), [0, 0, 100, 100]);
  assert.deepEqual(view("R"), [100, 0, 100, 100]);
});

test("noScale's margins are the box's pixels, before the stage's origin where it is centred", () => {
  const view = (salign: string | null) => {
    const v = shown(100, 100, 300, 200, "noScale", salign, 2);
    return [v.x, v.y, v.width, v.height, v.resolution];
  };
  assert.deepEqual(view("TL"), [0, 0, 300, 200, 2]);
  assert.deepEqual(view(null), [-100, -50, 300, 200, 2]);
});

test("exactFit, which leaves no margin, and an empty box keep the stage's own canvas", () => {
  const placed = place(200, 100, 400, 400, "exactFit", null, 1);
  assert.deepEqual(viewport(200, 100, 400, 400, "exactFit", placed), {
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    resolution: placed.resolution,
    css: { x: 0, y: 0, width: 400, height: 400 },
  });
  const empty = shown(100, 100, 0, 0, "showAll", null);
  assert.deepEqual([empty.width, empty.height], [100, 100]);
  assert.ok(empty.resolution > 0);
});

test("the margins are drawn at the stage's resolution: no finer, and no coarser on a large box", () => {
  // 800 by 600 full window on 2560 by 1440 at 2: the stage as fine as before the margins.
  const placed = place(800, 600, 2560, 1440, "showAll", null, 2);
  const view = viewport(800, 600, 2560, 1440, "showAll", placed);
  assert.equal(view.resolution, placed.resolution);
  assert.equal(view.resolution, 4.8);
  // So the canvas never has more pixels than the box shows.
  assert.ok(view.width * view.resolution <= 2560 * 2 + 1e-6);
  const big = shown(100, 100, 20_000, 1000, "showAll", null, 2);
  assert.ok(big.width * big.resolution <= 20_000 * 2 + 1e-6);
  assert.ok(100 * big.resolution <= MAX_SIDE);
});
