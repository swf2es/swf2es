import assert from "node:assert/strict";
import { test } from "node:test";
import { Player } from "../../../packages/player/dist/player.js";
import * as w from "../../swf-writer.ts";

test("advance plays what the time is worth and says how many frames; changes counts them", () => {
  const swf = w.swf({
    width: 10,
    height: 10,
    frameRate: 10,
    frameCount: 3,
    tags: [w.showFrame(), w.showFrame(), w.showFrame(), w.end()],
  });
  const player = new Player(swf);
  const before = player.changes;

  // Less than a frame's 100 ms: nothing played, nothing to draw.
  assert.equal(player.advance(60), 0);
  assert.equal(player.changes, before);

  // With what was kept, a frame's worth.
  assert.equal(player.advance(50), 1);
  assert.equal(player.changes, before + 1);
});

test("a destroyed player plays no more frames", () => {
  const swf = w.swf({
    width: 10,
    height: 10,
    frameRate: 10,
    frameCount: 3,
    tags: [w.showFrame(), w.showFrame(), w.showFrame(), w.end()],
  });
  const player = new Player(swf);
  player.tick();
  const changes = player.changes;

  player.destroy();
  assert.ok(player.destroyed);
  assert.equal(player.advance(1000), 0);
  player.tick();
  assert.equal(player.changes, changes);
  assert.equal(player.root.currentFrame, 2);
});
