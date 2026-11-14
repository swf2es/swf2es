// flash.display.Screen over a host's AirApplication.screens, as adl (AIR
// 51.3) has it: new Screen objects at every call, each keeping its two
// Rectangles, getScreensForRectangle's rounding and what it counts as on a
// screen, and `new Screen()` refused. What FACTS traces is what adl traced
// for the same script on its one screen, whose size it leaves out, but for
// its errors' text, which a debugger's player alone adds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { AirApplication, AirScreen } from "../../../../../../packages/player/dist/index.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { playerglobalLibrary } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../../../out/player-screen/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** An application of no window whose host has `screens`; the player's own where null. */
function application(screens: readonly AirScreen[] | null): AirApplication {
  return {
    descriptor: "<application/>",
    id: "org.swf2es.screens",
    arguments: [],
    ...(screens ? { screens: () => screens } : {}),
  };
}

/** Plays `source`'s class `name` in AIR for `frames` frames with `application`; what it traced. */
async function play(
  name: string,
  source: string,
  frames: number,
  application: AirApplication | null,
): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    air: true,
    application,
    screenCapabilities: { screenResolutionX: 1280, screenResolutionY: 720 },
  });
  await scripting.loadLibraries([libraryAbcs(`${out}libraries/`)[0], playerglobalLibrary]);
  const player = new Player(bare(compiler(out)(name, source), 1, name), scripting);
  try {
    await player.start();
    for (let i = 0; i < frames; i++) {
      player.tick();
    }
  } finally {
    player.destroy();
  }

  return lines;
}

const FACTS = readFileSync(new URL("./Facts.as", import.meta.url), "utf8");

test("a Screen is made at every call and keeps its Rectangles, as adl's", { skip }, async () => {
  // A task bar along its bottom, as adl's desktop had.
  const lines = await play(
    "Facts",
    FACTS,
    3,
    application([
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        visibleBounds: { x: 0, y: 0, width: 1920, height: 1040 },
        colorDepth: 32,
      },
    ]),
  );

  assert.deepEqual(lines, [
    // Never the same Screen twice, nor one of screens' own.
    "new each call false false false -1",
    "screens 1 true true [object Screen]",
    "bounds 0 0 true true true false number true",
    // One Screen's Rectangles are its own, and another's are equal to them.
    "kept true true false true",
    // adl's debugger words it too: "Screen$ class cannot be instantiated."
    "new Screen ArgumentError: Error #2012",
    "found 1 true false true false",
    "inside 1 1 1",
    "no area 0 0 0 0 0",
    // An edge shared is no area shared.
    "touching 0 0 0 0",
    "a pixel in 1 1 1 1",
    "outside 0 0",
    // x, y, width and height each to an int, a half to the even one.
    "rounded widths 0 0 1 0 0",
    "rounded places 0 1 0 0",
    // The far edge is the rounded place and the rounded width, not the far edge rounded.
    "rounded apart 1 0 0 1 0 1",
    "past an int 0 0 0 0 0 1",
    "not finite 0 0 0 0",
    // A script's changes stay in that Screen's Rectangles, and move no screen.
    "changed 1 77 true 1",
    "dispatched change true",
    "listens true true",
    "frame 3 true 1",
  ]);
});

const TWO = readFileSync(new URL("./Two.as", import.meta.url), "utf8");

test("getScreensForRectangle finds the screens a rectangle is on, in the host's order", {
  skip,
}, async () => {
  // The main one second, and to the right of a smaller one.
  const lines = await play(
    "Two",
    TWO,
    1,
    application([
      {
        bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
        visibleBounds: { x: -1280, y: 0, width: 1280, height: 1024 },
        colorDepth: 24,
      },
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        visibleBounds: { x: 0, y: 30, width: 1920, height: 1010 },
        colorDepth: 30,
        main: true,
      },
    ]),
  );

  assert.deepEqual(lines, [
    // A browser's and Electron's 24 bits of true colour, and their 30 of deep colour, are AIR's 32.
    "screens 2 (x=-1280, y=0, w=1280, h=1024) (x=-1280, y=0, w=1280, h=1024) 32",
    "second (x=0, y=0, w=1920, h=1080) (x=0, y=30, w=1920, h=1010) 32",
    "main (x=0, y=0, w=1920, h=1080) (x=0, y=30, w=1920, h=1010)",
    "on one [left] [main] [main]",
    "on both [left,main] [left,main]",
    // Each side of the seam is one screen's; a rectangle rounded to nothing is on neither.
    "at the seam [left] [main] [left,main] []",
    "on none [] [] [] [] [] []",
    // The whole screen counts, its task bar too.
    "in the free part's gap [main]",
    // adl crashes here, reading through the null.
    "null TypeError: Error #2007",
  ]);
});

const DEFAULT = `package {
  import flash.display.Screen;
  import flash.display.Sprite;

  public class Default extends Sprite {
    public function Default() {
      var main:Screen = Screen.mainScreen;
      trace(Screen.screens.length, main.bounds, main.visibleBounds, main.colorDepth);
    }
  }
}
`;

test("a host that names no screens has one, of the screen capabilities' size", {
  skip,
}, async () => {
  const expected = ["1 (x=0, y=0, w=1280, h=720) (x=0, y=0, w=1280, h=720) 32"];

  assert.deepEqual(await play("Default", DEFAULT, 1, application(null)), expected);
  assert.deepEqual(await play("Default", DEFAULT, 1, null), expected);
  assert.deepEqual(await play("Default", DEFAULT, 1, application([])), expected);
});

test("colorDepth counts a pixel's bits as AIR does: 32 for true colour, fewer as they are", {
  skip,
}, async () => {
  const bounds = { x: 0, y: 0, width: 1280, height: 720 };
  const depth = async (colorDepth: number) =>
    (
      await play(
        "Default",
        DEFAULT,
        1,
        application([{ bounds, visibleBounds: bounds, colorDepth }]),
      )
    )[0]
      .split(" ")
      .pop();

  // adl (AIR 51.3) on a desktop of true colour says 32, where Electron's display says 24.
  assert.equal(await depth(24), "32");
  assert.equal(await depth(32), "32");
  assert.equal(await depth(30), "32");
  assert.equal(await depth(16), "16");
  assert.equal(await depth(8), "8");
  assert.equal(await depth(48), "48");
});
