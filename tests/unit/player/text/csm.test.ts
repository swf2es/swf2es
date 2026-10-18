// Advanced anti-aliasing's cutoffs (text/csm.ts), against what adl draws.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  csmTables,
  cutoffs,
  isLight,
  setCsmTable,
} from "../../../../packages/player/dist/text/csm.js";

const font = (name: string, csmHint?: number) => ({ name, bold: false, italic: false, csmHint });

function at(table: readonly number[], ppem: number, thickness = 0, sharpness = 0): number[] {
  const out = new Float32Array(2);
  cutoffs(table, ppem, thickness, sharpness, out);
  return [...out].map((v) => Math.round(v * 1000) / 1000);
}

test("light text is a luma of 30:59:11 over 200, as adl takes it", () => {
  assert.equal(isLight(0xffffff), true);
  assert.equal(isLight(0xc9c9c9), true);
  assert.equal(isLight(0xc8c8c8), false);
  // Yellow light, cyan and magenta dark; 199.5 by Rec. 601's weights, 200.4 by these.
  assert.equal(isLight(0xffd200), true);
  assert.equal(isLight(0xffd000), false);
  assert.equal(isLight(0x00ffff), false);
  assert.equal(isLight(0xff00ff), false);
  assert.equal(isLight(0xc7c8ca), false);
});

test("a font without alignment zones is drawn by the thin tables, light text thickened most", () => {
  const [light, dark] = csmTables(font("NoZones"));
  // adl at 20 pixels: inside 0.209 and outside -0.829 light, 0.324 and -0.517 dark, the tables
  // to within 0.004.
  assert.deepEqual(at(light, 20), [0.209, -0.829]);
  assert.deepEqual(at(dark, 20), [0.325, -0.518]);
  // Flat past the tables' ends.
  assert.deepEqual(at(light, 4), at(light, 8));
  assert.deepEqual(at(light, 96), at(light, 27));
  assert.deepEqual(csmTables(font("Zones", 0)), csmTables(font("NoZones")));
  assert.notDeepEqual(csmTables(font("Zones", 1)), csmTables(font("Zones", 2)));
});

test("thickness moves both cutoffs and sharpness each the other way, a fiftieth of a pixel a pixel of size", () => {
  const [light] = csmTables(font("Stem"));
  // adl at 20 pixels: thickness 200 takes both 0.4 out; -200 in.
  assert.deepEqual(at(light, 20, 200), [-0.191, -1.229]);
  assert.deepEqual(at(light, 20, -200), [0.609, -0.429]);
  // adl at 20 pixels: sharpness 400 narrows the ramp by 0.8, to -0.196 and -0.432; at 40, past
  // where the cutoffs meet, they stay met, halfway.
  assert.deepEqual(at(light, 20, 0, 400), [-0.191, -0.429]);
  assert.deepEqual(at(light, 40, 0, 400), [-0.252, -0.252]);
});

test("a table set for a font draws its light and dark text alike, by size between its entries", () => {
  setCsmTable("Own", "regular", [
    [30, 1, -1],
    [10, 0.5, -0.5],
  ]);
  const [light, dark] = csmTables(font("Own"));
  assert.equal(light, dark);
  assert.deepEqual(at(light, 20), [0.75, -0.75]);
  assert.deepEqual(at(light, 5), [0.5, -0.5]);
  assert.deepEqual(at(light, 40), [1, -1]);
  // Bold is another style's.
  assert.notEqual(csmTables({ ...font("Own"), bold: true })[0], light);

  setCsmTable("Own", "regular", []);
  assert.notEqual(csmTables(font("Own"))[0], light);
});
