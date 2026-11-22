// Vector art drawn into a BitmapData and shown scaled up, with bitmaps that
// go other ways beside it (scripts/DisplayBitmaps.as), played as a host shows
// it at 2.7 canvas pixels a stage pixel, then 1.8, then 2.7 again for some
// 350 frames, in which the art the main bitmap was drawn from changes and
// nothing redraws the bitmap, then 2.7 after its context was lost, with the
// renderer's bitmapResolution at "stage", Flash's, and at "display".
//
// At display resolution the bitmap must look as the vectors do at each scale
// once it has held for a few frames: the left half of the art against the
// right within a little, and the glowing line, drawn in tiles, the same all
// along. Each bitmap shown must hold a texture at the
// scale its Bitmap shows it at, all the long still while: the one drawn into
// from itself none, the disposed one none from then on, the one a pixel was
// set in none from then on and shown as at Flash's resolution, and after the
// lost context only what was drawn again since; and every pixel the script
// reads back must be the same as at Flash's resolution.
//
//   node tests/player/display-bitmaps.ts [--write DIR]
//   node tests/player/display-bitmaps.ts --write-bench FILE
//
// --write keeps each step's frame as a PNG. --write-bench writes a scene to time
// instead (scripts/DisplayBitmapsBench.as, 1280 by 720): two bitmaps the stage's size drawn
// once, one drawn into on every frame, and sprites moving; play it with bench.ts --swf FILE
// --resolution 3 [--bitmap-resolution display].
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as w from "../swf-writer.ts";
import { withPage } from "./chrome.ts";
import { encodePng, type Image } from "./image.ts";
import { libraryAbcs } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";

const option = (name: string) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const write = option("--write");

