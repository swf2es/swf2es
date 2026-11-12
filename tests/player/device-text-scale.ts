// Device text on a stage a host shows at a scale that is not a whole number,
// as a window fits it: Flash rasterizes a device font at the size it is
// shown, so its text stays as sharp as the browser's own at that size. It
// was rasterized at the next whole resolution and scaled to the shown one,
// which blurred thin lettering in a small window (0.9 canvas pixels a stage
// pixel) and left it sharp maximised (1.95).
//
// Measured as the share of a text's inked pixels that are grey, edge pixels
// half covered, against the same text drawn by the page's canvas at that
// size; plain, in a glow's layer (white on white, which leaves the text's
// pixels as they are) and cached as a bitmap. And a window dragged through
// many resolutions, which must not rasterize the text anew at each.
//
//   node tests/player/device-text-scale.ts [--write DIR]
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as w from "../swf-writer.ts";
import { withPage } from "./chrome.ts";
import { encodePng, type Image } from "./image.ts";

const TEXT = "Guild of Pixels 0123";
/** The text's size, in stage pixels. */
const SIZE = 10;
const write = process.argv.includes("--write")
  ? process.argv[process.argv.indexOf("--write") + 1]
  : null;

const field = w.editText(2, TEXT, 3600, 320, 0, { font: 1, fontHeight: SIZE * 20, color: 0 });
const swf = w.swf({
  version: 10,
  width: 200,
  height: 100,
  frameRate: 30,
  frameCount: 1,
  tags: [
    w.backgroundColor(0xffffff),
    w.fontName(1, "_sans"),
    field,
    w.sprite(3, 1, [w.place({ depth: 1, character: 2 }), w.showFrame()]),
    w.place({ depth: 1, character: 2, matrix: { tx: 200, ty: 100 } }),
    w.place({
      depth: 2,
      character: 3,
      matrix: { tx: 200, ty: 700 },
      glows: [{ color: 0xffffff, blur: 2, strength: 2 }],
    }),
    w.place({ depth: 3, character: 3, matrix: { tx: 200, ty: 1300 }, cacheAsBitmap: true }),
    w.showFrame(),
    w.end(),
  ],
});

/** Each field's text, in stage pixels, the gutter's 2 pixels in from where it is placed. */
const REGIONS = [
  { name: "plain", x: 10, y: 5, width: 180, height: 20 },
  { name: "glow", x: 10, y: 35, width: 180, height: 20 },
  { name: "cached", x: 10, y: 65, width: 180, height: 20 },
];

const RESOLUTIONS = [0.9, 1, 1.25, 1.5, 1.95, 2];

interface Frame {
  width: number;
  height: number;
  pixels: string | null;
  rasterized: number;
}

/** A frame's pixels, its rows read back bottom up turned top down. */
function imageOf(frame: Frame): Image {
  const raw = Buffer.from(frame.pixels as string, "base64");
  const data = new Uint8Array(raw.length);
  const row = frame.width * 4;
  for (let y = 0; y < frame.height; y++) {
    data.set(raw.subarray((frame.height - 1 - y) * row, (frame.height - y) * row), y * row);
  }

  return { width: frame.width, height: frame.height, data };
}

function crop(image: Image, x: number, y: number, width: number, height: number): Image {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }

  return { width, height, data };
}

/** The squared steps in ink between neighbouring pixels over the ink: what blurring lowers. */
function edges(image: Image): number {
  const ink = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    return 1 - (image.data[i] + image.data[i + 1] + image.data[i + 2]) / (3 * 255);
  };
  let total = 0;
  let steps = 0;
  for (let y = 0; y < image.height - 1; y++) {
    for (let x = 0; x < image.width - 1; x++) {
      const here = ink(x, y);
      total += here;
      steps += (ink(x + 1, y) - here) ** 2 + (ink(x, y + 1) - here) ** 2;
    }
  }

  return total > 0 ? steps / total : 0;
}

/** The share of inked pixels, black on white, that are grey: no more than 4/5 nor less than 1/5 inked. */
function greyShare(image: Image): number {
  let inked = 0;
  let grey = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const ink = 1 - (image.data[i] + image.data[i + 1] + image.data[i + 2]) / (3 * 255);
    if (ink > 0.2) {
      inked++;
      if (ink < 0.8) {
        grey++;
      }
    }
  }

  return inked > 0 ? grey / inked : 0;
}

