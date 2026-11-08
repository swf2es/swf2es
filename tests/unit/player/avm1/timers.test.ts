// An AVM1 movie's clock on the real clock (avm1/timers.ts): a script that
// spins on getTimer to wait has the clock skip to the time it waits for,
// as AS3's (tests/unit/player/scripting/timers.test.ts), the frames then
// held until the real clock is there; a loop that works between its
// readings runs in real time. The clock is a host's that moves a little
// at each reading, as a loop that does nothing else between them sees it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../avm1-script.ts";
import * as w from "../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

/** A SWF 8 of one frame whose actions are `source`, at `frameRate`. */
function movie(source: string, frameRate = 24): Uint8Array {
  return w.swf({
    version: 8,
    width: 10,
    height: 10,
    frameRate,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A host clock that moves `perRead` ms at each reading, from 0. */
function clock(perRead: number) {
  const state = {
    now: 0,
    reads: 0,
    read: () => {
      state.reads++;
      state.now += perRead;
      return state.now;
    },
  };
  return state;
}

/** `source` started on a clock that moves `perRead` ms a reading: its trace, and the clock. */
async function spinRun(source: string, perRead: number) {
  const time = clock(perRead);
  const lines: string[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(line),
    realTime: time.read,
    audio: null,
  });
  const player = new Player(movie(source), null, avm1);
  const from = time.now;
  await player.start();
  return { lines, reads: time.reads, real: time.now - from, ahead: avm1.timers.ahead() };
}

test("a spin on getTimer has the clock skip to the time it waits for, the real clock then behind", async () => {
  // 10,000 readings a ms: a loop that only reads the clock.
  const { lines, reads, real, ahead } = await spinRun(
    "var start = getTimer(); while (getTimer() - start < 200) {} trace(getTimer() - start);",
    1e-4,
  );

  // Done within a ms past its time, without spinning through the 200 ms.
  const waited = Number(lines[0]);
  assert.ok(waited >= 200 && waited <= 201, lines.join(" "));
  assert.ok(reads < 100_000, `${reads} readings`);
  assert.ok(real < 10, `${real} ms`);
  // The clock is ahead by what was skipped, until the real clock has caught up.
  assert.ok(ahead > 190 && ahead <= 201, `${ahead} ahead`);
});

test("a loop that works between its readings of getTimer runs in real time", async () => {
  // 500 readings a ms: two microseconds of work between them.
  const { lines, reads, ahead } = await spinRun(
    "var start = getTimer(); while (getTimer() - start < 50) {} trace(getTimer() - start);",
    2e-3,
  );

  assert.equal(lines[0], "50");
  assert.ok(reads >= 25_000, `${reads} readings`);
  assert.equal(ahead, 0);
});

test("a movie that holds itself to 30 fps by spinning keeps its pace, the host's calls short", async () => {
  // A 60 fps movie whose onEnterFrame waits for 33 ms after the last, or 2,000,000 readings.
  const time = clock(1e-4);
  const lines: { line: string; real: number }[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push({ line, real: time.now }),
    realTime: time.read,
    audio: null,
  });
  const player = new Player(
    movie(
      `var hold = getTimer() + 33;
      onEnterFrame = function () {
        trace("F " + getTimer());
        var n = 0;
        while (getTimer() <= hold && n < 2000000) { n++; }
        hold = getTimer() + 33;
      };`,
      60,
    ),
    null,
    avm1,
  );
  await player.start();

  // A 60 Hz host whose calls come at the first refresh after the last call's work.
  const refresh = 1000 / 60;
  let last = time.now;
  let busiest = 0;
  const begin = time.now;
  while (time.now - begin < 3000) {
    const call = Math.ceil((time.now + 1e-9) / refresh) * refresh;
    time.now = call;
    player.advance(call - last);
    busiest = Math.max(busiest, time.now - call);
    last = call;
  }

  const frames = lines.filter((l) => l.line.startsWith("F "));
  // About 30 frames a second, as the movie asks, not 60.
  assert.ok(frames.length >= 85 && frames.length <= 95, `${frames.length} frames`);
  // Each call's work a fraction of a refresh: the spins were skipped, not run in real time.
  assert.ok(busiest < 5, `${busiest} ms in the busiest call`);
  // The movie's own cadence: about 33 ms between its frames by getTimer.
  const told = frames.map((f) => Number(f.line.slice(2)));
  const gaps = told.slice(1).map((t, i) => t - told[i]);
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1];
  assert.ok(median >= 33 && median <= 34, `median gap ${median}`);
});
