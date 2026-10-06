// Gradients as Flash draws them: its pixels under adl, read back through
// getPixel32, for the ramp, the spreads and the radial gradient's centre.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unmultiply } from "../../../packages/player/dist/bitmap/bitmap.js";
import { index, radialPixels, ramp } from "../../../packages/player/dist/display/gradients.js";

const at = [0, 1, 2, 9, 40, 41, 70, 100, 101, 160, 220, 221, 254, 255];
const read = (colors: Uint32Array) =>
  at.map((i) => unmultiply(colors[i]).toString(16).padStart(8, "0"));
const stops = (...s: [number, number][]) => s.map(([ratio, color]) => ({ ratio, color }));

test("a ramp is Flash's: straight interpolation truncated, premultiplied as c * (a + 1) >> 8", () => {
  // Red to green, opaque to clear.
  assert.deepEqual(read(ramp(stops([0, 0xffff0000], [255, 0x0000ff00]), false)), [
    "ffff0000",
    "fefe0000",
    "fdfd0100",
    "f6f50800",
    "d7d62700",
    "d6d52900",
    "b9b84500",
    "9b9b6300",
    "9a9a6500",
    "5f5ea100",
    "231ddb00",
    "221ee100",
    "0100ff00",
    "00000000",
  ]);
  // Three stops at uneven ratios, the middle half transparent: the first colour up to the first.
  assert.deepEqual(
    read(ramp(stops([40, 0xff000000], [100, 0x7fff8000], [220, 0xffffffff]), false)),
    [
      "ff000000",
      "ff000000",
      "ff000000",
      "ff000000",
      "ff000000",
      "fc030100",
      "bf7f4000",
      "7fff8000",
      "80ff8102",
      "bffebe7f",
      "ffffffff",
      "ffffffff",
      "ffffffff",
      "ffffffff",
    ],
  );
  // Linear RGB: through sRGB's linear light, the ends too, which takes 255 to 254.
  assert.deepEqual(read(ramp(stops([0, 0xffff0000], [255, 0xff0000ff]), true)), [
    "fffe0000",
    "fffe000c",
    "fffe0015",
    "fffb0034",
    "ffec006e",
    "ffec006f",
    "ffdd008e",
    "ffcc00a8",
    "ffcc00a8",
    "ffa400cf",
    "ff6700ee",
    "ff6600ef",
    "ff0c00fe",
    "ff0000fe",
  ]);
  // No stops: black. Ratios that go back are skipped, the last colour on to the end.
  assert.equal(ramp([], false)[128], 0xff000000);
  const unsorted = ramp(stops([0, 0xff000000], [200, 0xffffffff], [100, 0xffff0000]), false);
  assert.deepEqual(
    [unsorted[200], unsorted[240]].map((p) => p.toString(16)),
    ["ffffffff", "ffff0000"],
  );
});

test("pad clamps, repeat wraps and reflect mirrors the ramp's index", () => {
  // A 64 pixel gradient, read at pixel corners x, is 4x into the ramp.
  const indices = (spread: number) =>
    [60, 63, 64, 65, 127, 128].map((x) => index((x * 4) / 256, spread));
  assert.deepEqual(indices(0), [240, 252, 255, 255, 255, 255]);
  assert.deepEqual(indices(2), [240, 252, 0, 4, 252, 0]);
  assert.deepEqual(indices(1), [240, 252, 255, 251, 3, 0]);
});

test("a radial gradient's centre is the first stop, a focal point off it the last", () => {
  const colors = ramp(stops([0, 0xff000000], [255, 0xffffffff]), false);
  // The square to 20 by 20 pixels centred at (10, 10), over a 20 by 20 region.
  const m = { a: 20 / 1638.4, b: 0, c: 0, d: 20 / 1638.4, tx: 10, ty: 10 };
  const region = { x: 0, y: 0, width: 20, height: 20 };
  const centred = radialPixels(colors, m, 0, 0, region, 20, 20);
  assert.equal(centred[10 * 20 + 10], 0xff000000);
  // 4 pixels out of a radius of 10: 0.4 of the way, entry 102.
  assert.equal(centred[10 * 20 + 14], colors[102]);
  // The focus at 0.5, (15, 10): the last stop there, as Flash draws it.
  const focal = radialPixels(colors, m, 0.5, 0, region, 20, 20);
  assert.equal(focal[10 * 20 + 15], 0xffffffff);
});

