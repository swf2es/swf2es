// The player's test cases: SWFs built here, played for a few frames, whose
// frames must look as Flash drew them. Flash's frames are in references/,
// made by run.ts --update with the Flash oracle.
import { readFileSync } from "node:fs";
import { zlibCompress } from "../../packages/format/dist/index.js";
import * as w from "../swf-writer.ts";
import { type Compile, compileScripts } from "./scripts.ts";

export interface PlayerCase {
  name: string;
  /** The SWF, or how to build it around the compiled script. */
  swf?: Uint8Array | ((abc: Uint8Array) => Uint8Array);
  /** Or how to build it with the compiler in hand, for a SWF holding another; traced like a scripted case. */
  build?: (compile: Compile) => Uint8Array;
  /** The AS3 half: scripts/<script>.as, compiled in the oracle's container; its trace must match Flash's. */
  script?: string;
  frames: number;
  capture: number[];
  quality?: "low" | "medium" | "high" | "best";
  /** Ruffle's rule: a channel differing by more than `tolerance` is an outlier. */
  tolerance: number;
  maxOutliers: number;
  /** Drawn in Flash in an adl of its own (FlashJob.alone). */
  alone?: boolean;
}

const square = (id: number, color: number, size = 1000) =>
  w.shape({
    id,
    bounds: [0, size, 0, size],
    fills: [color],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [size, 0] },
          { line: [size, size] },
          { line: [0, size] },
          { line: [0, 0] },
        ],
      },
    ],
  });

// A fill with a curved side and a hole, outlined, so that the fill, the
// hole and the lines all show.
const outlined = w.shape({
  id: 1,
  bounds: [-20, 2020, -20, 1620],
  fills: [0xcc3300],
  lines: [{ width: 40, color: 0x000080 }],
  paths: [
    {
      fill1: 1,
      line: 1,
      commands: [
        { move: [0, 0] },
        { line: [2000, 0] },
        { curve: [2400, 800, 2000, 1600] },
        { line: [0, 1600] },
        { line: [0, 0] },
      ],
    },
    {
      fill1: 1,
      line: 1,
      commands: [
        { move: [400, 400] },
        { line: [400, 1200] },
        { line: [1200, 1200] },
        { line: [1200, 400] },
        { line: [400, 400] },
      ],
    },
  ],
});

