// flash.display.Screen over a host's AirApplication.screens, as adl (AIR
// 51.3) has it: new Screen objects at every call, each keeping its two
// Rectangles, getScreensForRectangle's rounding and what it counts as on a
// screen, and `new Screen()` refused. What FACTS traces is what adl traced
// for the same script on its one screen, whose size it leaves out, but for
// its errors' text, which a debugger's player alone adds.
import assert from "node:assert/strict";
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

const FACTS = `package {
  import flash.display.Screen;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Rectangle;

  public class Facts extends Sprite {
    private function found(x:Number, y:Number, width:Number, height:Number):int {
      return Screen.getScreensForRectangle(new Rectangle(x, y, width, height)).length;
    }

    public function Facts() {
      var main:Screen = Screen.mainScreen;
      var b:Rectangle = main.bounds;
      var v:Rectangle = main.visibleBounds;
      trace("new each call", Screen.screens === Screen.screens, Screen.screens[0] === Screen.screens[0], Screen.mainScreen === Screen.mainScreen, Screen.screens.indexOf(Screen.mainScreen));
      trace("screens", Screen.screens.length, Screen.screens[0] is Screen, Screen.screens[0].bounds.equals(b), String(main));
      trace("bounds", b.x, b.y, b.width > 0, b.height > 0, b.containsRect(v), b.equals(v), typeof main.colorDepth, main.colorDepth > 0);
      trace("kept", main.bounds === b, main.visibleBounds === v, Screen.mainScreen.bounds === b, Screen.mainScreen.bounds.equals(b));
      try {
        trace(new Screen());
      } catch (e:Error) {
        trace("new Screen", e);
      }

      var all:Array = Screen.getScreensForRectangle(b);
      trace("found", all.length, all[0] is Screen, all[0] === main, all[0].bounds.equals(b), Screen.getScreensForRectangle(b) === all);
      trace("inside", found(10, 10, 10, 10), found(0, 0, 1, 1), found(-100000, -100000, 300000, 300000));
      trace("no area", found(10, 10, 0, 0), found(10, 10, 0, 10), found(10, 10, 10, 0), found(10, 10, -5, -5), found(-5, -5, -5, -5));
      trace("touching", found(-10, 0, 10, 10), found(0, -10, 10, 10), found(b.right, 0, 10, 10), found(0, b.bottom, 10, 10));
      trace("a pixel in", found(-10, 0, 11, 10), found(0, -10, 10, 11), found(b.right - 1, 0, 10, 10), found(0, b.bottom - 1, 10, 10));
      trace("outside", found(-100000, -100000, 10, 10), found(b.right + 100000, 0, 10, 10));
      trace("rounded widths", found(-10, 0, 10.4, 10), found(-10, 0, 10.5, 10), found(-10, 0, 10.6, 10), found(-12, 0, 11.5, 10), found(-12, 0, 12.5, 10));
      trace("rounded places", found(-11.5, 0, 12, 10), found(-12.5, 0, 13, 10), found(-12.5, 0, 12, 10), found(-10.6, 0, 11, 10));
      trace("rounded apart", found(10.6, 10.6, 0.8, 0.8), found(10.4, 10.4, 0.2, 0.2), found(10.5, 10.5, 0.2, 0.2), found(10, 10, 1.5, 1.5), found(10, 10, 0.5, 10), found(10, 10, 0.51, 0.51));
      trace("past an int", found(3e9, 0, 10, 10), found(-3e9, 0, 3e9 + 10, 10), found(10, 10, 4294967306, 10), found(10, 10, 2147483648, 10), found(10, 10, 2147483647, 10), found(-5, 10, 2147483000, 10));
      trace("not finite", found(NaN, NaN, NaN, NaN), found(10, 10, NaN, NaN), found(10, 10, Infinity, Infinity), found(-Infinity, 0, Infinity, 10));
      b.width = 1;
      v.x = 77;
      trace("changed", main.bounds.width, main.visibleBounds.x, Screen.mainScreen.bounds.width > 1, found(500, 10, 10, 10));
      main.addEventListener(Event.CHANGE, function(e:Event):void {
        trace("dispatched", e.type, e.target === main);
      });
      trace("listens", main.hasEventListener(Event.CHANGE), main.dispatchEvent(new Event(Event.CHANGE)));
      var frames:int = 0;
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (++frames == 3) {
          trace("frame 3", main.bounds === b, b.width);
        }
      });
    }
  }
}
`;

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

const TWO = `package {
  import flash.display.Screen;
  import flash.display.Sprite;
  import flash.geom.Rectangle;

  public class Two extends Sprite {
    private function found(x:Number, y:Number, width:Number, height:Number):String {
      var screens:Array = Screen.getScreensForRectangle(new Rectangle(x, y, width, height));
      var names:Array = [];
      for (var i:int = 0; i < screens.length; i++) {
        names.push(screens[i].bounds.x < 0 ? "left" : "main");
      }

      return "[" + names.join(",") + "]";
    }

    public function Two() {
      var screens:Array = Screen.screens;
      trace("screens", screens.length, screens[0].bounds, screens[0].visibleBounds, screens[0].colorDepth);
      trace("second", screens[1].bounds, screens[1].visibleBounds, screens[1].colorDepth);
      trace("main", Screen.mainScreen.bounds, Screen.mainScreen.visibleBounds);
      trace("on one", found(-1000, 100, 200, 200), found(100, 100, 200, 200), found(100, 1030, 50, 50));
      trace("on both", found(-100, 100, 200, 200), found(-5000, -5000, 10000, 10000));
      trace("at the seam", found(-10, 0, 10, 10), found(0, 0, 10, 10), found(-1, 0, 2, 10), found(-0.5, 0, 0.5, 10));
      trace("on none", found(-1000, 1030, 50, 50), found(-1280, 1024, 1280, 56), found(1920, 0, 10, 10), found(-1290, 0, 10, 10), found(-100, 100, 0, 200), found(-100, 100, 200, -1));
      trace("in the free part's gap", found(100, 1050, 10, 10));
      try {
        trace(Screen.getScreensForRectangle(null));
      } catch (e:Error) {
        trace("null", e);
      }
    }
  }
}
`;

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