test("a radial gradient's texture is made again when what it fills grows", async () => {
  const { ShapeObject, CONTENT } = await import("../../../packages/player/dist/display/display.js");
  const { Drawing } = await import("../../../packages/player/dist/display/drawing.js");
  const { PixiView } = await import("../../../packages/player/dist/render/view.js");
  const renderer = { render: () => {} } as unknown as ConstructorParameters<typeof PixiView>[0];
  const view = new PixiView(renderer);
  const shape = new ShapeObject(null);
  const drawing = new Drawing();
  const fill = {
    type: "gradient" as const,
    radial: true,
    focal: 0,
    stops: stops([0, 0xff000000], [255, 0xffffffff]),
    spread: 0,
    linearRgb: false,
    matrix: { a: 10 / 1638.4, b: 0, c: 0, d: 10 / 1638.4, tx: 5, ty: 5 },
  };
  const square = (side: number) => {
    drawing.moveTo(0, 0);
    drawing.lineTo(side, 0);
    drawing.lineTo(side, side);
    drawing.lineTo(0, side);
    drawing.lineTo(0, 0);
  };
  drawing.beginFill(fill);
  square(10);
  shape.drawing = drawing;
  // The texture the shape's first fill draws with, a texel a pixel of its region.
  const width = () => {
    view.prepare(shape);
    const graphics = view.stage.children[0].children[0].children[0] as unknown as {
      context: { instructions: { data: { style: { texture: { source: { width: number } } } } }[] };
    };
    return graphics.context.instructions[0].data.style.texture.source.width;
  };
  assert.equal(width(), 10);

  // The same fill's path carried on, out to 20 by 20.
  square(20);
  shape.invalidate(CONTENT);
  assert.equal(width(), 20);
});

test("a radial fill's textures live while any context draws with them", async () => {
  const { ShapeObject, CONTENT } = await import("../../../packages/player/dist/display/display.js");
  const { Drawing } = await import("../../../packages/player/dist/display/drawing.js");
  const { PixiView } = await import("../../../packages/player/dist/render/view.js");
  const renderer = { render: () => {} } as unknown as ConstructorParameters<typeof PixiView>[0];
  const view = new PixiView(renderer);
  const fill = {
    type: "gradient" as const,
    radial: true,
    focal: 0,
    stops: stops([0, 0xff000000], [255, 0xffffffff]),
    spread: 0,
    linearRgb: false,
    matrix: { a: 10 / 1638.4, b: 0, c: 0, d: 10 / 1638.4, tx: 5, ty: 5 },
  };
  type Style = { texture: { destroyed: boolean; source: { width: number } } };
  // The textures of a shape's first layer's fills, as its Graphics draws them.
  const textures = (shape: InstanceType<typeof ShapeObject>, at: number) => {
    view.prepare(shape);
    const graphics = view.stage.children[0].children[at].children[0] as unknown as {
      context: { instructions: { action: string; data: { style: Style } }[] };
    };
    return graphics.context.instructions
      .filter((i) => i.action === "fill")
      .map((i) => [i.data.style.texture.source.width, i.data.style.texture.destroyed]);
  };
  const square = (side: number) => [0, 0, side, 0, side, side, 0, side, 0, 0];

  // drawPath with another winding makes a second entry of the one fill, over another region.
  const shape = new ShapeObject(null);
  const drawing = new Drawing();
  drawing.beginFill(fill);
  drawing.drawPath([1, 2, 2, 2, 2], square(10), "evenOdd");
  drawing.drawPath([1, 2, 2, 2, 2], square(20), "nonZero");
  shape.drawing = drawing;
  assert.deepEqual(textures(shape, 0), [
    [10, false],
    [20, false],
  ]);

  // copyFrom shares the fill; the copy's path grows; the original's texture stays.
  const original = new ShapeObject(null);
  const first = new Drawing();
  first.beginFill(fill);
  first.drawPath([1, 2, 2, 2, 2], square(10), "evenOdd");
  original.drawing = first;
  const copy = new ShapeObject(null);
  const second = new Drawing();
  second.copyFrom(first);
  copy.drawing = second;
  const both = new (await import("../../../packages/player/dist/display/display.js")).Container();
  both.addChildAt(original, 0);
  both.addChildAt(copy, 1);
  view.prepare(both);
  second.drawPath([1, 2, 2, 2, 2], square(20), "evenOdd");
  copy.invalidate(CONTENT);
  view.prepare(both);
  const kept = (
    view.stage.children[0].children[1].children[0].children[0] as unknown as {
      context: { instructions: { data: { style: Style } }[] };
    }
  ).context.instructions[0].data.style.texture;
  assert.deepEqual([kept.source.width, kept.destroyed], [10, false]);
});
