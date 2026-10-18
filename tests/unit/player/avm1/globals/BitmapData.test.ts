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

test("threshold keeps an opaque bitmap opaque: its getPixel is Flash's, its copies stay opaque", async () => {
  // Flash's getPixel32 reads 12040608 at (2, 1), the source's translucent pixel as kept, and
  // aa717171 for the fill; an opaque store here keeps alpha 255, which drawing and copies rely on.
  const source = `var s = new BitmapData(3, 3, true, 0x12345678);
s.setPixel32(0, 0, 0xFFFFFFFF); s.setPixel32(1, 1, 0xFFFFFFFF);
s.setPixel32(2, 1, 0); s.setPixel32(1, 2, 0);
`;
  assert.deepEqual(
    await run(`${source}var b = made(false);
trace(b.threshold(s, rect, point, "==", 0x33333333, 0xAAAAAAAA, 0x00FF0000, true));
trace(row(b, 1)); trace(b.getPixel(2, 1));
var f = made(false); trace(f.threshold(s, rect, point, null, 0x33333333, 0xAAAAAAAA, 0x00FF0000, false));
trace(row(f, 1));
var t = new BitmapData(3, 3, true, 0); t.copyPixels(b, b.rectangle, new flash.geom.Point(0, 0));
trace(row(t, 1));`),
    [
      "0",
      row("ffbbccdd ffffffff ff040608"),
      String(0x040608),
      "2",
      row("ffbbccdd ffbbccdd ff717171"),
      row("ffbbccdd ffffffff ff040608"),
    ],
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

test("draw takes a blend mode by name or number, anything else as normal, and clips", async () => {
  // adl: null, undefined, an unknown name, a name in capitals, a number in a string, true and an
  // object draw normally; 9 and 265 subtract, a byte's number; erase does nothing to a bitmap.
  assert.deepEqual(
    await run(`var modes = [null, undefined, "foo", "SUBTRACT", "9", true, {}, 9, 265, "erase", 12];
var src = new BitmapData(4, 4, false, 0xFFFF0000); var line = [];
for (var i = 0; i < modes.length; i++) {
  var d = new BitmapData(4, 4, false, 0xFF808080); d.draw(src, new flash.geom.Matrix(), null, modes[i]);
  line.push(d.getPixel32(1, 1).toString(16));
}
trace(line.join(" "));
var c = new BitmapData(50, 50, false, 0xFF0000FF);
c.draw(new BitmapData(50, 50, false, 0xFFFF0000), new flash.geom.Matrix(), null, null, new flash.geom.Rectangle(10, 10, 20, 20));
trace(row(c, 10) + " " + row(c, 29) + " " + row(c, 9) + " " + row(c, 30));`),
    [
      "-10000 -10000 -10000 -10000 -10000 -10000 -10000 -ff7f80 -ff7f80 -7f7f80 -7f7f80",
      [
        row("ff0000ff ff0000ff ff0000ff"),
        row("ff0000ff ff0000ff ff0000ff"),
        row("ff0000ff ff0000ff ff0000ff"),
        row("ff0000ff ff0000ff ff0000ff"),
      ].join(" "),
    ],
  );
});

test("copyPixels takes an alpha bitmap only with its point, and merges only when told", async () => {
  const copy = (args: string) => `var b = made(true);
b.copyPixels(new BitmapData(3, 3, false, 0x12345678), rect, point${args}); trace(row(b, 1));\n`;
  const alpha = ", new BitmapData(3, 3, true, 0x12345678)";
  assert.deepEqual(
    await run(copy(alpha) + copy(`${alpha}, point`) + copy(`${alpha}, point, true`)),
    [
      row("aabbccdc ff345678 ff345678"),
      row("aabbccdc 112d5a78 112d5a78"),
      row("aabbccdc afadc0d3 afadc0d3"),
    ],
  );
});
