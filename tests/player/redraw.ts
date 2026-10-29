// A drawing cleared and drawn again on every turn of its timeline, as a
// software 3D engine draws its triangles anew each frame: the view keeps
// the geometries of what it shows, letting a drawing's old layers go as
// it draws the next, their fills' and their lines'. It once kept each
// frame's for the idle frames, some 400,000 geometries and 300 MB in such
// a game.
//
//   node tests/player/redraw.ts
import assert from "node:assert/strict";
import { Avm1Assembler } from "../avm1-assembler.ts";
import * as w from "../swf-writer.ts";
import { playRedrawn } from "./chrome.ts";

const actions = new Avm1Assembler();
/** _root's `method` called with `args`, its result dropped. */
const call = (method: string, ...args: number[]) =>
  actions
    .push(...args.slice().reverse(), args.length, "_root")
    .op("GetVariable")
    .push(method)
    .op("CallMethod")
    .op("Pop");
call("clear");
// Outlined, so that each layer has its lines too, which the line cache keeps.
call("lineStyle", 1, 0x0000ff);
for (let i = 0; i < 20; i++) {
  call("beginFill", 0xff0000 + i * 8);
  call("moveTo", i * 5, 0);
  call("lineTo", i * 5 + 4, 50);
  call("lineTo", i * 5, 50);
  call("endFill");
}

const swf = w.swf({
  version: 8,
  width: 100,
  height: 50,
  frameRate: 30,
  frameCount: 2,
  tags: [w.doAction([...actions.end().bytes()]), w.showFrame(), w.showFrame(), w.end()],
});

// 400 frames, past the idle frames: one drawing's geometries, a fill and its lines each, not
// those of each time it was drawn.
const kept = await playRedrawn(swf, 400);
assert.ok(kept > 0 && kept <= 80, `${kept} geometries kept`);
console.log(`redraw: ok, ${kept} geometries kept`);
