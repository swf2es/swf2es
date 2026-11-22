// Vector art drawn into a BitmapData and shown scaled up, with bitmaps that
// go other ways beside it (scripts/DisplayBitmaps.as), played as a host shows
// it at 2.7 canvas pixels a stage pixel, then 1.8, then 2.7 again, then 2.7
// after its context was lost, with the renderer's bitmapResolution at
// "stage", Flash's, and at "display".
//
// At display resolution the bitmap must look as the vectors do at each scale
// once it has held for a few frames: the left half of the art against the
// right within a little. Each bitmap shown must hold a texture at the scale
// its Bitmap shows it at, the one drawn into from itself none, the disposed
// one none from then on, and after the lost context only what was drawn
// again since; and every pixel the script reads back must be the same as at
// Flash's resolution.
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
  height: 300,
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
  { name: "lost", resolution: 2.7, frames: 6, capture: true, lose: true },
];
/** The rows of the stage the art and its vectors take. */
const ART_ROWS = 240;

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

/** Texels `n` pixels take at `zoom`, as scene/display-bitmaps.ts counts them. */
const texels = (n: number, zoom: number) => Math.max(1, Math.ceil(n * zoom - 1e-6));
/** The bytes a w by h bitmap's texture takes shown at `zoom`. */
const bytes = (width: number, height: number, zoom: number) =>
  4 * texels(width, zoom) * texels(height, zoom);
/**
 * What the bitmaps shown hold at each step: the art's (180 by 216 shown at 200/180 a stage
 * pixel), the one drawn into each frame (60 by 40 at 1.25), the one disposed on frame 25
 * (40 by 30 at 1.4) and the one scaled up on frame 12 (40 by 30, at 1 then 1.4); none for the
 * one drawn from itself. After the lost context, only the one drawn into since.
 */
function expected(resolution: number, step: number): number {
  const art = bytes(180, 216, (resolution * 200) / 180);
  const live = bytes(60, 40, resolution * 1.25);
  const spare = bytes(40, 30, resolution * 1.4);
  const grown = bytes(40, 30, resolution * (step === 0 ? 1 : 1.4));
  return [art + live + spare + grown, art + live + spare + grown, art + live + grown, live][step];
}

const grids = new Map<string, Map<string, number[]>>();
const measured = new Map<string, { mean: number; off: number; bytes: number }[]>();
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
        const image = imageOf(shot);
        if (write) {
          writeFileSync(join(write, `${mode}-${STEPS[i].name}.png`), encodePng(image));
        }

        return {
          ...halves(image, Math.round(ART_ROWS * STEPS[i].resolution)),
          bytes: shot.bytes,
        };
      }),
    );
  }
});

for (const [mode, shots] of measured) {
  console.log(
    `${mode}: ${shots
      .map(
        (m, i) =>
          `${STEPS[i].name} art against vectors ${m.mean.toFixed(2)} a channel, ${(m.off * 100).toFixed(1)}% off, ${(m.bytes / 2 ** 20).toFixed(2)} MB held`,
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
for (const [i, step] of [0, 1, 2].entries()) {
  assert.ok(
    shots[step].off < 0.01 && shots[step].off < flash[step].off / 5,
    `${STEPS[i].name}: ${shots[step].off} off`,
  );
}

// Each texture at the scale its Bitmap shows it at.
for (const [i, step] of STEPS.entries()) {
  assert.equal(
    shots[i].bytes,
    expected(step.resolution, i),
    `${step.name}: ${shots[i].bytes} bytes held, ${expected(step.resolution, i)} expected`,
  );
}

// After the lost context, the art shows as at Flash's resolution, as its store's own draws went.
assert.equal(shots[3].mean, flash[3].mean, "after the lost context");
