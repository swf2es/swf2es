// The player's clock and pacing, on a SWF with no scripts: a tick is one
// frame and one frame's time; advance(dt) runs what the time is worth,
// keeps the rest, and catches up only so far after a long pause.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Player } from "../../../packages/player/dist/player.js";
import * as w from "../../swf-writer.ts";

const swf = w.swf({
  width: 10,
  height: 10,
  frameRate: 10,
  frameCount: 20,
  tags: [w.fileAttributes(false), ...Array.from({ length: 20 }, () => w.showFrame()), w.end()],
});

test("advance plays a frame per 100 ms at 10 fps, keeps the remainder, and catches up at most five frames", () => {
  const player = new Player(swf);
  assert.equal(player.root.currentFrame, 1);

  // Less than a frame: nothing yet; the rest adds up.
  player.advance(60);
  assert.equal(player.root.currentFrame, 1);
  player.advance(60);
  assert.equal(player.root.currentFrame, 2);
  player.advance(180);
  assert.equal(player.root.currentFrame, 4);

  // A long pause: five frames at most, and the time beyond them let go.
  player.advance(5000);
  assert.equal(player.root.currentFrame, 9);
  player.advance(99);
  assert.equal(player.root.currentFrame, 9);
  player.advance(1);
  assert.equal(player.root.currentFrame, 10);
});
