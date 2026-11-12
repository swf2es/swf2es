// The player's bitmap cases (cases.ts): placement, sampling, BitmapData's
// operations and encoding, draw into a bitmap, and cacheAsBitmap.
import { readFileSync } from "node:fs";
import { zlibCompress } from "../../../packages/format/dist/index.js";
import { PbjAssembler } from "../../pbj-assembler.ts";
import * as w from "../../swf-writer.ts";
import { type Compile, compileScripts } from "../scripts.ts";
import { bare, type PlayerCase, probeFont, square } from "./common.ts";

// A root of two frames whose document class makes BitmapDatas and shows three
// Bitmaps (scripts/Bitmaps.as), then changes their pixels on frame 2: what
// Flash traces of the pixel store, and draws before and after.
// A root of one frame, 210 by 64, whose document class draws bitmaps into
// bitmaps and shows the ones whose pixels the rasteriser decides
// (scripts/DrawBitmaps.as).
function drawBitmaps(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 210,
    height: 64,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "DrawBitmaps"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A root of one frame, 400 by 140, whose document class draws display
// objects into bitmaps and shows them (scripts/DrawObjects.as).
function drawObjects(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 400,
    height: 140,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "DrawObjects"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

function bitmaps(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 70,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "Bitmaps"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// The SWF's bitmap characters (scripts/BitmapSymbols.as): every kind of
// bitmap tag, each bound to a class extending BitmapData, and three placed
// on the timeline with PlaceObject3's HasImage, as Flash Pro places one.
// The images are the repository's own (images/README.md).
function bitmapSymbols(compile: Compile): Uint8Array {
  const image = (name: string) =>
    new Uint8Array(readFileSync(new URL(`../images/${name}`, import.meta.url)));
  const join = (...parts: (Uint8Array | number[])[]) => {
    const all = parts.map((p) => Uint8Array.from(p));
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) {
      out.set(p, at);
      at += p.length;
    }

    return out;
  };
  const u16 = (v: number) => [v & 0xff, v >> 8];
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
  // Flash refuses a bitmap tag with the short header: every one here has the long one but Short.
  const bitmap = (code: number, body: Uint8Array, long = true) => w.tag(code, body, long);
  const lossless = (
    id: number,
    format: number,
    width: number,
    height: number,
    data: number[],
    colors?: number,
  ) =>
    join(
      u16(id),
      [format],
      u16(width),
      u16(height),
      colors === undefined ? [] : [colors - 1],
      zlibCompress(Uint8Array.from(data)),
    );
  const argb = (pixels: number[]) =>
    pixels.flatMap((p) => [p >>> 24, (p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff]);
  const premultiplied = argb([
    0xff102030, 0x80402010, 0x00000000, 0x40200010, 0x01010101, 0x7f7f7f7f, 0xc0123456, 0xffffffff,
    0x00000000, 0x80808080, 0x20102010, 0x0a0a0a0a,
  ]);
  const pixel15 = (r: number, g: number, b: number) => {
    const v = (r << 10) | (g << 5) | b;
    return [v >> 8, v & 0xff];
  };
  const jpeg = image("j.jpg");
  // DefineBits' JPEG without its tables, which go in JPEGTables.
  const tables: number[] = [0xff, 0xd8];
  const rest: number[] = [0xff, 0xd8];
  for (let at = 2; at < jpeg.length; ) {
    const marker = jpeg[at + 1];
    if (marker === 0xda) {
      rest.push(...jpeg.subarray(at));
      break;
    }

    const end = at + 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3]);
    (marker === 0xdb || marker === 0xc4 ? tables : rest).push(...jpeg.subarray(at, end));
    at = end;
  }
  tables.push(0xff, 0xd9);
  const alpha = zlibCompress(Uint8Array.from({ length: 16 * 12 }, (_, i) => (i * 7) % 256));
  const png = image("p.png");
  const classes: [number, string][] = [
    [1, "L2"],
    [2, "L3"],
    [3, "L5"],
    [4, "L4"],
    [5, "L2P"],
    [6, "J2"],
    [7, "JP"],
    [8, "JT"],
    [9, "J3"],
    [10, "PNG"],
    [11, "GIF"],
    [12, "PNG3"],
    [13, "J4"],
    [14, "J444"],
    [15, "JPR"],
    [16, "Bad"],
    [17, "Short"],
    [20, "TL"],
    [1, "L2Alias"],
  ];
  const helpers = compileScripts([
    ...classes.map(([, name]) => ({
      name,
      source: `package { import flash.display.BitmapData; public class ${name} extends BitmapData { public function ${name}(w:int, h:int) { super(w, h); } } }`,
    })),
    ...["BB", "BB2"].map((name) => ({
      name,
      source: `package { import flash.display.Bitmap; public class ${name} extends Bitmap { public function ${name}() { super(); } } }`,
    })),
  ]);
  const main = compile("BitmapSymbols");
  const scaled = (depth: number, character: number, scale: number, tx: number, ty: number) =>
    w.place({ depth, character, matrix: { a: scale, d: scale, tx, ty }, hasImage: true });
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      bitmap(36, lossless(1, 5, 4, 3, premultiplied)),
      bitmap(
        20,
        lossless(2, 3, 3, 2, [10, 20, 30, 200, 100, 50, 0, 0, 0, 0, 1, 2, 0, 2, 1, 0, 0], 3),
      ),
      bitmap(
        20,
        lossless(
          3,
          5,
          3,
          2,
          [
            0x12, 1, 2, 3, 0, 250, 128, 7, 0x80, 9, 99, 199, 0xff, 4, 5, 6, 0x34, 255, 0, 0, 0, 0,
            0, 255,
          ],
        ),
      ),
      bitmap(
        20,
        lossless(4, 4, 3, 2, [
          ...pixel15(31, 0, 0),
          ...pixel15(0, 31, 0),
          ...pixel15(1, 2, 3),
          0,
          0,
          ...pixel15(16, 16, 16),
          ...pixel15(31, 31, 31),
          ...pixel15(0, 0, 31),
          0,
          0,
        ]),
      ),
      bitmap(
        36,
        lossless(
          5,
          3,
          3,
          2,
          [255, 0, 0, 255, 0, 128, 0, 128, 0, 0, 0, 0, 0, 1, 2, 0, 2, 1, 0, 0],
          3,
        ),
      ),
      bitmap(21, join(u16(6), jpeg)),
      // The stray EOI and SOI that old tools wrote before the JPEG.
      bitmap(21, join(u16(7), [0xff, 0xd9, 0xff, 0xd8], jpeg)),
      w.tag(8, Uint8Array.from(tables)),
      bitmap(6, join(u16(8), rest)),
      bitmap(35, join(u16(9), u32(jpeg.length), jpeg, alpha)),
      bitmap(21, join(u16(10), png)),
      bitmap(21, join(u16(11), image("g.gif"))),
      // A PNG in DefineBitsJPEG3: its own alpha, the tag's ignored.
      bitmap(
        35,
        join(
          u16(12),
          u32(png.length),
          png,
          zlibCompress(Uint8Array.from({ length: 20 }, () => 77)),
        ),
      ),
      // No deblocking, which Flash applies and the browser decoder does not.
      bitmap(90, join(u16(13), u32(jpeg.length), u16(0), jpeg, alpha)),
      bitmap(21, join(u16(14), image("j444.jpg"))),
      bitmap(21, join(u16(15), image("jprog.jpg"))),
      bitmap(
        21,
        join(
          u16(16),
          [0xff, 0xd8],
          Array.from({ length: 64 }, (_, i) => i),
        ),
      ),
      bitmap(
        36,
        lossless(17, 5, 2, 2, argb([0xff102030, 0xff102030, 0xff102030, 0xff102030])),
        false,
      ),
      bitmap(36, lossless(20, 5, 4, 3, premultiplied)),
      bitmap(36, lossless(21, 5, 4, 3, premultiplied)),
      ...classes.map(([, name]) => w.doAbc(helpers.get(name) as Uint8Array, name)),
      w.doAbc(helpers.get("BB") as Uint8Array, "BB"),
      w.doAbc(helpers.get("BB2") as Uint8Array, "BB2"),
      w.doAbc(main, "BitmapSymbols"),
      w.symbolClass([...classes, [21, "BB"], [21, "BB2"], [0, "BitmapSymbols"]]),
      scaled(1, 20, 8, 200, 100),
      scaled(2, 10, 8, 900, 100),
      scaled(3, 11, 8, 1700, 100),
      scaled(4, 14, 4, 200, 900),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Bitmap fills (scripts/BitmapFills.as): a 4 x 4 bitmap, every pixel its
// own colour and one translucent, filling a rect larger than it at five
// times its size in each of the four fill types, the bitmap's origin 10
// pixels in, so that clipping and repeating show; and a fill whose bitmap
// the SWF does not define.
function bitmapFills(abc: Uint8Array): Uint8Array {
  const pixels: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const argb =
        x === 3 && y === 3
          ? 0x80808080
          : 0xff000000 | ((x * 80) << 16) | ((y * 80) << 8) | (x === 2 && y === 1 ? 0 : 0xc0);
      pixels.push(argb >>> 24, (argb >> 16) & 0xff, (argb >> 8) & 0xff, argb & 0xff);
    }
  }

  const bitmap = w.tag(
    36,
    Uint8Array.from([1, 0, 5, 4, 0, 4, 0, ...zlibCompress(Uint8Array.from(pixels))]),
    true,
  );
  const rect = (id: number, fill: w.BitmapFill | number) =>
    w.shape({
      id,
      bounds: [0, 900, 0, 800],
      fills: [fill],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [900, 0] },
            { line: [900, 800] },
            { line: [0, 800] },
            { line: [0, 0] },
          ],
        },
      ],
      version: 3,
    });
  const scaled = { a: 100, d: 100, tx: 200, ty: 200 };
  const types = [0x40, 0x41, 0x42, 0x43] as const;
  return w.swf({
    width: 200,
    height: 150,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      bitmap,
      ...types.map((type, i) => rect(10 + i, { bitmap: 1, type, matrix: scaled })),
      rect(20, { bitmap: 99, type: 0x41, matrix: scaled }),
      w.doAbc(abc, "BitmapFills"),
      w.symbolClass([[0, "BitmapFills"]]),
      ...types.map((_, i) =>
        w.place({ depth: 1 + i, character: 10 + i, matrix: { tx: (5 + i * 50) * 20, ty: 100 } }),
      ),
      w.place({ depth: 5, character: 20, matrix: { tx: 100, ty: 2100 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Red squares and blue texts that Flash caches as bitmaps, given a blue
// square or a red text of the same bounds with the move flag on frame 2,
// then on frame 3 something that may draw them again
// (scripts/CacheReplace.as). Row 1, cached by the script: nothing, a
// larger square in their place, a colour transform, a scale, a move by
// the script, the cache turned off, off and on, a read of width, a move
// and a colour transform by the timeline. Row 2, texts: nothing, a read
// of text, of width. Row 3, cached for other reasons, each with the same
// bounds and then larger: a scrollRect, an opaqueBackground, a glow set
// by the script, which touch it, so that it takes neither. Row 4, the same
// by PlaceObject3's cacheAsBitmap, opaqueBackground and glow.
// Row 5: a clip whose child is cached and replaced, sent back to frame 1.
// Row 6, cached by PlaceObject3 and replaced: a shape in a clip the
// timeline scales on frame 3, a shape the script gives a glow on frame 3,
// one with a glow the timeline changes on frame 3, and a red square
// masked by one over it replaced by a triangle.
function cacheReplace(abc: Uint8Array): Uint8Array {
  const at = (x: number, y: number) => ({ tx: x * 20, ty: y * 20 });
  // Children named `names` from column `first` of row `y`, at depths of the row's.
  const row = (y: number, names: string[], character: number, extra = {}, first = 0) =>
    names.map((name, i) =>
      w.place({
        depth: y * 20 + first + i + 1,
        character,
        name,
        matrix: at(10 + (first + i) * 40, 10 + y * 45),
        ...extra,
      }),
    );
  const glow = { glows: [{ color: 0, blur: 2, strength: 1 }] };
  const c = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `c${i}`);
  return w.swf({
    width: 420,
    height: 275,
    frameRate: 24,
    frameCount: 5,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      probeFont(9),
      square(1, 0xff0000, 400),
      square(2, 0x0000ff, 600),
      square(3, 0x0000ff, 400),
      w.shape({
        id: 11,
        bounds: [0, 400, 0, 400],
        fills: [0x0000ff],
        paths: [
          {
            fill1: 1,
            commands: [{ move: [0, 0] }, { line: [400, 0] }, { line: [0, 400] }, { line: [0, 0] }],
          },
        ],
      }),
      w.staticText({
        id: 4,
        bounds: [0, 800, 0, 400],
        records: [{ font: 9, height: 400, color: 0x0000cc, x: 0, y: 300, glyphs: [[1, 400]] }],
      }),
      w.staticText({
        id: 5,
        bounds: [0, 800, 0, 400],
        records: [{ font: 9, height: 400, color: 0xcc0000, x: 0, y: 300, glyphs: [[4, 400]] }],
      }),
      w.sprite(7, 3, [
        w.place({ depth: 1, character: 1 }),
        w.showFrame(),
        w.place({ depth: 1, move: true, character: 3 }),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ]),
      w.sprite(10, 5, [
        w.place({ depth: 1, character: 1, cacheAsBitmap: true }),
        w.showFrame(),
        w.place({ depth: 1, move: true, character: 3 }),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "CacheReplace"),
      w.symbolClass([[0, "Main"]]),
      ...row(0, c, 1),
      ...row(1, ["t0", "t1", "t2"], 4),
      ...row(2, ["s0", "s1", "s2", "s3", "s4", "s5"], 1),
      ...row(3, ["p0", "p1"], 1, { cacheAsBitmap: true }),
      ...row(3, ["p2", "p3"], 1, { opaqueBackground: 0xffffffff }, 2),
      ...row(3, ["p4", "p5"], 1, glow, 4),
      ...row(4, ["r0"], 7),
      ...row(5, ["n0"], 10),
      ...row(5, ["n1"], 1, { cacheAsBitmap: true }, 1),
      ...row(5, ["n2"], 1, glow, 2),
      ...row(5, ["g"], 1, {}, 3),
      w.place({ depth: 110, character: 1, name: "m", matrix: at(130, 235), cacheAsBitmap: true }),
      w.showFrame(),
      ...c.map((_, i) => w.place({ depth: i + 1, move: true, character: 3 })),
      ...[0, 1, 2].map((i) => w.place({ depth: 21 + i, move: true, character: 5 })),
      ...[0, 1, 2, 3, 4, 5].flatMap((i) => [
        w.place({ depth: 41 + i, move: true, character: i % 2 ? 2 : 3 }),
        w.place({ depth: 61 + i, move: true, character: i % 2 ? 2 : 3 }),
      ]),
      w.place({ depth: 102, move: true, character: 3 }),
      w.place({ depth: 103, move: true, character: 3 }),
      w.place({ depth: 110, move: true, character: 11 }),
      w.showFrame(),
      w.place({ depth: 2, move: true, character: 2 }),
      w.place({ depth: 101, move: true, matrix: { a: 1.5, d: 1.5, ...at(10, 235) } }),
      w.place({ depth: 103, move: true, glows: [{ color: 0, blur: 4, strength: 1 }] }),
      w.place({ depth: 9, move: true, matrix: at(10 + 8 * 40 + 5, 10) }),
      w.place({ depth: 10, move: true, colorTransform: { mult: [1, 1, 1, 0.5] } }),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** scripts/DrawErase.as, with the kernel that copies its input it runs as CopyKernel. */
function drawErase(compile: Compile): Uint8Array {
  const copy = new PbjAssembler()
    .name("Copy")
    .version(1)
    .param("in", "float2", "f0.rg", "_OutCoord")
    .input(0, 4, "src")
    .param("out", "float4", "f1.rgba", "dst")
    .sample(false, "f1.rgba", "f0.rg", 0)
    .bytes();
  return w.swf({
    width: 320,
    height: 110,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.binaryData(1, copy),
      w.doAbc(
        compile(
          "CopyKernel",
          "package { import flash.utils.ByteArray; public class CopyKernel extends ByteArray {} }",
        ),
        "CopyKernel",
      ),
      w.doAbc(compile("DrawErase"), "DrawErase"),
      w.symbolClass([
        [0, "DrawErase"],
        [1, "CopyKernel"],
      ]),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

export const bitmapCases: PlayerCase[] = [
  {
    name: "cache-replace",
    swf: cacheReplace,
    script: "CacheReplace",
    frames: 5,
    capture: [1, 2, 3, 4],
    tolerance: 32,
    maxOutliers: 60,
  },
  {
    name: "bitmaps",
    swf: bitmaps,
    script: "Bitmaps",
    frames: 2,
    capture: [1, 2],
    // The smoothed Bitmap: Flash's bilinear filter and the GPU's part by up to 2 in a channel.
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "bitmap-placement",
    swf: (abc) => bare(abc, 1, "BitmapPlacement", 480, 100),
    script: "BitmapPlacement",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bitmap-sampling",
    swf: (abc) => bare(abc, 1, "BitmapSampling", 480, 250),
    script: "BitmapSampling",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
    gap:
      "a scaled or turned bitmap is read at each of the page's samples, sixteen a pixel of " +
      "Flash's at high quality, not once a pixel at its centre; its unsmoothed edges are antialiased",
  },
  {
    name: "bitmap-ops",
    swf: bare,
    script: "BitmapOps",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // The rects and points of BitmapData's operations, in place and not, on the GPU and not
    // (scripts/BitmapRects.as); shown, an opaque bitmap a copy in place left empty pixels in.
    name: "bitmap-rects",
    swf: (abc) => bare(abc, 1, "Main", 80, 32),
    script: "BitmapRects",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bitmap-pixel-endian",
    swf: (abc) => bare(abc, 1, "Main", 40, 40),
    script: "BitmapPixelEndian",
    alone: true,
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bitmap-symbols",
    build: bitmapSymbols,
    frames: 1,
    capture: [1],
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "bitmap-encode",
    swf: (abc) => bare(abc, 1, "BitmapEncode"),
    script: "BitmapEncode",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // BitmapData.encode as JPEG (scripts/BitmapEncodeJpeg.as): the files' segments and
    // tables, and the files loaded back and shown. The traces are exact. The frame is not:
    // Flash's decoder makes a block's chroma by a 16 by 16 inverse DCT and the browser's by
    // interpolating between samples, which part by up to 56 on a hard edge between colours
    // and by nothing where the colours change slowly. Decoded Flash's way, the files are
    // within 10 of this frame (tests/unit/player/bitmap/jpeg.test.ts).
    name: "bitmap-encode-jpeg",
    swf: (abc) => bare(abc, 1, "BitmapEncodeJpeg", 400, 68),
    script: "BitmapEncodeJpeg",
    frames: 6,
    capture: [6],
    tolerance: 32,
    maxOutliers: 150,
  },
  {
    // BitmapData.encode as JPEG XR (scripts/BitmapEncodeJpegXr.as): the files, which are
    // Flash's byte for byte, and the refusals. 64-bit adl crashes encoding a transparent
    // bitmap as JPEG XR, at least under Wine: draw the reference with the 32-bit adl.exe
    // (ADL names it).
    name: "bitmap-encode-jpegxr",
    swf: (abc) => bare(abc, 1, "BitmapEncodeJpegXr"),
    script: "BitmapEncodeJpegXr",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bitmap-fills",
    swf: bitmapFills,
    script: "BitmapFills",
    frames: 2,
    capture: [1, 2],
    // The smoothed fills: Flash's bilinear samples a few hundredths of a
    // texel from the GPU's, which shows where texels of far different
    // colours meet at five times their size, by up to 25 a channel. The
    // others, and the clipping, the tiling and the red, are exact.
    tolerance: 25,
    maxOutliers: 0,
  },
  {
    name: "draw-bitmaps",
    swf: drawBitmaps,
    script: "DrawBitmaps",
    frames: 1,
    capture: [1],
    // The smoothed tiles: Flash's bilinear filter and the GPU's part by up to 2 a channel.
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "draw-erase",
    build: drawErase,
    frames: 3,
    capture: [1],
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    // Draws followed by scrolls, fills and copies on every frame (scripts/DrawScroll.as).
    name: "draw-scroll",
    swf: (abc) => bare(abc, 1, "DrawScroll", 512, 104),
    script: "DrawScroll",
    frames: 6,
    capture: [2, 4, 6],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // Drawn bitmaps unshown for longer than an idle texture is kept, then read and shown
    // (scripts/DrawIdle.as).
    name: "draw-idle",
    // At 60 frames a second, as adl's job ends 20 s without a word from it.
    swf: (abc) =>
      w.swf({
        width: 120,
        height: 50,
        frameRate: 60,
        frameCount: 1,
        tags: [
          w.fileAttributes(true),
          w.backgroundColor(0xffffff),
          w.doAbc(abc, "DrawIdle"),
          w.symbolClass([[0, "DrawIdle"]]),
          w.showFrame(),
          w.end(),
        ],
      }),
    script: "DrawIdle",
    traced: true,
    frames: 322,
    capture: [100, 200, 322],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // BitmapData.draw takes its source with no blend mode of its own (scripts/DrawRootBlend.as).
    name: "draw-root-blend",
    swf: (abc) => bare(abc, 1, "DrawRootBlend", 320, 120),
    script: "DrawRootBlend",
    frames: 1,
    capture: [1],
    tolerance: 1,
    maxOutliers: 0,
  },
  {
    name: "draw-objects",
    swf: drawObjects,
    script: "DrawObjects",
    frames: 1,
    capture: [1],
    // Edges are each rasteriser's own: anti-aliased at high quality, a dozen drawn pixels
    // within 64 a channel; at low quality, aliased, where a curve passes near a pixel's
    // centre the two decide differently, some 30 more. Each drawn pixel is 16 here.
    tolerance: 32,
    maxOutliers: 768,
  },
  {
    name: "palette-compare",
    swf: (abc) => bare(abc, 1, "PaletteCompare"),
    script: "PaletteCompare",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "perlin-noise",
    swf: (abc) => bare(abc, 1, "PerlinNoise"),
    script: "PerlinNoise",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
];
