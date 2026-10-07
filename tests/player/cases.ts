// The player's test cases: SWFs built here, played for a few frames, whose
// frames must look as Flash drew them. Flash's frames are in references/,
// made by run.ts --update with the Flash oracle.
import { readFileSync } from "node:fs";
import { tags, zlibCompress } from "../../packages/format/dist/index.js";
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
  /** Played as a host showing the stage this many times its size draws it (page.ts); Flash draws it at its size. */
  zoom?: number;
  /**
   * With a zoom, the stage shown at it, the frames that size (page.ts); Flash
   * draws `flash` for them, the SWF built at that size.
   */
  shown?: boolean;
  /** What Flash draws for the references in place of the case's SWF. */
  flash?: Uint8Array;
  /** Played as a host whose renderer is made with `antialias: true` draws it, multisampled; Flash draws it as ever. */
  antialias?: boolean;
  /**
   * The transform table (render/table.ts) must draw some of it, and played
   * again without the table it must draw the same pixels.
   */
  table?: boolean;
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

// A SWF of `version` whose root places Bound, a clip of `frames` frames
// bound to the script's class, the root Main: for the node tests' gotos
// and orphans.
export function boundClip(abc: Uint8Array, version: number, frames: number): Uint8Array {
  return w.swf({
    version,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, frames, [...Array.from({ length: frames }, () => w.showFrame()), w.end()]),
      w.doAbc(abc),
      w.symbolClass([
        [0, "Main"],
        [2, "Bound"],
      ]),
      w.place({ depth: 1, character: 2, name: "bound" }),
      w.showFrame(),
      w.showFrame(),
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

// A linked clip has a button whose up state is a clip. Constructing that
// button runs its state scripts before the linked clip finishes constructing.
function buttonFirstFrame(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.sprite(1, 2, [w.showFrame(), w.showFrame(), w.end()]),
      w.tag(7, Uint8Array.of(2, 0, 0x0f, 1, 0, 1, 0, 0, 0, 0)),
      w.sprite(3, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "ButtonFirstFrame"),
      w.symbolClass([
        [0, "Main"],
        [1, "State"],
        [3, "Menu"],
      ]),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A button whose up state is a scripted clip, in a clip the timeline places
// beside another, by a frame or by a frame script's goto, and in clips
// scripts make with `new`, from a listener and from a frame script, as
// Ruffle's frame_script_button_order makes one, and in one that registers
// its frame script before super(): which pending frame scripts the button's
// early frame runs, and whether the clip being constructed around it still
// runs its first frame's script.
function buttonFrameOrder(abc: Uint8Array): Uint8Array {
  // Up state the clip, the others a square, at depth 1 and with no matrix.
  const button = w.tag(7, Uint8Array.of(2, 0, 0x01, 1, 0, 1, 0, 0, 0x0e, 7, 0, 1, 0, 0, 0, 0));
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 8,
    tags: [
      w.fileAttributes(true),
      square(7, 0x3366cc),
      w.sprite(1, 1, [w.showFrame(), w.end()]),
      button,
      w.sprite(3, 1, [w.showFrame(), w.end()]),
      w.sprite(4, 1, [
        w.place({ depth: 1, character: 3 }),
        w.place({ depth: 2, character: 2 }),
        w.place({ depth: 3, character: 3 }),
        w.showFrame(),
        w.end(),
      ]),
      w.sprite(5, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.sprite(6, 1, [w.showFrame(), w.end()]),
      w.sprite(8, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "ButtonFrameOrder"),
      w.symbolClass([
        [0, "Main"],
        [1, "State"],
        [3, "Child"],
        [4, "Container"],
        [5, "Menu"],
        [6, "Other"],
        [8, "Early"],
      ]),
      w.showFrame(),
      w.place({ depth: 1, character: 3 }),
      w.place({ depth: 2, character: 4 }),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.place({ depth: 3, character: 4 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// scripts/GotoPlaceFirst.as: frame 1's script goes to frame 3, which places
// a clip holding a button whose up state is a clip (its early frame
// broadcasts FRAME_CONSTRUCTED), then a named clip after it, which the
// root's listener looks for.
function gotoPlaceFirst(abc: Uint8Array): Uint8Array {
  // Up state the clip, the others a square, at depth 1 and with no matrix.
  const button = w.tag(7, Uint8Array.of(2, 0, 0x01, 1, 0, 1, 0, 0, 0x0e, 7, 0, 1, 0, 0, 0, 0));
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      square(7, 0x3366cc),
      w.sprite(1, 1, [w.showFrame(), w.end()]),
      button,
      w.sprite(3, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.sprite(4, 1, [w.showFrame(), w.end()]),
      w.doAbc(abc, "GotoPlaceFirst"),
      w.symbolClass([
        [0, "Main"],
        [1, "State"],
        [3, "Holder"],
        [4, "Setup"],
      ]),
      w.showFrame(),
      w.showFrame(),
      w.place({ depth: 1, character: 3, name: "holder" }),
      w.place({ depth: 2, character: 4, name: "setup" }),
      w.showFrame(),
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

// Bodies of ten frames, each holding a looping kid of four and another in a
// one-frame mid sprite, bound to the classes in scripts/GotoChildren.as that
// jump or stop in different ways, one unbound that never jumps, and a loop
// on the root.
function gotoChildren(abc: Uint8Array): Uint8Array {
  const body = (id: number) =>
    w.sprite(id, 10, [
      w.place({ depth: 1, character: 2, name: "kid" }),
      w.place({ depth: 2, character: 10, name: "mid" }),
      ...Array.from({ length: 10 }, () => w.showFrame()),
      w.end(),
    ]);
  return w.swf({
    version: 9,
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 12,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 4, [
        w.place({ depth: 1, character: 1 }),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ]),
      w.sprite(10, 1, [w.place({ depth: 1, character: 2, name: "kid" }), w.showFrame(), w.end()]),
      body(3),
      body(4),
      body(5),
      body(6),
      body(7),
      body(8),
      body(9),
      body(11),
      body(12),
      body(13),
      body(14),
      w.doAbc(abc, "GotoChildren"),
      w.symbolClass([
        [0, "Main"],
        [3, "Forward"],
        [4, "ForwardStop"],
        [5, "Back"],
        [6, "Listener"],
        [8, "ForwardPlay"],
        [9, "Stopper"],
        [11, "Same"],
        [12, "Nested"],
        [13, "Pooled"],
        [14, "Bound"],
      ]),
      w.place({ depth: 1, character: 3, name: "forward" }),
      w.place({ depth: 2, character: 4, name: "forwardStop" }),
      w.place({ depth: 3, character: 5, name: "back" }),
      w.place({ depth: 4, character: 6, name: "listener" }),
      w.place({ depth: 5, character: 7, name: "plain" }),
      w.place({ depth: 6, character: 2, name: "loose" }),
      w.place({ depth: 7, character: 8, name: "forwardPlay" }),
      w.place({ depth: 8, character: 9, name: "stopper" }),
      w.place({ depth: 9, character: 11, name: "same" }),
      w.place({ depth: 10, character: 12, name: "nested" }),
      w.place({ depth: 11, character: 13, name: "pooled" }),
      w.showFrame(),
      w.place({ depth: 12, character: 14, name: "bound" }),
      ...Array.from({ length: 11 }, () => w.showFrame()),
      w.end(),
    ],
  });
}

// Timeline children named and not, shapes and sprites, one inside a sprite,
// and one placed on frame 2, for scripts/InstanceNames.as to read the names of.
function instanceNames(abc: Uint8Array): Uint8Array {
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
      w.doAbc(abc, "InstanceNames"),
      w.symbolClass([[0, "Main"]]),
      w.place({ depth: 1, character: 1 }),
      w.place({ depth: 2, character: 2, name: "a" }),
      w.place({ depth: 3, character: 2 }),
      w.place({ depth: 4, character: 1 }),
      w.showFrame(),
      w.place({ depth: 5, character: 2 }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Places without the move flag at a taken depth, for scripts/SameDepth.as.
function sameDepth(abc: Uint8Array): Uint8Array {
  const clip = (id: number) =>
    w.sprite(id, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]);
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      clip(2),
      clip(3),
      clip(4),
      clip(5),
      clip(6),
      w.doAbc(abc, "SameDepth"),
      w.symbolClass([
        [0, "Main"],
        [2, "A"],
        [3, "B"],
        [4, "C"],
        [5, "D"],
        [6, "E"],
      ]),
      w.place({ depth: 1, character: 2 }),
      w.place({ depth: 1, character: 3 }),
      w.showFrame(),
      w.place({ depth: 1, character: 4 }),
      w.place({ depth: 2, character: 6 }),
      w.showFrame(),
      w.remove(1),
      w.place({ depth: 1, character: 5 }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Clips of four frames bound to scripts/GotoCycle.as's A, B and L, B's
// fourth frame placing an X and L's third a Y, in a SWF of version 10.
function gotoCycle(abc: Uint8Array): Uint8Array {
  const frames = (id: number, extra: Uint8Array[][]) =>
    w.sprite(id, 4, [...extra.flatMap((tags) => [...tags, w.showFrame()]), w.end()]);
  return w.swf({
    version: 10,
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 8,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(3, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      frames(4, [[], [], [], []]),
      frames(5, [[], [], [], [w.place({ depth: 1, character: 2 })]]),
      frames(6, [[], [], [w.place({ depth: 1, character: 3 })], []]),
      w.doAbc(abc, "GotoCycle"),
      w.symbolClass([
        [0, "Main"],
        [2, "X"],
        [3, "Y"],
        [4, "A"],
        [5, "B"],
        [6, "L"],
      ]),
      w.place({ depth: 1, character: 4 }),
      w.place({ depth: 2, character: 5 }),
      w.place({ depth: 3, character: 6 }),
      ...Array.from({ length: 8 }, () => w.showFrame()),
      w.end(),
    ],
  });
}

// Clips bound to scripts/GotoCycleNested.as's A, B and L, L's third frame
// placing a Y, and the root's second an X, in a SWF of version 10.
function gotoCycleNested(abc: Uint8Array): Uint8Array {
  const frames = (id: number, extra: Uint8Array[][]) =>
    w.sprite(id, 4, [...extra.flatMap((tags) => [...tags, w.showFrame()]), w.end()]);
  return w.swf({
    version: 10,
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(3, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      frames(4, [[], [], [], []]),
      frames(5, [[], [], [], []]),
      frames(6, [[], [], [w.place({ depth: 1, character: 3 })], []]),
      w.doAbc(abc, "GotoCycleNested"),
      w.symbolClass([
        [0, "Main"],
        [2, "X"],
        [3, "Y"],
        [4, "A"],
        [5, "B"],
        [6, "L"],
      ]),
      w.place({ depth: 1, character: 4, name: "a" }),
      w.place({ depth: 2, character: 5, name: "b" }),
      w.place({ depth: 3, character: 6, name: "l" }),
      w.showFrame(),
      w.place({ depth: 4, character: 2 }),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Clips of six empty frames bound to scripts/GotoStops.as's S, P, Q and R,
// and two of another without a class, named for the root's script to send
// them, in a SWF of version 10.
function gotoStops(abc: Uint8Array): Uint8Array {
  const six = (id: number) =>
    w.sprite(id, 6, [...Array.from({ length: 6 }, () => w.showFrame()), w.end()]);
  const names: [string, number][] = [
    ["a", 2],
    ["b", 2],
    ["c", 3],
    ["p", 3],
    ["q", 4],
    ["r", 5],
    ["e", 6],
    ["f", 6],
    ["t", 7],
  ];
  return w.swf({
    version: 10,
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 6,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      six(2),
      six(3),
      six(4),
      six(5),
      six(6),
      six(7),
      w.doAbc(abc, "GotoStops"),
      w.symbolClass([
        [0, "Main"],
        [2, "S"],
        [3, "P"],
        [4, "Q"],
        [5, "R"],
        [7, "T"],
      ]),
      ...names.map(([name, character], i) => w.place({ depth: i + 1, character, name })),
      ...Array.from({ length: 6 }, () => w.showFrame()),
      w.end(),
    ],
  });
}

// Squares on a timeline of 4 frames, blurred, which move a pixel a frame
// with their blur written again and without, and stay with it written
// again, for scripts/FilterRetween.as to add its own to.
function filterRetween(abc: Uint8Array): Uint8Array {
  const at = (x: number, y = 4) => ({ tx: x * 20, ty: y * 20 });
  const frames = [0, 1, 2, 3].map((f) => [
    w.place({ depth: 1, move: true, matrix: at(10 + f), blurs: [2] }),
    w.place({ depth: 2, move: true, matrix: at(60 + f) }),
    w.place({ depth: 3, move: true, matrix: at(110), blurs: [2] }),
    w.showFrame(),
  ]);
  return w.swf({
    width: 150,
    height: 56,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0x0033cc, 400),
      w.doAbc(abc, "FilterRetween"),
      w.symbolClass([[0, "FilterRetween"]]),
      ...[1, 2, 3].map((depth) =>
        w.place({ depth, character: 1, matrix: at(10 + 50 * (depth - 1)), blurs: [2] }),
      ),
      ...frames[0].slice(3),
      ...frames.slice(1).flat(),
      w.end(),
    ],
  });
}

// Clips of a square, two MorphShapes growing a square and three empty
// text fields, side by side, which frames 2 to 4 move with every property a place sets, for
// scripts/ScriptedMoves.as to touch, then a loop back to frame 1's places.
function scriptedMoves(abc: Uint8Array): Uint8Array {
  const grow = w.morphShape({
    id: 3,
    startBounds: [0, 400, 0, 400],
    endBounds: [0, 800, 0, 800],
    fills: [{ start: 0xff0000cc, end: 0xff00cc00 }],
    lines: [],
    start: [{ fill0: 1, commands: rectPath(0, 0, 20, 20) }],
    end: [rectPath(0, 0, 40, 40)],
  });
  const count = 29;
  const morph = (i: number) => i === 23 || i === 24;
  const field = (i: number) => i >= 25 && i <= 27;
  const at = (i: number, dx: number) => ({ tx: (i * 38 + dx) * 20, ty: 400 });
  const each = (f: (i: number) => Uint8Array) => Array.from({ length: count }, (_, i) => f(i));
  return w.swf({
    version: 10,
    width: 1120,
    height: 100,
    frameRate: 24,
    frameCount: 5,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0x806040, 400),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      grow,
      w.editText(4, "", 400, 400),
      w.doAbc(abc, "ScriptedMoves"),
      w.symbolClass([[0, "Main"]]),
      ...each((i) =>
        w.place({ depth: i + 1, character: morph(i) ? 3 : field(i) ? 4 : 2, matrix: at(i, 0) }),
      ),
      w.showFrame(),
      ...each((i) =>
        w.place({
          depth: i + 1,
          move: true,
          matrix: at(i, 10),
          colorTransform: { mult: [0.5, 1, 1, 0.75] },
          ratio: morph(i) ? 32768 : undefined,
          blurs: [2],
          blendMode: 3,
          visible: false,
        }),
      ),
      w.showFrame(),
      ...each((i) =>
        w.place({
          depth: i + 1,
          move: true,
          matrix: { ...at(i, 20), a: 1.5, d: 1.5 },
          colorTransform: { mult: [1, 1, 1, 1], add: [100, 0, 0, 0] },
          ratio: morph(i) ? 65535 : undefined,
          blurs: [],
          blendMode: 6,
          visible: true,
        }),
      ),
      w.showFrame(),
      ...each((i) => w.place({ depth: i + 1, move: true, matrix: at(i, 30) })),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Frames whose first command at a depth does nothing, then a rewind past
// them, a place without the move flag at a taken depth 3 on frame 2, and
// at depth 4 a place, a removal and a place again before the rewind's
// target, at depth 5 a move to another character after a place, and at
// depth 6 a move with a character where nothing is, for scripts/RewindFirst.as.
function rewindFirst(abc: Uint8Array): Uint8Array {
  const clip = (id: number) =>
    w.sprite(id, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]);
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      clip(2),
      clip(3),
      clip(4),
      w.doAbc(abc, "RewindFirst"),
      w.symbolClass([
        [0, "Main"],
        [2, "A"],
        [3, "B"],
        [4, "C"],
      ]),
      w.place({ depth: 1, move: true, matrix: { tx: 400 } }),
      w.remove(2),
      w.place({ depth: 3, character: 2, matrix: { tx: 1400 } }),
      w.place({ depth: 4, character: 2, matrix: { tx: 1600 } }),
      w.place({ depth: 5, character: 2, matrix: { tx: 2200 } }),
      w.showFrame(),
      w.place({ depth: 1, character: 2 }),
      w.place({ depth: 2, character: 2, matrix: { tx: 200 } }),
      w.place({ depth: 3, character: 3, matrix: { tx: 1200 } }),
      w.remove(4),
      w.place({ depth: 4, character: 2, matrix: { tx: 1800 } }),
      w.place({ depth: 5, move: true, character: 4 }),
      w.place({ depth: 6, move: true, character: 4, matrix: { tx: 2600 } }),
      w.showFrame(),
      w.remove(1),
      w.remove(2),
      w.place({ depth: 1, character: 3, matrix: { tx: 600 } }),
      w.place({ depth: 2, character: 3, matrix: { tx: 800 } }),
      w.remove(4),
      w.place({ depth: 4, character: 3, matrix: { tx: 2000 } }),
      w.remove(5),
      w.place({ depth: 5, character: 3, matrix: { tx: 2400 } }),
      w.remove(6),
      w.place({ depth: 6, character: 3, matrix: { tx: 2800 } }),
      w.showFrame(),
      w.place({ depth: 1, move: true, matrix: { tx: 1000 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Another clip placed in a clip's stead with a ratio other than its, and
// one with its ratio, then a rewind past them, for scripts/RewindRatio.as.
function rewindRatio(abc: Uint8Array): Uint8Array {
  const clip = (id: number) =>
    w.sprite(id, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]);
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      clip(2),
      clip(3),
      w.doAbc(abc, "RewindRatio"),
      w.symbolClass([
        [0, "Main"],
        [2, "A"],
        [3, "B"],
      ]),
      w.place({ depth: 1, character: 2, matrix: { tx: 200 } }),
      w.place({ depth: 2, character: 2, ratio: 5, matrix: { tx: 400 } }),
      w.place({ depth: 3, character: 2, matrix: { tx: 600 } }),
      w.showFrame(),
      w.remove(1),
      w.place({ depth: 1, character: 3, ratio: 1, matrix: { tx: 800 } }),
      w.remove(2),
      w.place({ depth: 2, character: 3, ratio: 5, matrix: { tx: 1000 } }),
      w.place({ depth: 3, move: true, ratio: 9, matrix: { tx: 1200 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Frame 1 places a clip and a shape, frame 2 another kind at each depth,
// without the move flag and at the same ratio, and frame 3's script
// rewinds to frame 1, for scripts/RewindShapeClip.as.
function rewindShapeClip(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000, 400),
      w.sprite(4, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "RewindShapeClip"),
      w.symbolClass([
        [0, "Main"],
        [4, "A"],
      ]),
      w.place({ depth: 1, character: 4 }),
      w.place({ depth: 2, character: 1, matrix: { tx: 1000 } }),
      w.showFrame(),
      w.remove(1),
      w.remove(2),
      w.place({ depth: 1, character: 1 }),
      w.place({ depth: 2, character: 4, matrix: { tx: 1000 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// First-frame children of each kind moved to another ratio, and shapes
// placed again with another ratio and with the same, then a rewind past
// them, for scripts/RewindKinds.as.
function rewindKinds(abc: Uint8Array): Uint8Array {
  const grow = w.morphShape({
    id: 2,
    startBounds: [0, 400, 0, 400],
    endBounds: [0, 800, 0, 800],
    fills: [{ start: 0xff0000ff, end: 0xff00ff00 }],
    start: [
      {
        fill0: 1,
        commands: [
          { move: [0, 0] },
          { line: [400, 0] },
          { line: [400, 400] },
          { line: [0, 400] },
          { line: [0, 0] },
        ],
      },
    ],
    end: [
      [
        { move: [0, 0] },
        { line: [800, 0] },
        { line: [800, 800] },
        { line: [0, 800] },
        { line: [0, 0] },
      ],
    ],
  });
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000, 400),
      grow,
      w.editText(3, "t", 400, 400),
      w.sprite(4, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "RewindKinds"),
      w.symbolClass([
        [0, "Main"],
        [4, "A"],
      ]),
      w.place({ depth: 1, character: 1, matrix: { tx: 200 } }),
      w.place({ depth: 2, character: 2, ratio: 0, matrix: { tx: 400 } }),
      w.place({ depth: 3, character: 3, matrix: { tx: 600 } }),
      w.place({ depth: 4, character: 1, matrix: { tx: 800 } }),
      w.place({ depth: 5, character: 1, matrix: { tx: 1000 } }),
      w.place({ depth: 6, character: 4, matrix: { tx: 1200 } }),
      w.showFrame(),
      w.place({ depth: 1, move: true, ratio: 9 }),
      w.place({ depth: 2, move: true, ratio: 30000 }),
      w.place({ depth: 3, move: true, ratio: 9 }),
      w.remove(4),
      w.place({ depth: 4, character: 1, ratio: 3, matrix: { tx: 800 } }),
      w.remove(5),
      w.place({ depth: 5, character: 1, matrix: { tx: 1000 } }),
      w.place({ depth: 6, move: true, ratio: 9 }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A clip of three frames, bound to scripts/LoopRatio.as's L, that tweens
// its C by ratios and loops on its own, beside a D it leaves.
function loopRatio(abc: Uint8Array): Uint8Array {
  const clip = (id: number) =>
    w.sprite(id, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]);
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      clip(2),
      clip(3),
      w.sprite(4, 3, [
        w.place({ depth: 1, character: 2, matrix: { tx: 200 } }),
        w.place({ depth: 2, character: 3, matrix: { tx: 1000 } }),
        w.showFrame(),
        w.place({ depth: 1, move: true, ratio: 1, matrix: { tx: 400 } }),
        w.showFrame(),
        w.place({ depth: 1, move: true, ratio: 2, matrix: { tx: 600 } }),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "LoopRatio"),
      w.symbolClass([
        [0, "Main"],
        [2, "C"],
        [3, "D"],
        [4, "L"],
      ]),
      w.place({ depth: 1, character: 4 }),
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

// Two-frame sprites, a red square then a blue one, bound to a Sprite and a
// MovieClip class and placed on a two-frame root bound to a Sprite class,
// whose second frame adds a green square (scripts/SpriteFrames.as).
function spriteFrames(abc: Uint8Array): Uint8Array {
  const twoFrames = (id: number) =>
    w.sprite(id, 2, [
      w.place({ depth: 1, character: 1 }),
      w.showFrame(),
      w.remove(1),
      w.place({ depth: 2, character: 2 }),
      w.showFrame(),
      w.end(),
    ]);
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000, 400),
      square(2, 0x0000ff, 600),
      square(3, 0x00aa00, 200),
      twoFrames(10),
      twoFrames(11),
      w.doAbc(abc, "SpriteFrames"),
      w.symbolClass([
        [0, "SpriteFrames"],
        [10, "SpriteFramesSprite"],
        [11, "SpriteFramesClip"],
      ]),
      w.place({ depth: 1, character: 10, name: "placed", matrix: { tx: 400, ty: 200 } }),
      w.place({ depth: 2, character: 11, name: "placedClip", matrix: { tx: 1600, ty: 200 } }),
      w.showFrame(),
      w.place({ depth: 3, character: 3, matrix: { tx: 3000, ty: 200 } }),
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

// Four-frame clips whose square moves each frame: a Kid; a Box with a Kid
// on its first frame; a Box3 with a Kid on its first and another on its
// third; an Outer with a Box; a one-frame SBox with a Kid; a Maker, empty.
// A five-frame root places a Box, an Outer and a Box3 and makes the rest,
// and loads a SWF of a four-frame root with a four-frame clip
// (scripts/FreshClips.as.template).
function freshClips(compile: Compile): Uint8Array {
  const moving = (square: number, ty = 0) => [
    w.place({ depth: 2, character: square, matrix: { tx: 0, ty } }),
    w.showFrame(),
    ...[100, 200, 300].flatMap((tx) => [
      w.place({ depth: 2, move: true, matrix: { tx, ty } }),
      w.showFrame(),
    ]),
  ];
  const kid = w.sprite(10, 4, [...moving(2, 200), w.end()]);
  const inner = w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(2, 0x0000ff, 200),
      kid,
      w.place({ depth: 1, character: 10, matrix: { tx: 3600, ty: 1600 } }),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
  const template = readFileSync(new URL("scripts/FreshClips.as.template", import.meta.url), "utf8");
  const abc = compile(
    "FreshClips",
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  const [first, ...rest] = moving(1);
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 5,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000, 200),
      square(2, 0x0000ff, 200),
      kid,
      w.sprite(11, 4, [w.place({ depth: 1, character: 10, name: "kid" }), first, ...rest, w.end()]),
      w.sprite(12, 4, [
        w.place({ depth: 1, character: 11, name: "box" }),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ]),
      w.sprite(13, 1, [w.place({ depth: 1, character: 10, name: "kid" }), w.showFrame(), w.end()]),
      w.sprite(14, 1, [w.showFrame(), w.end()]),
      w.sprite(15, 4, [
        w.place({ depth: 1, character: 10, name: "kid" }),
        first,
        ...rest.slice(0, 3),
        w.place({ depth: 3, character: 10, name: "late", matrix: { tx: 0, ty: -200 } }),
        ...rest.slice(3),
        w.end(),
      ]),
      w.doAbc(abc, "FreshClips"),
      w.symbolClass([
        [0, "Main"],
        [10, "Kid"],
        [11, "Box"],
        [12, "Outer"],
        [13, "SBox"],
        [14, "Maker"],
        [15, "Box3"],
      ]),
      w.place({ depth: 1, character: 11, name: "placed", matrix: { tx: 0, ty: 1600 } }),
      w.place({ depth: 2, character: 12, name: "placedOuter", matrix: { tx: 800, ty: 1600 } }),
      w.place({ depth: 3, character: 15, name: "q", matrix: { tx: 1600, ty: 1600 } }),
      w.showFrame(),
      w.showFrame(),
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

function loadedFont(compile: Compile): Uint8Array {
  const inner = w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.font3({
        id: 1,
        name: "Probe",
        ascent: 800,
        descent: 200,
        glyphs: [{ char: "A", advance: 500, boxes: [[0, -500, 400, 0]] }],
      }),
      w.doAbc(compile("LoadedFontInner"), "LoadedFontInner"),
      w.symbolClass([[0, "LoadedFontInner"]]),
      w.showFrame(),
      w.end(),
    ],
  });
  const template = readFileSync(new URL("scripts/LoadedFont.as.template", import.meta.url), "utf8");
  const abc = compile(
    "LoadedFont",
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.font3({
        id: 1,
        name: "Probe",
        ascent: 800,
        descent: 200,
        glyphs: [{ char: "A", advance: 100, boxes: [[0, -500, 80, 0]] }],
      }),
      w.doAbc(abc, "LoadedFont"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
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

// loaderInfo.parameters of SWFs loaded from bytes with a LoaderContext's
// (scripts/LoaderParameters.as.template, scripts/ParametersInner.as).
function loaderParameters(compile: Compile): Uint8Array {
  const inner = bare(compile("ParametersInner"), 1, "ParametersInner");
  const template = readFileSync(
    new URL("scripts/LoaderParameters.as.template", import.meta.url),
    "utf8",
  );
  const abc = compile(
    "LoaderParameters",
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return bare(abc, 3);
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

// AVM1 SWFs an AS3 one loads (scripts/Avm1Movie.as.template): one of
// version 8 whose FileAttributes leaves out ActionScript 3, three frames
// that move a square and add another, and one of version 6 without
// FileAttributes, a green square. The first's frame 1 has a DoAction,
// `x = "1"`, which shows nothing: the player runs no AVM1 actions.
function avm1Movie(compile: Compile): Uint8Array {
  const inner = w.swf({
    version: 8,
    width: 100,
    height: 50,
    frameRate: 12,
    frameCount: 3,
    tags: [
      w.fileAttributes(false),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      square(2, 0x0000ff, 400),
      w.place({ depth: 1, character: 1, matrix: { tx: 100, ty: 100 } }),
      // Push "x", push "1", SetVariable, End.
      w.tag(12, Uint8Array.from([0x96, 3, 0, 0, 0x78, 0, 0x96, 3, 0, 0, 0x31, 0, 0x1d, 0])),
      w.showFrame(),
      w.place({ depth: 1, move: true, matrix: { tx: 500, ty: 100 } }),
      w.place({ depth: 2, character: 2, matrix: { tx: 1400, ty: 400 } }),
      w.showFrame(),
      w.remove(2),
      w.showFrame(),
      w.end(),
    ],
  });
  const bare = w.swf({
    version: 6,
    width: 60,
    height: 40,
    frameRate: 30,
    frameCount: 1,
    tags: [
      w.backgroundColor(0xffffff),
      square(1, 0x00aa00, 600),
      w.place({ depth: 1, character: 1, matrix: { tx: 200, ty: 200 } }),
      w.showFrame(),
      w.end(),
    ],
  });
  const template = readFileSync(new URL("scripts/Avm1Movie.as.template", import.meta.url), "utf8");
  const abc = compile(
    "Avm1Movie",
    template
      .replaceAll("@@INNER@@", Buffer.from(inner).toString("base64"))
      .replaceAll("@@BARE@@", Buffer.from(bare).toString("base64")),
  );
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "Avm1Movie"),
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

function fontNatives(compile: Compile): Uint8Array {
  return w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      probeFont(1),
      w.doAbc(
        compile(
          "EmbeddedProbe",
          "package { import flash.text.Font; public class EmbeddedProbe extends Font {} }",
        ),
        "EmbeddedProbe",
      ),
      w.doAbc(compile("FontNatives")),
      w.symbolClass([
        [0, "FontNatives"],
        [1, "EmbeddedProbe"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Probe, regular, and a bold font bound to a class, for TextField.isFontCompatible.
function textFieldQueries(compile: Compile): Uint8Array {
  return w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      probeFont(1),
      w.font3({
        id: 2,
        name: "BoldProbe",
        bold: true,
        ascent: 800,
        descent: 200,
        glyphs: [{ char: "a", advance: 500, boxes: [[50, -500, 450, 0]] }],
      }),
      w.doAbc(
        compile(
          "EmbeddedBold",
          "package { import flash.text.Font; public class EmbeddedBold extends Font {} }",
        ),
        "EmbeddedBold",
      ),
      w.doAbc(compile("TextFieldQueries")),
      w.symbolClass([
        [0, "TextFieldQueries"],
        [2, "EmbeddedBold"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

function fontRegistration(compile: Compile): Uint8Array {
  const inner = w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      probeFont(1),
      w.doAbc(
        compile(
          "EmbeddedProbe",
          "package { import flash.text.Font; public class EmbeddedProbe extends Font {} }",
        ),
        "EmbeddedProbe",
      ),
      w.symbolClass([[1, "EmbeddedProbe"]]),
      w.showFrame(),
      w.end(),
    ],
  });
  const template = readFileSync(
    new URL("scripts/FontRegistration.as.template", import.meta.url),
    "utf8",
  );
  const abc = compile(
    "FontRegistration",
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return bare(abc, 3, "FontRegistration");
}

function soundSymbols(compile: Compile): Uint8Array {
  const pcm = new Uint8Array(11025).fill(128);
  const sound = new w.BitWriter()
    .u16(1)
    .u8((1 << 2) | 0)
    .u32(pcm.length)
    .raw(pcm)
    .done();
  return w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.tag(tags.DefineSound, sound),
      w.doAbc(
        compile("Tone", "package { import flash.media.Sound; public class Tone extends Sound {} }"),
        "Tone",
      ),
      w.doAbc(compile("SoundSymbols")),
      w.symbolClass([
        [0, "SoundSymbols"],
        [1, "Tone"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A document class `script` beside Tone, one second of silence at 5.5 kHz. */
export const toneScript =
  (script: string) =>
  (compile: Compile): Uint8Array => {
    const pcm = new Uint8Array(5512).fill(128);
    const sound = new w.BitWriter()
      .u16(1)
      .u8(1 << 2)
      .u32(pcm.length)
      .raw(pcm)
      .done();
    return w.swf({
      width: 20,
      height: 20,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        w.tag(tags.DefineSound, sound),
        w.doAbc(
          compile(
            "Tone",
            "package { import flash.media.Sound; public class Tone extends Sound {} }",
          ),
          "Tone",
        ),
        w.doAbc(compile(script)),
        w.symbolClass([
          [0, script],
          [1, "Tone"],
        ]),
        w.showFrame(),
        w.end(),
      ],
    });
  };

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

/**
 * A floor of boards, as Flash Pro exports one: a rectangle's outline with
 * the fill on its inside, and the seams between the boards, lines with the
 * same fill on both sides. Flash fills the whole rectangle and strokes the
 * seams over it. Its edges come in an order, some reversed, in which the
 * player once joined the fill's edges both ways along the seams into
 * contours that crossed, and cut part of the floor away as a hole.
 */
function sharedFillEdges(): Uint8Array {
  const [left, right, top, bottom] = [10, 390, 10, 130];
  const rows = [top, 40, 70, 100, bottom];
  // Each row's joints between boards, where a seam crosses the row aslant.
  const joints = [[120, 300], [60, 220, 340], [170], [90, 260]];
  const at = (x: number, y: number): [number, number] => [x * 20, y * 20];
  // A row's edge, split where joints meet it from above or below.
  const splits = (r: number) =>
    [
      ...(r > 0 ? joints[r - 1].map((x) => x + 12) : []),
      ...(r < joints.length ? joints[r] : []),
    ].sort((a, b) => a - b);
  // The seams: the rows' lines, then the joints between their boards.
  const seams: [number, number][][] = [];
  for (let r = 1; r < rows.length - 1; r++) {
    seams.push([left, ...splits(r), right].map((x) => at(x, rows[r])));
  }

  for (const [r, xs] of joints.entries()) {
    for (const x of xs) {
      seams.push([at(x, rows[r]), at(x + 12, rows[r + 1])]);
    }
  }

  // The outline's four sides clockwise, so that its inside is on their right.
  const sides = [
    [left, ...splits(0), right].map((x) => at(x, top)),
    rows.map((y) => at(right, y)),
    [left, ...splits(rows.length - 1), right].reverse().map((x) => at(x, bottom)),
    rows
      .slice()
      .reverse()
      .map((y) => at(left, y)),
  ];
  const edges = [
    ...seams.map((points) => ({ points, fill0: 1, fill1: 1 })),
    ...sides.map((points) => ({ points, fill0: 0, fill1: 1 })),
  ];
  const order = [12, 6, 3, 5, 2, 11, 13, 10, 4, 1, 0, 8, 7, 9, 14];
  const reverse = new Set([0, 2, 3, 5, 6, 8, 10, 11, 13, 14]);
  const paths = order.map((i) => {
    const { points, fill0, fill1 } = edges[i];
    const flip = reverse.has(i);
    const ordered = flip ? points.slice().reverse() : points;
    return {
      fill0: flip ? fill1 : fill0,
      fill1: flip ? fill0 : fill1,
      line: fill0 === fill1 ? 1 : 0,
      commands: [
        { move: ordered[0] },
        ...ordered.slice(1).map((line) => ({ line })),
      ] as w.PathCommand[],
    };
  });
  return w.swf({
    width: 400,
    height: 140,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.shape({
        id: 1,
        bounds: [0, 8000, 0, 2800],
        fills: [0x806655],
        lines: [{ width: 40, color: 0x3a2a20 }],
        paths,
      }),
      w.place({ depth: 1, character: 1 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

/**
 * One fill's regions and holes, as Pixi cuts them: a square, then one with
 * two holes, then one with a hole holding an island and a second hole.
 * Each hole is its own region's, not the region drawn before it.
 */
function fillHoles(): Uint8Array {
  const squares: [number, number, number, number][] = [
    [5, 5, 30, 30],
    [50, 5, 45, 45],
    [55, 10, 15, 15],
    [75, 30, 15, 15],
    [110, 5, 45, 45],
    [115, 10, 20, 20],
    [120, 15, 10, 10],
    [140, 30, 10, 10],
  ];
  return w.swf({
    width: 200,
    height: 60,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.shape({
        id: 1,
        bounds: [0, 4000, 0, 1200],
        fills: [0xcc3300],
        paths: squares.map(([x, y, width, height]) => ({
          fill1: 1,
          commands: rectPath(x, y, width, height),
        })),
      }),
      w.place({ depth: 1, character: 1 }),
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

/** A circle's path, in pixels: eight quadratics, as Flash's drawCircle; an ellipse `r` by `ry`. */
function circlePath(cx: number, cy: number, r: number, ry = r): w.PathCommand[] {
  const at = (radius: number, angle: number): [number, number] => [
    Math.round((cx + radius * Math.cos(angle)) * 20),
    Math.round((cy + ((radius * ry) / r) * Math.sin(angle)) * 20),
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

// A soft shadow under a figure, as a game draws one: a black ellipse in a
// clip blurred 14 pixels at three quarters' alpha, in a clip stretched wide
// and flattened, placed twice the second time at twice the size.
function blurredShadow(): Uint8Array {
  const stretched = (x: number, scale: number) => ({
    a: 1.39 * scale,
    d: 0.81 * scale,
    tx: x * 20,
    ty: 50 * 20,
  });
  return w.swf({
    width: 240,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.backgroundColor(0xd0d0e0),
      w.shape({
        id: 1,
        bounds: [-470, 470, -150, 150],
        fills: [0x000000],
        paths: [{ fill1: 1, commands: circlePath(0, 0, 23.5, 7.5) }],
      }),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(3, 1, [
        w.place({
          depth: 1,
          character: 2,
          matrix: { tx: 3, ty: 29 },
          colorTransform: { mult: [1, 1, 1, 0.75] },
          blurs: [14],
        }),
        w.showFrame(),
        w.end(),
      ]),
      w.place({ depth: 1, character: 3, matrix: stretched(60, 1) }),
      w.place({ depth: 2, character: 3, matrix: stretched(170, 2) }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Filters on a stage a host shows `zoom` times its size: the soft shadow,
// a glow as a chat's outline, and a drop shadow, each at its size and in a
// clip scaled twice, which leaves them as they are. Flash Player draws a
// stage so shown as its size `zoom` times over with every filter `zoom`
// times as wide and as far, as measured in its window; adl cannot show a
// stage zoomed, so the references are adl's frames of this SWF built so.
function zoomedFilters(zoom: number): Uint8Array {
  const at = (x: number, y: number, a = 1, d = a) => ({
    a: a * zoom,
    d: d * zoom,
    tx: x * 20 * zoom,
    ty: y * 20 * zoom,
  });
  const rect = (id: number, color: number, width: number, height: number) =>
    w.shape({
      id,
      bounds: [0, width * 20, 0, height * 20],
      fills: [color],
      paths: [{ fill1: 1, commands: rectPath(0, 0, width, height) }],
    });
  const glows = [{ color: 0x333333, blur: 4 * zoom, strength: 3 }];
  const shadows = [{ blur: 2 * zoom, distance: 4 * zoom, angle: 45 }];
  return w.swf({
    width: 260 * zoom,
    height: 100 * zoom,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.backgroundColor(0xd0d0e0),
      w.shape({
        id: 1,
        bounds: [-470, 470, -150, 150],
        fills: [0x000000],
        paths: [{ fill1: 1, commands: circlePath(0, 0, 23.5, 7.5) }],
      }),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(3, 1, [
        w.place({
          depth: 1,
          character: 2,
          colorTransform: { mult: [1, 1, 1, 0.75] },
          blurs: [14 * zoom],
        }),
        w.showFrame(),
        w.end(),
      ]),
      rect(4, 0xffffff, 40, 8),
      rect(5, 0xffffff, 20, 4),
      rect(6, 0xcc0000, 12, 12),
      rect(7, 0xcc0000, 6, 6),
      w.sprite(8, 1, [w.place({ depth: 1, character: 5, glows }), w.showFrame(), w.end()]),
      w.sprite(9, 1, [w.place({ depth: 1, character: 7, shadows }), w.showFrame(), w.end()]),
      w.place({ depth: 1, character: 3, matrix: at(48, 25, 1.39, 0.81) }),
      w.place({ depth: 2, character: 3, matrix: at(175, 32, 2.78, 1.62) }),
      w.place({ depth: 3, character: 4, matrix: at(20, 72), glows }),
      w.place({ depth: 4, character: 8, matrix: at(80, 72, 2) }),
      w.place({ depth: 5, character: 6, matrix: at(150, 70), shadows }),
      w.place({ depth: 6, character: 9, matrix: at(190, 70, 2) }),
      w.showFrame(),
      w.end(),
    ],
  });
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

// Static text in Probe, defined before the font it uses: a DefineText of
// two lines in two colours, and a DefineText2 turned and scaled by its
// matrix, a run in half-transparent green, one of a font the SWF lacks,
// which shows nothing, and a smaller line below.
function staticTexts(): Uint8Array {
  return w.swf({
    width: 320,
    height: 160,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.staticText({
        id: 1,
        bounds: [0, 1400, -400, 800],
        matrix: { tx: 400, ty: 1000 },
        records: [
          {
            font: 5,
            height: 400,
            color: 0x0000cc,
            x: 0,
            y: 0,
            glyphs: [
              [2, 300],
              [3, 400],
              [4, 200],
            ],
          },
          {
            color: 0xcc0000,
            x: 0,
            y: 600,
            glyphs: [
              [1, 450],
              [2, 200],
            ],
          },
        ],
      }),
      probeFont(5),
      w.staticText({
        id: 2,
        version: 2,
        bounds: [0, 1800, -600, 1000],
        matrix: { a: 1.2, b: 0.3, c: -0.3, d: 1.2, tx: 3200, ty: 800 },
        records: [
          {
            font: 5,
            height: 600,
            color: 0x80008000,
            x: 0,
            y: 0,
            glyphs: [
              [2, 400],
              [3, 500],
            ],
          },
          { font: 99, height: 400, glyphs: [[2, 300]] },
          {
            font: 5,
            height: 300,
            color: 0xff000000,
            x: 200,
            y: 900,
            glyphs: [
              [4, 200],
              [1, 300],
            ],
          },
        ],
      }),
      w.place({ depth: 1, character: 1, matrix: { tx: 200, ty: 200 } }),
      w.place({ depth: 2, character: 2 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Static text in Probe over a red square, given drop shadows by
// scripts/StaticTextFilters.as.
function staticTextFilters(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xcc0000, 3600),
      probeFont(5),
      w.staticText({
        id: 2,
        bounds: [0, 3300, -1000, 300],
        records: [
          {
            font: 5,
            height: 1200,
            color: 0xffffff,
            x: 0,
            y: 0,
            glyphs: [
              [2, 700],
              [3, 900],
              [4, 500],
              [1, 1300],
            ],
          },
        ],
      }),
      w.doAbc(abc, "StaticTextFilters"),
      w.symbolClass([[0, "StaticTextFilters"]]),
      w.place({ depth: 1, character: 1, matrix: { tx: 200, ty: 200 } }),
      w.place({ depth: 2, character: 2, matrix: { tx: 600, ty: 1600 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Static text in Probe for scripts/StaticTextProbe.as: a text of two
// lines, one that sets no colour, and one whose middle glyph is past the
// font's, which moves no pen.
function staticTextProbe(abc: Uint8Array): Uint8Array {
  const ab: [number, number][] = [
    [2, 300],
    [3, 400],
  ];
  return w.swf({
    width: 200,
    height: 120,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      probeFont(5),
      w.staticText({
        id: 1,
        version: 2,
        bounds: [0, 1400, -800, 800],
        records: [
          { font: 5, height: 400, color: 0xff000000, x: 0, y: 0, glyphs: ab },
          {
            y: 600,
            glyphs: [
              [1, 450],
              [4, 200],
            ],
          },
        ],
      }),
      w.staticText({
        id: 2,
        bounds: [0, 1400, -800, 300],
        records: [{ font: 5, height: 400, x: 0, y: 0, glyphs: ab }],
      }),
      w.staticText({
        id: 3,
        version: 2,
        bounds: [0, 1400, -800, 300],
        records: [
          {
            font: 5,
            height: 400,
            color: 0xff0000cc,
            x: 0,
            y: 0,
            glyphs: [
              [2, 300],
              [40, 600],
              [3, 400],
            ],
          },
        ],
      }),
      w.doAbc(abc, "StaticTextProbe"),
      w.symbolClass([[0, "StaticTextProbe"]]),
      w.place({ depth: 1, character: 1, matrix: { tx: 800, ty: 800 } }),
      w.place({ depth: 2, character: 2, matrix: { tx: 800, ty: 2000 } }),
      w.place({ depth: 3, character: 3, matrix: { tx: 2400, ty: 800 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Two clips of one outlined shape and one static text in Probe, for
// scripts/SharedColors.as, which colour-transforms the first and then
// takes the transform off: the second shares the first's fills and glyphs.
function sharedColors(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 200,
    height: 80,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.shape({
        id: 1,
        bounds: [-40, 840, -40, 840],
        fills: [0xcc3300],
        lines: [{ width: 80, color: 0x004400 }],
        paths: [{ fill1: 1, line: 1, commands: rectPath(0, 0, 40, 40) }],
      }),
      probeFont(5),
      w.staticText({
        id: 2,
        bounds: [0, 1600, -800, 200],
        records: [
          {
            font: 5,
            height: 600,
            color: 0x000080,
            x: 0,
            y: 0,
            glyphs: [
              [2, 400],
              [3, 500],
              [4, 400],
            ],
          },
        ],
      }),
      w.sprite(3, 1, [
        w.place({ depth: 1, character: 1 }),
        w.place({ depth: 2, character: 2, matrix: { tx: 1000, ty: 700 } }),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "SharedColors"),
      w.symbolClass([[0, "SharedColors"]]),
      w.place({ depth: 1, character: 3, matrix: { tx: 200, ty: 200 } }),
      w.place({ depth: 2, character: 3, matrix: { tx: 2200, ty: 200 } }),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A field inset from its origin, as authored, for scripts/FieldPosition.as.
function fieldPosition(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 300,
    height: 120,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.editText(1, "Back", 2492, 598, 2, { at: [886, -40], color: 0xff000000 }),
      w.doAbc(abc, "FieldPosition"),
      w.symbolClass([[0, "FieldPosition"]]),
      w.place({ depth: 1, character: 1, matrix: { tx: 400, ty: 400 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}

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

/**
 * "Pixel", a pixel font: glyphs on a grid of an eighth of an em, as a
 * bitmap font's outlines are. Its "a" is two contours, a top bar whose
 * bottom edge runs along the corners of the outline below it, as an
 * authoring tool joins the pixels; "b" and "o" have holes the other way
 * round, cut as a font's are.
 */
const pixelFont = (id: number): Uint8Array => {
  const p = (points: [number, number][]): [number, number][] =>
    points.map(([x, y]) => [x * 128, y * 128]);
  const boxes = (...list: [number, number, number, number][]) =>
    list.map((b) => b.map((v) => v * 128) as [number, number, number, number]);
  return w.font3({
    id,
    name: "Pixel",
    ascent: 896,
    descent: 256,
    glyphs: [
      {
        char: "a",
        advance: 768,
        boxes: [],
        contours: [
          p([
            [1, -5],
            [1, -3],
            [4, -3],
            [4, -5],
            [5, -5],
            [5, 0],
            [4, 0],
            [4, -2],
            [1, -2],
            [1, 0],
            [0, 0],
            [0, -5],
          ]),
          p([
            [4, -5],
            [1, -5],
            [1, -6],
            [4, -6],
          ]),
        ],
      },
      {
        char: "b",
        advance: 640,
        boxes: boxes([0, -6, 4, 0]),
        contours: [
          p([
            [1, -5],
            [1, -4],
            [3, -4],
            [3, -5],
          ]),
          p([
            [1, -3],
            [1, -1],
            [3, -1],
            [3, -3],
          ]),
        ],
      },
      { char: "i", advance: 256, boxes: boxes([0, -6, 1, -5], [0, -4, 1, 0]) },
      {
        char: "k",
        advance: 640,
        boxes: boxes([0, -6, 1, 0], [1, -3, 3, -2], [3, -5, 4, -3], [3, -2, 4, 0]),
      },
      {
        char: "o",
        advance: 640,
        boxes: boxes([0, -5, 4, 0]),
        contours: [
          p([
            [1, -4],
            [1, -1],
            [3, -1],
            [3, -4],
          ]),
        ],
      },
      { char: "[", advance: 384, boxes: boxes([0, -6, 1, 1], [1, -6, 2, -5], [1, 0, 2, 1]) },
      { char: "]", advance: 384, boxes: boxes([1, -6, 2, 1], [0, -6, 1, -5], [0, 0, 1, 1]) },
      { char: ".", advance: 256, boxes: boxes([0, -1, 1, 0]) },
      { char: " ", advance: 384, boxes: [] },
    ],
  });
};

// Chat lines in fields with a hanging indent (scripts/TextIndent.as):
// three of one DefineEditText, HTML, multiline and wrapped in Pixel, with
// a left margin of 10 and an indent of -10 pixels.
function textIndent(abc: Uint8Array): Uint8Array {
  const chat = w.editText(2, "", 4000, 400, 0, {
    html: true,
    multiline: true,
    wordWrap: true,
    useOutlines: true,
    color: 0xffffff,
    font: 1,
    fontHeight: 320,
    layout: { leftMargin: 200, rightMargin: 0, indent: -200, leading: 0 },
  });
  return w.swf({
    width: 420,
    height: 200,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      pixelFont(1),
      chat,
      w.doAbc(abc, "TextIndent"),
      w.symbolClass([[0, "TextIndent"]]),
      w.place({ depth: 1, character: 2, matrix: { tx: 100, ty: 100 } }),
      w.place({ depth: 2, character: 2, matrix: { tx: 100, ty: 1400 } }),
      w.place({ depth: 3, character: 2, matrix: { tx: 100, ty: 2000 } }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Fields for scripts/TextFinalNewline.as: a DefineEditText read-only, so
// dynamic, and one not, so input, both HTML, multiline and wrapped in
// Pixel. Four hidden probes, then a chat's column of each kind.
function textFinalNewline(abc: Uint8Array): Uint8Array {
  const field = (id: number, readOnly: boolean) =>
    w.editText(id, "", 4000, 400, 0, {
      html: true,
      multiline: true,
      wordWrap: true,
      useOutlines: true,
      readOnly,
      color: 0,
      font: 1,
      fontHeight: 320,
    });
  const kinds = [2, 3, 3, 2, 2, 2, 2, 2, 3, 3, 3, 3];
  return w.swf({
    width: 420,
    height: 200,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      pixelFont(1),
      field(2, true),
      field(3, false),
      w.doAbc(abc, "TextFinalNewline"),
      w.symbolClass([[0, "TextFinalNewline"]]),
      ...kinds.map((character, i) =>
        w.place({ depth: i + 1, character, matrix: { tx: i < 8 ? 100 : 4300, ty: 0 } }),
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Three morph shapes: one whose straight edges pair with curves as its
// fill, line width and colour change; one of two paths with a turning
// gradient, in a DefineMorphShape2; and two regions of two colours whose
// shared edge, fill0 on one side and fill1 on the other, moves. The
// timeline sets ratios, swaps a shape for a morph and back with the move
// flag, and loops onto a shape a rewind keeps.
function morphs(): Uint8Array {
  const bend = w.morphShape({
    id: 1,
    startBounds: [-20, 1220, -20, 1220],
    endBounds: [-280, 1480, -280, 1480],
    fills: [{ start: 0xffcc3300, end: 0xff0033cc }],
    lines: [{ startWidth: 40, endWidth: 160, startColor: 0xff000000, endColor: 0xff00a000 }],
    start: [
      {
        fill0: 1,
        line: 1,
        commands: [
          { move: [0, 0] },
          { line: [1200, 0] },
          { line: [1200, 1200] },
          { line: [0, 1200] },
          { line: [0, 0] },
        ],
      },
    ],
    end: [
      [
        { move: [600, -200] },
        { curve: [1400, -200, 1400, 600] },
        { line: [600, 1400] },
        { curve: [-200, 1400, -200, 600] },
        { line: [600, -200] },
      ],
    ],
  });
  const turn = w.morphShape({
    id: 2,
    version: 2,
    startBounds: [-40, 1840, -40, 1040],
    endBounds: [-40, 1940, 160, 1240],
    fills: [
      {
        type: 0x10,
        startMatrix: { a: 0.05, d: 0.05, tx: 900, ty: 500 },
        endMatrix: { a: 0, b: 0.05, c: -0.05, d: 0, tx: 900, ty: 700 },
        stops: [
          [0, 0xffffff00, 0, 0xff00ffff],
          [255, 0xffff0000, 128, 0x80000080],
        ],
      },
    ],
    lines: [{ startWidth: 20, endWidth: 80, startColor: 0xff404040, endColor: 0xffff00ff }],
    start: [
      {
        fill0: 1,
        line: 1,
        commands: [{ move: [0, 0] }, { line: [1200, 0] }, { line: [600, 1000] }, { line: [0, 0] }],
      },
      { fill0: 1, line: 1, commands: rectPath(70, 0, 20, 20) },
    ],
    end: [
      [{ move: [0, 200] }, { line: [1200, 200] }, { line: [600, 1200] }, { line: [0, 200] }],
      rectPath(65, 40, 30, 20),
    ],
  });
  // The left region's outline, the right's, then the edge between them at x.
  const regions = (x: number, height: number): w.PathCommand[][] => [
    [{ move: [x, 0] }, { line: [0, 0] }, { line: [0, height] }, { line: [x, height] }],
    [{ move: [x, height] }, { line: [1200, height] }, { line: [1200, 0] }, { line: [x, 0] }],
    [{ move: [x, height] }, { line: [x, 0] }],
  ];
  const [left, right, between] = regions(300, 600);
  const split = w.morphShape({
    id: 4,
    startBounds: [0, 1200, 0, 600],
    endBounds: [0, 1200, 0, 1000],
    fills: [
      { start: 0xffff0000, end: 0xffffaa00 },
      { start: 0xff0000ff, end: 0xff00aaff },
    ],
    start: [
      { fill0: 1, commands: left },
      { fill0: 2, commands: right },
      { fill0: 1, fill1: 2, commands: between },
    ],
    end: regions(900, 1000),
  });
  return w.swf({
    width: 320,
    height: 200,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xeeeeee),
      bend,
      turn,
      split,
      square(3, 0x00aa00, 800),
      w.place({ depth: 1, character: 1, matrix: { tx: 400, ty: 400 } }),
      w.place({ depth: 2, character: 2, matrix: { tx: 2400, ty: 400 }, ratio: 32768 }),
      w.place({ depth: 3, character: 3, matrix: { tx: 4800, ty: 400 } }),
      w.place({ depth: 5, character: 4, matrix: { tx: 4600, ty: 2600 } }),
      w.showFrame(),
      w.place({ depth: 1, move: true, ratio: 16384 }),
      w.place({ depth: 2, move: true, ratio: 65535 }),
      w.place({ depth: 3, move: true, character: 1, ratio: 49152 }),
      w.place({ depth: 5, move: true, ratio: 32768 }),
      w.showFrame(),
      w.place({ depth: 1, move: true, character: 3 }),
      w.place({ depth: 2, move: true, character: 1 }),
      w.place({ depth: 3, move: true, ratio: 65535 }),
      w.place({ depth: 5, move: true, ratio: 65535 }),
      w.showFrame(),
      w.remove(1),
      w.place({ depth: 1, character: 3, matrix: { tx: 400, ty: 2200 } }),
      w.place({ depth: 4, character: 1, matrix: { tx: 2400, ty: 2200 }, ratio: 40000 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A pale band in overlay drifting a quarter pixel each way a frame over a
// checkerboard, once on the root and once inside a clip drawn as a layer,
// whose blend reads the layer's pixels: what shows through the band must
// stay where it is, at a zoom whose resolution is no whole number.
function blendDrift(): Uint8Array {
  const frames = 8;
  const rect = (x: number, y: number, width: number, height: number): w.PathCommand[] => [
    { move: [x, y] },
    { line: [x + width, y] },
    { line: [x + width, y + height] },
    { line: [x, y + height] },
    { line: [x, y] },
  ];
  const cells: w.PathCommand[][] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = row % 2; col < 10; col += 2) {
      cells.push(rect(col * 80, row * 80, 80, 80));
    }
  }

  const dark = w.shape({
    id: 1,
    bounds: [0, 800, 0, 640],
    fills: [0x101820],
    paths: [{ fill1: 1, commands: rect(0, 0, 800, 640) }],
  });
  const checker = w.shape({
    id: 2,
    bounds: [0, 800, 0, 640],
    fills: [0xf0e8d0],
    paths: cells.map((commands) => ({ fill1: 1, commands })),
  });
  const band = w.shape({
    id: 3,
    version: 3,
    bounds: [0, 300, 0, 500],
    fills: [0xc0ffffff],
    paths: [{ fill1: 1, commands: rect(0, 0, 300, 500) }],
  });
  const ground = (x: number, y: number) => [
    w.place({ depth: 1, character: 1, matrix: { tx: x, ty: y } }),
    w.place({ depth: 2, character: 2, matrix: { tx: x, ty: y } }),
  ];
  const drift = (f: number, x: number, y: number) =>
    w.place({
      depth: 3,
      character: f === 0 ? 4 : undefined,
      move: f > 0,
      matrix: { tx: x + 5 * f, ty: y + 5 * f },
      blendMode: f === 0 ? 13 : undefined,
    });
  const layered: Uint8Array[] = [...ground(0, 0)];
  const root: Uint8Array[] = [
    ...ground(1000, 100),
    w.place({ depth: 4, character: 5, matrix: { tx: 100, ty: 100 }, blendMode: 2 }),
  ];
  for (let f = 0; f < frames; f++) {
    layered.push(drift(f, 160, 40), w.showFrame());
    root.push(drift(f, 1160, 140), w.showFrame());
  }

  return w.swf({
    width: 100,
    height: 50,
    frameCount: frames,
    tags: [
      w.backgroundColor(0xeeeeee),
      dark,
      checker,
      band,
      w.sprite(4, 1, [w.place({ depth: 1, character: 3 }), w.showFrame(), w.end()]),
      w.sprite(5, frames, [...layered, w.end()]),
      ...root,
      w.end(),
    ],
  });
}

/**
 * Shapes the transform table draws in runs (render/table.ts), and what ends
 * a run or draws in the middle of one: added and multiplied shapes, drawn
 * as layers; a layer, a run, then a layer whose first content is a layer of
 * a shape, as a host's render passes may leave another texture unit active
 * as the table uploads; squares filled alone under multiply and screen, which split a run
 * by its blend mode; a gradient, a blurred shape, a mask over two shapes, a
 * shape whose lines are stroked anew each frame as it turns stretched, a
 * depth whose character is replaced each frame, a row of small shapes,
 * moving down, whose run is too long to pass its rows in uniforms, and
 * after a layer a short run whose rows follow the long one's.
 */
function tableRuns(): Uint8Array {
  const outlined = (id: number, color: number, sides: number) => {
    const point = (k: number): [number, number] => [
      Math.round(400 * Math.cos((2 * Math.PI * k) / sides)),
      Math.round(300 * Math.sin((2 * Math.PI * k) / sides)),
    ];
    const commands: w.PathCommand[] = [{ move: point(0) }];
    for (let k = 1; k <= sides; k++) {
      commands.push({ line: point(k) });
    }

    return w.shape({
      id,
      bounds: [-440, 440, -340, 340],
      fills: [color],
      lines: [{ width: 40, color: 0x101010 }],
      paths: [{ fill1: 1, line: 1, commands }],
    });
  };
  const gradient = w.shape({
    id: 3,
    bounds: [0, 800, 0, 600],
    fills: [
      {
        type: 0x10,
        matrix: { a: 800 / 32768, d: 600 / 32768, tx: 400, ty: 300 },
        stops: [
          [0, 0xffffcc00],
          [255, 0xff0060c0],
        ],
      },
    ],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [800, 0] },
          { line: [800, 600] },
          { line: [0, 600] },
          { line: [0, 0] },
        ],
      },
    ],
    version: 3,
  });
  const at = (x: number, y: number) => ({ tx: x * 20, ty: y * 20 });
  const turned = (frame: number) => {
    const a = 0.5 * frame;
    return {
      a: 1.6 * Math.cos(a),
      b: 1.6 * Math.sin(a),
      c: -0.6 * Math.sin(a),
      d: 0.6 * Math.cos(a),
      ...at(200, 90),
    };
  };
  const swapped = (frame: number) => [1, 2, 4][frame % 3];
  const tags: Uint8Array[] = [
    w.fileAttributes(true),
    w.backgroundColor(0xffffff),
    outlined(1, 0xe04030, 4),
    outlined(2, 0x30b050, 6),
    gradient,
    square(4, 0x3050e0, 700),
    square(5, 0xe0a020, 500),
    w.sprite(6, 1, [w.place({ depth: 1, character: 2, blendMode: 8 }), w.showFrame(), w.end()]),
    w.place({ depth: 1, character: 1, matrix: at(25, 25) }),
    w.place({ depth: 2, character: 2, matrix: at(45, 35), blendMode: 8 }),
    w.place({ depth: 3, character: 4, matrix: at(55, 15) }),
    w.place({ depth: 4, character: 1, matrix: at(68, 42), blendMode: 8 }),
    w.place({ depth: 5, character: 3, matrix: at(80, 15) }),
    w.place({ depth: 6, character: 1, matrix: at(110, 35), blurs: [4] }),
    w.place({ depth: 7, character: 2, matrix: at(135, 25) }),
    w.place({ depth: 8, character: 4, matrix: { a: 1.5, d: 1.5, ...at(150, 10) }, clipDepth: 10 }),
    w.place({ depth: 9, character: 1, matrix: at(160, 25) }),
    w.place({ depth: 10, character: 2, matrix: at(185, 40) }),
    w.place({ depth: 11, character: 1, matrix: turned(1) }),
    w.place({ depth: 12, character: 2, matrix: at(25, 95), blendMode: 3 }),
    w.place({ depth: 13, character: 4, matrix: at(35, 90) }),
    w.place({ depth: 14, character: 6, matrix: at(55, 100), blendMode: 8 }),
    w.place({ depth: 15, character: 5, matrix: at(75, 95), blendMode: 3 }),
    w.place({ depth: 16, character: 5, matrix: at(85, 102), blendMode: 4 }),
    w.place({ depth: 17, character: 4, matrix: at(100, 105) }),
    w.place({ depth: 18, character: swapped(1), matrix: at(130, 95) }),
  ];
  const small = (k: number, frame: number) => ({
    a: 0.2,
    d: 0.2,
    ...at(5 + 8.8 * k, 132 + 4 * frame),
  });
  for (let k = 0; k < 27; k++) {
    tags.push(w.place({ depth: 19 + k, character: 1 + (k % 2), matrix: small(k, 1) }));
  }

  // After the long run, a layer, then a short run whose rows lie past the long run's.
  const third = (x: number) => ({ a: 0.4, d: 0.4, ...at(x, 118) });
  tags.push(
    w.place({ depth: 46, character: 2, matrix: third(145), blendMode: 8 }),
    w.place({ depth: 47, character: 1, matrix: third(163) }),
    w.place({ depth: 48, character: 2, matrix: third(181) }),
    w.showFrame(),
  );
  for (let frame = 2; frame <= 3; frame++) {
    tags.push(
      w.place({ depth: 1, move: true, matrix: at(25 + 6 * frame, 25) }),
      w.place({ depth: 11, move: true, matrix: turned(frame) }),
      w.remove(18),
      w.place({ depth: 18, character: swapped(frame), matrix: at(130, 95) }),
    );
    for (let k = 0; k < 27; k++) {
      tags.push(w.place({ depth: 19 + k, move: true, matrix: small(k, frame) }));
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: 240, height: 160, frameRate: 24, frameCount: 3, tags });
}

const moved = { frames: 2, capture: [1, 2], tolerance: 32, maxOutliers: 500 };

// A rounded panel 100 by 60 with a line, for the `scale9` case: its corners
// are curves, which 9-slice scaling keeps as they are.
const roundedPanel = (id: number) =>
  w.shape({
    id,
    bounds: [-20, 2020, -20, 1220],
    fills: [0xb0b8c8, 0xe0a020],
    lines: [{ width: 40, color: 0x202020 }],
    paths: [
      {
        fill1: 1,
        line: 1,
        commands: [
          { move: [320, 0] },
          { line: [1680, 0] },
          { curve: [2000, 0, 2000, 320] },
          { line: [2000, 880] },
          { curve: [2000, 1200, 1680, 1200] },
          { line: [320, 1200] },
          { curve: [0, 1200, 0, 880] },
          { line: [0, 320] },
          { curve: [0, 0, 320, 0] },
        ],
      },
      {
        fill1: 2,
        commands: [
          { move: [100, 440] },
          { line: [260, 440] },
          { line: [260, 760] },
          { line: [100, 760] },
          { line: [100, 440] },
        ],
      },
      {
        fill1: 2,
        commands: [
          { move: [900, 440] },
          { line: [1100, 440] },
          { line: [1100, 760] },
          { line: [900, 760] },
          { line: [900, 440] },
        ],
      },
    ],
  });

// Panels with DefineScalingGrid stretched, shrunk past their corners,
// turned and flipped, which Flash does not slice, a button with a grid, a
// grid on a fill's edge, and a sprite in a panel, which scales as ever;
// scripts/Scale9.as sets grids on what it draws, and on frame 2 rescales a
// panel of each kind.
function scale9(abc: Uint8Array): Uint8Array {
  const turn = (15 * Math.PI) / 180;
  return w.swf({
    width: 560,
    height: 420,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      roundedPanel(1),
      square(2, 0x30a030, 200),
      w.sprite(12, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.sprite(10, 1, [
        w.place({ depth: 1, character: 1 }),
        w.place({ depth: 2, character: 12, matrix: { tx: 1700, ty: 900 } }),
        w.showFrame(),
        w.end(),
      ]),
      // A half pixel in: the getter cuts it to 20, the slice keeps it.
      w.scalingGrid(10, 410, 1600, 400, 800),
      w.button2(13, 1),
      w.scalingGrid(13, 400, 1600, 400, 800),
      // On the fill's left edge, inside the line's recorded bounds: sliced.
      w.sprite(14, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.scalingGrid(14, 0, 1600, 400, 800),
      w.doAbc(abc, "Scale9"),
      w.symbolClass([[0, "Scale9"]]),
      w.place({ depth: 1, character: 10, name: "wide", matrix: { a: 3, d: 2, tx: 200, ty: 200 } }),
      w.place({
        depth: 2,
        character: 10,
        name: "small",
        matrix: { a: 0.3, d: 0.5, tx: 6600, ty: 200 },
      }),
      w.place({
        depth: 3,
        character: 10,
        name: "turned",
        matrix: {
          a: 0.8 * Math.cos(turn),
          b: 0.8 * Math.sin(turn),
          c: -Math.sin(turn),
          d: Math.cos(turn),
          tx: 7600,
          ty: 800,
        },
      }),
      w.place({
        depth: 4,
        character: 13,
        name: "button",
        matrix: { a: 2, d: 1.5, tx: 200, ty: 3010 },
      }),
      w.place({
        depth: 5,
        character: 10,
        name: "flipped",
        matrix: { a: 1.5, d: -1.2, tx: 4600, ty: 4440 },
      }),
      w.place({
        depth: 6,
        character: 14,
        name: "edge",
        matrix: { a: 0.5, d: 1.5, tx: 9250, ty: 3010 },
      }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// scripts/Scale9Changes.as's root, 640 by 640, with one timeline symbol:
// a panel with a grid whose bars are a mask layer (clipDepth) over a green
// rectangle, which Flash draws unsliced.
function scale9Changes(abc: Uint8Array): Uint8Array {
  const rect = (id: number, color: number, x: number, y: number, width: number, height: number) =>
    w.shape({
      id,
      bounds: [x, x + width, y, y + height],
      fills: [color],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [x, y] },
            { line: [x + width, y] },
            { line: [x + width, y + height] },
            { line: [x, y + height] },
            { line: [x, y] },
          ],
        },
      ],
    });
  return w.swf({
    width: 640,
    height: 640,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      rect(30, 0xcccccc, 0, 0, 2000, 1200),
      w.shape({
        id: 31,
        bounds: [80, 1920, 440, 760],
        fills: [0],
        paths: [80, 1760].map((x) => ({
          fill1: 1,
          commands: [
            { move: [x, 440] },
            { line: [x + 160, 440] },
            { line: [x + 160, 760] },
            { line: [x, 760] },
            { line: [x, 440] },
          ],
        })),
      }),
      rect(32, 0x33aa33, 0, 0, 2000, 1200),
      w.sprite(33, 1, [
        w.place({ depth: 1, character: 30 }),
        w.place({ depth: 2, character: 31, clipDepth: 3 }),
        w.place({ depth: 3, character: 32 }),
        w.showFrame(),
        w.end(),
      ]),
      w.scalingGrid(33, 400, 1600, 400, 800),
      w.doAbc(abc, "Scale9Changes"),
      w.symbolClass([[0, "Scale9Changes"]]),
      w.place({ depth: 1, character: 33, name: "clipped", matrix: { a: 1.5, tx: 8400, ty: 8200 } }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// scripts/Scale9Hits.as's root, 560 by 440, with two timeline symbols: a
// panel with a grid whose bars are a MorphShape that reaches 136 at ratio
// 1, set on its second frame, and 116 at a half, on its third, which Flash
// slices by on the frame each is set; and a clip layer holding a sprite
// over a rectangle, which a script's shape test hits nothing of.
function scale9Hits(abc: Uint8Array): Uint8Array {
  const rect = (id: number, color: number, x: number, y: number, width: number, height: number) =>
    w.shape({
      id,
      bounds: [x * 20, (x + width) * 20, y * 20, (y + height) * 20],
      fills: [color],
      paths: [{ fill1: 1, commands: rectPath(x, y, width, height) }],
    });
  return w.swf({
    width: 560,
    height: 440,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      rect(40, 0x6699cc, 0, 0, 100, 60),
      w.morphShape({
        id: 41,
        startBounds: [80, 1920, 440, 760],
        endBounds: [80, 2720, 440, 760],
        fills: [{ start: 0xffcc3333, end: 0xffcc3333 }],
        start: [
          { fill0: 1, commands: rectPath(4, 22, 8, 16) },
          { fill0: 1, commands: rectPath(88, 22, 8, 16) },
        ],
        end: [rectPath(4, 22, 8, 16), rectPath(128, 22, 8, 16)],
      }),
      w.sprite(42, 4, [
        w.place({ depth: 1, character: 40 }),
        w.place({ depth: 2, character: 41, ratio: 0 }),
        w.showFrame(),
        w.place({ depth: 2, move: true, ratio: 65535 }),
        w.showFrame(),
        w.place({ depth: 2, move: true, ratio: 32768 }),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ]),
      w.scalingGrid(42, 400, 1600, 400, 800),
      rect(43, 0x3333aa, 0, 0, 260, 60),
      rect(44, 0x000000, 10, 22, 50, 16),
      w.sprite(45, 1, [w.place({ depth: 1, character: 44 }), w.showFrame(), w.end()]),
      w.sprite(46, 1, [
        w.place({ depth: 1, character: 45, name: "inner" }),
        w.showFrame(),
        w.end(),
      ]),
      w.sprite(47, 1, [
        w.place({ depth: 1, character: 46, name: "layer", clipDepth: 2 }),
        w.place({ depth: 2, character: 43, name: "under" }),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "Scale9Hits"),
      w.symbolClass([[0, "Scale9Hits"]]),
      w.place({ depth: 1, character: 42, name: "morph", matrix: { a: 2, tx: 200, ty: 7400 } }),
      w.place({ depth: 2, character: 47, name: "clips", matrix: { tx: 5800, ty: 7400 } }),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

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
  { name: "fill-holes", swf: fillHoles(), frames: 1, capture: [1], tolerance: 0, maxOutliers: 0 },
  {
    name: "shared-fill-edges",
    swf: sharedFillEdges(),
    frames: 1,
    capture: [1],
    // The aslant seams' ends anti-alias within a pixel of Flash's: some 30 pixels.
    tolerance: 32,
    maxOutliers: 60,
  },
  {
    name: "static-text",
    swf: staticTexts(),
    frames: 1,
    capture: [1],
    tolerance: 32,
    maxOutliers: 100,
  },
  {
    name: "static-text-probe",
    swf: staticTextProbe,
    script: "StaticTextProbe",
    frames: 2,
    capture: [1],
    tolerance: 32,
    maxOutliers: 20,
  },
  {
    name: "static-text-filters",
    swf: staticTextFilters,
    script: "StaticTextFilters",
    frames: 1,
    capture: [1],
    // The glyphs' edges, where the sharp shadow meets the glow, differ by
    // up to 52 a channel along some 120 pixels: the page's four samples a
    // pixel against adl's whole pixels, as for `filters`.
    tolerance: 32,
    maxOutliers: 200,
  },
  {
    name: "morph-shapes",
    swf: morphs(),
    frames: 6,
    capture: [1, 2, 3, 4, 5, 6],
    // The thick curved lines anti-alias within a pixel of Flash's, as for
    // `shared-lines`, the end shape's too: some 570 pixels in frame 4.
    tolerance: 32,
    maxOutliers: 800,
  },
  {
    name: "shared-colors",
    swf: sharedColors,
    script: "SharedColors",
    frames: 3,
    capture: [1, 2, 3],
    tolerance: 32,
    maxOutliers: 60,
  },
  {
    name: "table-runs",
    swf: tableRuns(),
    frames: 3,
    capture: [1, 2, 3],
    // The outlines' anti-aliased edges, each rasteriser's own, along the diagonals
    // and around the small shapes.
    tolerance: 32,
    maxOutliers: 1000,
    table: true,
  },
  {
    name: "scale9",
    swf: scale9,
    script: "Scale9",
    frames: 2,
    capture: [1, 2],
    // The rounded outlines anti-alias within a pixel of Flash's, which snaps
    // their straight runs to whole pixels, on the panels Flash does not
    // slice as on those it does: some 1,080 channels. A bar a pixel off
    // would add about 96.
    tolerance: 32,
    maxOutliers: 1150,
  },
  {
    name: "scale9-changes",
    swf: scale9Changes,
    script: "Scale9Changes",
    frames: 2,
    capture: [1, 2],
    // The curves' edges anti-alias within a pixel of Flash's: some 160
    // channels, most along the quadratic. A bar a pixel off would add about 96.
    tolerance: 32,
    maxOutliers: 200,
  },
  {
    name: "scale9-hits",
    swf: scale9Hits,
    script: "Scale9Hits",
    frames: 4,
    capture: [1, 2, 3, 4],
    // The edge of a Shape sliced to a third of a pixel rounds a channel apart from Flash's.
    tolerance: 1,
    maxOutliers: 0,
  },
  {
    name: "render-groups",
    swf: (abc) => bare(abc, 5, "RenderGroups", 240, 96),
    script: "RenderGroups",
    frames: 5,
    capture: [1, 2, 3, 4, 5],
    tolerance: 3,
    maxOutliers: 0,
  },
  {
    name: "field-position",
    swf: fieldPosition,
    script: "FieldPosition",
    frames: 1,
    // Its trace alone: the field's device font draws as the browser's does.
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
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
    name: "button-first-frame",
    swf: buttonFirstFrame,
    script: "ButtonFirstFrame",
    frames: 6,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "button-frame-order",
    swf: buttonFrameOrder,
    script: "ButtonFrameOrder",
    // Flash's harness counts the buttons' early EXIT_FRAMEs as frames.
    frames: 20,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "goto-place-first",
    swf: gotoPlaceFirst,
    script: "GotoPlaceFirst",
    frames: 6,
    capture: [],
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
    name: "goto-children",
    swf: gotoChildren,
    script: "GotoChildren",
    frames: 10,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "instance-names",
    swf: instanceNames,
    script: "InstanceNames",
    frames: 6,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "same-depth",
    swf: sameDepth,
    script: "SameDepth",
    frames: 12,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "goto-cycle",
    swf: gotoCycle,
    script: "GotoCycle",
    frames: 6,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "goto-cycle-nested",
    swf: gotoCycleNested,
    script: "GotoCycleNested",
    frames: 4,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "goto-stops",
    swf: gotoStops,
    script: "GotoStops",
    frames: 24,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "scripted-moves",
    swf: scriptedMoves,
    script: "ScriptedMoves",
    frames: 9,
    capture: [3, 4],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "rewind-first",
    swf: rewindFirst,
    script: "RewindFirst",
    frames: 7,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "rewind-ratio",
    swf: rewindRatio,
    script: "RewindRatio",
    frames: 5,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "rewind-shape-clip",
    swf: rewindShapeClip,
    script: "RewindShapeClip",
    frames: 5,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "rewind-kinds",
    swf: rewindKinds,
    script: "RewindKinds",
    frames: 5,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "loop-ratio",
    swf: loopRatio,
    script: "LoopRatio",
    frames: 9,
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
    name: "font-natives",
    build: fontNatives,
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "text-field-queries",
    build: textFieldQueries,
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "font-description-natives",
    swf: (abc) => bare(abc, 1, "FontDescriptionNatives"),
    script: "FontDescriptionNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "tab-stop-natives",
    swf: (abc) => bare(abc, 1, "TabStopNatives"),
    script: "TabStopNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "accessibility-natives",
    swf: (abc) => bare(abc, 1, "AccessibilityNatives"),
    script: "AccessibilityNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "currency-parse-result-natives",
    swf: (abc) => bare(abc, 1, "CurrencyParseResultNatives"),
    script: "CurrencyParseResultNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "number-parse-result-natives",
    swf: (abc) => bare(abc, 1, "NumberParseResultNatives"),
    script: "NumberParseResultNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sprite-drag-natives",
    swf: (abc) => bare(abc, 1, "SpriteDragNatives"),
    script: "SpriteDragNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "crypto-random",
    swf: (abc) => bare(abc, 1, "CryptoRandom"),
    script: "CryptoRandom",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "security-domain",
    swf: (abc) => bare(abc, 1, "SecurityDomainNatives"),
    script: "SecurityDomainNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "mouse-visibility",
    swf: (abc) => bare(abc, 1, "MouseVisibility"),
    script: "MouseVisibility",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "mouse-cursor",
    swf: (abc) => bare(abc, 1, "MouseCursorNatives"),
    script: "MouseCursorNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sprite-sound",
    swf: (abc) => bare(abc, 1, "SpriteSound"),
    script: "SpriteSound",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "font-registration",
    build: fontRegistration,
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-symbols",
    build: soundSymbols,
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-loops",
    build: toneScript("SoundLoops"),
    frames: 50,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-mixer",
    build: toneScript("MixerState"),
    frames: 50,
    capture: [],
    tolerance: 0,
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
    name: "text-indent",
    swf: textIndent,
    script: "TextIndent",
    frames: 1,
    capture: [1],
    // Exact but for each border's bottom right corner, part grey in Flash: 6 channels.
    tolerance: 0,
    maxOutliers: 6,
  },
  {
    name: "text-final-newline",
    swf: textFinalNewline,
    script: "TextFinalNewline",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "glyph-contours",
    swf: (abc) =>
      w.swf({
        width: 200,
        height: 100,
        frameRate: 24,
        frameCount: 1,
        tags: [
          w.fileAttributes(true),
          w.backgroundColor(0xffffff),
          pixelFont(1),
          w.doAbc(abc, "GlyphContours"),
          w.symbolClass([[0, "GlyphContours"]]),
          w.showFrame(),
          w.end(),
        ],
      }),
    script: "GlyphContours",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
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
    name: "blend-drift",
    swf: blendDrift(),
    frames: 8,
    capture: [1, 2, 3, 4, 5, 6, 7, 8],
    // A resolution of 6, where Pixi's arithmetic lands a hair off whole pixels.
    zoom: 1.5,
    // Within 3 a channel, the layer's 8-bit round trip, as for `blend-modes`.
    tolerance: 3,
    maxOutliers: 0,
  },
  {
    name: "blend-direct",
    swf: (abc) => bare(abc, 1, "BlendDirect", 240, 80),
    script: "BlendDirect",
    frames: 4,
    capture: [1, 2, 3, 4],
    tolerance: 1,
    maxOutliers: 0,
  },
  {
    name: "blend-edges",
    swf: (abc) => bare(abc, 1, "BlendEdges", 200, 150),
    script: "BlendEdges",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "blend-antialias",
    swf: (abc) => bare(abc, 1, "BlendAntialias", 240, 160),
    script: "BlendAntialias",
    frames: 1,
    capture: [1],
    // Multisampled, as most hosts draw: blends and filters then read their
    // backdrops through the bounded resolves of render/resolve.ts, which no
    // other case runs. Within 3 a channel, as drawn without multisampling:
    // the blends' 8-bit round trips and adl's rounding of the blurs.
    antialias: true,
    tolerance: 3,
    maxOutliers: 0,
  },
  {
    name: "blend-nested",
    swf: (abc) => bare(abc, 1, "BlendNested", 240, 120),
    script: "BlendNested",
    frames: 1,
    capture: [1],
    // Within 8 a channel: adl's 8-bit rounding of the blurred edges, their
    // offset colour and the sums, the ground under a layer one darker where
    // the glow's tail is all but clear. A glow cut at its shapes' edges, as
    // the layer's region was, parted by up to 111.
    tolerance: 8,
    maxOutliers: 0,
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
    name: "line-close",
    swf: (abc) => bare(abc, 1, "LineClose", 800, 500),
    script: "LineClose",
    frames: 1,
    capture: [1],
    // The diagonals anti-alias within a pixel of Flash's, as one closed by
    // its own lineTo does, and where a half-transparent path meets itself
    // the page darkens it: some 5,700 channels. No closing lines would make
    // it 26,000.
    tolerance: 32,
    maxOutliers: 5800,
  },
  {
    name: "line-close-probes",
    swf: (abc) => bare(abc, 1, "LineCloseProbes", 800, 300),
    script: "LineCloseProbes",
    frames: 1,
    // Its trace alone: adl fills drawPath's unclosed contours in bands to the
    // shape's edge, which the page does not draw.
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "line-order",
    swf: (abc) => bare(abc, 1, "LineOrder", 400, 300),
    script: "LineOrder",
    frames: 1,
    capture: [1],
    // The squares' corners and the lines' ends anti-alias within a pixel of
    // Flash's: some 250 channels. Lines under their fills would add 3,800.
    tolerance: 32,
    maxOutliers: 300,
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
    name: "filter-retween",
    swf: filterRetween,
    script: "FilterRetween",
    frames: 4,
    capture: [1, 2, 3, 4],
    // The blurs' corners, one apart from adl's on the last frame.
    tolerance: 1,
    maxOutliers: 0,
  },
  {
    name: "blurred-shadow",
    swf: blurredShadow(),
    frames: 1,
    capture: [1],
    // A host showing the stage nearly three times its size, where the
    // blur's padding shrank but not its reach across the stage.
    zoom: 2.8,
    // The page's samples against adl's whole pixels, within 5 a channel.
    tolerance: 5,
    maxOutliers: 0,
  },
  {
    name: "zoomed-filters",
    swf: zoomedFilters(1),
    frames: 1,
    capture: [1],
    zoom: 2.8,
    shown: true,
    flash: zoomedFilters(2.8),
    // The glows' outer edges, a few levels lighter in Flash.
    tolerance: 8,
    maxOutliers: 0,
  },
  {
    name: "filter-cache",
    swf: (abc) => bare(abc, 7, "FilterCache", 380, 100),
    script: "FilterCache",
    frames: 7,
    capture: [1, 2, 3, 4, 5, 6, 7],
    // As "filters": the page's samples against adl's whole pixels, here
    // along the turned square's blurred edges, up to 12 a channel.
    tolerance: 8,
    maxOutliers: 60,
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
    table: true,
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
    name: "sprite-frames",
    swf: spriteFrames,
    script: "SpriteFrames",
    frames: 3,
    capture: [3],
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
  {
    name: "fresh-clips",
    build: freshClips,
    frames: 5,
    capture: [2, 3],
    tolerance: 0,
    maxOutliers: 0,
  },
  // The unload at INIT follows frame 2's capture (see the harness): frame 3 shows it.
  { name: "loads-init", build: loadsInit, frames: 3, capture: [3], tolerance: 0, maxOutliers: 0 },
  {
    name: "loader-parameters",
    build: loaderParameters,
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
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
    name: "shared-objects",
    swf: bare,
    script: "SharedObjects",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "stage-children",
    swf: bare,
    script: "StageChildren",
    frames: 4,
    capture: [1, 2, 3, 4],
    tolerance: 0,
    maxOutliers: 0,
    alone: true,
  },
  {
    name: "stage-hits",
    swf: (abc) => bare(abc, 2, "StageHits", 100, 50),
    script: "StageHits",
    frames: 2,
    capture: [2],
    tolerance: 0,
    maxOutliers: 0,
    alone: true,
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
    name: "loaded-font",
    build: loadedFont,
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Frame 1 is drawn at the outer SWF's INIT, before the AVM1 movies come at
  // that frame's end; the player draws the frame whole, with them.
  {
    name: "avm1-movie",
    build: avm1Movie,
    frames: 6,
    capture: [2, 3, 4, 5, 6],
    tolerance: 0,
    maxOutliers: 0,
  },
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
  {
    name: "three-d",
    swf: (abc) => bare(abc, 1, "ThreeD"),
    script: "ThreeD",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "point-at",
    swf: (abc) => bare(abc, 1, "PointAt"),
    script: "PointAt",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "matrix3d-swf12",
    swf: (abc) => withVersion(bare(abc, 1, "Matrix3DVersions"), 12),
    script: "Matrix3DVersions",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "matrix3d-swf13",
    swf: (abc) => withVersion(bare(abc, 1, "Matrix3DVersions"), 13),
    script: "Matrix3DVersions",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "text-natives",
    swf: (abc) => bare(abc, 1, "TextNatives"),
    script: "TextNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "legacy-xml",
    swf: (abc) => bare(abc, 1, "LegacyXml"),
    script: "LegacyXml",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "palette-compare",
    swf: (abc) => bare(abc, 1, "PaletteCompare"),
    script: "PaletteCompare",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "perlin-noise",
    swf: (abc) => bare(abc, 1, "PerlinNoise"),
    script: "PerlinNoise",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "system-natives",
    swf: (abc) => bare(abc, 2, "SystemNatives"),
    script: "SystemNatives",
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "timeline-sounds",
    build: timelineSounds,
    frames: 33,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
];

/** The SWF with its header's version set to `version`. */
function withVersion(swf: Uint8Array, version: number): Uint8Array {
  swf[3] = version;
  return swf;
}

/**
 * Timeline sounds (scripts/TimelineSounds.as): Tone, a second of silence
 * at 5.5 kHz bound to a class, started from the root's frames 2 to 5 with
 * each sync; the child "streamer", eight frames of a stream of silence, a
 * block on each.
 */
function timelineSounds(compile: Compile): Uint8Array {
  const block = 230;
  const streamer: Uint8Array[] = [w.soundStreamHead({ rate: 0, samplesPerBlock: block })];
  for (let f = 0; f < 8; f++) {
    streamer.push(w.soundStreamBlock(new Uint8Array(block).fill(128)), w.showFrame());
  }

  const root: Uint8Array[][] = Array.from({ length: 40 }, () => []);
  root[0].push(w.place({ depth: 1, character: 10, name: "streamer" }));
  root[1].push(w.startSound(1, { noMultiple: true }));
  root[2].push(w.startSound(1, { stop: true }));
  root[4].push(w.startSound(1, { loops: 2, inPoint: 4410, outPoint: 22050 }));
  return w.swf({
    width: 20,
    height: 20,
    frameRate: 24,
    frameCount: root.length,
    tags: [
      w.fileAttributes(true),
      w.defineSound(1, { rate: 0, samples: 5512 }, new Uint8Array(5512).fill(128)),
      w.sprite(10, 8, [...streamer, w.end()]),
      w.doAbc(
        compile("Tone", "package { import flash.media.Sound; public class Tone extends Sound {} }"),
        "Tone",
      ),
      w.doAbc(compile("TimelineSounds"), "TimelineSounds"),
      w.symbolClass([
        [0, "TimelineSounds"],
        [1, "Tone"],
      ]),
      ...root.flatMap((frame) => [...frame, w.showFrame()]),
      w.end(),
    ],
  });
}
