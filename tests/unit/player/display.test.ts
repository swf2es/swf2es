// The display list and timeline without a renderer: SWFs built with the
// test writer, played in node. The built package, as the browser loads it;
// display.js and player.js leave pixi.js out.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DisplayObject,
  MovieClip,
  ShapeObject,
} from "../../../packages/player/dist/display.js";
import { Player } from "../../../packages/player/dist/player.js";
import * as w from "../../swf-writer.ts";

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

test("another character placed with the move flag keeps the child, and swaps only an untouched shape's graphic, as Flash does", () => {
  const swapped = movie(
    [w.place({ depth: 1, character: 1 }), w.place({ depth: 2, character: 1 })],
    [
      w.place({ depth: 1, move: true, character: 2 }),
      w.place({ depth: 2, move: true, character: 2 }),
    ],
  );
  const [plain, touched] = [1, 2].map((d) => swapped.root.depths.get(d) as ShapeObject);
  touched.scripted = true;
  swapped.tick();
  assert.equal(swapped.root.depths.get(1), plain);
  assert.equal(swapped.root.depths.get(2), touched);
  assert.equal(plain.shape?.id, 2);
  assert.equal(touched.shape?.id, 1);

  // A goto forward does the same; a rewind that ends on another character
  // makes a new child instead, as Flash's does (the corpus's
  // place_object_replace_2).
  const jumped = movie(
    [w.place({ depth: 1, character: 1 })],
    [w.place({ depth: 1, move: true, character: 2 })],
    [w.place({ depth: 1, move: true, character: 1 })],
  );
  const kept = jumped.root.depths.get(1) as ShapeObject;
  jumped.root.gotoFrame(3);
  assert.equal(jumped.root.depths.get(1), kept);
  assert.equal(kept.shape?.id, 1);
  jumped.root.gotoFrame(2);
  assert.notEqual(jumped.root.depths.get(1), kept);
  assert.equal((jumped.root.depths.get(1) as ShapeObject).shape?.id, 2);
  assert.equal(jumped.root.children.length, 1);
});

test("a rewind puts back what the first frame's place left unsaid", () => {
  // Frame 1 places the square with no matrix, frame 2 moves it; the loop
  // must bring it back to where a character first placed is, not leave it.
  const player = movie(
    [w.place({ depth: 1, character: 1 })],
    [w.place({ depth: 1, move: true, matrix: { tx: 1000 } })],
  );
  const square = player.root.depths.get(1);
  player.tick();
  assert.equal(square?.matrix.tx, 50);

  player.tick();
  assert.equal(player.root.currentFrame, 1);
  assert.equal(player.root.depths.get(1), square);
  assert.equal(square?.matrix.tx, 0);
});

test("a goto forward makes a new child where the frame places the character anew", () => {
  // As frame by frame would (see the place without the move flag above);
  // only a rewind, or a place in the child's stead, keeps it.
  const jumped = movie(
    [w.place({ depth: 1, character: 1 })],
    [w.place({ depth: 1, character: 1 })],
  );
  const before = jumped.root.depths.get(1);
  jumped.root.gotoFrame(2);
  assert.notEqual(jumped.root.depths.get(1), before);
  assert.equal(jumped.root.children.length, 1);

  const replaced = movie(
    [w.place({ depth: 1, character: 1 })],
    [w.place({ depth: 1, character: 1, move: true, matrix: { tx: 200 } })],
  );
  const kept = replaced.root.depths.get(1);
  replaced.root.gotoFrame(2);
  assert.equal(replaced.root.depths.get(1), kept);
  assert.equal(kept?.matrix.tx, 10);
});

test("a goto forward leaves the display list as playing the frames would", () => {
  // Frame 1 places the square, frame 2 moves it, frame 3 places it anew with
  // no matrix: a jump must not hand the new square the moved one's place.
  const anew = () =>
    movie(
      [w.place({ depth: 1, character: 1 })],
      [w.place({ depth: 1, move: true, matrix: { tx: 1000 } })],
      [w.place({ depth: 1, character: 1 })],
    );
  const played = anew();
  played.tick();
  played.tick();
  const jumped = anew();
  const before = jumped.root.depths.get(1);
  jumped.root.gotoFrame(3);
  assert.equal(played.root.depths.get(1)?.matrix.tx, 0);
  assert.equal(jumped.root.depths.get(1)?.matrix.tx, 0);
  assert.notEqual(jumped.root.depths.get(1), before);

  // In the square's stead, the other character keeps its place both ways.
  const instead = () =>
    movie(
      [w.place({ depth: 1, character: 1 })],
      [w.place({ depth: 1, move: true, matrix: { tx: 1000 } })],
      [w.place({ depth: 1, character: 2, move: true })],
    );
  const playedInstead = instead();
  playedInstead.tick();
  playedInstead.tick();
  const jumpedInstead = instead();
  jumpedInstead.root.gotoFrame(3);
  for (const player of [playedInstead, jumpedInstead]) {
    const child = player.root.depths.get(1);
    assert.equal(child?.character?.id, 2);
    assert.equal(child?.matrix.tx, 50);
  }
});

