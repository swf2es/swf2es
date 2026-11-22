// Vector art drawn into a BitmapData the stage's size and shown scaled up
// (scripts/DisplayBitmaps.as), on a stage shown at 2.7 canvas pixels a
// stage pixel, with the renderer's bitmapResolution at "stage", Flash's,
// and at "display": frame 1 as each draws it, frame 2 after the script read
// the bitmap's pixels and filled a marker. What the script read must be
// the same both ways but where lines thinner than a pixel cross it: at
// display resolution the bitmap is read back averaged down to its size.
// --verbose names each pixel that differs.
//
//   node tests/player/display-bitmaps.ts [--write DIR] [--zoom Z] [--verbose]
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as w from "../swf-writer.ts";
import { runPlayer } from "./chrome.ts";
import { libraryAbcs } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";

const option = (name: string) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const write = option("--write") ?? join(homedir(), ".cache/swf2es/hires-bitmaps");
const zoom = Number(option("--zoom") ?? 2.7);

libraryAbcs();
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

const modes = ["stage", "display"] as const;
const results = await runPlayer(
  modes.map((bitmapResolution) => ({
    swf,
    frames: 2,
    capture: [1, 2],
    zoom,
    shown: true,
    bitmapResolution,
  })),
);

mkdirSync(write, { recursive: true });
const grids: number[][] = [];
for (const [i, mode] of modes.entries()) {
  const result = results[i];
  assert.equal(result.error, null, `${mode}: ${result.error}`);
  for (const [frame, png] of result.images) {
    writeFileSync(join(write, `${mode}-frame${frame}.png`), png);
  }

  const line = result.trace.find((t) => t.startsWith("pixels ")) ?? "";
  grids.push(
    line
      .slice(7)
      .split(" ")
      .map((hex) => Number.parseInt(hex, 16)),
  );
}

const [stage, display] = grids;
assert.equal(stage.length, display.length);
let most = 0;
let differing = 0;
let far = 0;
for (let i = 0; i < stage.length; i++) {
  let pixel = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    pixel = Math.max(
      pixel,
      Math.abs(((stage[i] >>> shift) & 255) - ((display[i] >>> shift) & 255)),
    );
  }

  most = Math.max(most, pixel);
  differing += pixel > 0 ? 1 : 0;
  far += pixel > 4 ? 1 : 0;
  if (pixel > 0 && process.argv.includes("--verbose")) {
    console.log(
      `(${5 + (i % 10) * 20}, ${5 + Math.floor(i / 10) * 20}): ${stage[i].toString(16)} vs ${display[i].toString(16)}`,
    );
  }
}

console.log(
  `${stage.length} pixels read back: ${differing} differ, ${far} by more than 4, by at most ${most} a channel; frames in ${write}`,
);
// Averaged down from texels drawn at 3 a side rather than sampled 4 a side, fills differ by a
// level or so; lines thinner than a pixel, hairlines among them, by much more, as Flash draws them
// a pixel wide and the display a texel.
assert.ok(far <= stage.length * 0.15, `${far} pixels read back differ by more than 4`);
