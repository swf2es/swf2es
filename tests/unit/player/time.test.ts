// The player's pacing: a tick is one frame and one frame's time;
// advance(dt) plays frames on the grid of the frame rate as Flash does, as
// many in a call as the host's typical interval holds, and drops the
// frames a long frame or a stall lost rather than run them back to back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../oracle/oracle.ts";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { bare } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compiler } from "../../player/scripts.ts";
import * as w from "../../swf-writer.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../out/player-time/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

/** A player of a SWF with no scripts at `frameRate`, long enough never to loop in a test. */
function playerAt(frameRate: number): Player {
  return new Player(
    w.swf({
      width: 10,
      height: 10,
      frameRate,
      frameCount: 2000,
      tags: [
        w.fileAttributes(false),
        ...Array.from({ length: 2000 }, () => w.showFrame()),
        w.end(),
      ],
    }),
  );
}

/** What each call to advance played, for `dts`. */
function play(player: Player, dts: number[]): number[] {
  return dts.map((dt) => player.advance(dt));
}

const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);
const hz = (rate: number, calls: number) => Array.from({ length: calls }, () => 1000 / rate);

test("advance plays a frame per frame's time, keeps the remainder, and says how many it played", () => {
  const player = playerAt(10);

  // Less than a frame: nothing yet; the rest adds up.
  assert.deepEqual(play(player, [60, 60, 50, 50]), [0, 1, 0, 1]);
  assert.equal(player.root.currentFrame, 3);
});

test("a 24 fps SWF on a 60 Hz display plays 24 frames a second, one a call at most", () => {
  const player = playerAt(24);
  const counts = play(player, hz(60, 600));

  assert.ok(counts.every((n) => n <= 1));
  assert.ok(Math.abs(sum(counts) - 240) <= 1, `${sum(counts)} frames`);
});

test("a long frame is not caught up with: the next frame runs at once, the next at its slot", () => {
  const player = playerAt(10);
  // A 20 Hz host, then 230 ms: one frame, and the two it lost dropped.
  assert.deepEqual(play(player, [50, 50, 50, 230]), [0, 1, 0, 1]);

  // 80 ms of the next frame passed already: it runs at the next call, then the grid's pace.
  assert.deepEqual(play(player, [50, 50, 50, 50, 50]), [1, 0, 1, 0, 1]);
});

test("a 200 ms hitch at 60 Hz runs one frame, not a burst, and drops what it lost", () => {
  const player = playerAt(24);
  play(player, hz(60, 120));

  const after = play(player, [200, ...hz(60, 60)]);
  assert.ok(after.every((n) => n <= 1));
  // 1.2 s is worth 28.8 frames; the hitch's lost ones are dropped.
  assert.ok(sum(after) >= 24 && sum(after) <= 26, `${sum(after)} frames`);
});

test("a 120 fps SWF on a 60 Hz display plays two frames a call", () => {
  const player = playerAt(120);
  play(player, hz(60, 10));

  const counts = play(player, hz(60, 60));
  assert.ok(counts.every((n) => n <= 2));
  assert.ok(Math.abs(sum(counts) - 120) <= 2, `${sum(counts)} frames`);
});

test("a 24 fps SWF on a 30 Hz display plays 24 frames a second", () => {
  const player = playerAt(24);
  play(player, hz(30, 10));

  const counts = play(player, hz(30, 300));
  assert.ok(counts.every((n) => n <= 1));
  assert.ok(Math.abs(sum(counts) - 240) <= 1, `${sum(counts)} frames`);
});

test("seconds in a background tab play one frame when it comes back, then the usual pace", () => {
  const player = playerAt(24);
  play(player, hz(60, 60));

  const counts = play(player, [5000, ...hz(60, 60)]);
  assert.equal(counts[0], 1);
  assert.ok(counts.every((n) => n <= 1));
  assert.ok(Math.abs(sum(counts) - 25) <= 1, `${sum(counts)} frames`);
});

test("a walk placed by the time between frames reaches its end on a host that lags", {
  skip,
}, async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const lines: string[] = [];
  // The host's clock: the time passes between its animation frames, none while frames run.
  let now = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: () => now,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("WalkStall"), 1), scripting);
  await player.start();

  // 60 Hz, with a 200 ms draw every half second: 1.7 s of walk and some to spare.
  for (let call = 1; call <= 180; call++) {
    const dt = call % 30 === 0 ? 200 : 1000 / 60;
    now += dt;
    player.advance(dt);
  }

  assert.deepEqual(lines, ["arrived"]);
});
