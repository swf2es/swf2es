// The display list and timeline without a renderer: SWFs built with the
// test writer, played in node. The built package, as the browser loads it;
// display.js and player.js leave pixi.js out.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MovieClip, ShapeObject } from "../../../packages/player/dist/display.js";
import { Player } from "../../../packages/player/dist/player.js";
import * as w from "../../player/swf-writer.ts";

const square = (id: number) =>
  w.shape({
    id,
    bounds: [0, 1000, 0, 1000],
    fills: [0xff0000],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [1000, 0] },
          { line: [1000, 1000] },
          { line: [0, 1000] },
          { line: [0, 0] },
        ],
      },
    ],
  });

/** A movie of the frames given, each a list of tags, with squares 1 and 2 defined. */
function movie(...frames: Uint8Array[][]): Player {
  const tags = [w.fileAttributes(true), square(1), square(2)];
  for (const frame of frames) {
    tags.push(...frame, w.showFrame());
  }

  tags.push(w.end());
  return new Player(
    w.swf({ width: 200, height: 100, frameRate: 24, frameCount: frames.length, tags }),
  );
}

const depths = (clip: MovieClip) => clip.children.map((c) => c.depth);

test("children are in render order, which is depth order for the timeline's", () => {
  const { root } = movie([
    w.place({ depth: 5, character: 1 }),
    w.place({ depth: 2, character: 2 }),
    w.place({ depth: 3, character: 1 }),
  ]);
  assert.deepEqual(depths(root), [2, 3, 5]);
  assert.equal(root.depths.get(3), root.children[1]);
});

test("a loop keeps what the first frame placed, playing on", () => {
  // A three-frame sprite on frame 1 of a two-frame root, as Flash was seen
  // to run it: on the root's third frame the sprite shows its own third.
  const player = movie(
    [
      w.sprite(3, 3, [
        w.place({ depth: 1, character: 1, matrix: { tx: 0 } }),
        w.showFrame(),
        w.place({ depth: 1, move: true, matrix: { tx: 1000 } }),
        w.showFrame(),
        w.place({ depth: 1, move: true, matrix: { tx: 2000 } }),
        w.showFrame(),
        w.end(),
      ]),
      w.place({ depth: 1, character: 3 }),
    ],
    [],
  );
  const inner = player.root.depths.get(1) as MovieClip;
  const innerSquare = inner.depths.get(1) as ShapeObject;
  player.tick();
  player.tick();
  assert.equal(player.root.currentFrame, 1);
  assert.equal(player.root.depths.get(1), inner);
  assert.equal(inner.currentFrame, 3);
  assert.equal(innerSquare.matrix.tx, 100);

  // The sprite's own loop puts its square back where frame 1 has it, as the same object.
  player.tick();
  assert.equal(inner.currentFrame, 1);
  assert.equal(inner.depths.get(1), innerSquare);
  assert.equal(innerSquare.matrix.tx, 0);
});

test("a loop removes what later frames placed and puts back the first frame's state", () => {
  const player = movie(
    [w.place({ depth: 1, character: 1, matrix: { tx: 0 } })],
    [w.place({ depth: 2, character: 2 }), w.place({ depth: 1, move: true, matrix: { tx: 1000 } })],
    [],
  );
  const first = player.root.depths.get(1);
  player.tick();
  assert.deepEqual(depths(player.root), [1, 2]);
  assert.equal(first?.matrix.tx, 50);

  player.tick();
  player.tick();
  assert.equal(player.root.currentFrame, 1);
  assert.deepEqual(depths(player.root), [1]);
  assert.equal(player.root.depths.get(1), first);
  assert.equal(first?.matrix.tx, 0);
});

test("a goto replays the frames between, forward and back", () => {
  const { root } = movie(
    [w.place({ depth: 1, character: 1 })],
    [w.place({ depth: 2, character: 2, matrix: { tx: 0 } })],
    [w.remove(1)],
    [w.place({ depth: 2, move: true, matrix: { tx: 500 } })],
  );
  root.gotoFrame(4);
  assert.equal(root.currentFrame, 4);
  assert.deepEqual(depths(root), [2]);
  const second = root.depths.get(2);
  assert.equal(second?.matrix.tx, 25);

  // Back to 2: the second square was placed by then and stays, at frame 2's
  // position; the first is made again, as the removal on frame 3 is undone.
  root.gotoFrame(2);
  assert.deepEqual(depths(root), [1, 2]);
  assert.equal(root.depths.get(2), second);
  assert.equal(second?.matrix.tx, 0);

  // Forward past the removal.
  root.gotoFrame(3);
  assert.deepEqual(depths(root), [2]);
  assert.equal(root.depths.get(2), second);
});

test("a place without the move flag makes a new child; with it, changes the one there", () => {
  const replaced = movie(
    [w.place({ depth: 1, character: 1 })],
    [w.place({ depth: 1, character: 1 })],
  );
  const before = replaced.root.depths.get(1);
  replaced.tick();
  assert.notEqual(replaced.root.depths.get(1), before);
  assert.equal(replaced.root.children.length, 1);

  const moved = movie(
    [w.place({ depth: 1, character: 1 })],
    [w.place({ depth: 1, move: true, matrix: { tx: 200 } })],
  );
  const kept = moved.root.depths.get(1);
  moved.tick();
  assert.equal(moved.root.depths.get(1), kept);
  assert.equal(kept?.matrix.tx, 10);
});