libraryAbcs();
const bench = option("--write-bench");
if (bench) {
  const abc = compileScripts(["DisplayBitmapsBench"]).get("DisplayBitmapsBench") as Uint8Array;
  writeFileSync(
    bench,
    w.swf({
      width: 1280,
      height: 720,
      frameRate: 30,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        w.backgroundColor(0xffffff),
        w.doAbc(abc, "DisplayBitmapsBench"),
        w.symbolClass([[0, "Main"]]),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  process.exit(0);
}

const abc = compileScripts(["DisplayBitmaps"]).get("DisplayBitmaps") as Uint8Array;
const swf = w.swf({
  width: 400,
  height: 320,
  frameRate: 24,
  frameCount: 1,
  tags: [
    w.fileAttributes(true),
    w.backgroundColor(0xffffff),
    w.doAbc(abc, "DisplayBitmaps"),
    w.symbolClass([[0, "Main"]]),
    w.showFrame(),
    w.end(),
  ],
});

/** Each step's scale and frames: long enough for a new scale to hold, the third past the read. */
const STEPS = [
  { name: "2.7", resolution: 2.7, frames: 10, capture: true },
  { name: "1.8", resolution: 1.8, frames: 12, capture: true },
  { name: "read", resolution: 2.7, frames: 12, capture: true },
  ...Array.from({ length: 7 }, (_, i) => ({
    name: `still-${i + 1}`,
    resolution: 2.7,
    frames: 50,
    capture: i === 6,
  })),
  { name: "lost", resolution: 2.7, frames: 6, capture: true, lose: true },
];
/** The rows of the stage the art and its vectors take. */
const ART_ROWS = 240;
/** The glowing line's rows within its bitmap, and the bitmap's columns. */
const LINE = { bitmap: 302, rows: 6, x: 5, width: 390 };
/** The bitmap a pixel is set in on frame 15, where it is on the stage. */
const POKE = { x: 350, y: 255, width: 45, height: 30 };

interface Shot {
  width: number;
  height: number;
  pixels: string | null;
  bytes: number;
  count: number;
}

interface Run {
  trace: string[];
  error: string | null;
  shots: Shot[];
}

/** A shot's pixels, its rows read back bottom up turned top down. */
function imageOf(shot: Shot): Image {
  const raw = Buffer.from(shot.pixels as string, "base64");
  const data = new Uint8Array(raw.length);
  const row = shot.width * 4;
  for (let y = 0; y < shot.height; y++) {
    data.set(raw.subarray((shot.height - 1 - y) * row, (shot.height - y) * row), y * row);
  }

  return { width: shot.width, height: shot.height, data };
}

/** The art's left half against its right: the mean step a channel, and the share of pixels off by more than 16. */
function halves(image: Image, rows: number): { mean: number; off: number } {
  const half = Math.floor(image.width / 2);
  let total = 0;
  let off = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < half; x++) {
      const i = (y * image.width + x) * 4;
      const j = i + half * 4;
      let most = 0;
      for (let k = 0; k < 3; k++) {
        const step = Math.abs(image.data[i + k] - image.data[j + k]);
        total += step;
        most = Math.max(most, step);
      }

      off += most > 16 ? 1 : 0;
    }
  }

  const n = half * rows;
  return { mean: total / (n * 3), off: off / n };
}

/**
 * The glowing line's bitmap along its middle: each column's mean channel, the most any strays
 * from their median, where tiles drawn apart would part, as the line is the same all along.
 */
function line(image: Image, resolution: number): number {
  const x0 = Math.ceil((LINE.x + 20) * resolution);
  const x1 = Math.floor((LINE.x + LINE.width - 20) * resolution);
  const y0 = Math.round(LINE.bitmap * resolution);
  const rows = Math.floor(LINE.rows * resolution);
  const columns: number[] = [];
  for (let x = x0; x < x1; x++) {
    let total = 0;
    for (let r = 0; r < rows; r++) {
      const i = ((y0 + r) * image.width + x) * 4;
      total += image.data[i] + image.data[i + 1] + image.data[i + 2];
    }

    columns.push(total / (rows * 3));
  }

  const median = [...columns].sort((a, b) => a - b)[columns.length >> 1];
  return Math.max(...columns.map((c) => Math.abs(c - median)));
}

/** The pixels of `region` of the stage at `resolution`, row by row. */
function region(image: Image, r: typeof POKE, resolution: number): number[] {
  const out: number[] = [];
  for (let y = Math.ceil(r.y * resolution); y < Math.floor((r.y + r.height) * resolution); y++) {
    for (let x = Math.ceil(r.x * resolution); x < Math.floor((r.x + r.width) * resolution); x++) {
      const i = (y * image.width + x) * 4;
      out.push(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
  }

  return out;
}

/** Texels `n` pixels take at `zoom`, as scene/display-bitmaps.ts counts them. */
const texels = (n: number, zoom: number) => Math.max(1, Math.ceil(n * zoom - 1e-6));
/** The bytes a w by h bitmap's texture takes shown at `zoom`, at most 4. */
const bytes = (width: number, height: number, zoom: number) =>
  4 * texels(width, Math.min(4, zoom)) * texels(height, Math.min(4, zoom));
/**
 * What the bitmaps shown hold at a step: the art's (180 by 216 shown at 200/180 a stage pixel),
 * the one drawn into each frame (60 by 40 at 1.25), the one disposed on frame 25 (40 by 30 at
 * 1.4), the one scaled up on frame 12 (40 by 30, at 1 then 1.4), the one a pixel is set in on
 * frame 15 (30 by 20 at 1.5) and the glowing line's (390 by 10 at 1); none for the one drawn
 * from itself. After the lost context, only the one drawn into since.
 */
function expected(resolution: number, name: string): number {
  const art = bytes(180, 216, (resolution * 200) / 180);
  const live = bytes(60, 40, resolution * 1.25);
  const spare = bytes(40, 30, resolution * 1.4);
  const grown = bytes(40, 30, resolution * (name === "2.7" ? 1 : 1.4));
  const poke = bytes(30, 20, resolution * 1.5);
  const wide = bytes(390, 10, resolution);
  switch (name) {
    case "2.7":
      return art + live + spare + grown + poke + wide;
    case "1.8":
      return art + live + spare + grown + wide;
    case "lost":
      return live;
    default:
      return art + live + grown + wide;
  }
}

const grids = new Map<string, Map<string, number[]>>();
const measured = new Map<
  string,
  {
    mean: number;
    off: number;
    bytes: number;
    line: number | null;
    poke: number[] | null;
  }[]
>();
if (write) {
  mkdirSync(write, { recursive: true });
}

await withPage("displayBitmapsSwf", async (evaluate) => {
  const base64 = Buffer.from(swf).toString("base64");
  for (const mode of ["stage", "display"] as const) {
    const { value, exception } = await evaluate<Run>(
      `displayBitmapsSwf(${JSON.stringify(base64)}, "${mode}", ${JSON.stringify(STEPS)})`,
    );
    if (exception !== null || value === undefined) {
      throw new Error(exception ?? "no answer");
    }

    assert.equal(value.error, null, `${mode}: ${value.error}`);
    const read = new Map<string, number[]>();
    for (const line of value.trace) {
      const [name, ...values] = line.split(" ");
      read.set(
        name,
        values.map((hex) => Number.parseInt(hex, 16)),
      );
    }

    grids.set(mode, read);
    measured.set(
      mode,
      value.shots.map((shot, i) => {
        if (!shot.pixels) {
          return { mean: 0, off: 0, bytes: shot.bytes, line: null, poke: null };
        }

        const image = imageOf(shot);
        if (write) {
          writeFileSync(join(write, `${mode}-${STEPS[i].name}.png`), encodePng(image));
        }

        const resolution = STEPS[i].resolution;
        return {
          ...halves(image, Math.round(ART_ROWS * resolution)),
          bytes: shot.bytes,
          line: line(image, resolution),
          poke: region(image, POKE, resolution),
        };
      }),
    );
  }
});

for (const [mode, shots] of measured) {
  console.log(
    `${mode}: ${shots
      .map((m, i) =>
        m.line !== null
          ? `${STEPS[i].name} art against vectors ${m.mean.toFixed(2)} a channel, ${(m.off * 100).toFixed(1)}% off, line's columns ${m.line.toFixed(2)} apart at most, ${(m.bytes / 2 ** 20).toFixed(2)} MB held`
          : `${STEPS[i].name} ${(m.bytes / 2 ** 20).toFixed(2)} MB held`,
      )
      .join("; ")}`,
  );
}

// Every pixel read back the same as at Flash's resolution: the art's, the one drawn into on
// every frame, the one drawn from itself and the copy.
const stage = grids.get("stage") ?? new Map<string, number[]>();
const display = grids.get("display") ?? new Map<string, number[]>();
for (const name of ["pixels", "live", "self", "copy"]) {
  const a = stage.get(name) ?? [];
  const b = display.get(name) ?? [];
  assert.ok(a.length > 0 && a.length === b.length, `no ${name} read back`);
  const differing = a.filter((p, i) => p !== b[i]).length;
  console.log(`${name}: ${a.length} pixels read back, ${differing} differ`);
  assert.equal(differing, 0, `${name}'s pixels read back differ from Flash's resolution`);
}

const shots = measured.get("display") ?? [];
const flash = measured.get("stage") ?? [];
// As the vectors, near enough, at each scale; at Flash's resolution ten times as many are off.
for (const i of [0, 1, 2, STEPS.length - 2]) {
  assert.ok(
    shots[i].off < 0.01 && shots[i].off < flash[i].off / 5,
    `${STEPS[i].name}: ${shots[i].off} off`,
  );
}

// Each texture at the scale its Bitmap shows it at, kept all the still while.
for (const [i, step] of STEPS.entries()) {
  assert.equal(
    shots[i].bytes,
    expected(step.resolution, step.name),
    `${step.name}: ${shots[i].bytes} bytes held, ${expected(step.resolution, step.name)} expected`,
  );
}

// The line drawn in tiles, its glow read past each tile's edge: no column apart.
for (const i of [0, 1, 2, STEPS.length - 2]) {
  const worst = shots[i].line ?? Number.POSITIVE_INFINITY;
  assert.ok(worst < 4, `${STEPS[i].name}: the line's columns ${worst} apart`);
}

// The bitmap a pixel was set in shows as at Flash's resolution.
assert.deepEqual(shots[1].poke, flash[1].poke, "the bitmap a pixel was set in");

// After the lost context, the art shows as at Flash's resolution, as its store's own draws went.
const lost = STEPS.length - 1;
assert.equal(shots[lost].mean, flash[lost].mean, "after the lost context");
