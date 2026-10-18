// flash.filters' AS2 classes in node: their values kept as Flash keeps
// them, the filters of clips and fields set and read back, and
// BitmapData's applyFilter and generateFilterRect on them. Each expected
// line is Flash's, from Ruffle's corpus (avm1/bitmap_filters,
// displacementmapfilter_mappoint_throw_error) or adl.
import assert from "node:assert/strict";
import { test } from "node:test";
import { traces } from "../text-fields.ts";

const run = async (source: string) => traces([`var F = flash.filters;\n${source}`]);

test("a filter keeps an alpha in a byte, a strength in 256ths, an angle within a turn, clamped values", async () => {
  assert.deepEqual(
    await run(`var f = new F.DropShadowFilter();
trace(f.distance + " " + f.angle + " " + f.color + " " + f.alpha + " " + f.strength);
f.alpha = 0.5; f.color = 0x10000FF; f.angle = 366; f.strength = 256; f.quality = 100; f.blurX = -1;
trace(f.alpha + " " + f.color + " " + f.angle + " " + f.strength + " " + f.quality + " " + f.blurX);
var names = []; for (var k in f) { names.push(k); } names.reverse(); trace(names.join(","));
var b = new F.BevelFilter(); b.type = "INNER"; trace(b.type + " " + (b.clone() instanceof F.BevelFilter) + " " + new F.BitmapFilter().clone());`),
    [
      "4 44.9999999772279 0 1 1",
      "0.498039215686275 255 6 255 15 0",
      "distance,angle,color,alpha,quality,inner,knockout,blurX,blurY,strength,hideObject,clone",
      "full true undefined",
    ],
  );
});

test("a gradient's alphas and ratios outlast a shorter list of colours", async () => {
  assert.deepEqual(
    await run(`var f = new F.GradientGlowFilter();
function show() { trace(f.colors + " | " + f.alphas + " | " + f.ratios); }
f.colors = [-0x12345678, 10]; show(); f.ratios = [500, 50.5, 100]; show();
f.alphas = [0.5, 1.5, -0.5]; f.colors = "ASDF"; show(); f.ratios = [50]; show();`),
    [
      "13347208,10 | 0,0 | 0,0",
      "13347208,10 | 0,0 | 255,50",
      "0,0,0,0 | 0.501960784313725,1,0,0 | 255,50,0,0",
      "0 | 0.501960784313725 | 50",
    ],
  );
});

test("matrices are floats: a colour matrix's twenty, NaN past a list; a convolution's grown to its size", async () => {
  assert.deepEqual(
    await run(`var c = new F.ColorMatrixFilter([0.2, true]); trace(c.matrix.slice(0, 3));
c.matrix = null; trace(c.matrix.length); c.matrix = "ASD"; trace(c.matrix[0]);
var k = new F.ConvolutionFilter(2, 1, [1, 2.2]); trace(k.matrix + " " + k.divisor + " " + k.alpha);
k.matrixY = 2; trace(k.matrix); k.matrix = "ASD"; trace(k.matrix);
trace(new F.ConvolutionFilter(1, 1, [1], 1, 0, true, true, 0xFF).alpha);`),
    [
      "0.200000002980232,1,NaN",
      "20",
      "NaN",
      "1,2.20000004768372 3.20000004768372 0",
      "1,2.20000004768372,0,0",
      "NaN,NaN,NaN,0",
      "1",
    ],
  );
});

test("a displacement map's point is its own x and y as ints, both or none, and new each read", async () => {
  // The corpus's displacementmapfilter_mappoint_throw_error has what errors in them do.
  assert.deepEqual(
    await run(`var f = new F.DisplacementMapFilter();
f.mapPoint = {x: 12.5, y: -4200}; trace(f.mapPoint);
f.mapPoint = {x: 1}; trace(f.mapPoint + " " + (f.mapPoint == f.mapPoint));
var bm = new flash.display.BitmapData(10, 10); f.mapBitmap = bm; f.mapBitmap = 45;
trace(f.mapBitmap.width + " " + (f.mapBitmap == bm) + " " + f.mode); f.mode = "Color"; trace(f.mode);`),
    ["(x=12, y=-4200)", "(x=0, y=0) false", "10 false wrap", "wrap"],
  );
});

