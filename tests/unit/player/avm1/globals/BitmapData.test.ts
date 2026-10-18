// BitmapData's AS2 face in node: the methods AS3's operations serve, with
// AVM1's own answers and conversions. Each expected line is Flash's, from
// Ruffle's corpus (avm1/bitmap_data_thorough and the other bitmap_data
// tests), on the same bitmaps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { traces } from "../text-fields.ts";

/** Bitmaps as the corpus makes them, a rect of 2 by 2 at the origin, a point at (1, 1), and a dump. */
const setup = `var BitmapData = flash.display.BitmapData;
var rect = new flash.geom.Rectangle(0, 0, 2, 2);
var point = new flash.geom.Point(1, 1);
function px(b, x, y) { var p = b.getPixel32(x, y); return p < 0 ? p + 4294967296 : p; }
function row(b, y) { return px(b, 0, y) + " " + px(b, 1, y) + " " + px(b, 2, y); }
function made(transparent) { return new BitmapData(3, 3, transparent, 0xAABBCCDD); }
`;

const run = async (source: string) => traces([setup + source]);

/** A row of pixels as the dump traces it, from their hex: in decimal, as radix 16 casts to int. */
const row = (hex: string) =>
  hex
    .split(" ")
    .map((h) => String(Number.parseInt(h, 16)))
    .join(" ");

test("compare answers -1 without an argument, -2 for no bitmap, -3 and -4 for other sizes", async () => {
  assert.deepEqual(
    await run(`var b = made(true);
trace(b.compare()); trace(b.compare({})); trace(b.compare(new BitmapData(2, 3)));
trace(b.compare(new BitmapData(3, 2))); trace(b.compare(made(true)));
var d = b.compare(new BitmapData(3, 3, true, 0)); trace(d instanceof BitmapData);
var gone = made(true); gone.dispose(); trace(b.compare(gone));`),
    ["-1", "-2", "-3", "-4", "0", "true", "-2"],
  );
});

test("threshold compares premultiplied pixels, takes an unknown operation as <, and counts", async () => {
  // The source's translucent pixels premultiply to a red under the threshold's.
  const source = `var s = new BitmapData(3, 3, true, 0x12345678);
s.setPixel32(0, 0, 0xFFFFFFFF); s.setPixel32(1, 1, 0xFFFFFFFF);
s.setPixel32(2, 1, 0); s.setPixel32(1, 2, 0);
`;
  assert.deepEqual(
    await run(`${source}var b = made(true);
trace(b.threshold(s, rect, point, null, 0x33333333, 0xAAAAAAAA, 0x00FF0000, true));
trace(row(b, 1)); trace(row(b, 2));
trace(made(true).threshold(s, rect, point, "==", 0x33333333, 0xAAAAAAAA, 0x00FF0000, true));
trace(made(true).threshold(s, rect, point, "=="));`),
    ["2", row("aabbccdc ffffffff aaa9a9a9"), row("aabbccdc aaa9a9a9 ffffffff"), "0", "-1"],
  );
});

test("getColorBoundsRect matches the premultiplied colour against masked pixels", async () => {
  assert.deepEqual(
    await run(`var b = made(true);
function r(o) { return o.x + " " + o.y + " " + o.width + " " + o.height; }
trace(r(b.getColorBoundsRect(2, 0xFF0000, false)));
trace(r(b.getColorBoundsRect(0xFFFFFF, 0xFF0000)));
trace(r(b.getColorBoundsRect(0xFFFFFF, 0xFF0000, false)));
trace(b.getColorBoundsRect(1));`),
    ["0 0 3 3", "0 0 0 0", "0 0 3 3", "-1"],
  );
});

test("merge clamps its multipliers to 0 to 256 and answers -1", async () => {
  assert.deepEqual(
    await run(`var b = made(true);
trace(b.merge(new BitmapData(3, 3, true, 0x12345678), rect, point, 32, 64, 128, -2));
trace(row(b, 1));`),
    ["-1", row("aabbccdc aaa9aea6 aaa9aea6")],
  );
});

test("paletteMap sums its tables' entries as they are, and needs the red one", async () => {
  assert.deepEqual(
    await run(`var low = []; var high = [];
for (var i = 0; i < 256; i++) { low[i] = 256 - i; high[i] = 256 + i; }
var s = new BitmapData(3, 3, false, 0x12345678); s.setPixel32(1, 1, 0xABCABCAB);
var b = made(true);
trace(b.paletteMap(s, rect, point, low, high)); trace(row(b, 1)); trace(row(b, 2));
trace(b.paletteMap(s, rect, point));`),
    ["-1", row("aabbccdc ff00029a ff00029a"), row("aabbccdc ff00029a ff00029d"), "-1"],
  );
});

test("floodFill answers 0 off the bitmap and for its own colour, scroll 0, pixelDissolve needs five", async () => {
  assert.deepEqual(
    await run(`var b = made(true);
trace(b.floodFill(-1, 2, 0x98765432)); trace(b.floodFill(0, 0, 0xAABBCCDD));
trace(b.floodFill(0, 0, 0x98765432)); trace(b.scroll(5, 10));
trace(b.pixelDissolve(made(true), rect, point, 100));
trace(b.noise()); trace(b.noise(1));`),
    ["0", "0", "1", "0", "-1", "-1", "0"],
  );
});

test("hitTest: a point needs alpha above 0, a rect not at threshold 0, and errors are numbers", async () => {
  assert.deepEqual(
    await run(`var b = new BitmapData(3, 3, true, 0);
trace(b.hitTest({x: 0, y: 0}, 0, {x: 0, y: 0}));
trace(b.hitTest({x: 0, y: 0}, 0, {x: 0, y: 0, width: 1, height: 1}));
trace(b.hitTest({x: 0}, 0, {x: 0, y: 0}));
trace(b.hitTest({x: 0, y: 0}, 0, {x: 0}));
trace(b.hitTest({x: 0, y: 0}, 0, made(true), 5));
trace(b.hitTest({x: 0, y: 0}, 0, made(true)));`),
    ["false", "true", "-2", "-3", "-4", "true"],
  );
});
