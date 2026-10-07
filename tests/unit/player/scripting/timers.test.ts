// The player's clock and timers through a SWF's scripts: Timer's firings
// in the order of their times, and getTimer by the real clock or the
// frame's.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../out/player-timers/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("timers fire in the order of their times, each at its own time", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  // A 10 fps root: the clock is at 100 as the constructor starts the timers, at 400 after three ticks.
  const player = new Player(bare(compiler(out)("Timers"), 4), scripting);
  player.frameRate = 10;
  await player.start();
  player.tick();
  player.tick();
  player.tick();
  // Both due at 400: B was scheduled for it first, at 250, and goes first.
  assert.deepEqual(lines, ["A 200", "B 250", "A 300", "B 400", "A 400"]);
});

test("timers due at once fire in the order started, after others around them were stopped", {
  skip,
}, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  // Five timers started A to E, three stopped at once: B and C, both due at 300, keep their order.
  const player = new Player(bare(compiler(out)("TimerTies"), 3), scripting);
  player.frameRate = 10;
  await player.start();
  player.tick();
  player.tick();
  assert.deepEqual(lines, ["B 300", "C 300"]);
});

test("a timer whose closure throws keeps running and fires again", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("TimerThrows"), 3), scripting);
  player.frameRate = 10;
  await player.start();
  // The first firing's error reaches the host; the timer is back in its place for the next.
  assert.throws(() => player.tick());
  assert.equal(scripting.timers.now, scripting.timers.clock);
  player.tick();
  assert.deepEqual(lines, ["firing 1 200 true", "firing 2 300 true"]);
});

test("getTimer reads the real clock as it runs on within a frame, or the frame clock if asked", {
  skip,
}, async () => {
  const compile = compiler(out);
  const swf = bare(
    compile(
      "ClockReads",
      `package {
        import flash.display.Sprite;
        import flash.utils.getTimer;
        public class ClockReads extends Sprite {
          public function ClockReads() { var a:int = getTimer(); var b:int = getTimer(); trace(a, b); }
        }
      }`,
    ),
    1,
    "ClockReads",
  );

  // The frame clock: the first frame's time at 24 fps, the same at each read.
  const framed: string[] = [];
  const stepped = new Scripting(await createCodegen(wasm), {
    print: (l) => framed.push(l),
    realTime: null,
  });
  await stepped.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, stepped).start();
  assert.deepEqual(framed, ["42 42"]);

  // A host's clock, read once as the player starts, then at each getTimer:
  // the time since, which runs on within the frame.
  let clock = 1000;
  const real: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (l) => real.push(l),
    realTime: () => (clock += 2),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, scripting).start();
  assert.deepEqual(real, ["2 4"]);
});

test("getTimer runs on in real time by default", { skip }, async () => {
  const swf = bare(
    compiler(out)(
      "ClockRuns",
      `package {
        import flash.display.Sprite;
        import flash.utils.getTimer;
        public class ClockRuns extends Sprite {
          public function ClockRuns() {
            var start:int = getTimer();
            for (var n:int = 0; getTimer() == start && n < 100000000; n++) {}
            trace(getTimer() > start);
          }
        }
      }`,
    ),
    1,
    "ClockRuns",
  );
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (l) => lines.push(l) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, scripting).start();
  assert.deepEqual(lines, ["true"]);
});
