// MovieClip's AS2 face in node: its methods and display properties on
// clips an AVM1 SWF places, compiled by the release codegen.wasm.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";
import { files, movie, play, take } from "../network.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

const as1 = (source: string, version: number) =>
  w.doAction([...script(source, version)(flashAssembler()).end().bytes()]);

/** A 20 pixel square, shape 1. */
const square = w.shape({
  id: 1,
  bounds: [0, 400, 0, 400],
  fills: [0xff0000],
  paths: [
    {
      fill1: 1,
      commands: [{ move: [0, 0] }, { line: [400, 0] }, { line: [400, 400] }, { line: [0, 400] }],
    },
  ],
});

/**
 * What `source` traces in a SWF of `version` whose root places `a` and `c`,
 * clips of the square, at (10, 5) and (30, 5), and `Beta` of three frames.
 */
async function traces(source: string, version = 7): Promise<string[]> {
  const swf = w.swf({
    version,
    width: 100,
    height: 100,
    frameCount: 1,
    tags: [
      square,
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(3, 3, [w.showFrame(), w.showFrame(), w.showFrame(), w.end()]),
      w.place({ depth: 1, character: 2, name: "a", matrix: { tx: 200, ty: 100 } }),
      w.place({ depth: 2, character: 2, name: "c", matrix: { tx: 600, ty: 100 } }),
      w.place({ depth: 3, character: 3, name: "Beta" }),
      as1(source, version),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const errors: unknown[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
  });
  await new Player(swf, null, avm1).start();
  assert.deepEqual(errors, []);
  return lines;
}

test("depths are the timeline's less 16384, and swapDepths swaps with a sibling or moves to a depth", async () => {
  assert.deepEqual(
    await traces(
      `trace(a.getDepth() + " " + c.getDepth()); a.swapDepths(c); trace(a.getDepth() + " " + c.getDepth());
a.swapDepths(-16000); trace(a.getDepth()); trace(typeof getInstanceAtDepth); trace(this.getInstanceAtDepth(-16000)._name);
trace(this.getNextHighestDepth());`,
    ),
    ["-16383 -16382", "-16382 -16383", "-16000", "function", "a", "0"],
  );
});

test("points and bounds go between a clip's space and the root's in twips", async () => {
  assert.deepEqual(
    await traces(
      `var p = {x: 1.234, y: 2}; a.localToGlobal(p); trace(p.x + " " + p.y); a.globalToLocal(p); trace(p.x + " " + p.y);
var b = a.getBounds(); trace(b.xMin + " " + b.xMax + " " + b.yMin + " " + b.yMax);
b = a.getBounds(this); trace(b.xMin + " " + b.xMax + " " + b.yMin + " " + b.yMax);
b = Beta.getBounds(); trace(b.xMin);
trace(a.hitTest(15, 10) + " " + a.hitTest(5, 10) + " " + a.hitTest(c) + " " + a.hitTest(15, 10, true));`,
    ),
    ["11.2 7", "1.2 2", "0 20 0 20", "10 30 5 25", "6710886.35", "true false true true"],
  );
});

test("nothing's bounds in another clip's space switch to 6710886.4 for good under a root of SWF 8", async () => {
  const empty = `var e = createEmptyMovieClip("e", 9); trace(e.getBounds(e).xMin + " " + e.getBounds(this).xMin);`;
  assert.deepEqual(await traces(empty, 7), ["6710886.35 6710886.35"]);
  assert.deepEqual(await traces(empty, 8), ["6710886.35 6710886.4"]);
});

test("SWF 8 code under a root of SWF 7 switches the invalid bounds for the root's code too", async () => {
  const played = await play(
    `var e = createEmptyMovieClip("e", 1); trace("7 " + e.getBounds(this).xMin);
createEmptyMovieClip("holder", 2).loadMovie("child.swf");
var frames = 0;
this.onEnterFrame = function () { frames++; if (frames == 2) { trace("7 " + e.getBounds(_root).xMin); } };`,
    { fetch: files({ "child.swf": movie(`trace("8 " + _level0.e.getBounds(_level0).xMin);`, 8) }) },
    7,
  );

  assert.deepEqual(take(played), ["7 6710886.35"]);
  await played.deliver();
  played.player.tick();
  played.player.tick();
  assert.deepEqual(take(played), ["8 6710886.4", "7 6710886.4"]);
});

test("blendMode takes a name or a byte's number, null as normal, and ignores anything else", async () => {
  // The corpus's movieclip_blend_mode_property.
  assert.deepEqual(
    await traces(
      `var line = [];
var modes = ["layer", null, 259, 3.5, true, -1, "lAyEr", {}];
for (var i = 0; i < modes.length; i++) { a.blendMode = "invert"; a.blendMode = modes[i]; line.push(a.blendMode); }
trace(line.join(" "));`,
      8,
    ),
    ["layer normal multiply multiply invert invert invert invert"],
  );
});

test("the timeline's methods move a clip, play and stop it", async () => {
  assert.deepEqual(
    await traces(
      `Beta.gotoAndStop(3); trace(Beta._currentframe); Beta.prevFrame(); trace(Beta._currentframe);
Beta.nextFrame(); Beta.nextFrame(); trace(Beta._currentframe); Beta.gotoAndPlay(1); trace(Beta._currentframe);
Beta.stop(); Beta.play(); trace(Beta._totalframes + " " + Beta._framesloaded);`,
    ),
    ["3", "2", "3", "1", "3 3"],
  );
});

test("the display properties read and set by name in any case, and as SetProperty converts", async () => {
  assert.deepEqual(
    await traces(
      `a._X = 5.555; trace(a._x); a._xscale = 33.3333; trace(a._XSCALE + " " + a._width); a._xscale = 100;
a._width = 40; trace(a._xscale); a._height = -1; trace(a._height); a._alpha = 50.1; trace(a._alpha);
a._visible = "0"; trace(a._visible); a._visible = "x"; trace(a._visible); a._name = "renamed"; trace(typeof a + " " + renamed._name);
trace(renamed._target + " " + renamed._droptarget.length + " " + renamed._quality + " " + renamed._highquality);
trace(renamed.hasOwnProperty("_x"));`,
    ),
    [
      "5.55",
      "33.3333 6.65",
      "200",
      "20",
      "50",
      "false",
      "false",
      "undefined renamed",
      "/renamed 0 HIGH 1",
      "false",
    ],
  );
});

test("scale properties preserve assigned percentages exactly", async () => {
  for (const version of [5, 6, 7, 8, 10]) {
    assert.deepEqual(
      await traces(
        `var values = [7, 29, 57, 58, -29, 0.1, 1 / 3, 33.3333, 1000000, Infinity];
for (var i = 0; i < values.length; i++) {
  a._xscale = values[i]; a._yscale = values[i];
  trace(a._xscale == values[i] && a._yscale == values[i]);
}
setProperty(a, 2, 29); setProperty(a, 3, 57);
trace(getProperty(a, 2) == 29 && getProperty(a, 3) == 57);`,
        version,
      ),
      new Array(11).fill("true"),
      `SWF ${version}`,
    );
  }
});

test("incrementing scale percentages reaches exact integer endpoints", async () => {
  assert.deepEqual(
    await traces(
      `a._xscale = 0; a._yscale = 0;
for (var i = 0; i < 100; i++) { a._xscale++; a._yscale++; }
trace(a._xscale == 100 && a._yscale == 100);
trace(a._xscale - 100); trace(a._yscale - 100);`,
    ),
    ["true", "0", "0"],
  );
});

test("_width and _height scale a turned clip by its turned, unscaled bounds, and a scale past 32768 draws at that (adl)", async () => {
  assert.deepEqual(
    await traces(
      `function show() { trace(a._width + "," + a._height + " " + a._xscale + "," + a._yscale); }
a._rotation = 30; a._width = 37.3; show(); a._height = 11.15; show();
a._rotation = 0; a._xscale = -50; a._yscale = 100; a._height = 30; show();
a._xscale = Infinity; show(); a._xscale = 1e6; show(); a._xscale = -1e10; show();
a._xscale = 100; a._yscale = 100; a._rotation = 30; a._xscale = 200; a._yscale = 50; a._width = 30; show();`,
    ),
    [
      "33.65,31 136.630036630037,100",
      "25.45,19.4 123.260073260073,40.8424908424908",
      "10,30 50,150",
      "655360,30 Infinity,150",
      "200000,30 1000000,150",
      "655360,30 -10000000000,150",
      "29.55,29.15 109.89010989011,104.945054945055",
    ],
  );
});