test("a jump remembers a character placed anew through what follows", () => {
  // Frame 2 places the square anew, frame 3 places it in its own stead: the
  // child is frame 2's, not frame 1's, whether played or jumped to.
  const anew = () =>
    movie(
      [w.place({ depth: 1, character: 1 })],
      [w.place({ depth: 1, character: 1 })],
      [w.place({ depth: 1, character: 1, move: true, matrix: { tx: 1000 } })],
    );
  const played = anew();
  const playedFirst = played.root.depths.get(1);
  played.tick();
  played.tick();
  const jumped = anew();
  const jumpedFirst = jumped.root.depths.get(1);
  jumped.root.gotoFrame(3);
  for (const [player, first] of [
    [played, playedFirst],
    [jumped, jumpedFirst],
  ] as const) {
    const child = player.root.depths.get(1);
    assert.notEqual(child, first);
    assert.equal(child?.matrix.tx, 50);
    assert.equal(child?.placeFrame, 2);
  }
});

/** What a container's timeline children are, comparably between two players. */
function snapshot(root: MovieClip, original: Map<number, DisplayObject | undefined>) {
  return [...root.depths.keys()].sort().map((depth) => {
    const child = root.depths.get(depth);
    return {
      depth,
      character: child?.character?.id,
      tx: child?.matrix.tx,
      placeFrame: child?.placeFrame,
      sameAsFirst: child === original.get(depth),
    };
  });
}

test("jumping forward to any frame of a random timeline ends as playing to it", () => {
  // Place anew (with a matrix or not), place in another's stead, move,
  // remove: a few per frame over three depths, two characters. Flash's
  // forward goto is the frames played through, so the two must agree.
  // A 32-bit LCG; Math.imul keeps it in 32 bits, where a double would lose the low bits.
  let seed = 2026;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const command = (): Uint8Array => {
    const depth = 1 + random(3);
    const character = 1 + random(2);
    const matrix = random(2) ? { tx: 200 * (1 + random(9)) } : undefined;
    switch (random(4)) {
      case 0:
        return w.place({ depth, character, matrix });
      case 1:
        return w.place({ depth, character, move: true, matrix });
      case 2:
        return w.place({ depth, move: true, matrix: matrix ?? { tx: 0 } });
      default:
        return w.remove(depth);
    }
  };

  for (let t = 0; t < 1000; t++) {
    const frames = Array.from({ length: 2 + random(4) }, () =>
      Array.from({ length: random(4) }, command),
    );
    for (let target = 2; target <= frames.length; target++) {
      const played = movie(...frames);
      const playedFirst = new Map([...played.root.depths].map(([d, c]) => [d, c]));
      for (let f = 1; f < target; f++) {
        played.tick();
      }

      const jumped = movie(...frames);
      const jumpedFirst = new Map([...jumped.root.depths].map(([d, c]) => [d, c]));
      jumped.root.gotoFrame(target);
      assert.deepEqual(
        snapshot(jumped.root, jumpedFirst),
        snapshot(played.root, playedFirst),
        `timeline ${t}, frame ${target}`,
      );
    }

    // A rewind from the last frame to each earlier one shows what playing
    // to it shows, though it keeps the children it can rather than make
    // them again, so which object is which is not compared.
    const state = (root: MovieClip) =>
      snapshot(root, new Map()).map(({ sameAsFirst: _, ...rest }) => rest);
    for (let target = 1; target < frames.length; target++) {
      const played = movie(...frames);
      for (let f = 1; f < target; f++) {
        played.tick();
      }

      const rewound = movie(...frames);
      for (let f = 1; f < frames.length; f++) {
        rewound.tick();
      }

      rewound.root.gotoFrame(target);
      assert.deepEqual(state(rewound.root), state(played.root), `timeline ${t}, back to ${target}`);
    }
  }
});
