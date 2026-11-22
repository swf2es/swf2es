// Vector art drawn into a BitmapData the stage's size and shown scaled up
// (scripts/DisplayBitmaps.as: the bitmap on the left, the same art as
// vectors on the right), played as a host shows it at 2.7 canvas pixels a
// stage pixel, then 1.8, then 2.7 again, with the renderer's
// bitmapResolution at "stage", Flash's, and at "display".
//
// At display resolution the bitmap must look as the vectors do, at each
// scale once it has held for a few frames: the left half against the right
// within a little. What the script reads back thirty frames on must be what
// it reads at Flash's resolution, the bitmap drawn again there; and after
// that read and a fill the bitmap shows at a texel a pixel again.
//
//   node tests/player/display-bitmaps.ts [--write DIR]
//   node tests/player/display-bitmaps.ts --write-bench FILE
//
// --write-bench writes a scene to time instead (scripts/DisplayBitmapsBench.as, 1280 by 720):
// two bitmaps the stage's size drawn once, one drawn into on every frame, and sprites moving;
// play it with bench.ts --swf FILE --resolution 3 [--bitmap-resolution display].
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as w from "../swf-writer.ts";
import { withPage } from "./chrome.ts";
import { encodePng, type Image } from "./image.ts";
import { libraryAbcs } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";

const write = process.argv.includes("--write")
  ? process.argv[process.argv.indexOf("--write") + 1]
  : join(homedir(), ".cache/swf2es/hires-bitmaps");

libraryAbcs();
if (process.argv.includes("--write-bench")) {
  const bench = compileScripts(["DisplayBitmapsBench"]).get("DisplayBitmapsBench") as Uint8Array;
  writeFileSync(
    process.argv[process.argv.indexOf("--write-bench") + 1],
    w.swf({
      width: 1280,
      height: 720,
      frameRate: 30,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        w.backgroundColor(0xffffff),
        w.doAbc(bench, "DisplayBitmapsBench"),
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
  height: 240,
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

/** Each step's scale and frames: long enough for a new scale to hold, the last past the read. */
const STEPS = [
  { name: "2.7", resolution: 2.7, frames: 10, capture: true },
  { name: "1.8", resolution: 1.8, frames: 12, capture: true },
  { name: "read", resolution: 2.7, frames: 12, capture: true },
];

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

/** The left half against the right: the mean step a channel, and the share of pixels off by more than 16. */
function halves(image: Image): { mean: number; off: number } {
  const half = Math.floor(image.width / 2);
  let total = 0;
  let off = 0;
  for (let y = 0; y < image.height; y++) {
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

  const n = half * image.height;
  return { mean: total / (n * 3), off: off / n };
}

const grids = new Map<string, number[]>();
const measured = new Map<string, { mean: number; off: number; bytes: number }[]>();
mkdirSync(write, { recursive: true });
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
    const line = value.trace.find((t) => t.startsWith("pixels ")) ?? "";
    grids.set(
      mode,
      line
        .slice(7)
        .split(" ")
        .map((hex) => Number.parseInt(hex, 16)),
    );
    measured.set(
      mode,
      value.shots.map((shot, i) => {
        const image = imageOf(shot);
        writeFileSync(join(write, `${mode}-${STEPS[i].name}.png`), encodePng(image));
        return { ...halves(image), bytes: shot.bytes };
      }),
    );
  }
});

for (const [mode, shots] of measured) {
  console.log(
    `${mode}: ${shots
      .map(
        (m, i) =>
          `${STEPS[i].name} bitmap against vectors ${m.mean.toFixed(2)} a channel, ${(m.off * 100).toFixed(1)}% off, ${(m.bytes / 2 ** 20).toFixed(1)} MB held`,
      )
      .join("; ")}`,
  );
}

const stage = grids.get("stage") ?? [];
const display = grids.get("display") ?? [];
assert.ok(stage.length > 0 && stage.length === display.length, "no pixels read back");
const differing = stage.filter((p, i) => p !== display[i]).length;
console.log(`${stage.length} pixels read back: ${differing} differ; frames in ${write}`);

const [at27, at18, read] = measured.get("display") ?? [];
const [flash27] = measured.get("stage") ?? [];
// As the vectors, near enough, at each scale: at Flash's resolution ten times as many are off.
assert.ok(at27.off < 0.01 && at27.off < flash27.off / 5, `at 2.7: ${at27.off} off`);
assert.ok(at18.off < 0.01, `drawn again at 1.8: ${at18.off} off`);
// Read back as Flash's draws make it, then shown so.
assert.equal(differing, 0, "pixels read back differ from Flash's resolution");
assert.equal(read.bytes, 0, "the bitmap still holds its texture at display resolution");