test("a clip's or a field's filters take a list's filter objects up to its length, and read back new ones", async () => {
  // adl: an object without a length sets none, and anything not a filter is left out.
  assert.deepEqual(
    await run(`var blur = new F.BlurFilter(2, 3, 1);
mc.filters = [blur, {}, new F.GlowFilter(), 5];
trace(mc.filters.length + " " + (mc.filters[0] instanceof F.BlurFilter) + " " + (mc.filters[0] == mc.filters[0]) + " " + mc.filters[0].blurY);
blur.blurY = 9; trace(mc.filters[0].blurY);
mc.filters = {a: blur}; trace(mc.filters.length);
t.filters = [blur]; trace(t.filters[0].blurY);`),
    ["2 true false 3", "3", "0", "9"],
  );
});

test("generateFilterRect and applyFilter: AS3's operations, Flash's error numbers", async () => {
  // adl, a 10 by 10 bitmap.
  assert.deepEqual(
    await run(`var B = flash.display.BitmapData, R = flash.geom.Rectangle, P = flash.geom.Point;
var bd = new B(10, 10, true, 0xFF336699), blur = new F.BlurFilter(4, 4, 1), glow = new F.GlowFilter();
trace(bd.generateFilterRect(new R(0, 0, 3, 3), blur) + " " + bd.generateFilterRect(new R(0, 0, 3, 3), {}));
trace(bd.generateFilterRect(null, blur) + " " + bd.generateFilterRect(new R(20, 20, 3, 3), blur));
var src = new B(10, 10, true, 0xFF00FF00);
trace(bd.applyFilter(src, new R(0, 0, 10, 10), new P(0, 0), blur) + " " + bd.applyFilter(src, new R(0, 0, 10, 10), new P(0, 0), {}));
trace(bd.applyFilter(src, null, new P(0, 0), blur) + " " + bd.applyFilter(src, new R(0, 0, 10, 10), null, blur));
var op = new B(10, 10, false, 0xFF336699);
trace(op.applyFilter(src, new R(0, 0, 10, 10), new P(0, 0), glow) + " " + op.getPixel32(5, 5).toString(16));
var d = new B(10, 10, true, 0); d.applyFilter(src, new R(2, 2, 4, 4), new P(1, 1), blur);
trace(d.getPixel32(0, 3).toString(16) + " " + d.getPixel32(3, 3).toString(16) + " " + d.getPixel32(7, 3));`),
    [
      "(x=-2, y=-2, w=7, h=7) -2",
      "-1 (x=134217725, y=134217725, w=4, h=4)",
      "0 -5",
      "-4 0",
      "-6 -cc9967",
      "-20ff0200 -ff0100 0",
    ],
  );
});

test("applyFilter answers -6 where AS3 refuses the rect or the filter, its rect's numbers as AS3's", async () => {
  // adl: an x of NaN, -Infinity or a height of Infinity, a width of 2e8, a shadow cast NaN far.
  assert.deepEqual(
    await run(`var B = flash.display.BitmapData, R = flash.geom.Rectangle, P = flash.geom.Point;
var bd = new B(10, 10, true, 0xFF336699), src = new B(10, 10, true, 0xFF00FF00), blur = new F.BlurFilter(4, 4, 1);
var at = new P(0, 0), line = [];
line.push(bd.applyFilter(src, new R(NaN, 0, 10, 10), at, blur));
line.push(bd.applyFilter(src, new R(NaN, 0, 10, 10), at, new F.ColorMatrixFilter()));
line.push(bd.applyFilter(src, new R(-Infinity, 0, 10, 10), at, new F.BevelFilter()));
line.push(bd.applyFilter(src, new R(0, 0, 200000000, 10), at, blur));
line.push(bd.applyFilter(src, new R(0, 0, 10, Infinity), at, blur));
line.push(bd.applyFilter(src, new R(0, 0, 10, 10), at, new F.DropShadowFilter(NaN, 45)));
trace(line.join(" "));`),
    ["-6 0 -6 -6 -6 -6"],
  );
});

test("lists are read as long as Flash reads them, up to a bound past any real one", async () => {
  // adl: a kernel of 300 and of 100,000 kept whole, a filters list of a million read through.
  assert.deepEqual(
    await run(`var k = new F.ConvolutionFilter(), big = [];
for (var i = 0; i < 300; i++) { big.push(i); }
k.matrix = big; trace(k.matrix.length + " " + k.matrix[299]);
k.matrix = {length: 100000}; trace(k.matrix.length);
k.matrix = {length: 2147483647}; trace(k.matrix.length);
mc.filters = {length: 1000000, 0: new F.BlurFilter()}; trace(mc.filters.length);`),
    ["300 299", "100000", "1048576", "1"],
  );
});