await withPage("deviceTextSwf", async (evaluate) => {
  const base64 = Buffer.from(swf).toString("base64");
  const ask = async <R>(expression: string): Promise<R> => {
    const { value, exception } = await evaluate<R>(expression);
    if (exception !== null || value === undefined) {
      throw new Error(exception ?? "no answer");
    }

    return value;
  };

  const frames = await ask<Frame[]>(
    `deviceTextSwf(${JSON.stringify(base64)}, ${JSON.stringify(RESOLUTIONS)}, true)`,
  );
  const failures: string[] = [];
  for (let i = 0; i < RESOLUTIONS.length; i++) {
    const r = RESOLUTIONS[i];
    const image = imageOf(frames[i]);
    const width = Math.floor(REGIONS[0].width * r);
    const height = Math.floor(REGIONS[0].height * r);
    const reference = await ask<string>(
      `canvasText(${JSON.stringify(TEXT)}, "${SIZE * r}px Arial, Helvetica, sans-serif", ${width}, ${height}, 2, ${Math.round(15 * r)})`,
    );
    const canvas = { width, height, data: Buffer.from(reference, "base64") };
    const expected = { grey: greyShare(canvas), edges: edges(canvas) };
    const measured = REGIONS.map((region) => {
      const part = crop(image, Math.floor(region.x * r), Math.floor(region.y * r), width, height);
      if (write) {
        mkdirSync(write, { recursive: true });
        writeFileSync(join(write, `${region.name}-${r}.png`), encodePng(part));
      }

      return { grey: greyShare(part), edges: edges(part) };
    });
    const shown = (m: { grey: number; edges: number }) =>
      `${m.grey.toFixed(3)} grey, ${m.edges.toFixed(3)} edges`;
    console.log(
      `${r.toFixed(2)}: ${measured.map((m, k) => `${REGIONS[k].name} ${shown(m)}`).join("; ")}; canvas ${shown(expected)}`,
    );
    for (let k = 0; k < REGIONS.length; k++) {
      // As sharp as the canvas's own, near enough: scaled after rasterizing, its edges were a
      // fifth to a third softer.
      if (measured[k].edges < expected.edges * 0.9) {
        failures.push(
          `${REGIONS[k].name} at ${r}: ${shown(measured[k])}, canvas ${shown(expected)}`,
        );
      }
    }
  }

  // A window dragged from 0.9 to 1.95 canvas pixels a stage pixel, a frame at each step, and
  // then left: its text rasterized again only as its size crosses a step, not every frame.
  const drag: number[] = [];
  for (let r = 0.9; r <= 1.95; r += 0.005) {
    drag.push(r);
  }

  for (let i = 0; i < 30; i++) {
    drag.push(1.95);
  }

  const dragged = await ask<Frame[]>(
    `deviceTextSwf(${JSON.stringify(base64)}, ${JSON.stringify(drag)}, false)`,
  );
  const first = dragged[0].rasterized;
  let busy = 0;
  for (let i = 1; i < dragged.length; i++) {
    busy += dragged[i].rasterized > dragged[i - 1].rasterized ? 1 : 0;
  }

  const moving = dragged[dragged.length - 31].rasterized - first;
  const still = dragged[dragged.length - 1].rasterized - dragged[dragged.length - 31].rasterized;
  console.log(
    `drag: ${first} rasterized at first, ${moving} over ${drag.length - 31} frames of resizing (in ${busy} of them), ${still} over 30 still`,
  );
  assert.equal(still, 0, "text left at one resolution is rasterized again");
  // Its glyphs at each half pixel of its size, 9 to 19.5, at each of their 4 phases at most.
  const sizes = Math.round((1.95 - 0.9) * SIZE * 2) + 1;
  const glyphs = new Set(TEXT.replaceAll(" ", "")).size;
  assert.ok(moving <= sizes * glyphs * 4, `${moving} rasterized while resizing`);
  assert.deepEqual(failures, []);
});

console.log("device-text-scale: ok");
