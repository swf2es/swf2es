import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeDxt, encodeDxt } from "@swf2es/context3d";

/** A level of RGBA, each pixel from `pixel`. */
function level(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out.set(pixel(x, y), (y * width + x) * 4);
    }
  }

  return out;
}

const roundTrip = (rgba: Uint8Array, dxt5: boolean, width: number, height: number) => {
  const out = new Uint8Array(width * height * 4);
  decodeDxt(encodeDxt(rgba, dxt5, width, height), dxt5, width, height, out);
  return out;
};

test("flat colours encode exactly where RGB565 holds them, opaque in DXT1", () => {
  for (const colour of [
    [255, 0, 0, 255],
    [0, 255, 0, 128],
    [0, 0, 255, 0],
    [255, 255, 0, 255],
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ]) {
    const rgba = level(8, 8, () => colour);
    const dxt1 = roundTrip(rgba, false, 8, 8);
    assert.deepEqual([...dxt1.subarray(0, 4)], [...colour.slice(0, 3), 255]);
    const dxt5 = roundTrip(rgba, true, 8, 8);
    assert.deepEqual([...dxt5.subarray(0, 4)], colour);
  }
});

test("gradients along a line come back within DXT's error, and levels smaller than a block", () => {
  // DXT's colours lie on a line between two endpoints a block, as a gradient's do.
  const rgba = level(16, 16, (x, y) => [(x + y) * 8, (x + y) * 4, 255 - (x + y) * 8, y * 16]);
  const back = roundTrip(rgba, true, 16, 16);
  for (let i = 0; i < rgba.length; i++) {
    assert.ok(Math.abs(rgba[i] - back[i]) <= 24, `byte ${i}: ${rgba[i]} ${back[i]}`);
  }

  for (const [w, h] of [
    [1, 1],
    [2, 2],
    [2, 1],
  ]) {
    const small = level(w, h, () => [0, 255, 0, 255]);
    assert.equal(encodeDxt(small, false, w, h).length, 8);
    assert.deepEqual([...roundTrip(small, false, w, h)], [...small]);
  }
});

test("a DXT1 block of three colours has transparent black for its fourth index", () => {
  // c0 = blue (0x001f) not above c1 = red (0xf800): blue, red, their midpoint, transparent.
  const block = new Uint8Array([0x1f, 0x00, 0x00, 0xf8, 0xe4, 0xe4, 0xe4, 0xe4]);
  const out = new Uint8Array(64);
  decodeDxt(block, false, 4, 4, out);
  assert.deepEqual(
    [...out.subarray(0, 16)],
    [0, 0, 255, 255, 255, 0, 0, 255, 127, 0, 127, 255, 0, 0, 0, 0],
  );
});