function moves(as3: boolean): Uint8Array {
  return w.swf({
    width: 320,
    height: 200,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(as3),
      w.backgroundColor(0xeeeeee),
      outlined,
      w.place({ depth: 1, character: 1, matrix: { tx: 400, ty: 600 } }),
      w.showFrame(),
      w.place({
        depth: 1,
        move: true,
        matrix: { a: 1.2, b: 0.2, c: -0.1, d: 0.8, tx: 2400, ty: 1200 },
      }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Frame 1 puts blue under red; frame 2 takes red away and puts green at
// a depth between, then over.
const depths = w.swf({
  width: 200,
  height: 150,
  frameRate: 24,
  frameCount: 3,
  tags: [
    w.fileAttributes(true),
    w.backgroundColor(0xffffff),
    square(1, 0xff0000),
    square(2, 0x0000ff),
    square(3, 0x00ff00),
    w.place({ depth: 5, character: 1, matrix: { tx: 600, ty: 600 } }),
    w.place({ depth: 2, character: 2, matrix: { tx: 1000, ty: 1000 } }),
    w.showFrame(),
    w.remove(5),
    w.place({ depth: 3, character: 3, matrix: { tx: 1400, ty: 400 } }),
    w.showFrame(),
    w.place({ depth: 3, move: true, matrix: { tx: 1200, ty: 1200 } }),
    w.place({ depth: 1, character: 1, matrix: { tx: 200, ty: 200 } }),
    w.showFrame(),
    w.end(),
  ],
});

// A three-frame sprite on frame 1 of a two-frame root. When the root loops
// the sprite keeps playing rather than starting over, so its square is at
// its third position on root frame 3 and back at its first on frame 4.
function loops(as3: boolean): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(as3),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 3, [
        w.place({ depth: 1, character: 1, matrix: { tx: 0, ty: 0 } }),
        w.showFrame(),
        w.place({ depth: 1, move: true, matrix: { tx: 1000, ty: 0 } }),
        w.showFrame(),
        w.place({ depth: 1, move: true, matrix: { tx: 2000, ty: 0 } }),
        w.showFrame(),
        w.end(),
      ]),
      w.place({ depth: 1, character: 2, matrix: { tx: 0, ty: 0 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Three instances of a sprite whose outlined shape turns and swells on a
// loop of three frames, in step, so that they see its lines alike and the
// renderer shares them, and the loop comes back to the lines it had; and a
// sprite whose loop leaves theirs on its second frame and comes back.
function sharedLines(): Uint8Array {
  const turn = (angle: number, scale: number, skew = 0) => ({
    a: scale * Math.cos(angle),
    b: scale * Math.sin(angle),
    c: -scale * Math.sin(angle) + skew,
    d: scale * Math.cos(angle),
    tx: 0,
    ty: 0,
  });
  const loop = [turn(0.5, 0.5), turn(-0.3, 0.7, 0.2), turn(1.2, 0.6)];
  const other = [loop[0], turn(0.9, 0.8), loop[2]];
  const sprite = (id: number, frames: typeof loop) =>
    w.sprite(id, frames.length, [
      ...frames.flatMap((matrix, f) => [
        f === 0
          ? w.place({ depth: 1, character: 1, matrix })
          : w.place({ depth: 1, move: true, matrix }),
        w.showFrame(),
      ]),
      w.end(),
    ]);
  return w.swf({
    width: 400,
    height: 200,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      outlined,
      sprite(2, loop),
      sprite(3, other),
      ...[0, 1, 2, 3].map((i) =>
        w.place({
          depth: i + 1,
          character: i < 3 ? 2 : 3,
          matrix: { tx: 1000 + i * 1800, ty: 2000 },
        }),
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Frame 1 places a square with no matrix and frame 2 moves it: when the
// root loops, Flash shows frame 3 as it showed frame 1, the square back at
// the origin, though frame 1's place says nothing about where.
function rewinds(as3: boolean): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(as3),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.place({ depth: 1, character: 1 }),
      w.showFrame(),
      w.place({ depth: 1, move: true, matrix: { tx: 1000, ty: 0 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A document class (scripts/Main.as) on a two-frame root with a sprite named
// "box" placed on frame 1 and moved on frame 2: what it traces when it is
// constructed and on each frame's script must be what Flash traces.
export function scripted(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "Main"),
      w.symbolClass([[0, "Main"]]),
      w.place({ depth: 1, character: 2, name: "box", matrix: { tx: 200, ty: 400 } }),
      w.showFrame(),
      w.place({ depth: 1, move: true, matrix: { tx: 1000, ty: 400 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A root of `frames` frames with `abc` as its code and nothing placed: for
// what the scripts alone do (scripts/Events.as, and the node tests' loads).
export function bare(
  abc: Uint8Array,
  frames = 2,
  documentClass = "Main",
  width = 100,
  height = 50,
): Uint8Array {
  return w.swf({
    width,
    height,
    frameRate: 24,
    frameCount: frames,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, documentClass),
      w.symbolClass([[0, documentClass]]),
      ...Array.from({ length: frames }, () => w.showFrame()),
      w.end(),
    ],
  });
}

// A sprite with one child, bound to a class the script constructs during
// its initializer and again later (scripts/Init.as).
function bound(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "Init"),
      w.symbolClass([
        [0, "Main"],
        [2, "Box"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A four-frame root whose square moves each frame, with scripts/Goto.as:
// frame 2's script jumps to frame 4.
function gotos(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.doAbc(abc, "Goto"),
      w.symbolClass([[0, "Main"]]),
      w.place({ depth: 1, character: 1, matrix: { tx: 0, ty: 400 } }),
      w.showFrame(),
      w.place({ depth: 1, move: true, matrix: { tx: 800, ty: 400 } }),
      w.showFrame(),
      w.place({ depth: 1, move: true, matrix: { tx: 1600, ty: 400 } }),
      w.showFrame(),
      w.place({ depth: 1, move: true, matrix: { tx: 2400, ty: 400 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A root of two scenes, Intro (frames 1 and 2) and Main (3 to 5), with
// labels in its scene data, FrameLabel tags alike as Flash's authoring
// tool writes them, and one more FrameLabel on frame 5 the data leaves
// out; and a
// sprite labelled by FrameLabel tags alone; scripts/Scenes.as walks them.
function scenes(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 5,
    tags: [
      w.fileAttributes(true),
      w.sceneData(
        [
          [0, "Intro"],
          [2, "Main"],
        ],
        [
          [0, "start"],
          [1, "middle"],
          [3, "go"],
        ],
      ),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 4, [
        w.frameLabel("walk"),
        w.place({ depth: 1, character: 1 }),
        w.showFrame(),
        w.showFrame(),
        w.frameLabel("run"),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "Scenes"),
      w.symbolClass([[0, "Main"]]),
      w.frameLabel("start"),
      w.place({ depth: 1, character: 2, name: "kid" }),
      w.showFrame(),
      w.frameLabel("middle"),
      w.showFrame(),
      w.showFrame(),
      w.frameLabel("go"),
      w.showFrame(),
      w.frameLabel("fl_a"),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A root labelled by FrameLabel tags alone, no scene data; scripts/FrameLabels.as reads it.
function frameLabels(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "FrameLabels"),
      w.symbolClass([[0, "Main"]]),
      w.frameLabel("a"),
      w.showFrame(),
      w.showFrame(),
      w.frameLabel("b"),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A root with nothing placed and a bound Box symbol, with scripts/AddChild.as adding Boxes.
function added(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "AddChild"),
      w.symbolClass([
        [0, "Main"],
        [2, "Box"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A two-frame clip (its square moving on frame 2) on a two-frame root, both
// classes with frame scripts (scripts/Nested.as).
function nested(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 2, [
        w.place({ depth: 1, character: 1 }),
        w.showFrame(),
        w.place({ depth: 1, move: true, matrix: { tx: 1000, ty: 0 } }),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "Nested"),
      w.symbolClass([
        [0, "Main"],
        [2, "Inner"],
      ]),
      w.place({ depth: 1, character: 2, matrix: { tx: 200, ty: 400 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Three three-frame clips, a, b and c, on a four-frame root: a script takes
// a and c off in frame 1 and puts c back in frame 3, the timeline takes b
// off at frame 2; scripts make three more (scripts/Orphans.as).
function orphans(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000, 400),
      w.sprite(2, 3, [
        w.place({ depth: 1, character: 1 }),
        w.showFrame(),
        w.place({ depth: 1, move: true, matrix: { tx: 600, ty: 0 } }),
        w.showFrame(),
        w.place({ depth: 1, move: true, matrix: { tx: 1200, ty: 0 } }),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "Orphans"),
      w.symbolClass([
        [0, "Main"],
        [2, "Clip"],
      ]),
      w.place({ depth: 1, character: 2, name: "a", matrix: { tx: 200, ty: 200 } }),
      w.place({ depth: 2, character: 2, name: "b", matrix: { tx: 200, ty: 1200 } }),
      w.place({ depth: 3, character: 2, name: "c", matrix: { tx: 2400, ty: 200 } }),
      w.showFrame(),
      w.remove(2),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A one-frame root of 220 by 140 with `abc` as its code and nothing placed: room to draw in (scripts/Draws.as).
function drawn(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 220,
    height: 140,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "Main"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A three-frame root whose frame 3 places a clip with a frame script; the
// root's frame 1 script jumps there (scripts/GotoChild.as).
function gotoChild(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "GotoChild"),
      w.symbolClass([
        [0, "Main"],
        [2, "Inner"],
      ]),
      w.showFrame(),
      w.showFrame(),
      w.place({ depth: 1, character: 2, matrix: { tx: 400, ty: 400 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Two squares placed on frame 1, given a negative scale and a turn by
// scripts/Replaces.as, and replaced by another character on frame 3 with no
// matrix in the place: what the new children report of their transforms.
function replaces(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 300,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000, 400),
      square(2, 0x0000ff, 400),
      w.sprite(3, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(4, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "Replaces"),
      w.symbolClass([[0, "Main"]]),
      w.place({ depth: 1, character: 1, matrix: { tx: 1200, ty: 400 } }),
      w.place({ depth: 2, character: 1, matrix: { tx: 2400, ty: 400 } }),
      w.place({ depth: 3, character: 1, matrix: { tx: 3600, ty: 400 } }),
      w.place({ depth: 4, character: 3, matrix: { tx: 1200, ty: 1200 } }),
      w.place({ depth: 5, character: 1, matrix: { tx: 2400, ty: 1200 } }),
      w.place({ depth: 6, character: 3, matrix: { tx: 3600, ty: 1200 } }),
      w.place({ depth: 7, character: 1, matrix: { tx: 600, ty: 2000 } }),
      w.place({ depth: 8, character: 1, matrix: { tx: 1600, ty: 2000 } }),
      w.place({ depth: 9, character: 1, matrix: { tx: 2600, ty: 2000 } }),
      w.place({ depth: 10, character: 1, matrix: { tx: 3600, ty: 2000 } }),
      w.place({ depth: 11, character: 1, matrix: { tx: 600, ty: 2800 } }),
      w.place({ depth: 12, character: 1, matrix: { tx: 1600, ty: 2800 } }),
      w.place({ depth: 13, character: 1, matrix: { tx: 2600, ty: 2800 } }),
      w.place({ depth: 14, character: 1, matrix: { tx: 600, ty: 3600 } }),
      w.place({ depth: 15, character: 1, matrix: { tx: 1600, ty: 3600 } }),
      w.place({ depth: 16, character: 1, matrix: { tx: 2600, ty: 3600 } }),
      w.place({ depth: 17, character: 1, matrix: { tx: 200, ty: 4400 } }),
      w.place({ depth: 18, character: 1, matrix: { tx: 1000, ty: 4400 } }),
      w.place({ depth: 19, character: 1, matrix: { tx: 1800, ty: 4400 } }),
      w.place({ depth: 20, character: 1, matrix: { tx: 2600, ty: 4400 } }),
      w.place({ depth: 21, character: 1, matrix: { tx: 3400, ty: 4400 } }),
      w.place({ depth: 22, character: 1, matrix: { tx: 200, ty: 5200 } }),
      w.place({ depth: 23, character: 1, matrix: { tx: 1000, ty: 5200 } }),
      w.place({ depth: 24, character: 1, matrix: { tx: 1800, ty: 5200 } }),
      w.place({ depth: 25, character: 1, matrix: { tx: 2600, ty: 5200 } }),
      w.place({ depth: 26, character: 1, matrix: { tx: 3400, ty: 5200 } }),
      w.showFrame(),
      w.showFrame(),
      ...[
        1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      ].map((depth) => w.place({ depth, move: true, character: 2 })),
      w.place({ depth: 4, move: true, character: 4 }),
      w.place({ depth: 5, move: true, character: 4 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A root of two frames whose document class makes BitmapDatas and shows three
// Bitmaps (scripts/Bitmaps.as), then changes their pixels on frame 2: what
// Flash traces of the pixel store, and draws before and after.
// A root of one frame, 210 by 64, whose document class draws bitmaps into
// bitmaps and shows the ones whose pixels the rasteriser decides
// (scripts/DrawBitmaps.as).
function drawBitmaps(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 210,
    height: 64,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "DrawBitmaps"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A root of one frame, 400 by 140, whose document class draws display
// objects into bitmaps and shows them (scripts/DrawObjects.as).
function drawObjects(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 400,
    height: 140,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "DrawObjects"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

function bitmaps(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 70,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "Bitmaps"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A Box placed by the timeline on frame 1 and removed on frame 2, and one a
// script adds and removes, each listening for the display list's events
// (scripts/Added.as).
function addedEvents(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "Added"),
      w.symbolClass([
        [0, "Main"],
        [2, "Box"],
      ]),
      w.place({ depth: 1, character: 2 }),
      w.showFrame(),
      w.remove(1),
      w.showFrame(),
      w.end(),
    ],
  });
}

// What differs from Flash in "moves" is anti-aliasing a quarter pixel off:
// Flash's curved lines reach further into their shape, and under the skew
// of frame 2 its lines are a little wider or narrower than Ruffle's rule
// for line widths gives.
// A SWF loading another with loadBytes. The inner one, with scripts/Inner.as as
// its document class, is built first and carried in the outer's script,
// scripts/Loads.as.template, as base64.
export function innerSwf(abc: Uint8Array, frames = 2): Uint8Array {
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 12,
    frameCount: frames,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0x0000ff),
      w.doAbc(abc, "Inner"),
      w.symbolClass([[0, "Inner"]]),
      w.place({ depth: 1, character: 1, matrix: { tx: 200, ty: 200 } }),
      ...Array.from({ length: frames }, () => w.showFrame()),
      w.end(),
    ],
  });
}

function loads(compile: Compile): Uint8Array {
  return loading(compile, "Loads", 2);
}

// The same, unloading from INIT (scripts/LoadsInit.as.template). The inner
// SWF has one frame: a clip taken off the display list plays on in Flash,
// which is not this case's.
// A document class that looks definitions up (scripts/Definitions.as), and
// lazy DoABCs whose scripts throw when they run (scripts/DefinitionsBad.as,
// scripts/DefinitionsIndirect.as).
function definitions(compile: Compile): Uint8Array {
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(compile("DefinitionsBad"), "DefinitionsBad", true),
      w.doAbc(compile("DefinitionsIndirect"), "DefinitionsIndirect", true),
      w.doAbc(compile("Definitions"), "Definitions"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

function loadsInit(compile: Compile): Uint8Array {
  return loading(compile, "LoadsInit", 1);
}

function loading(compile: Compile, script: string, innerFrames: number): Uint8Array {
  const inner = innerSwf(compile("Inner"), innerFrames);
  const template = readFileSync(new URL(`scripts/${script}.as.template`, import.meta.url), "utf8");
  const abc = compile(
    script,
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, script),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// What Crossbridge's runtime asks of the player as it starts
// (scripts/CrossbridgeRuntime.as): a ByteArray subclass bound to
// DefineBinaryData, as Crossbridge keeps a C program's data, among the rest.
function crossbridgeRuntime(compile: Compile): Uint8Array {
  const blob = compile(
    "Blob",
    "package { import flash.utils.ByteArray; public class Blob extends ByteArray { public function Blob() { super(); } } }",
  );
  const main = compile("CrossbridgeRuntime");
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.binaryData(1, Uint8Array.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xfe, 1, 2])),
      w.doAbc(blob, "Blob"),
      w.doAbc(main, "CrossbridgeRuntime"),
      w.symbolClass([
        [1, "Blob"],
        [0, "CrossbridgeRuntime"],
      ]),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// The SWF's bitmap characters (scripts/BitmapSymbols.as): every kind of
// bitmap tag, each bound to a class extending BitmapData, and three placed
// on the timeline with PlaceObject3's HasImage, as Flash Pro places one.
// The images are the repository's own (images/README.md).
function bitmapSymbols(compile: Compile): Uint8Array {
  const image = (name: string) =>
    new Uint8Array(readFileSync(new URL(`images/${name}`, import.meta.url)));
  const join = (...parts: (Uint8Array | number[])[]) => {
    const all = parts.map((p) => Uint8Array.from(p));
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) {
      out.set(p, at);
      at += p.length;
    }

    return out;
  };
  const u16 = (v: number) => [v & 0xff, v >> 8];
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
  // Flash refuses a bitmap tag with the short header: every one here has the long one but Short.
  const bitmap = (code: number, body: Uint8Array, long = true) => w.tag(code, body, long);
  const lossless = (
    id: number,
    format: number,
    width: number,
    height: number,
    data: number[],
    colors?: number,
  ) =>
    join(
      u16(id),
      [format],
      u16(width),
      u16(height),
      colors === undefined ? [] : [colors - 1],
      zlibCompress(Uint8Array.from(data)),
    );
  const argb = (pixels: number[]) =>
    pixels.flatMap((p) => [p >>> 24, (p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff]);
  const premultiplied = argb([
    0xff102030, 0x80402010, 0x00000000, 0x40200010, 0x01010101, 0x7f7f7f7f, 0xc0123456, 0xffffffff,
    0x00000000, 0x80808080, 0x20102010, 0x0a0a0a0a,
  ]);
  const pixel15 = (r: number, g: number, b: number) => {
    const v = (r << 10) | (g << 5) | b;
    return [v >> 8, v & 0xff];
  };
  const jpeg = image("j.jpg");
  // DefineBits' JPEG without its tables, which go in JPEGTables.
  const tables: number[] = [0xff, 0xd8];
  const rest: number[] = [0xff, 0xd8];
  for (let at = 2; at < jpeg.length; ) {
    const marker = jpeg[at + 1];
    if (marker === 0xda) {
      rest.push(...jpeg.subarray(at));
      break;
    }

    const end = at + 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3]);
    (marker === 0xdb || marker === 0xc4 ? tables : rest).push(...jpeg.subarray(at, end));
    at = end;
  }
  tables.push(0xff, 0xd9);
  const alpha = zlibCompress(Uint8Array.from({ length: 16 * 12 }, (_, i) => (i * 7) % 256));
  const png = image("p.png");
  const classes: [number, string][] = [
    [1, "L2"],
    [2, "L3"],
    [3, "L5"],
    [4, "L4"],
    [5, "L2P"],
    [6, "J2"],
    [7, "JP"],
    [8, "JT"],
    [9, "J3"],
    [10, "PNG"],
    [11, "GIF"],
    [12, "PNG3"],
    [13, "J4"],
    [14, "J444"],
    [15, "JPR"],
    [16, "Bad"],
    [17, "Short"],
    [20, "TL"],
  ];
  const helpers = compileScripts([
    ...classes.map(([, name]) => ({
      name,
      source: `package { import flash.display.BitmapData; public class ${name} extends BitmapData { public function ${name}(w:int, h:int) { super(w, h); } } }`,
    })),
    {
      name: "BB",
      source:
        "package { import flash.display.Bitmap; public class BB extends Bitmap { public function BB() { super(); } } }",
    },
  ]);
  const main = compile("BitmapSymbols");
  const scaled = (depth: number, character: number, scale: number, tx: number, ty: number) =>
    w.place({ depth, character, matrix: { a: scale, d: scale, tx, ty }, hasImage: true });
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      bitmap(36, lossless(1, 5, 4, 3, premultiplied)),
      bitmap(
        20,
        lossless(2, 3, 3, 2, [10, 20, 30, 200, 100, 50, 0, 0, 0, 0, 1, 2, 0, 2, 1, 0, 0], 3),
      ),
      bitmap(
        20,
        lossless(
          3,
          5,
          3,
          2,
          [
            0x12, 1, 2, 3, 0, 250, 128, 7, 0x80, 9, 99, 199, 0xff, 4, 5, 6, 0x34, 255, 0, 0, 0, 0,
            0, 255,
          ],
        ),
      ),
      bitmap(
        20,
        lossless(4, 4, 3, 2, [
          ...pixel15(31, 0, 0),
          ...pixel15(0, 31, 0),
          ...pixel15(1, 2, 3),
          0,
          0,
          ...pixel15(16, 16, 16),
          ...pixel15(31, 31, 31),
          ...pixel15(0, 0, 31),
          0,
          0,
        ]),
      ),
      bitmap(
        36,
        lossless(
          5,
          3,
          3,
          2,
          [255, 0, 0, 255, 0, 128, 0, 128, 0, 0, 0, 0, 0, 1, 2, 0, 2, 1, 0, 0],
          3,
        ),
      ),
      bitmap(21, join(u16(6), jpeg)),
      // The stray EOI and SOI that old tools wrote before the JPEG.
      bitmap(21, join(u16(7), [0xff, 0xd9, 0xff, 0xd8], jpeg)),
      w.tag(8, Uint8Array.from(tables)),
      bitmap(6, join(u16(8), rest)),
      bitmap(35, join(u16(9), u32(jpeg.length), jpeg, alpha)),
      bitmap(21, join(u16(10), png)),
      bitmap(21, join(u16(11), image("g.gif"))),
      // A PNG in DefineBitsJPEG3: its own alpha, the tag's ignored.
      bitmap(
        35,
        join(
          u16(12),
          u32(png.length),
          png,
          zlibCompress(Uint8Array.from({ length: 20 }, () => 77)),
        ),
      ),
      // No deblocking, which Flash applies and the browser decoder does not.
      bitmap(90, join(u16(13), u32(jpeg.length), u16(0), jpeg, alpha)),
      bitmap(21, join(u16(14), image("j444.jpg"))),
      bitmap(21, join(u16(15), image("jprog.jpg"))),
      bitmap(
        21,
        join(
          u16(16),
          [0xff, 0xd8],
          Array.from({ length: 64 }, (_, i) => i),
        ),
      ),
      bitmap(
        36,
        lossless(17, 5, 2, 2, argb([0xff102030, 0xff102030, 0xff102030, 0xff102030])),
        false,
      ),
      bitmap(36, lossless(20, 5, 4, 3, premultiplied)),
      bitmap(36, lossless(21, 5, 4, 3, premultiplied)),
      ...classes.map(([, name]) => w.doAbc(helpers.get(name) as Uint8Array, name)),
      w.doAbc(helpers.get("BB") as Uint8Array, "BB"),
      w.doAbc(main, "BitmapSymbols"),
      w.symbolClass([...classes, [21, "BB"], [0, "BitmapSymbols"]]),
      scaled(1, 20, 8, 200, 100),
      scaled(2, 10, 8, 900, 100),
      scaled(3, 11, 8, 1700, 100),
      scaled(4, 14, 4, 200, 900),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Bitmap fills (scripts/BitmapFills.as): a 4 x 4 bitmap, every pixel its
// own colour and one translucent, filling a rect larger than it at five
// times its size in each of the four fill types, the bitmap's origin 10
// pixels in, so that clipping and repeating show; and a fill whose bitmap
// the SWF does not define.
function bitmapFills(abc: Uint8Array): Uint8Array {
  const pixels: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const argb =
        x === 3 && y === 3
          ? 0x80808080
          : 0xff000000 | ((x * 80) << 16) | ((y * 80) << 8) | (x === 2 && y === 1 ? 0 : 0xc0);
      pixels.push(argb >>> 24, (argb >> 16) & 0xff, (argb >> 8) & 0xff, argb & 0xff);
    }
  }

  const bitmap = w.tag(
    36,
    Uint8Array.from([1, 0, 5, 4, 0, 4, 0, ...zlibCompress(Uint8Array.from(pixels))]),
    true,
  );
  const rect = (id: number, fill: w.BitmapFill | number) =>
    w.shape({
      id,
      bounds: [0, 900, 0, 800],
      fills: [fill],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [900, 0] },
            { line: [900, 800] },
            { line: [0, 800] },
            { line: [0, 0] },
          ],
        },
      ],
      version: 3,
    });
  const scaled = { a: 100, d: 100, tx: 200, ty: 200 };
  const types = [0x40, 0x41, 0x42, 0x43] as const;
  return w.swf({
    width: 200,
    height: 150,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      bitmap,
      ...types.map((type, i) => rect(10 + i, { bitmap: 1, type, matrix: scaled })),
      rect(20, { bitmap: 99, type: 0x41, matrix: scaled }),
      w.doAbc(abc, "BitmapFills"),
      w.symbolClass([[0, "BitmapFills"]]),
      ...types.map((_, i) =>
        w.place({ depth: 1 + i, character: 10 + i, matrix: { tx: (5 + i * 50) * 20, ty: 100 } }),
      ),
      w.place({ depth: 5, character: 20, matrix: { tx: 100, ty: 2100 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Gradient fills (scripts/Gradients.as): the SWF's linear, radial and
// focal gradients, the gradient square scaled into 60 by 30 pixel rects.
function gradients(abc: Uint8Array): Uint8Array {
  const rect = (id: number, fill: w.GradientFillSpec) =>
    w.shape({
      id,
      bounds: [0, 1200, 0, 600],
      fills: [fill],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [1200, 0] },
            { line: [1200, 600] },
            { line: [0, 600] },
            { line: [0, 0] },
          ],
        },
      ],
      version: 3,
    });
  // The square, 32768 twips a side, to 60 by 30 pixels (1200 by 600 twips) centred in the rect.
  const fit = { a: 1200 / 32768, d: 600 / 32768, tx: 600, ty: 300 };
  return w.swf({
    width: 220,
    height: 160,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      rect(10, {
        type: 0x10,
        matrix: fit,
        stops: [
          [0, 0xffff0000],
          [128, 0x7f00ff00],
          [255, 0xff0000ff],
        ],
      }),
      rect(11, {
        type: 0x12,
        matrix: { a: 400 / 32768, d: 400 / 32768, tx: 600, ty: 300 },
        spread: 1,
        stops: [
          [0, 0xff000000],
          [255, 0xffffcc00],
        ],
      }),
      rect(12, {
        type: 0x13,
        matrix: fit,
        interpolation: 1,
        focal: 0.6,
        stops: [
          [0, 0xffffffff],
          [255, 0xff800080],
        ],
      }),
      w.doAbc(abc, "Gradients"),
      w.symbolClass([[0, "Gradients"]]),
      ...[10, 11, 12].map((character, i) =>
        w.place({ depth: 1 + i, character, matrix: { tx: (5 + i * 70) * 20, ty: 100 } }),
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A rectangle's path, in pixels. */
function rectPath(x: number, y: number, width: number, height: number): w.PathCommand[] {
  const [l, t, r, b] = [x * 20, y * 20, (x + width) * 20, (y + height) * 20];
  return [{ move: [l, t] }, { line: [r, t] }, { line: [r, b] }, { line: [l, b] }, { line: [l, t] }];
}

/** A circle's path, in pixels: eight quadratics, as Flash's drawCircle. */
function circlePath(cx: number, cy: number, r: number): w.PathCommand[] {
  const at = (radius: number, angle: number): [number, number] => [
    Math.round((cx + radius * Math.cos(angle)) * 20),
    Math.round((cy + radius * Math.sin(angle)) * 20),
  ];
  const path: w.PathCommand[] = [{ move: at(r, 0) }];
  for (let i = 1; i <= 8; i++) {
    path.push({
      curve: [
        ...at(r / Math.cos(Math.PI / 8), ((i - 0.5) * Math.PI) / 4),
        ...at(r, (i * Math.PI) / 4),
      ],
    });
  }

  return path;
}

// Timeline masks (scripts/ClipDepths.as): five cells of a yellow ground, a
// mask at the next depth clipping red and blue, then green above the
// range. The first mask's lines must clip nothing; into the second the
// script puts black among the clipped and magenta on top; the third is a
// sprite of two circles the script hides; the script takes the fourth
// away; the fifth clips to the top depth, so what the script adds on top
// is clipped too.
function clipDepths(abc: Uint8Array): Uint8Array {
  const rect = (id: number, color: number, x: number, y: number, width: number, height: number) =>
    w.shape({
      id,
      bounds: [x * 20, (x + width) * 20, y * 20, (y + height) * 20],
      fills: [color],
      paths: [{ fill1: 1, commands: rectPath(x, y, width, height) }],
    });
  const cells: Uint8Array[] = [];
  for (const [k, mask] of [2, 2, 6, 2].entries()) {
    const at = { tx: k * 2000 };
    const cell = "ABCD"[k];
    const base = k * 10;
    cells.push(
      w.place({ depth: base + 1, character: 1, matrix: at }),
      w.place({
        depth: base + 2,
        character: mask,
        matrix: at,
        name: `m${cell}`,
        clipDepth: base + 4,
      }),
      w.place({ depth: base + 3, character: 3, matrix: at, name: `r${cell}` }),
      w.place({ depth: base + 4, character: 4, matrix: at, name: `b${cell}` }),
      w.place({ depth: base + 5, character: 5, matrix: at }),
    );
  }

  return w.swf({
    width: 500,
    height: 100,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      rect(1, 0xffff00, 0, 0, 100, 100),
      // A circle of radius 20 inside a line 20 wide: radius 30 if lines clipped.
      w.shape({
        id: 2,
        bounds: [400, 1600, 400, 1600],
        fills: [0x00ff00],
        lines: [{ width: 400, color: 0x000000 }],
        paths: [{ fill1: 1, line: 1, commands: circlePath(50, 50, 20) }],
      }),
      rect(3, 0xff0000, 0, 0, 100, 50),
      rect(4, 0x0000ff, 0, 50, 100, 50),
      rect(5, 0x00ff00, 40, 0, 20, 100),
      w.shape({
        id: 7,
        bounds: [300, 1700, 700, 1300],
        fills: [0x00ff00],
        paths: [
          { fill1: 1, commands: circlePath(30, 50, 15) },
          { fill1: 1, commands: circlePath(70, 50, 15) },
        ],
      }),
      w.sprite(6, 1, [w.place({ depth: 1, character: 7 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "ClipDepths"),
      w.symbolClass([[0, "ClipDepths"]]),
      ...cells,
      w.place({ depth: 41, character: 1, matrix: { tx: 8000 } }),
      w.place({ depth: 42, character: 2, matrix: { tx: 8000 }, name: "mE", clipDepth: 1000 }),
      w.place({ depth: 43, character: 3, matrix: { tx: 8000 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

/**
 * "Probe", a font of rectangles: advances of half an em and more, a glyph
 * of two boxes, a space and a kerning pair, so that its layout in adl
 * shows Flash's rules with numbers that tell them apart.
 */
export const probeFont = (id: number): Uint8Array =>
  w.font3({
    id,
    name: "Probe",
    ascent: 800,
    descent: 200,
    leading: 100,
    glyphs: [
      { char: "a", advance: 500, boxes: [[50, -500, 450, 0]] },
      { char: "b", advance: 700, boxes: [[50, -750, 650, 0]] },
      {
        char: "c",
        advance: 300,
        boxes: [
          [30, -400, 270, 0],
          [30, 0, 100, 150],
        ],
      },
      { char: " ", advance: 250, boxes: [] },
      { char: "W", advance: 1000, boxes: [[0, -700, 1000, 0]] },
    ],
    kerning: [["a", "b", -100]],
  });

// Text laid out in Probe (scripts/TextLayout.as).
function textLayout(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 400,
    height: 300,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      probeFont(1),
      w.doAbc(abc, "TextLayout"),
      w.symbolClass([[0, "TextLayout"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Text drawn in Probe (scripts/TextDraw.as).
function textDraw(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 400,
    height: 150,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      probeFont(1),
      w.doAbc(abc, "TextDraw"),
      w.symbolClass([[0, "TextDraw"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

const moved = { frames: 2, capture: [1, 2], tolerance: 32, maxOutliers: 500 };

const looped = { frames: 4, capture: [1, 3, 4], tolerance: 0, maxOutliers: 0 };
const rewound = { frames: 3, capture: [1, 2, 3], tolerance: 0, maxOutliers: 0 };

export const cases: PlayerCase[] = [
  { name: "moves", swf: moves(true), ...moved },
  { name: "moves-avm1", swf: moves(false), ...moved },
  {
    name: "shared-lines",
    swf: sharedLines(),
    frames: 5,
    capture: [1, 2, 3, 4, 5],
    // The curved, turned lines anti-alias within a quarter pixel of Flash's,
    // as for `moves`; frames 4 and 5 come out as 1 and 2 did.
    tolerance: 32,
    maxOutliers: 1300,
  },
  { name: "depths", swf: depths, frames: 3, capture: [1, 2, 3], tolerance: 0, maxOutliers: 0 },
  { name: "loops", swf: loops(true), ...looped },
  { name: "loops-avm1", swf: loops(false), ...looped },
  { name: "rewinds", swf: rewinds(true), ...rewound },
  { name: "rewinds-avm1", swf: rewinds(false), ...rewound },
  {
    name: "scripted",
    swf: scripted,
    script: "Main",
    frames: 2,
    capture: [1, 2],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "events",
    swf: bare,
    script: "Events",
    frames: 2,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "init",
    swf: bound,
    script: "Init",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "scenes",
    swf: scenes,
    script: "Scenes",
    frames: 40,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "frame-labels",
    swf: frameLabels,
    script: "FrameLabels",
    frames: 8,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "gotos",
    swf: gotos,
    script: "Goto",
    frames: 3,
    capture: [1, 2, 3],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "replaces",
    swf: replaces,
    script: "Replaces",
    frames: 3,
    capture: [1, 3],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bitmaps",
    swf: bitmaps,
    script: "Bitmaps",
    frames: 2,
    capture: [1, 2],
    // The smoothed Bitmap: Flash's bilinear filter and the GPU's part by up to 2 in a channel.
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "bitmap-ops",
    swf: bare,
    script: "BitmapOps",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bitmap-symbols",
    build: bitmapSymbols,
    frames: 1,
    capture: [1],
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "bitmap-encode",
    swf: (abc) => bare(abc, 1, "BitmapEncode"),
    script: "BitmapEncode",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bitmap-fills",
    swf: bitmapFills,
    script: "BitmapFills",
    frames: 2,
    capture: [1, 2],
    // The smoothed fills: Flash's bilinear samples a few hundredths of a
    // texel from the GPU's, which shows where texels of far different
    // colours meet at five times their size, by up to 25 a channel. The
    // others, and the clipping, the tiling and the red, are exact.
    tolerance: 25,
    maxOutliers: 0,
  },
  {
    name: "gradients",
    swf: gradients,
    script: "Gradients",
    frames: 1,
    capture: [1],
    // The ramps are Flash's exactly, and most pixels within 3. Apart: the
    // rotated repeating gradient's seam, where the stage's supersampling
    // softens the jump from the last colour to the first that Flash leaves
    // hard (some 75 pixels); the pixel at the focal point, where Flash's
    // fixed point still draws the last stop though the SWF's 8.8 focus
    // misses the pixel's corner; and a few of the focal rings: some 240
    // channels in all, where a gradient drawn wrong is thousands.
    tolerance: 8,
    maxOutliers: 300,
  },
  {
    name: "masks",
    swf: (abc) => bare(abc, 3, "Masks", 400, 300),
    script: "Masks",
    frames: 3,
    capture: [3],
    // Mask edges: Flash's anti-aliasing covers a little more of the edge
    // pixels than the stencil's samples (a circle of radius 30 covers 2848
    // pixels in Flash, 2836 here), by up to 80 a channel along the
    // circles; some 390 channels beyond 32, where a mask misplaced by a
    // pixel is thousands.
    tolerance: 32,
    maxOutliers: 450,
  },
  {
    name: "clip-depths",
    swf: clipDepths,
    script: "ClipDepths",
    frames: 2,
    capture: [2],
    // Mask edges, as in "masks": some 230 channels beyond 32 along the circles.
    tolerance: 32,
    maxOutliers: 300,
  },
  {
    name: "color-transforms",
    swf: (abc) => bare(abc, 3, "ColorTransforms", 600, 150),
    script: "ColorTransforms",
    frames: 3,
    capture: [1, 2, 3],
    // Within 2 a channel, Flash's 8.8 multipliers against floats, but for the
    // line's round caps, anti-aliased each rasteriser's way: 48 channels a frame.
    tolerance: 2,
    maxOutliers: 60,
  },
  {
    name: "text-layout",
    swf: textLayout,
    script: "TextLayout",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "text-draw",
    swf: textDraw,
    script: "TextDraw",
    frames: 1,
    capture: [1],
    // Within 64 a channel: Flash's 4 by 4 samples sit an eighth of a pixel
    // past the page's, so a glyph's edge between them takes one row of
    // samples more or less (64). Beyond it, each border's bottom right
    // corner, part grey in Flash: 27 channels.
    tolerance: 64,
    maxOutliers: 40,
  },
  {
    name: "blend-modes",
    swf: (abc) => bare(abc, 1, "BlendModes", 700, 200),
    script: "BlendModes",
    frames: 1,
    capture: [1],
    // Within 3 a channel, the layer's 8-bit round trip; beyond, a pixel's
    // line along the alpha cell's squares, where the filter's sampling of
    // the layer softens its edge and Flash leaves the ground (up to 42):
    // 180 channels in all.
    tolerance: 3,
    maxOutliers: 200,
  },
  {
    name: "filter-objects",
    swf: (abc) => bare(abc, 1, "FilterObjects"),
    script: "FilterObjects",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "apply-filter",
    swf: (abc) => bare(abc, 1, "ApplyFilter"),
    script: "ApplyFilter",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "convolution",
    swf: (abc) => bare(abc, 1, "Convolution"),
    script: "Convolution",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "convolution-draw",
    swf: (abc) => bare(abc, 1, "ConvolutionDraw", 396, 198),
    script: "ConvolutionDraw",
    frames: 1,
    capture: [1],
    // The page's four samples a pixel premultiply a half-transparent
    // object's colour a level or so off adl's: within 3 a channel. A 0 × 3
    // kernel's copy reads a row past adl's bitmap of the object, and adl
    // draws what memory lies there: 10 pixels, transparent in an adl of its
    // own, another job's pixels after one.
    tolerance: 3,
    maxOutliers: 10,
    alone: true,
  },
  {
    name: "bevel",
    swf: (abc) => bare(abc, 1, "Bevel"),
    script: "Bevel",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bevel-draw",
    swf: (abc) => bare(abc, 1, "BevelDraw", 396, 198),
    script: "BevelDraw",
    frames: 1,
    capture: [1],
    // The page blurs at its four samples a pixel, where adl blurs whole
    // pixels, and off the axes adl reads its offset a 256th further out:
    // within 12 a channel, most within 4.
    tolerance: 12,
    maxOutliers: 0,
  },
  {
    name: "gradient-filters",
    swf: (abc) => bare(abc, 1, "GradientFilters"),
    script: "GradientFilters",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "gradient-draw",
    swf: (abc) => bare(abc, 1, "GradientDraw", 396, 198),
    script: "GradientDraw",
    frames: 1,
    capture: [1],
    // The page blurs at its four samples a pixel, where adl blurs whole
    // pixels: within 12 a channel, but for the corners of a bevel at 45°,
    // where adl reads its offset a 256th further out (5, up to 18).
    tolerance: 12,
    maxOutliers: 5,
  },
  {
    name: "displacement-map",
    swf: (abc) => bare(abc, 1, "DisplacementMap"),
    script: "DisplacementMap",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "displacement-draw",
    swf: (abc) => bare(abc, 1, "DisplacementDraw", 396, 198),
    script: "DisplacementDraw",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "displacement-live",
    swf: (abc) => bare(abc, 3, "DisplacementLive", 140, 70),
    script: "DisplacementLive",
    frames: 3,
    capture: [1, 2, 3],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "filters",
    swf: (abc) => bare(abc, 1, "FiltersDraw", 396, 132),
    script: "FiltersDraw",
    frames: 1,
    capture: [1],
    // The page blurs at its four samples a pixel and averages them, where
    // adl blurs whole pixels: within 4 a channel but along the glows'
    // edges, up to 11, 12 channels beyond 8.
    tolerance: 8,
    maxOutliers: 20,
  },
  {
    name: "text-fields",
    swf: (abc) => bare(abc, 1, "TextFields"),
    script: "TextFields",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "draw-bitmaps",
    swf: drawBitmaps,
    script: "DrawBitmaps",
    frames: 1,
    capture: [1],
    // The smoothed tiles: Flash's bilinear filter and the GPU's part by up to 2 a channel.
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "draw-objects",
    swf: drawObjects,
    script: "DrawObjects",
    frames: 1,
    capture: [1],
    // Edges are each rasteriser's own: anti-aliased at high quality, a dozen drawn pixels
    // within 64 a channel; at low quality, aliased, where a curve passes near a pixel's
    // centre the two decide differently, some 30 more. Each drawn pixel is 16 here.
    tolerance: 32,
    maxOutliers: 768,
  },
  {
    name: "addChild",
    swf: added,
    script: "AddChild",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "nested",
    swf: nested,
    script: "Nested",
    frames: 3,
    capture: [1, 2, 3],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "gotoChild",
    swf: gotoChild,
    script: "GotoChild",
    frames: 2,
    capture: [1, 2],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "added",
    swf: addedEvents,
    script: "Added",
    frames: 2,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Curves and a turned sprite: anti-aliased a little differently, as "moves" is.
  {
    name: "draws",
    swf: drawn,
    script: "Draws",
    frames: 2,
    capture: [1],
    tolerance: 32,
    maxOutliers: 500,
  },
  {
    name: "orphans",
    swf: orphans,
    script: "Orphans",
    frames: 4,
    capture: [1, 2, 3, 4],
    tolerance: 0,
    maxOutliers: 0,
  },
  // The unload at INIT follows frame 2's capture (see the harness): frame 3 shows it.
  { name: "loads-init", build: loadsInit, frames: 3, capture: [3], tolerance: 0, maxOutliers: 0 },
  {
    name: "vector-definitions",
    swf: bare,
    script: "VectorDefinitions",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "definitions",
    build: definitions,
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Last: the content it unloads plays on in Flash until collected, and its
  // traces would reach the case recorded after it.
  { name: "loads", build: loads, frames: 3, capture: [1, 2, 3], tolerance: 0, maxOutliers: 0 },
  {
    name: "crossbridge-runtime",
    build: crossbridgeRuntime,
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "url-stream-close",
    swf: (abc) => bare(abc, 1, "UrlStreamClose"),
    script: "UrlStreamClose",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
];
