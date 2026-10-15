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
