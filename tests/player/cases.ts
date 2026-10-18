// The player's test cases: SWFs built here, played for a few frames, whose
// frames must look as Flash drew them. Flash's frames are in references/,
// made by run.ts --update with the Flash oracle.
import { readFileSync } from "node:fs";
import { tags, zlibCompress } from "../../packages/format/dist/index.js";
import {
  Avm1Assembler,
  byteString,
  constant,
  double,
  FunctionFlag,
  type PushValue,
  register,
  type SimpleAction,
  TryFlag,
} from "../avm1-assembler.ts";
import { flashAssembler, script } from "../avm1-script.ts";
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
  /**
   * What Flash draws for the references in place of the case's SWF, or how
   * to build it around the compiled script.
   */
  flash?: Uint8Array | ((abc: Uint8Array) => Uint8Array);
  /** Played as a host whose renderer is made with `antialias: true` draws it, multisampled; Flash draws it as ever. */
  antialias?: boolean;
  /** An AVM1 SWF whose trace must match Flash's. */
  traced?: boolean;
  /**
   * The transform table (render/table.ts) must draw some of it, and played
   * again without the table it must draw the same pixels.
   */
  table?: boolean;
  /**
   * A known gap: what Flash does that the player does not yet. The case is
   * left out of the default run and runs, expected to fail, when named.
   */
  gap?: string;
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

// Outlined parts turning inside parents squashed to 0.9 and 0.6 of their
// height, as a game's limbs inside a squashed body: through a stretch that
// turns with each, or, nearly even, through one even stretch (strokes.ts,
// settledStretch), lines of 1, 2 and 4 pixels as wide as Flash draws them.
function squashedTurns(): Uint8Array {
  const part = (id: number, width: number) =>
    w.shape({
      id,
      bounds: [-1020 - width, 1020 + width, -820 - width, 820 + width],
      fills: [0xcc3300],
      lines: [{ width, color: 0x000080 }],
      paths: [
        {
          fill1: 1,
          line: 1,
          commands: [
            { move: [-1000, -800] },
            { line: [1000, -800] },
            { curve: [1400, 0, 1000, 800] },
            { line: [-1000, 800] },
            { line: [-1000, -800] },
          ],
        },
      ],
    });
  const angles = [0.3, 1.1, 2.5];
  const turning = (id: number, character: number) =>
    w.sprite(id, angles.length, [
      ...angles.flatMap((angle, f) => {
        const matrix = {
          a: 0.6 * Math.cos(angle),
          b: 0.6 * Math.sin(angle),
          c: -0.6 * Math.sin(angle),
          d: 0.6 * Math.cos(angle),
          tx: 0,
          ty: 0,
        };
        return [
          f === 0
            ? w.place({ depth: 1, character, matrix })
            : w.place({ depth: 1, move: true, matrix }),
          w.showFrame(),
        ];
      }),
      w.end(),
    ]);
  const placed = [
    [11, 0.9],
    [12, 0.9],
    [13, 0.9],
    [13, 0.6],
  ] as const;
  return w.swf({
    width: 480,
    height: 160,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      part(1, 20),
      part(2, 40),
      part(3, 80),
      turning(11, 1),
      turning(12, 2),
      turning(13, 3),
      ...placed.map(([character, squash], i) =>
        w.place({
          depth: i + 1,
          character,
          matrix: { a: 1, d: squash, tx: 1200 + i * 2400, ty: 1600 },
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

// A row of Boxes the timeline places on frame 1 and partly removes on
// frame 2, under the rows scripts/RemoveReentry.as adds and removes from
// the display list's events.
function removeReentry(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 100,
    height: 170,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000, 200),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "RemoveReentry"),
      w.symbolClass([
        [0, "Main"],
        [2, "Box"],
      ]),
      ...[0, 1, 2].map((i) =>
        w.place({ depth: i + 1, character: 2, name: `p${i}`, matrix: { tx: 240 * i, ty: 3000 } }),
      ),
      w.showFrame(),
      w.remove(1),
      w.remove(2),
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

// ApplicationDomain.currentDomain is the domain of the code that asks
// (scripts/CurrentDomain.as.template): the main SWF's, before and after
// it loads a SWF into a child domain, and the loaded SWF's in its own
// code (scripts/CurrentDomainChild.as), whose second DoABC defines a class
// only it sees. The domain is found from the script each frame of the
// stack names, which JavaScriptCore gives no Function's code.
function currentDomain(compile: Compile): Uint8Array {
  const inner = w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.doAbc(compile("CurrentDomainOnly"), "CurrentDomainOnly"),
      w.doAbc(compile("CurrentDomainChild"), "CurrentDomainChild"),
      w.symbolClass([[0, "CurrentDomainChild"]]),
      w.showFrame(),
      w.end(),
    ],
  });
  const template = readFileSync(
    new URL("scripts/CurrentDomain.as.template", import.meta.url),
    "utf8",
  );
  const abc = compile(
    "CurrentDomain",
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.doAbc(abc, "CurrentDomain"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
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

/** An AVM1 block of what `write` assembles, and End. */
const avm1 = (write: (a: Avm1Assembler) => Avm1Assembler): number[] => [
  ...write(new Avm1Assembler()).end().bytes(),
];

/** Values as AVM1 traces them, in adl: a number to 15 digits, with Flash's own exponents. */
const AVM1_VALUES = [
  undefined,
  null,
  true,
  false,
  7,
  double(-0),
  double(Number.NaN),
  double(Number.POSITIVE_INFINITY),
  double(Number.NEGATIVE_INFINITY),
  1e21,
  0.1,
  1.5,
  -990.123,
  1e-7,
  1e15,
  1e-5,
  123456789012345680000,
  0.8000000000000005,
  9.999999999999998,
  -9999999999999996,
  -0.000009999999999999996,
];

// An AVM1 SWF of version 6 (player/src/avm1/avm1.ts): frame 1's DoAction
// blocks share the operand stack and the constant pool, its DoInitAction
// runs before them though its tag comes after, and values trace as AVM1
// writes them; frame 2 finds the stack empty, traces and stops, so
// frame 1's actions never run again.
function avm1Hello(): Uint8Array {
  return w.swf({
    version: 6,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.backgroundColor(0xffffff),
      w.sprite(1, 1, [w.showFrame(), w.end()]),
      w.doAction(avm1((a) => a.push("left on the stack"))),
      w.doAction(avm1((a) => a.push("frame 1").trace().trace())),
      w.doAction(avm1((a) => a.constantPool("pooled"))),
      w.doAction(avm1((a) => a.push(constant(0)).trace())),
      w.doAction(avm1((a) => AVM1_VALUES.reduce((b, v) => b.push(v).trace(), a))),
      w.doInitAction(
        1,
        avm1((a) => a.push("init").trace()),
      ),
      w.showFrame(),
      w.doAction(avm1((a) => a.trace().push("frame 2").trace().stop())),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** Every pair of `values`, each pushed in turn, but NaN with NaN (see `avm1Operators`). */
function pairs(left: PushValue[], right: PushValue[] = left): [PushValue, PushValue][] {
  const nan = (v: PushValue) =>
    typeof v === "object" && v !== null && "value" in v && Number.isNaN(v.value);
  return left.flatMap((a) =>
    right.flatMap((b): [PushValue, PushValue][] => (nan(a) && nan(b) ? [] : [[a, b]])),
  );
}

/** A DoAction that traces `action` of each of `operands`, pushed in order. */
function traceEach(action: SimpleAction, operands: PushValue[][]): Uint8Array {
  return w.doAction(
    avm1((a) =>
      operands.reduce(
        (b, values) =>
          b
            .push(...values)
            .op(action)
            .trace(),
        a,
      ),
    ),
  );
}

const NAN = double(Number.NaN);
const INFINITY = double(Number.POSITIVE_INFINITY);

/** Values to convert, as SWF 4 to 10 read strings, numbers and their edges. */
const AVM1_CONVERTED: PushValue[] = [
  undefined,
  null,
  true,
  false,
  0,
  double(-0),
  1,
  double(-2.5),
  NAN,
  INFINITY,
  double(2147483648),
  double(4294967295),
  double(1e21),
  "",
  " 12",
  "12 ",
  "0x1A",
  "-0x10",
  "012",
  "1e3",
  ".",
  "abc",
  "\t5",
  "é",
  "😀",
  byteString(0xc3, 0xa9),
  byteString(0x80),
];

// What AVM1's arithmetic, comparison, logical, bitwise, string and
// conversion actions push in a SWF of `version`, as adl traces them: the
// conversions of each version (undefined and strings as numbers, hex from
// SWF 6, booleans as 1 and 0 up to 4), SWF 4's "#ERROR#" for a division by
// zero, Less2's undefined for NaN and its empty string after every other,
// >>> signed in SWF 8 and 9, and up to SWF 5 strings as bytes, which the
// log writes as UTF-8. A NaN is never compared with another: Flash has
// one equal to a copy of itself and not to another, which values cannot
// tell (docs/avm1.md).
function avm1Operators(version: number): Uint8Array {
  const arithmetic: PushValue[] = [
    undefined,
    null,
    true,
    0,
    double(-0),
    double(2.5),
    NAN,
    INFINITY,
    "",
    "2",
    "abc",
    "0x10",
  ];
  const divisors: PushValue[] = [undefined, true, 0, double(-0), 2, "3", "abc", "0x10"];
  const compared: PushValue[] = [undefined, null, true, 0, 1, NAN, "", "1", "abc", "0x1"];
  const strings: PushValue[] = ["", "a", "B", "ab", "é", "中", byteString(0x80)];
  const codes = [0, 65, 233, 256, 321, 1000, 0xc3a9, 0xd800, 65535, 65601, -191];
  const shifted: [PushValue, PushValue][] = [
    [-1, 0],
    [-1, 1],
    [-1, 31],
    [-1, 32],
    [-1, 33],
    [double(2147483648), 0],
    [double(4294967295), 1],
    [double(1e21), 0],
    [double(1.9), 1],
    [double(-1.9), 1],
    [NAN, 1],
    [INFINITY, 1],
    ["0x80000000", 1],
    [5, -1],
    [1, 31],
  ];
  const extracted: [PushValue, PushValue][] = [
    [0, 2],
    [1, 2],
    [2, 2],
    [-1, -1],
    [2, -1],
    [6, 10],
    [7, 1],
    [double(2.7), double(1.5)],
    ["3", NAN],
    [undefined, undefined],
    [double(-2147483648), 2],
  ];
  const unary = (action: SimpleAction, values: PushValue[]) =>
    traceEach(
      action,
      values.map((v) => [v]),
    );
  const binary = (action: SimpleAction, operands: [PushValue, PushValue][]) =>
    traceEach(action, operands);

  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 1,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      ...(
        ["ToNumber", "ToString", "ToInteger", "Not", "Increment", "Decrement", "TypeOf"] as const
      ).map((action) => unary(action, AVM1_CONVERTED)),
      ...(["StringLength", "MBStringLength", "CharToAscii", "MBCharToAscii"] as const).map(
        (action) => unary(action, [...strings, 7, true, undefined]),
      ),
      ...(["AsciiToChar", "MBAsciiToChar"] as const).map((action) => unary(action, codes)),
      w.doAction(
        avm1((a) =>
          codes.reduce((b, c) => b.push(c).op("MBAsciiToChar").op("StringLength").trace(), a),
        ),
      ),
      ...(["Add", "Add2", "Subtract", "Multiply", "Divide", "Modulo"] as const).map((action) =>
        binary(action, pairs(arithmetic, divisors)),
      ),
      ...(
        ["Equals", "Equals2", "StrictEquals", "Less", "Less2", "Greater", "And", "Or"] as const
      ).map((action) => binary(action, pairs(compared))),
      // Whether a comparison pushes a boolean, even in SWF 4.
      w.doAction(
        avm1((a) =>
          (["Equals", "Less", "And", "StringEquals"] as const)
            .reduce((b, action) => b.push(1, 1).op(action).op("TypeOf").trace(), a)
            .push(1)
            .op("Not")
            .op("TypeOf")
            .trace(),
        ),
      ),
      ...(["StringAdd", "StringEquals", "StringLess", "StringGreater", "Less2"] as const).map(
        (action) => binary(action, pairs(strings)),
      ),
      ...(["BitAnd", "BitOr", "BitXor", "BitLShift", "BitRShift", "BitURShift"] as const).map(
        (action) => binary(action, shifted),
      ),
      ...(["StringExtract", "MBStringExtract"] as const).map((action) =>
        traceEach(
          action,
          ["abcdef", byteString(0xc3, 0xa9, 0x41)].flatMap((text) =>
            extracted.map(([index, count]) => [text, index, count]),
          ),
        ),
      ),
      // Each half of a surrogate pair StringExtract cuts is U+FFFD from SWF 6,
      // when compared or joined: the halves joined again are not the pair.
      w.doAction(
        avm1((a) =>
          a
            .push("a😀b", 2, 1)
            .op("StringExtract")
            .push("a😀b", 3, 1)
            .op("StringExtract")
            .op("StringAdd")
            .op("PushDuplicate")
            .trace()
            .push("😀")
            .op("StringEquals")
            .trace()
            .push("a😀b", 3, 1)
            .op("MBStringExtract")
            .push(0xfffd)
            .op("AsciiToChar")
            .op("StringEquals")
            .trace()
            .push("😀😀", 2, 2)
            .op("StringExtract")
            .push("c")
            .op("StringAdd")
            .trace(),
        ),
      ),
      // PushDuplicate and StackSwap of the empty stack's undefined.
      w.doAction(
        avm1((a) =>
          a
            .push("a", "b")
            .op("StackSwap")
            .trace()
            .trace()
            .op("PushDuplicate")
            .op("TypeOf")
            .trace()
            .trace(),
        ),
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** AVM1 code that leaves a value on the stack, for the cases of objects. */
type Avm1Expr = (a: Avm1Assembler) => Avm1Assembler;

const lit =
  (v: PushValue): Avm1Expr =>
  (a) =>
    a.push(v);
const getVar =
  (name: string): Avm1Expr =>
  (a) =>
    a.push(name).op("GetVariable");
const member =
  (o: Avm1Expr, name: string): Avm1Expr =>
  (a) =>
    o(a).push(name).op("GetMember");
const op =
  (action: SimpleAction, ...operands: Avm1Expr[]): Avm1Expr =>
  (a) =>
    operands.reduce((b, e) => e(b), a).op(action);
/** Arguments as calls take them: the last first, then their count. */
const args = (a: Avm1Assembler, values: Avm1Expr[]) =>
  [...values]
    .reverse()
    .reduce((b, e) => e(b), a)
    .push(values.length);
const callMethod =
  (o: Avm1Expr, name: string | undefined, ...values: Avm1Expr[]): Avm1Expr =>
  (a) =>
    o(args(a, values)).push(name).op("CallMethod");
const callFunction =
  (name: string, ...values: Avm1Expr[]): Avm1Expr =>
  (a) =>
    args(a, values).push(name).op("CallFunction");
const newObject =
  (name: string, ...values: Avm1Expr[]): Avm1Expr =>
  (a) =>
    args(a, values).push(name).op("NewObject");
const initObject =
  (...pairs: [string, Avm1Expr][]): Avm1Expr =>
  (a) =>
    pairs
      .reduce((b, [name, e]) => e(b.push(name)), a)
      .push(pairs.length)
      .op("InitObject");
const initArray =
  (...elements: Avm1Expr[]): Avm1Expr =>
  (a) =>
    [...elements]
      .reverse()
      .reduce((b, e) => e(b), a)
      .push(elements.length)
      .op("InitArray");

/** Statements of the cases of objects, each a function of the assembler. */
type Avm1Statement = (a: Avm1Assembler) => Avm1Assembler;

const setVar =
  (name: string, e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a.push(name)).op("SetVariable");
const setMember =
  (o: Avm1Expr, name: string, e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(o(a).push(name)).op("SetMember");
const traceOf =
  (e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).trace();
const note =
  (text: string): Avm1Statement =>
  (a) =>
    a.push(text).trace();
const drop =
  (e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).pop();
let forInLabels = 0;
/** `for (k in o) trace(k)`, by Enumerate2: the names up to the terminator. */
const forIn =
  (o: Avm1Expr): Avm1Statement =>
  (a) => {
    const n = forInLabels++;
    return o(a)
      .op("Enumerate2")
      .label(`in${n}`)
      .op("PushDuplicate")
      .push(null)
      .op("Equals2")
      .if(`out${n}`)
      .trace()
      .jump(`in${n}`)
      .label(`out${n}`)
      .pop();
  };
/** `for (k in o)` the names joined in one line, so that a line stands for an enumeration. */
const keysOf =
  (o: Avm1Expr): Avm1Statement =>
  (a) => {
    const n = forInLabels++;
    a.push("k", "").op("SetVariable");
    return o(a)
      .op("Enumerate2")
      .label(`in${n}`)
      .op("PushDuplicate")
      .push(null)
      .op("Equals2")
      .if(`out${n}`)
      .push("k")
      .op("StackSwap")
      .push("k")
      .op("GetVariable")
      .op("StackSwap")
      .op("Add2")
      .push(" ")
      .op("Add2")
      .op("SetVariable")
      .jump(`in${n}`)
      .label(`out${n}`)
      .pop()
      .push("k")
      .op("GetVariable")
      .trace();
  };
const block = (...statements: Avm1Statement[]) =>
  w.doAction(avm1((a) => statements.reduce((b, s) => s(b), a)));

const o = getVar("o");
const OBJECT_PROTO = member(getVar("Object"), "prototype");

// What AVM1's objects do in a SWF of `version`, as adl traces it
// (docs/avm1.md, "Objects"): for..in's order and its terminator, names by
// the version's case, ASSetPropFlags' attributes and version bits,
// addProperty, watch and __resolve with native functions, which are all a
// SWF can call before step 7 brings its own, delete, the prototypes of
// primitives, _global, Object, and variables and paths on the root.
function avm1Objects(version: number): Uint8Array {
  const v6 = version >= 6;
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 1,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      // for..in: the last added first, a name deleted and set again last.
      block(
        note("-- enumeration"),
        setVar("o", initObject(["a", lit(1)], ["b", lit(2)])),
        setMember(o, "c", lit(3)),
        setMember(o, "d", lit(4)),
        traceOf(op("Delete", o, lit("b"))),
        setMember(o, "b", lit(5)),
        keysOf(o),
        // A prototype's names come first, but those the object has.
        setVar("p", initObject(["x", lit(1)], ["c", lit(2)], ["y", lit(3)])),
        setMember(o, "__proto__", getVar("p")),
        keysOf(o),
        setVar("q", initObject(["z", lit(1)])),
        setMember(getVar("q"), "__proto__", o),
        keysOf(getVar("q")),
        // The terminator, and an enumeration of no object.
        (a) => a.push("t").op("Enumerate").op("TypeOf").trace(),
        (a) => a.push(7).op("Enumerate2").op("TypeOf").trace(),
        keysOf(initArray(lit("a"), lit("b"), lit("c"))),
        keysOf(initObject(["10", lit(1)], ["2", lit(2)], ["1", lit(3)])),
        forIn(initObject(["only", lit(1)])),
      ),
      // Names by the version's case: up to SWF 6 the first spelling stays.
      block(
        note("-- case"),
        setVar("c", initObject()),
        setMember(getVar("c"), "Ab", lit(1)),
        setMember(getVar("c"), "aB", lit(2)),
        traceOf(member(getVar("c"), "ab")),
        traceOf(member(getVar("c"), "Ab")),
        traceOf(member(getVar("c"), "aB")),
        keysOf(getVar("c")),
        setVar("Vx", lit(7)),
        traceOf(getVar("vX")),
        traceOf(getVar("Vx")),
        traceOf(callMethod(getVar("c"), "HASOWNPROPERTY", lit("AB"))),
        traceOf(op("Delete", getVar("c"), lit("AB"))),
        keysOf(getVar("c")),
        ...(v6
          ? [
              setMember(getVar("c"), "é", lit(1)),
              traceOf(member(getVar("c"), "É")),
              setMember(getVar("c"), "ж", lit(2)),
              traceOf(member(getVar("c"), "Ж")),
            ]
          : []),
        traceOf(op("Equals2", getVar("THIS"), getVar("this"))),
      ),
      // ASSetPropFlags: don't enum 1, don't delete 2, read only 4, and the
      // bits that hide a property from SWFs before a version.
      block(
        note("-- flags"),
        setVar("f", initObject(["a", lit(1)], ["b", lit(2)], ["c", lit(3)], ["d", lit(4)])),
        drop(callFunction("ASSetPropFlags", getVar("f"), lit("a"), lit(1))),
        drop(callFunction("ASSetPropFlags", getVar("f"), lit("b,C"), lit(2))),
        drop(callFunction("ASSetPropFlags", getVar("f"), initArray(lit("d")), lit(4))),
        keysOf(getVar("f")),
        traceOf(op("Delete", getVar("f"), lit("b"))),
        traceOf(op("Delete", getVar("f"), lit("a"))),
        setMember(getVar("f"), "d", lit(40)),
        traceOf(member(getVar("f"), "d")),
        traceOf(callMethod(getVar("f"), "isPropertyEnumerable", lit("c"))),
        traceOf(callMethod(getVar("f"), "isPropertyEnumerable", lit("d"))),
        drop(callFunction("ASSetPropFlags", getVar("f"), lit(null), lit(0), lit(7))),
        keysOf(getVar("f")),
        // Every property, __proto__ and constructor included, shown.
        drop(callFunction("ASSetPropFlags", OBJECT_PROTO, lit(null), lit(0), lit(1))),
        keysOf(initObject()),
        drop(callFunction("ASSetPropFlags", OBJECT_PROTO, lit(null), lit(1))),
        setVar("g", initObject(["k", lit(1)])),
        drop(callFunction("ASSetPropFlags", getVar("g"), lit(null), lit(0), lit(1))),
        keysOf(getVar("g")),
        // The version bits.
        ...[0x80, 0x100, 0x400, 0x500, 0x1000, 0x2000, 0x4000, 0x8000].flatMap((bits) => [
          setVar("h", initObject(["v", lit(bits)])),
          drop(callFunction("ASSetPropFlags", getVar("h"), lit("v"), lit(bits))),
          traceOf(member(getVar("h"), "v")),
          traceOf(callMethod(getVar("h"), "hasOwnProperty", lit("v"))),
          keysOf(getVar("h")),
          setMember(getVar("h"), "v", lit("set")),
          traceOf(member(getVar("h"), "v")),
        ]),
        traceOf(op("TypeOf", getVar("Function"))),
        traceOf(op("TypeOf", member(initObject(), "watch"))),
        traceOf(op("TypeOf", member(initObject(), "toString"))),
      ),
      // addProperty, with natives as getter and setter.
      block(
        note("-- addProperty"),
        setVar("a", initObject(["s", lit(1)])),
        traceOf(callMethod(getVar("a"), "addProperty")),
        traceOf(callMethod(getVar("a"), "addProperty", lit("p"))),
        traceOf(callMethod(getVar("a"), "addProperty", lit(""), member(OBJECT_PROTO, "valueOf"))),
        traceOf(callMethod(getVar("a"), "addProperty", lit("p"), lit(5), lit(null))),
        traceOf(callMethod(getVar("a"), "addProperty", lit("p"), member(OBJECT_PROTO, "valueOf"))),
        traceOf(
          callMethod(getVar("a"), "addProperty", lit("p"), member(OBJECT_PROTO, "valueOf"), lit(7)),
        ),
        traceOf(op("TypeOf", member(getVar("a"), "p"))),
        traceOf(
          callMethod(
            getVar("a"),
            "addProperty",
            lit("p"),
            member(OBJECT_PROTO, "valueOf"),
            lit(null),
          ),
        ),
        traceOf(op("Equals2", member(getVar("a"), "p"), getVar("a"))),
        setMember(getVar("a"), "p", lit(9)),
        traceOf(op("Equals2", member(getVar("a"), "p"), getVar("a"))),
        traceOf(callMethod(getVar("a"), "hasOwnProperty", lit("p"))),
        keysOf(getVar("a")),
        // A getter or a setter that is an object but no function is refused.
        traceOf(callMethod(getVar("a"), "addProperty", lit("n"), initObject(), initObject())),
        traceOf(member(getVar("a"), "n")),
        traceOf(
          callMethod(
            getVar("a"),
            "addProperty",
            lit("n"),
            member(OBJECT_PROTO, "valueOf"),
            initObject(),
          ),
        ),
        // A getter over a value, and a toString getter.
        traceOf(
          callMethod(
            getVar("a"),
            "addProperty",
            lit("s"),
            member(OBJECT_PROTO, "toString"),
            lit(null),
          ),
        ),
        traceOf(member(getVar("a"), "s")),
        // A getter on the prototype, seen through an object and a primitive.
        setVar("b", initObject()),
        setMember(getVar("b"), "__proto__", getVar("a")),
        traceOf(member(getVar("b"), "s")),
        setMember(getVar("b"), "s", lit("own")),
        traceOf(member(getVar("b"), "s")),
        traceOf(callMethod(getVar("b"), "hasOwnProperty", lit("s"))),
      ),
      // watch: what each call gives, and a native callback's value set.
      block(
        note("-- watch"),
        setVar("w", initObject(["x", lit(1)])),
        traceOf(callMethod(getVar("w"), "watch")),
        traceOf(callMethod(getVar("w"), "watch", lit("x"))),
        traceOf(callMethod(getVar("w"), "watch", lit("x"), lit(5))),
        traceOf(callMethod(getVar("w"), "watch", lit("x"), initObject())),
        traceOf(callMethod(getVar("w"), "watch", lit("x"), member(OBJECT_PROTO, "valueOf"))),
        setMember(getVar("w"), "x", lit(2)),
        traceOf(op("Equals2", member(getVar("w"), "x"), getVar("w"))),
        // A second watch replaces the first: Object called with the name boxes it.
        traceOf(callMethod(getVar("w"), "watch", lit("x"), getVar("Object"), lit("data"))),
        setMember(getVar("w"), "x", lit(3)),
        traceOf(member(getVar("w"), "x")),
        traceOf(op("TypeOf", member(getVar("w"), "x"))),
        traceOf(callMethod(getVar("w"), "unwatch", lit("X"))),
        traceOf(callMethod(getVar("w"), "unwatch", lit("x"))),
        traceOf(callMethod(getVar("w"), "unwatch")),
        setMember(getVar("w"), "x", lit(4)),
        traceOf(member(getVar("w"), "x")),
        // A name not set yet, then set through SetVariable's path.
        traceOf(callMethod(getVar("w"), "watch", lit("later"), getVar("Object"))),
        setVar("w.later", lit(1)),
        traceOf(member(getVar("w"), "later")),
        // A watched read-only property.
        drop(callFunction("ASSetPropFlags", getVar("w"), lit("later"), lit(4))),
        setMember(getVar("w"), "later", lit(2)),
        traceOf(member(getVar("w"), "later")),
      ),
      // __resolve: asked for a name the chain lacks, with the name.
      block(
        note("-- __resolve"),
        setVar("r", initObject(["here", lit("here")])),
        setMember(getVar("r"), "__resolve", getVar("Object")),
        traceOf(member(getVar("r"), "missing")),
        traceOf(op("TypeOf", member(getVar("r"), "missing"))),
        traceOf(member(getVar("r"), "here")),
        traceOf(callMethod(getVar("r"), "hasOwnProperty", lit("missing"))),
        setMember(getVar("r"), "__resolve", lit(5)),
        traceOf(member(getVar("r"), "missing")),
        setMember(getVar("r"), "__resolve", initObject()),
        traceOf(member(getVar("r"), "missing")),
        setMember(getVar("r"), "__resolve", member(OBJECT_PROTO, "toString")),
        traceOf(member(getVar("r"), "missing")),
        // On the prototype; and not for a conversion's valueOf.
        setVar("s", initObject()),
        setMember(getVar("s"), "__proto__", getVar("r")),
        traceOf(member(getVar("s"), "missing")),
        setVar("bare", callFunction("Object")),
        setMember(getVar("bare"), "__resolve", getVar("Object")),
        traceOf(op("Add2", getVar("bare"), lit(""))),
        traceOf(getVar("bare")),
        // Through the scope chain: a variable missing is not resolved.
        traceOf(op("TypeOf", getVar("noSuchVariable"))),
      ),
      // delete, Delete2, and variables at the root.
      block(
        note("-- delete"),
        setVar("d", initObject(["x", lit(1)])),
        traceOf(op("Delete", getVar("d"), lit("x"))),
        traceOf(op("Delete", getVar("d"), lit("x"))),
        traceOf(op("Delete", lit("str"), lit("length"))),
        traceOf(op("Delete", getVar("d"), lit("__proto__"))),
        traceOf(op("Delete", OBJECT_PROTO, lit("toString"))),
        setVar("gone", lit(1)),
        traceOf(op("Delete2", lit("gone"))),
        traceOf(op("Delete2", lit("gone"))),
        traceOf(op("TypeOf", getVar("gone"))),
        setVar("dd", initObject(["y", lit(2)])),
        traceOf(op("Delete2", lit("dd.y"))),
        traceOf(op("TypeOf", member(getVar("dd"), "y"))),
        (a) => a.push("loc", 1).op("DefineLocal"),
        traceOf(getVar("loc")),
        (a) => a.push("loc").op("DefineLocal2"),
        traceOf(getVar("loc")),
        (a) => a.push("loc2").op("DefineLocal2"),
        traceOf(op("TypeOf", getVar("loc2"))),
        traceOf(callMethod(getVar("this"), "hasOwnProperty", lit("loc2"))),
        // Paths to objects' properties.
        setVar("pa", initObject(["b", initObject(["c", lit("deep")])])),
        traceOf(getVar("pa.b.c")),
        traceOf(getVar("pa:b")),
        traceOf(getVar("pa.b:c")),
        setVar("pa.b.e", lit("set")),
        traceOf(member(member(getVar("pa"), "b"), "e")),
        setVar("nopath.x", lit(1)),
        traceOf(op("TypeOf", getVar("nopath"))),
        traceOf(getVar("this.loc")),
        traceOf(getVar(".x")),
      ),
      // The prototypes of primitives, which GetMember and CallMethod box.
      block(
        note("-- primitives"),
        traceOf(member(lit("abc"), "length")),
        traceOf(member(lit("abc"), "LENGTH")),
        traceOf(
          op("Equals2", member(lit("abc"), "__proto__"), member(getVar("String"), "prototype")),
        ),
        traceOf(op("Equals2", member(lit("abc"), "constructor"), getVar("String"))),
        traceOf(op("Equals2", member(lit(5), "__constructor__"), getVar("Number"))),
        traceOf(callMethod(lit(5), "toString")),
        traceOf(callMethod(lit(true), "toString")),
        traceOf(callMethod(lit("s"), "valueOf")),
        traceOf(op("TypeOf", callMethod(lit("s"), "valueOf"))),
        setMember(member(getVar("String"), "prototype"), "extra", lit("on String")),
        traceOf(member(lit("x"), "extra")),
        traceOf(member(lit(1), "extra")),
        setMember(member(getVar("Object"), "prototype"), "everywhere", lit("on Object")),
        traceOf(member(lit(1), "everywhere")),
        traceOf(member(lit(false), "everywhere")),
        setMember(lit("x"), "bar", lit(1)),
        traceOf(member(lit("x"), "bar")),
        traceOf(member(lit(undefined), "x")),
        traceOf(member(lit(null), "x")),
        traceOf(callMethod(lit("x"), "hasOwnProperty", lit("length"))),
        traceOf(callMethod(lit(1), "hasOwnProperty", lit("length"))),
        traceOf(op("Delete", member(getVar("Object"), "prototype"), lit("everywhere"))),
        traceOf(op("Delete", member(getVar("String"), "prototype"), lit("extra"))),
        traceOf(callMethod(lit(undefined), "toString")),
      ),
      // _global, Object and the builtins' conversions.
      block(
        note("-- global"),
        traceOf(op("TypeOf", getVar("_global"))),
        setMember(getVar("_global"), "gv", lit("global")),
        traceOf(getVar("gv")),
        setVar("gv", lit("root")),
        traceOf(getVar("gv")),
        traceOf(member(getVar("_global"), "gv")),
        traceOf(op("TypeOf", member(getVar("_global"), "__proto__"))),
        traceOf(op("Equals2", getVar("_global"), lit(null))),
        traceOf(op("TypeOf", getVar("Object"))),
        // A SWF 5 sees no prototype of a function.
        traceOf(op("TypeOf", member(getVar("Object"), "__proto__"))),
        traceOf(getVar("Object")),
        traceOf(getVar("NaN")),
        traceOf(getVar("o")),
        traceOf(op("TypeOf", newObject("Object"))),
        traceOf(op("TypeOf", callFunction("Object"))),
        traceOf(op("TypeOf", member(callFunction("Object"), "toString"))),
        traceOf(newObject("Object", lit("boxed"))),
        traceOf(op("TypeOf", newObject("Object", lit(5)))),
        traceOf(op("Add2", newObject("Object", lit(5)), lit(1))),
        traceOf(callFunction("Object", lit(true))),
        traceOf(callMethod(newObject("Object"), "hasOwnProperty", lit("constructor"))),
        traceOf(callMethod(newObject("Object"), "hasOwnProperty", lit("__constructor__"))),
        traceOf(callMethod(initObject(), "hasOwnProperty", lit("constructor"))),
        traceOf(callMethod(initObject(), "isPrototypeOf", initObject())),
        traceOf(callMethod(OBJECT_PROTO, "isPrototypeOf", initObject())),
        traceOf(callMethod(OBJECT_PROTO, "isPrototypeOf", lit("s"))),
        traceOf(initObject(["a", lit(1)])),
        traceOf(callMethod(initObject(), "toString")),
        traceOf(callMethod(getVar("Object"), "toString")),
        traceOf(op("Equals2", callMethod(o, "valueOf"), o)),
        traceOf(op("Add2", initObject(), lit(1))),
        traceOf(initArray(lit(1), lit(undefined), lit("c"))),
        traceOf(op("TypeOf", initArray())),
        traceOf(member(initArray(lit(1), lit(2)), "length")),
        // InitObject's later pairs are set first; a count out of range pops none.
        keysOf(initObject(["a", lit(1)], ["b", lit(2)], ["a", lit(3)])),
        traceOf(member(initObject(["a", lit(1)], ["b", lit(2)], ["a", lit(3)]), "a")),
        (a) => a.push("kept", -1).op("InitObject").op("TypeOf").trace().trace(),
        (a) => a.push("kept", -1).op("InitArray").op("TypeOf").trace().trace(),
        // Counts are truncated: -0.5 is 0, NaN none, 1.7 pairs one.
        (a) => a.push("kept", -0.5).op("InitObject").op("TypeOf").trace().trace(),
        (a) => a.push("kept", Number.NaN).op("InitArray").op("TypeOf").trace().trace(),
        (a) => a.push("kept", "a", 1, "b", 2, 1.7).op("InitObject").op("Enumerate2"),
        (a) => a.trace().trace().trace().trace().trace(),
      ),
      // Flash's lower case, ASSetPropFlags' bits as an int's low 16, and paths' first steps.
      block(
        note("-- more names"),
        ...(v6
          ? (
              [
                ["İ", "i"],
                ["ΑΣ", "ασ"],
                ["xς", "XΣ"],
                ["ß", "ẞ"],
                ["ა", "Ⴀ"],
                ["ɐ", "Ɐ"],
              ] as const
            ).map(([stored, asked]) => traceOf(member(initObject([stored, lit(stored)]), asked)))
          : []),
        setVar("h", initObject(["v", lit(1)])),
        drop(callFunction("ASSetPropFlags", getVar("h"), lit("v"), lit(65537))),
        traceOf(op("Delete", getVar("h"), lit("v"))),
        setVar("h", initObject(["v", lit(1)])),
        drop(callFunction("ASSetPropFlags", getVar("h"), lit("v"), lit(-65534))),
        traceOf(op("Delete", getVar("h"), lit("v"))),
        setVar("h", initObject()),
        setMember(getVar("h"), "__resolve", getVar("Object")),
        drop(callFunction("ASSetPropFlags", getVar("h"), lit("__resolve"), lit(0x4000))),
        traceOf(op("TypeOf", member(getVar("h"), "missing"))),
        setVar("px", lit("root's")),
        traceOf(getVar("_ROOT.px")),
        traceOf(getVar("THIS.px")),
        traceOf(getVar("_global.ASSetPropFlags")),
        setVar("_global.pg", lit("global's")),
        traceOf(member(getVar("_global"), "pg")),
        setVar("this.pt", lit(1)),
        traceOf(getVar("pt")),
        // An array's indices: up to SWF 6 the digits before anything else; its length by case.
        ...["3abc", "1.9", " +3", "4294967298"].flatMap((name) => [
          setVar("ar", initArray(lit("x"))),
          setMember(getVar("ar"), name, lit(1)),
          traceOf(member(getVar("ar"), "length")),
        ]),
        setVar("ar", initArray(lit("x"), lit("y"), lit("z"))),
        setMember(getVar("ar"), "LENGTH", lit(1)),
        keysOf(getVar("ar")),
        // A __PROTO__ where __proto__ was deleted.
        setVar("pr", initObject()),
        drop(callFunction("ASSetPropFlags", getVar("pr"), lit("__proto__"), lit(0), lit(2))),
        traceOf(op("Delete", getVar("pr"), lit("__proto__"))),
        setMember(getVar("pr"), "__PROTO__", initObject(["inherited", lit("yes")])),
        traceOf(member(getVar("pr"), "inherited")),
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A function's body of statements. */
const body = (...statements: Avm1Statement[]) =>
  statements.reduce((b, s) => s(b), new Avm1Assembler());
/** `function name(params) { ... }`: DefineFunction. */
const defineFn =
  (name: string, params: string[], ...statements: Avm1Statement[]): Avm1Statement =>
  (a) =>
    a.defineFunction(name, params, body(...statements));
/** An anonymous function, which DefineFunction pushes. */
const fnExpr =
  (params: string[], ...statements: Avm1Statement[]): Avm1Expr =>
  (a) =>
    a.defineFunction("", params, body(...statements));
/** DefineFunction2, with its register count, flags and parameters' registers. */
const defineFn2 =
  (
    name: string,
    registers: number,
    flags: number,
    params: [string, number][],
    ...statements: Avm1Statement[]
  ): Avm1Statement =>
  (a) =>
    a.defineFunction2(name, registers, flags, params, body(...statements));
const fn2Expr =
  (
    registers: number,
    flags: number,
    params: [string, number][],
    ...statements: Avm1Statement[]
  ): Avm1Expr =>
  (a) =>
    a.defineFunction2("", registers, flags, params, body(...statements));
const ret =
  (e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).op("Return");
const reg =
  (n: number): Avm1Expr =>
  (a) =>
    a.push(register(n));
const storeReg =
  (n: number, e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).storeRegister(n).pop();
const local =
  (name: string, e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a.push(name)).op("DefineLocal");
const newMethod =
  (o: Avm1Expr, name: string | undefined, ...values: Avm1Expr[]): Avm1Expr =>
  (a) =>
    o(args(a, values)).push(name).op("NewMethod");
let ifLabels = 0;
/** `if (cond) { statements }`. */
const ifThen =
  (cond: Avm1Expr, ...statements: Avm1Statement[]): Avm1Statement =>
  (a) => {
    const skip = `skip${ifLabels++}`;
    return statements.reduce((b, s) => s(b), cond(a).op("Not").if(skip)).label(skip);
  };
const proto = (name: string) => member(getVar(name), "prototype");
/**
 * "root" for the root, else the value's type: the player's root is no clip
 * yet (docs/avm1.md, step 10), whose `typeof` is "movieclip".
 */
const kind =
  (e: Avm1Expr): Avm1Expr =>
  (a) => {
    const n = ifLabels++;
    return e(a)
      .op("PushDuplicate")
      .push("_root")
      .op("GetVariable")
      .op("StrictEquals")
      .if(`root${n}`)
      .op("TypeOf")
      .jump(`kind${n}`)
      .label(`root${n}`)
      .pop()
      .push("root")
      .label(`kind${n}`);
  };

// What AVM1 functions do in a SWF of `version`, as adl traces it
// (docs/avm1.md, "Functions and registers"): calls and what they give,
// the operand stack a body shares with its caller, `this` by how a
// function is called, closures, `arguments`, registers global and
// DefineFunction2's own with its preloads, Function's call and apply, new,
// super, getters, setters, watchers and __resolve that are functions, the
// recursion limits, and the constant pool a function reads.
function avm1Functions(version: number): Uint8Array {
  // The root's _parent is left out: adl loads the SWF, whose root has one there.
  const all =
    FunctionFlag.preloadThis |
    FunctionFlag.preloadArguments |
    FunctionFlag.preloadSuper |
    FunctionFlag.preloadRoot |
    FunctionFlag.preloadGlobal;
  const describe = [
    traceOf(kind(reg(1))),
    traceOf(kind(getVar("this"))),
    traceOf(op("Equals2", getVar("this"), o)),
    traceOf(op("Equals2", getVar("this"), getVar("_root"))),
    traceOf(op("TypeOf", getVar("arguments"))),
    traceOf(op("TypeOf", getVar("super"))),
  ];
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 3,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      block(
        note("-- calls"),
        defineFn(
          "add",
          ["a", "b"],
          traceOf(getVar("a")),
          traceOf(getVar("b")),
          traceOf(member(getVar("arguments"), "length")),
          ret(op("Add2", getVar("a"), getVar("b"))),
        ),
        traceOf(callFunction("add", lit(1), lit(2))),
        traceOf(callFunction("add", lit(1))),
        traceOf(callFunction("add", lit(1), lit(2), lit(3))),
        defineFn("none", []),
        traceOf(callFunction("none")),
        traceOf(op("TypeOf", callFunction("none"))),
        traceOf(op("TypeOf", getVar("add"))),
        traceOf(getVar("add")),
        traceOf(op("TypeOf", member(getVar("add"), "prototype"))),
        traceOf(op("Equals2", member(proto("add"), "constructor"), getVar("add"))),
        traceOf(op("Equals2", member(proto("add"), "__proto__"), OBJECT_PROTO)),
        traceOf(op("Equals2", member(getVar("add"), "__proto__"), proto("Function"))),
        keysOf(getVar("add")),
        keysOf(proto("add")),
        traceOf(callMethod(getVar("add"), "hasOwnProperty", lit("prototype"))),
        setVar("anon", fnExpr(["x"], ret(op("Multiply", getVar("x"), lit(2))))),
        traceOf(callFunction("anon", lit(21))),
        traceOf(callFunction("noSuchFunction", lit(1))),
        setVar("num", lit(5)),
        traceOf(callFunction("num")),
        setVar("obj", initObject(["v", lit(1)])),
        traceOf(callMethod(getVar("obj"), "nope")),
        traceOf(callMethod(getVar("obj"), "v")),
        traceOf(op("TypeOf", newObject("noSuchClass"))),
        traceOf(op("TypeOf", newMethod(getVar("obj"), "nope"))),
        traceOf(op("TypeOf", newMethod(getVar("obj"), "v"))),
        traceOf(op("TypeOf", newMethod(lit(undefined), "x"))),
        traceOf(callMethod(getVar("add"), "", lit(2), lit(3))),
        traceOf(callMethod(getVar("add"), undefined, lit(4), lit(5))),
        setVar("made", newMethod(getVar("add"), "", lit(1), lit(1))),
        traceOf(op("TypeOf", getVar("made"))),
        setMember(
          getVar("obj"),
          "self",
          fnExpr([], ret(op("Equals2", getVar("this"), getVar("obj")))),
        ),
        traceOf(callFunction("obj.self")),
        traceOf(callMethod(getVar("obj"), "self")),
        traceOf(callFunction("obj:self")),
        setVar("thisOf", fnExpr([], ret(kind(getVar("this"))))),
        traceOf(callMethod(getVar("thisOf"), "")),
        traceOf(callFunction("thisOf")),
        traceOf(callMethod(getVar("obj"), "thisOf")),
        defineFn("Casey", [], ret(lit("casey"))),
        traceOf(callFunction("casey")),
        traceOf(callFunction("CASEY")),
      ),
      block(
        note("-- the stack"),
        defineFn("popper", [], (a) => a.trace().trace()),
        (a) => a.push("under1", "under2", 0, "popper").op("CallFunction").trace(),
        defineFn("leaver", [], (a) => a.push("left"), ret(lit("ret"))),
        (a) => a.push(0, "leaver").op("CallFunction").trace().trace(),
        defineFn("emptyReturn", [], (a) => a.op("Return")),
        (a) => a.push("callers", 0, "emptyReturn").op("CallFunction").trace().trace(),
        (a) => a.push("kept", "popped").op("Return").push("after return").trace(),
      ),
      block(note("-- after a block's return"), (a) => a.trace().trace()),
      block(
        note("-- this"),
        setVar("o", initObject()),
        setMember(
          o,
          "who",
          fnExpr(
            [],
            traceOf(op("Equals2", getVar("this"), o)),
            traceOf(op("Equals2", getVar("this"), getVar("_root"))),
            traceOf(kind(getVar("this"))),
            traceOf(kind(getVar("THIS"))),
          ),
        ),
        drop(callMethod(o, "who")),
        setVar("who", member(o, "who")),
        drop(callFunction("who")),
        setMember(
          o,
          "outer",
          fnExpr(
            [],
            defineFn("inner", [], ret(getVar("this"))),
            local("got", callFunction("inner")),
            traceOf(op("Equals2", getVar("got"), o)),
            traceOf(op("Equals2", getVar("got"), getVar("_root"))),
            traceOf(kind(getVar("got"))),
            traceOf(callMethod(getVar("got"), "hasOwnProperty", lit("got"))),
            traceOf(op("TypeOf", callMethod(getVar("this"), "inner"))),
          ),
        ),
        drop(callMethod(o, "outer")),
        setMember(OBJECT_PROTO, "me", fnExpr([], ret(op("TypeOf", getVar("this"))))),
        traceOf(callMethod(lit("s"), "me")),
        traceOf(callMethod(lit(5), "me")),
        traceOf(callMethod(lit(true), "me")),
        drop(op("Delete", OBJECT_PROTO, lit("me"))),
        setMember(o, "setThis", fnExpr([], setVar("this", lit(5)), traceOf(getVar("this")))),
        drop(callMethod(o, "setThis")),
      ),
      block(
        note("-- closures"),
        defineFn(
          "counter",
          ["n"],
          local("c", getVar("n")),
          ret(fnExpr([], setVar("c", op("Add2", getVar("c"), lit(1))), ret(getVar("c")))),
        ),
        setVar("c1", callFunction("counter", lit(10))),
        traceOf(callFunction("c1")),
        traceOf(callFunction("c1")),
        setVar("c2", callFunction("counter", lit(20))),
        traceOf(callFunction("c2")),
        traceOf(callFunction("c1")),
        traceOf(op("TypeOf", getVar("c"))),
        traceOf(getVar("c")),
        defineFn("locals", [], local("loc", lit(1)), setVar("glob", lit(2)), (a) =>
          a.push("loc2").op("DefineLocal2"),
        ),
        drop(callFunction("locals")),
        traceOf(op("TypeOf", getVar("loc"))),
        traceOf(op("TypeOf", getVar("loc2"))),
        traceOf(getVar("glob")),
        setVar("shadow", lit("root")),
        defineFn("shadower", ["shadow"], setVar("shadow", lit("param")), traceOf(getVar("shadow"))),
        drop(callFunction("shadower", lit("arg"))),
        traceOf(getVar("shadow")),
        defineFn("missing", ["shadow"], traceOf(getVar("shadow"))),
        drop(callFunction("missing")),
        defineFn("outerP", ["p"], ret(fnExpr([], ret(op("Add2", getVar("p"), getVar("shadow")))))),
        traceOf(callMethod(callFunction("outerP", lit("p:")), "")),
        // A SWF 5 function's named function is its clip's; any other variable stays its own.
        defineFn(
          "definesInner",
          [],
          defineFn("innerNamed", [], ret(lit("inner"))),
          local("innerLocal", lit(1)),
        ),
        drop(callFunction("definesInner")),
        traceOf(op("TypeOf", getVar("innerNamed"))),
        traceOf(op("TypeOf", getVar("innerLocal"))),
      ),
      block(
        note("-- arguments"),
        defineFn(
          "args",
          ["a"],
          traceOf(member(getVar("arguments"), "length")),
          traceOf(member(getVar("arguments"), "0")),
          traceOf(op("TypeOf", getVar("arguments"))),
          traceOf(op("Equals2", member(getVar("arguments"), "callee"), getVar("args"))),
          traceOf(member(getVar("arguments"), "caller")),
          traceOf(op("TypeOf", member(getVar("arguments"), "caller"))),
          traceOf(op("Equals2", member(getVar("arguments"), "__proto__"), proto("Array"))),
          traceOf(op("Equals2", member(getVar("arguments"), "constructor"), getVar("Array"))),
          keysOf(getVar("arguments")),
          traceOf(getVar("arguments")),
          setMember(getVar("arguments"), "0", lit("changed")),
          traceOf(getVar("a")),
          setVar("a", lit("a set")),
          traceOf(member(getVar("arguments"), "0")),
          traceOf(callMethod(getVar("arguments"), "hasOwnProperty", lit("callee"))),
          traceOf(callMethod(getVar("arguments"), "isPropertyEnumerable", lit("callee"))),
          traceOf(getVar("ARGUMENTS")),
        ),
        drop(callFunction("args", lit(1), lit(2))),
        defineFn("callsArgs", [], drop(callFunction("whoCalled"))),
        defineFn(
          "whoCalled",
          [],
          traceOf(op("Equals2", member(getVar("arguments"), "caller"), getVar("callsArgs"))),
          traceOf(op("TypeOf", member(getVar("arguments"), "caller"))),
        ),
        drop(callFunction("callsArgs")),
        drop(callFunction("whoCalled")),
        defineFn("argsTwice", [], ret(getVar("arguments"))),
        traceOf(op("Equals2", callFunction("argsTwice"), callFunction("argsTwice"))),
        defineFn("argsSet", [], setVar("arguments", lit("mine")), traceOf(getVar("arguments"))),
        drop(callFunction("argsSet")),
        defineFn(
          "argsDelete",
          [],
          traceOf(op("Delete2", lit("arguments"))),
          traceOf(op("TypeOf", getVar("arguments"))),
        ),
        drop(callFunction("argsDelete")),
        traceOf(op("TypeOf", getVar("arguments"))),
      ),
      block(
        note("-- registers"),
        storeReg(0, lit("g0")),
        storeReg(1, lit("g1")),
        storeReg(2, lit("g2")),
        storeReg(3, lit("g3")),
        storeReg(4, lit("g4")),
        traceOf(reg(0)),
        traceOf(reg(1)),
        traceOf(reg(2)),
        traceOf(reg(3)),
        traceOf(reg(4)),
        traceOf(reg(255)),
        (a) => a.push("stays").storeRegister(1).trace(),
        traceOf(reg(1)),
        defineFn("df1", [], traceOf(reg(1)), storeReg(2, lit("from df1")), traceOf(reg(0))),
        drop(callFunction("df1")),
        traceOf(reg(2)),
        defineFn2(
          "df2",
          3,
          0,
          [
            ["x", 1],
            ["y", 0],
          ],
          traceOf(reg(0)),
          traceOf(reg(1)),
          traceOf(reg(2)),
          traceOf(reg(3)),
          traceOf(getVar("y")),
          traceOf(op("TypeOf", getVar("x"))),
          storeReg(2, lit("own")),
          storeReg(3, lit("global 3")),
          storeReg(5, lit("none")),
          traceOf(reg(5)),
        ),
        drop(callFunction("df2", lit("X"), lit("Y"))),
        traceOf(reg(2)),
        traceOf(reg(3)),
        defineFn2(
          "df2past",
          2,
          0,
          [
            ["x", 4],
            ["y", 1],
          ],
          traceOf(reg(4)),
          traceOf(reg(1)),
          traceOf(op("TypeOf", getVar("x"))),
        ),
        drop(callFunction("df2past", lit("X"), lit("Y"))),
        defineFn2(
          "df2zero",
          0,
          0,
          [["x", 0]],
          traceOf(reg(0)),
          traceOf(reg(1)),
          traceOf(getVar("x")),
        ),
        drop(callFunction("df2zero", lit("X0"))),
        defineFn2(
          "fact",
          2,
          0,
          [["n", 1]],
          ifThen(op("Less2", reg(1), lit(2)), ret(lit(1))),
          ret(op("Multiply", reg(1), callFunction("fact", op("Decrement", reg(1))))),
        ),
        traceOf(callFunction("fact", lit(5))),
        defineFn2(
          "same",
          2,
          0,
          [
            ["a", 1],
            ["b", 1],
          ],
          traceOf(reg(1)),
        ),
        drop(callFunction("same", lit("A"), lit("B"))),
      ),
      block(
        note("-- preloads"),
        defineFn2(
          "pre",
          10,
          all,
          [["p", 7]],
          ...[1, 2, 3, 4, 5, 6, 7, 8].map((r) => traceOf(kind(reg(r)))),
          traceOf(op("Equals2", reg(1), o)),
          traceOf(op("Equals2", reg(5), getVar("_global"))),
          traceOf(member(reg(2), "length")),
          traceOf(reg(7)),
          ...describe,
        ),
        setMember(o, "pre", getVar("pre")),
        drop(callMethod(o, "pre", lit("P"))),
        // Without its own `this`, a function's is its caller's or its definer's.
        defineFn2(
          "noThis",
          2,
          FunctionFlag.suppressThis,
          [],
          traceOf(op("Equals2", getVar("this"), o)),
          traceOf(kind(getVar("this"))),
        ),
        setMember(o, "callsNoThis", fnExpr([], drop(callFunction("noThis")))),
        drop(callMethod(o, "callsNoThis")),
        setMember(
          o,
          "definesNoThis",
          fnExpr(
            [],
            ret(
              fn2Expr(
                2,
                FunctionFlag.suppressThis,
                [],
                traceOf(op("Equals2", getVar("this"), o)),
                traceOf(kind(getVar("this"))),
              ),
            ),
          ),
        ),
        drop(callMethod(callMethod(o, "definesNoThis"), "")),
        ...[
          FunctionFlag.preloadThis | FunctionFlag.suppressThis,
          FunctionFlag.suppressThis,
          FunctionFlag.preloadArguments | FunctionFlag.suppressArguments,
          FunctionFlag.suppressArguments,
          FunctionFlag.preloadSuper | FunctionFlag.suppressSuper,
          FunctionFlag.suppressSuper,
          FunctionFlag.preloadRoot,
          FunctionFlag.preloadParent,
          FunctionFlag.preloadGlobal,
        ].flatMap((flags) => [
          note(`flags ${flags}`),
          setMember(o, "flagged", fn2Expr(4, flags, [], ...describe)),
          drop(callMethod(o, "flagged")),
        ]),
      ),
      block(
        note("-- call and apply"),
        setVar(
          "ca",
          fnExpr(
            ["a", "b"],
            traceOf(op("Equals2", getVar("this"), o)),
            traceOf(op("TypeOf", getVar("this"))),
            traceOf(getVar("a")),
            traceOf(getVar("b")),
            traceOf(member(getVar("arguments"), "length")),
            traceOf(op("TypeOf", getVar("super"))),
            ret(lit("r")),
          ),
        ),
        traceOf(callMethod(getVar("ca"), "call", o, lit(1), lit(2))),
        traceOf(callMethod(getVar("ca"), "apply", o, initArray(lit(3), lit(4)))),
        traceOf(callMethod(getVar("ca"), "apply", o)),
        traceOf(callMethod(getVar("ca"), "apply", o, lit(5))),
        traceOf(
          callMethod(
            getVar("ca"),
            "apply",
            o,
            initObject(["length", lit(2)], ["0", lit("x")], ["1", lit("y")]),
          ),
        ),
        traceOf(callMethod(getVar("ca"), "call")),
        traceOf(callMethod(getVar("ca"), "call", lit(null), lit("n"))),
        traceOf(callMethod(getVar("ca"), "call", lit("str"))),
        traceOf(op("TypeOf", member(proto("Function"), "call"))),
        traceOf(op("TypeOf", member(proto("Function"), "apply"))),
        traceOf(callMethod(member(OBJECT_PROTO, "hasOwnProperty"), "call", o, lit("pre"))),
        traceOf(callMethod(member(proto("Function"), "call"), "call", getVar("ca"), o, lit("cc"))),
        keysOf(proto("Function")),
        traceOf(op("TypeOf", callFunction("Function"))),
        traceOf(op("TypeOf", member(callFunction("Function"), "__proto__"))),
        traceOf(op("Equals2", callFunction("Function", getVar("ca")), getVar("ca"))),
        traceOf(op("TypeOf", newObject("Function"))),
        traceOf(op("Equals2", newObject("Function", getVar("ca")), getVar("ca"))),
      ),
      block(
        note("-- new"),
        defineFn(
          "Point",
          ["x", "y"],
          setMember(getVar("this"), "x", getVar("x")),
          setMember(getVar("this"), "y", getVar("y")),
          ret(lit("ignored")),
        ),
        setVar("pt", newObject("Point", lit(1), lit(2))),
        traceOf(op("TypeOf", getVar("pt"))),
        traceOf(member(getVar("pt"), "x")),
        traceOf(op("Equals2", member(getVar("pt"), "__proto__"), proto("Point"))),
        traceOf(op("Equals2", member(getVar("pt"), "constructor"), getVar("Point"))),
        traceOf(op("Equals2", member(getVar("pt"), "__constructor__"), getVar("Point"))),
        keysOf(getVar("pt")),
        defineFn("RetObj", [], ret(initObject(["from", lit("returned")]))),
        traceOf(member(newObject("RetObj"), "from")),
        setMember(
          proto("Point"),
          "sum",
          fnExpr([], ret(op("Add2", member(getVar("this"), "x"), member(getVar("this"), "y")))),
        ),
        traceOf(callMethod(getVar("pt"), "sum")),
        setMember(getVar("Point"), "prototype", initObject(["kind", lit("replaced")])),
        traceOf(member(newObject("Point"), "kind")),
        setMember(o, "Ctor", getVar("Point")),
        traceOf(member(newMethod(o, "Ctor", lit(3), lit(4)), "x")),
        drop(callFunction("Point", lit("px"), lit("py"))),
        traceOf(getVar("x")),
      ),
      block(
        note("-- super"),
        defineFn(
          "Base",
          ["v"],
          traceOf(op("Add2", lit("Base "), getVar("v"))),
          setMember(getVar("this"), "base", getVar("v")),
        ),
        setMember(
          proto("Base"),
          "hello",
          fnExpr([], ret(op("Add2", lit("Base.hello "), member(getVar("this"), "name")))),
        ),
        defineFn(
          "Derived",
          ["v"],
          drop(callMethod(getVar("super"), undefined, op("Add2", getVar("v"), lit(1)))),
          traceOf(lit("Derived")),
        ),
        setMember(proto("Derived"), "__proto__", proto("Base")),
        setMember(proto("Derived"), "__constructor__", getVar("Base")),
        setMember(
          proto("Derived"),
          "hello",
          fnExpr([], ret(op("Add2", lit("Derived.hello "), callMethod(getVar("super"), "hello")))),
        ),
        setVar("d", newObject("Derived", lit(1))),
        traceOf(member(getVar("d"), "base")),
        setMember(getVar("d"), "name", lit("d")),
        traceOf(callMethod(getVar("d"), "hello")),
        defineFn("Third", [], drop(callMethod(getVar("super"), undefined)), traceOf(lit("Third"))),
        setMember(proto("Third"), "__proto__", proto("Derived")),
        setMember(proto("Third"), "__constructor__", getVar("Derived")),
        setMember(
          proto("Third"),
          "hello",
          fnExpr([], ret(op("Add2", lit("Third.hello "), callMethod(getVar("super"), "hello")))),
        ),
        setVar("t3", newObject("Third")),
        setMember(getVar("t3"), "name", lit("t3")),
        traceOf(callMethod(getVar("t3"), "hello")),
        setMember(proto("Base"), "prop", lit("base prop")),
        setMember(
          proto("Derived"),
          "peek",
          fnExpr(
            [],
            traceOf(op("TypeOf", getVar("super"))),
            traceOf(member(getVar("super"), "prop")),
            traceOf(op("TypeOf", member(getVar("super"), "peek"))),
            traceOf(op("TypeOf", member(getVar("super"), "hello"))),
            traceOf(op("Equals2", getVar("super"), getVar("this"))),
            traceOf(getVar("super")),
          ),
        ),
        drop(callMethod(getVar("d"), "peek")),
        defineFn(
          "plainSuper",
          [],
          traceOf(op("TypeOf", getVar("super"))),
          traceOf(callMethod(getVar("super"), "hello")),
        ),
        drop(callFunction("plainSuper")),
        setMember(getVar("d"), "own", fnExpr([], ret(callMethod(getVar("super"), "hello")))),
        traceOf(callMethod(getVar("d"), "own")),
        // A method found two prototypes up, and one a getter gives: up to SWF 6
        // its `super` is above `this`'s prototype, from SWF 7 above where it was found.
        setMember(proto("Base"), "inh", fnExpr([], ret(callMethod(getVar("super"), "hello")))),
        traceOf(callMethod(getVar("t3"), "inh")),
        drop(
          callMethod(
            proto("Base"),
            "addProperty",
            lit("viaGetter"),
            fnExpr([], ret(member(proto("Base"), "inh"))),
            lit(null),
          ),
        ),
        traceOf(callMethod(getVar("t3"), "viaGetter")),
      ),
      block(
        note("-- properties"),
        setVar("pp", initObject()),
        traceOf(
          callMethod(
            getVar("pp"),
            "addProperty",
            lit("v"),
            fnExpr([], ret(lit("got"))),
            fnExpr(
              ["x"],
              traceOf(op("Add2", lit("set "), getVar("x"))),
              setMember(getVar("this"), "stored", getVar("x")),
            ),
          ),
        ),
        traceOf(member(getVar("pp"), "v")),
        setMember(getVar("pp"), "v", lit(5)),
        traceOf(member(getVar("pp"), "stored")),
        setVar("wo", initObject(["x", lit(1)])),
        traceOf(
          callMethod(
            getVar("wo"),
            "watch",
            lit("x"),
            fnExpr(
              ["name", "old", "nu", "data"],
              traceOf(getVar("name")),
              traceOf(getVar("old")),
              traceOf(getVar("nu")),
              traceOf(getVar("data")),
              traceOf(op("Equals2", getVar("this"), getVar("wo"))),
              ret(op("Add2", getVar("nu"), lit(100))),
            ),
            lit("d"),
          ),
        ),
        setMember(getVar("wo"), "x", lit(2)),
        traceOf(member(getVar("wo"), "x")),
        traceOf(callMethod(getVar("wo"), "watch", lit("x"), fnExpr([]))),
        setMember(getVar("wo"), "x", lit(3)),
        traceOf(op("TypeOf", member(getVar("wo"), "x"))),
        setVar("rs", initObject()),
        setMember(
          getVar("rs"),
          "__resolve",
          fnExpr(["n"], ret(op("Add2", lit("resolved "), getVar("n")))),
        ),
        traceOf(member(getVar("rs"), "anything")),
        traceOf(callMethod(getVar("rs"), "method", lit(1))),
        setVar("count", lit(0)),
        setVar("rec", initObject()),
        drop(
          callMethod(
            getVar("rec"),
            "addProperty",
            lit("p"),
            fnExpr(
              [],
              setVar("count", op("Increment", getVar("count"))),
              ret(member(getVar("this"), "p")),
            ),
            lit(null),
          ),
        ),
        traceOf(member(getVar("rec"), "p")),
        traceOf(getVar("count")),
        setVar("count", lit(0)),
        setVar("ws", initObject()),
        drop(
          callMethod(
            getVar("ws"),
            "watch",
            lit("p"),
            fnExpr(
              ["n", "old", "v"],
              setVar("count", op("Increment", getVar("count"))),
              setMember(getVar("this"), "p", op("Add2", getVar("v"), lit(1))),
              ret(getVar("v")),
            ),
          ),
        ),
        setMember(getVar("ws"), "p", lit(0)),
        traceOf(member(getVar("ws"), "p")),
        traceOf(getVar("count")),
        // A native getter that reads itself: join of an array whose element it is.
        setVar("ja", initArray()),
        drop(
          callMethod(
            getVar("ja"),
            "addProperty",
            lit("0"),
            member(proto("Array"), "join"),
            lit(null),
          ),
        ),
        traceOf(member(getVar("ja"), "length")),
        traceOf(callMethod(getVar("ja"), "join")),
        traceOf(member(getVar("ja"), "0")),
      ),
      block(
        note("-- constant pool"),
        (a) => a.constantPool("pool A"),
        defineFn("poolFn", [], traceOf(lit(constant(0)))),
        (a) => a.constantPool("pool B"),
        drop(callFunction("poolFn")),
        traceOf(lit(constant(0))),
        defineFn("poolSetter", [], (a) => a.constantPool("in body"), traceOf(lit(constant(0)))),
        drop(callFunction("poolSetter")),
        traceOf(lit(constant(0))),
        drop(callFunction("poolSetter")),
      ),
      w.showFrame(),
      block(
        note("-- frame 2"),
        traceOf(reg(1)),
        traceOf(reg(3)),
        drop(callFunction("poolFn")),
        traceOf(callFunction("c1")),
        storeReg(1, lit("across blocks")),
      ),
      block(traceOf(reg(1))),
      block(
        note("-- recursion"),
        setVar("depth", lit(0)),
        defineFn(
          "deep",
          [],
          setVar("depth", op("Increment", getVar("depth"))),
          ifThen(op("Greater", getVar("depth"), lit(250)), traceOf(getVar("depth"))),
          drop(callFunction("deep")),
          traceOf(lit("unwound")),
        ),
        drop(callFunction("deep")),
        traceOf(lit("after deep")),
      ),
      block(note("the block after")),
      w.showFrame(),
      block(note("-- frame 3"), traceOf(getVar("depth"))),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A SWF of `version` whose frame runs avm1/<name>.as, compiled by
// tests/avm1-script.ts as Flash's compiler writes it (a constant pool,
// batched pushes, DefineFunction2 from SWF 7): the cases of the language's
// classes, too long to read as the assembler's calls.
function avm1Script(name: string, version: number): Uint8Array {
  const source = readFileSync(new URL(`avm1/${name}.as`, import.meta.url), "utf8");
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 1,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      w.doAction([...script(source, version)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A DoAction of AS1 source, as Flash's compiler writes it for a SWF of `version`. */
const as1 = (source: string, version: number) =>
  w.doAction([...script(source, version)(flashAssembler()).end().bytes()]);

/** A DefineSprite of the frames' tags, each frame ended by a ShowFrame. */
const avm1Sprite = (id: number, frames: Uint8Array[][]) =>
  w.sprite(id, frames.length, [...frames.flatMap((f) => [...f, w.showFrame()]), w.end()]);

/** An AVM1 SWF of `version`, its root's frames' tags after the definitions. */
function avm1Swf(version: number, defs: Uint8Array[], frames: Uint8Array[][]): Uint8Array {
  return w.swf({
    version,
    width: 100,
    height: 100,
    frameRate: 24,
    frameCount: frames.length,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      ...defs,
      ...frames.flatMap((f) => [...f, w.showFrame()]),
      w.end(),
    ],
  });
}

// Clips as AVM1 sees them in a SWF of `version`, avm1/clips.as (docs/avm1.md,
// "Clips and paths"): `a` and `c` of a clip of three frames, which places
// `b` of another, beside an unnamed square and `Beta`; each clip traces its
// frames, which play in Flash's order, the newest clip first.
function avm1Clips(version: number): Uint8Array {
  const source = readFileSync(new URL("avm1/clips.as", import.meta.url), "utf8");
  const inner = avm1Sprite(2, [
    [w.place({ depth: 1, character: 1 }), as1(`trace("inner " + _target);`, version)],
  ]);
  const mover = avm1Sprite(3, [
    [
      w.frameLabel("one"),
      w.place({ depth: 1, character: 2, name: "b" }),
      as1(`trace("mover 1 " + _target);`, version),
    ],
    [w.frameLabel("Two"), as1(`trace("mover 2 " + _target);`, version)],
    [as1(`trace("mover 3 " + _target); stop();`, version)],
  ]);
  return avm1Swf(
    version,
    [square(1, 0xff0000, 400), inner, mover],
    [
      [
        w.place({ depth: 1, character: 3, name: "a", matrix: { tx: 200, ty: 100 } }),
        w.place({ depth: 2, character: 3, name: "c", matrix: { tx: 600, ty: 100 } }),
        w.place({ depth: 3, character: 1, matrix: { tx: 0, ty: 800 } }),
        w.place({ depth: 4, character: 2, name: "Beta", matrix: { tx: 900, ty: 900 } }),
        as1(source, version),
      ],
      [as1(`trace("root 2");`, version)],
      [as1(`trace("root 3"); stop();`, version)],
    ],
  );
}

// Gotos in a SWF of `version`, avm1/gotos.as and the root's later frames:
// a clip of four labelled frames whose frames 2 to 4 place clips before
// and after their actions, which a goto makes and runs in tag order,
// those of the frames before the target first; the frames a goto enters
// queued and run in Flash's order.
function avm1Gotos(version: number): Uint8Array {
  const source = readFileSync(new URL("avm1/gotos.as", import.meta.url), "utf8");
  const traced = (frame: number) =>
    as1(`trace("leaf " + _parent._name + "." + _name + " ${frame}");`, version);
  const leaf = avm1Sprite(2, [[traced(1)], [traced(2)]]);
  const place = (depth: number, name: string) => w.place({ depth, character: 2, name });
  const clip = avm1Sprite(3, [
    [w.frameLabel("start"), as1(`trace("clip " + _name + " 1"); stop();`, version)],
    [w.frameLabel("Middle"), place(1, "early"), as1(`trace("clip " + _name + " 2");`, version)],
    [place(2, "before"), as1(`trace("clip " + _name + " 3");`, version), place(3, "after")],
    [as1(`trace("clip " + _name + " 4"); stop();`, version), place(4, "four")],
  ]);
  return avm1Swf(
    version,
    [leaf, clip],
    [
      [
        w.place({ depth: 1, character: 3, name: "a" }),
        w.place({ depth: 2, character: 3, name: "b" }),
        as1(source, version),
        w.place({ depth: 3, character: 3, name: "c" }),
      ],
      [
        as1(
          `trace("root 2 " + a._currentframe + " " + b._currentframe); b.gotoAndStop(4); a.gotoAndStop(1);`,
          version,
        ),
      ],
      [
        as1(
          `trace("root 3 " + a._currentframe); a.gotoAndStop(4); a.prevFrame(); trace(a._currentframe); stop();`,
          version,
        ),
      ],
    ],
  );
}

// Slash paths in a SWF 4 or 5, avm1/paths.as: variables of clips by
// `/a:x`, GetProperty and SetProperty of slash paths, tellTarget.
function avm1Paths(version: number): Uint8Array {
  const source = readFileSync(new URL("avm1/paths.as", import.meta.url), "utf8");
  const clip = avm1Sprite(3, [
    [w.place({ depth: 1, character: 4, name: "inner" }), as1(`x = 1;`, version)],
    [as1(`stop();`, version)],
  ]);
  return avm1Swf(
    version,
    [avm1Sprite(4, [[]]), clip],
    [[w.place({ depth: 1, character: 3, name: "a" }), as1(source, version)]],
  );
}

// Functions defined in clips in a SWF of `version`, avm1/scopes.as: their
// targets, `this`, `_parent` and `_root`, called through clips, by name, in
// tellTarget and with, as SWF 5's non-closures and later SWFs' closures.
function avm1Scopes(version: number): Uint8Array {
  const source = readFileSync(new URL("avm1/scopes.as", import.meta.url), "utf8");
  const inner = avm1Sprite(2, [
    [
      as1(
        `var where = "inner"; function who() { return _target + " " + where + " " + (this == _root ? "root" : this._name); }`,
        version,
      ),
    ],
  ]);
  const clip = avm1Sprite(3, [
    [
      w.place({ depth: 1, character: 2, name: "kid" }),
      as1(
        `var where = "clip"; function f() { trace("f " + _target + " " + where + " " + typeof kid + " " + _parent._target + " " + _root._target + " " + (this == _root ? "root" : this._name)); return kid; } stop();`,
        version,
      ),
    ],
  ]);
  return avm1Swf(
    version,
    [inner, clip],
    [[w.place({ depth: 1, character: 3, name: "a" }), as1(source, version)]],
  );
}

// Clips' properties as they draw (docs/avm1.md, "Clips and paths"): a
// square's clip moved, scaled, turned, faded, hidden and sized by
// SetProperty and SetMember.
function avm1ClipDrawn(): Uint8Array {
  const clip = avm1Sprite(2, [[w.place({ depth: 1, character: 1 })]]);
  const place = (depth: number, name: string, tx: number) =>
    w.place({ depth, character: 2, name, matrix: { tx, ty: 200 } });
  return avm1Swf(
    6,
    [square(1, 0x3366cc, 400), clip],
    [
      [
        place(1, "a", 100),
        place(2, "b", 600),
        place(3, "c", 1100),
        place(4, "d", 1600),
        place(5, "e", 100),
        as1(
          `a._x = 30.5; a._y = 40; a._rotation = 90;
b._xscale = 150; b._yscale = 50; b._alpha = 40;
c._visible = false; d._visible = 0; setProperty("d", 7, 1); setProperty("d", 0, 60); setProperty("d", 1, 30);
e._width = 70; e._height = 12; e._y = 70;`,
          6,
        ),
      ],
      [as1(`stop();`, 6)],
    ],
  );
}

// Filters a SWF 8 script sets on clips of a square (docs/avm1.md, "flash.filters"):
// a blur, a glow, a drop shadow, a bevel, a colour matrix and a gradient glow,
// one cleared again, and the shadow read back and set on another clip.
function avm1Filters(): Uint8Array {
  const clip = avm1Sprite(2, [[w.place({ depth: 1, character: 1 })]]);
  const place = (depth: number, name: string, tx: number, ty: number) =>
    w.place({ depth, character: 2, name, matrix: { tx, ty } });
  return avm1Swf(
    8,
    [square(1, 0x3366cc, 400), clip],
    [
      [
        place(1, "a", 200, 200),
        place(2, "b", 900, 200),
        place(3, "c", 1600, 200),
        place(4, "d", 200, 1000),
        place(5, "e", 900, 1000),
        place(6, "f", 1600, 1000),
        place(7, "g", 200, 1600),
        as1(
          `var F = flash.filters;
a.filters = [new F.BlurFilter(6, 2, 2)];
b.filters = [new F.GlowFilter(0xff3300, 0.8, 8, 8, 2, 1)];
c.filters = [new F.DropShadowFilter(5, 60, 0x000000, 0.6, 4, 4, 1, 1)];
d.filters = [new F.BevelFilter(3, 45, 0xffffff, 1, 0x000000, 1, 3, 3, 1, 1, "inner")];
e.filters = [new F.ColorMatrixFilter([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0])];
f.filters = [new F.GradientGlowFilter(0, 45, [0xffffff, 0xff0000], [0, 1], [0, 255], 6, 6, 1, 1, "outer")];
g.filters = [new F.BlurFilter()]; g.filters = [];
g.filters = c.filters;
trace(a.filters[0].blurX + " " + g.filters.length + " " + g.filters[0].distance);`,
          8,
        ),
      ],
      [as1(`stop();`, 8)],
    ],
  );
}

/** Clip actions for a place in a SWF of `version`: each record's events and its AS1 source. */
const clipEvents = (version: number, records: [number, string][]) =>
  w.clipActions(
    version,
    records.map(([events, source]) => ({
      events,
      actions: [...script(source, version)(flashAssembler()).end().bytes()],
    })),
  );

// The clip events' bits (format's ClipEvent).
const EVENT = {
  load: 1 << 0,
  enterFrame: 1 << 1,
  unload: 1 << 2,
  mouseDown: 1 << 4,
  data: 1 << 8,
  initialize: 1 << 9,
  construct: 1 << 18,
};

/** Clip actions that trace each event's name, `tag` and the clip's name. */
const tracedEvents = (version: number, tag: string, events: (keyof typeof EVENT)[]) =>
  clipEvents(
    version,
    events.map((e) => [EVENT[e], `trace("${tag} ${e} " + this._name);`]),
  );

// Clip events in a SWF of `version` (docs/avm1.md, "Clip events"): a
// clip's initialize, construct, load, enterFrame and unload, its child's
// first, the events nothing brings (mouseDown, data) never; from SWF 6
// the handlers set as methods, onLoad, onEnterFrame and onUnload, after
// the clip actions; and a clip removed with an unload handler, kept a
// frame at a depth below the timeline's.
function avm1Events(version: number): Uint8Array {
  const handlers = version >= 6;
  const kid = avm1Sprite(2, [
    [w.place({ depth: 1, character: 1 }), as1(`trace("kid frame " + _name);`, version)],
  ]);
  const clip = avm1Sprite(3, [
    [
      w.place({
        depth: 1,
        character: 2,
        name: "kid",
        clipActions: tracedEvents(version, "kid", [
          "initialize",
          "construct",
          "load",
          "enterFrame",
          "unload",
        ]),
      }),
      as1(`trace("clip frame 1 " + _name);`, version),
    ],
    [as1(`trace("clip frame 2 " + _name);`, version)],
  ]);
  return avm1Swf(
    version,
    [square(1, 0x3366cc, 200), kid, clip],
    [
      [
        as1(`trace("root 1");`, version),
        w.place({
          depth: 1,
          character: 3,
          name: "a",
          clipActions: tracedEvents(version, "a", [
            "initialize",
            "construct",
            "load",
            "enterFrame",
            "unload",
            "mouseDown",
            "data",
          ]),
        }),
        as1(
          handlers
            ? `trace("root 1 after " + typeof a.kid);
a.onLoad = function () { trace("a onLoad"); };
a.onEnterFrame = function () { trace("a onEnterFrame " + this._currentframe); };
a.onUnload = function () { trace("a onUnload " + this._name); };
_root.onEnterFrame = function () { trace("root onEnterFrame " + _currentframe); };`
            : `trace("root 1 after " + typeof a.kid);`,
          version,
        ),
      ],
      [
        as1(`trace("root 2");`, version),
        w.place({ depth: 2, character: 3, name: "b" }),
        as1(
          handlers
            ? `b.onUnload = function () { trace("b onUnload " + this._name + " " + typeof this.kid); };`
            : `trace("b " + typeof b);`,
          version,
        ),
      ],
      [
        w.remove(1),
        as1(`trace("root 3 " + typeof a + " " + a._name + " " + typeof a.kid);`, version),
      ],
      [w.remove(2), as1(`trace("root 4 " + typeof a + " " + typeof b);`, version)],
      [as1(`trace("root 5"); delete _root.onEnterFrame; stop();`, version)],
    ],
  );
}

// Clips made with a class Object.registerClass binds to their symbol, in a
// SWF of `version`, avm1/construct.as: by the timeline, by
// duplicateMovieClip, attachMovie and createEmptyMovieClip, with their
// clip events' and constructors' order.
function avm1Construct(version: number): Uint8Array {
  const source = readFileSync(new URL("avm1/construct.as", import.meta.url), "utf8");
  const show = (what: string) =>
    `trace("${what} " + this._name + " p=" + this.p + " q=" + this.q + " kid=" + typeof this.kid + " hello=" + typeof this.hello + " own=" + this.hasOwnProperty("p"));`;
  const kid = avm1Sprite(3, [[as1(`trace("kid frame 1 " + _parent._name);`, version)]]);
  const clip = avm1Sprite(2, [
    [
      w.place({
        depth: 1,
        character: 3,
        name: "kid",
        clipActions: clipEvents(version, [
          [EVENT.initialize, `trace("kid initialize " + _parent._name);`],
          [EVENT.construct, `trace("kid construct " + _parent._name);`],
          [EVENT.load, `trace("kid load " + _parent._name);`],
        ]),
      }),
      as1(`trace("clip frame 1 " + this._name + " " + this.q);`, version),
    ],
  ]);
  const register = `_global.C = function () { trace("C " + this._name + " p=" + this.p + " kid=" + typeof this.kid); this.q = 1; };
C.prototype = new MovieClip();
C.prototype.hello = function () { return "hi"; };
trace("registered " + Object.registerClass("clip", C));`;
  return avm1Swf(
    version,
    [kid, clip, w.exportAssets([[2, "clip"]])],
    [
      [
        w.place({
          depth: 1,
          character: 2,
          name: "a",
          clipActions: clipEvents(version, [
            [EVENT.initialize, show("initialize")],
            [EVENT.construct, show("construct")],
            [EVENT.load, show("load")],
          ]),
        }),
        w.doInitAction(2, [...script(register, version)(flashAssembler()).end().bytes()]),
        as1(source, version),
      ],
      [as1(`trace("root 2"); stop();`, version)],
    ],
  );
}

// Clips a script makes and removes by depth in a SWF of `version`,
// avm1/depths.as, and from SWF 7 avm1/depths7.as.
function avm1Depths(version: number): Uint8Array {
  const read = (name: string) => readFileSync(new URL(`avm1/${name}.as`, import.meta.url), "utf8");
  const clip = avm1Sprite(2, [[w.place({ depth: 1, character: 1 })]]);
  return avm1Swf(
    version,
    [square(1, 0x3366cc, 200), clip, w.exportAssets([[2, "clip"]])],
    [
      [
        w.place({ depth: 1, character: 2, name: "a" }),
        as1(read("depths"), version),
        ...(version >= 7 ? [as1(read("depths7"), version)] : []),
      ],
      [as1(`trace("root 2 " + typeof _root.y + " " + typeof _root.c1); stop();`, version)],
    ],
  );
}

// #initclip, the root's DoInitAction blocks (docs/avm1.md, "The frame"):
// a frame's run as the root enters it, before its places and its actions,
// in tag order, a sprite's once; a sprite attached before its own runs.
function avm1Initclip(): Uint8Array {
  const version = 6;
  const init = (sprite: number, source: string) =>
    w.doInitAction(sprite, [...script(source, version)(flashAssembler()).end().bytes()]);
  const sprite = (id: number) =>
    avm1Sprite(id, [[as1(`trace("sprite ${id} " + _name);`, version)]]);
  return avm1Swf(
    version,
    [
      sprite(2),
      sprite(3),
      sprite(4),
      w.exportAssets([
        [2, "two"],
        [3, "three"],
        [4, "four"],
      ]),
    ],
    [
      [
        as1(`trace("root 1"); attachMovie("three", "early", 1);`, version),
        w.place({ depth: 2, character: 2, name: "placed" }),
        init(2, `trace("init two");`),
        init(4, `trace("init four");`),
      ],
      [
        init(3, `trace("init three");`),
        as1(`trace("root 2");`, version),
        init(2, `trace("init two again");`),
        w.place({ depth: 3, character: 3, name: "late" }),
      ],
      [as1(`trace("root 3"); attachMovie("four", "four", 4); stop();`, version)],
    ],
  );
}

// setTimeout and setInterval in a SWF of `version` at 2 frames a second,
// avm1/timers.as: what they fire between frames, by Flash's clock and the
// tests' frame clock alike.
function avm1Timers(version: number): Uint8Array {
  const source = readFileSync(new URL("avm1/timers.as", import.meta.url), "utf8");
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 2,
    frameCount: 7,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      as1(source, version),
      w.showFrame(),
      as1(`trace("root 2");`, version),
      w.showFrame(),
      as1(`trace("root 3");`, version),
      w.showFrame(),
      as1(`trace("root 4");`, version),
      w.showFrame(),
      as1(`trace("root 5"); delete _root.onEnterFrame;`, version),
      w.showFrame(),
      w.showFrame(),
      as1(`trace("root 7 " + later.join(", ")); stop();`, version),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Past the recursion limit, a ScriptLimits of 40 here, Flash disables the
// movie's actions, the rest of the frame's and every later frame's, which
// no catch or finally runs, and its timeline plays on: frame 2 places a
// square, which frame 3 shows.
function avm1Recursion(): Uint8Array {
  return w.swf({
    version: 6,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.backgroundColor(0xffffff),
      w.tag(tags.ScriptLimits, Uint8Array.from([40, 0, 15, 0])),
      square(1, 0xff0000, 400),
      block(
        setVar("depth", lit(0)),
        defineFn(
          "deep",
          [],
          setVar("depth", op("Increment", getVar("depth"))),
          ifThen(op("Greater", getVar("depth"), lit(35)), traceOf(getVar("depth"))),
          drop(callFunction("deep")),
          note("unwound"),
        ),
        tryDo("e", [drop(callFunction("deep"))], traceCaught("e"), [note("not finally")]),
        note("after"),
      ),
      block(note("the next block")),
      w.showFrame(),
      w.place({ depth: 1, character: 1, matrix: { tx: 100, ty: 100 } }),
      block(note("frame 2")),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A ScriptLimits takes effect as its frame comes, before the frame's
// actions, and of two in a frame the later: frame 1 recurses 100 deep
// under Flash's default limit, frame 2 sets 80 then 40, under which 30
// deep runs and 60 disables the actions, frame 3's too.
function avm1ScriptLimits(): Uint8Array {
  const limits = (depth: number) => w.tag(tags.ScriptLimits, Uint8Array.from([depth, 0, 15, 0]));
  const recurse = (n: number) => [
    setVar("depth", lit(0)),
    drop(callFunction("deep", lit(n))),
    traceOf(op("Add2", lit("reached "), getVar("depth"))),
  ];
  return w.swf({
    version: 6,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.backgroundColor(0xffffff),
      block(
        defineFn(
          "deep",
          ["n"],
          setVar("depth", op("Increment", getVar("depth"))),
          ifThen(
            op("Less2", getVar("depth"), getVar("n")),
            drop(callFunction("deep", getVar("n"))),
          ),
        ),
        ...recurse(100),
      ),
      w.showFrame(),
      block(note("frame 2"), ...recurse(30)),
      limits(80),
      limits(40),
      block(...recurse(60), note("unreached")),
      w.showFrame(),
      block(note("frame 3")),
      w.showFrame(),
      w.end(),
    ],
  });
}

let controlLabels = 0;
const label = () => `c${controlLabels++}`;
const at =
  (name: string): Avm1Statement =>
  (a) =>
    a.label(name);
const goTo =
  (name: string): Avm1Statement =>
  (a) =>
    a.jump(name);
const throwOf =
  (e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).op("Throw");
/** Bytes as they are, for the stack's cases. */
const code =
  (write: (a: Avm1Assembler) => Avm1Assembler): Avm1Statement =>
  (a) =>
    write(a);
/** `with (o) { statements }`. */
const withDo =
  (o: Avm1Expr, ...statements: Avm1Statement[]): Avm1Statement =>
  (a) => {
    const end = label();
    return statements.reduce((b, s) => s(b), o(a).with(end)).label(end);
  };
/**
 * `try { body } catch (into) { caught } finally { always }`, as compilers
 * write it: the try body and the catch go on at the finally. A null catch
 * or finally is none; `runOff` leaves out the try body's jump past the
 * catch, so that it runs off into the catch's bytes.
 */
const tryDo =
  (
    into: string | number,
    body: Avm1Statement[],
    caught: Avm1Statement[] | null,
    always: Avm1Statement[] | null,
    runOff = false,
  ): Avm1Statement =>
  (a) => {
    const catchAt = label();
    const finallyAt = label();
    const end = label();
    const flags =
      (caught ? TryFlag.catch : 0) |
      (always ? TryFlag.finally : 0) |
      (typeof into === "number" ? TryFlag.catchInRegister : 0);
    a.try(typeof into === "number" ? register(into) : into, catchAt, finallyAt, end, flags);
    body.reduce((b, s) => s(b), a);
    if (caught && !runOff) {
      a.jump(finallyAt);
    }

    a.label(catchAt);
    (caught ?? []).reduce((b, s) => s(b), a);
    a.label(finallyAt);
    (always ?? []).reduce((b, s) => s(b), a);
    return a.label(end);
  };
const concat = (...parts: Avm1Expr[]): Avm1Expr => parts.reduce((x, y) => op("Add2", x, y));
/** `catch (e) { trace("caught " + e) }`. */
const traceCaught = (into: string) => [traceOf(concat(lit("caught "), getVar(into)))];
/** `depth` Withs one in another, each of an object whose `v` is its depth, `v` traced in the last. */
const withNest = (depth: number): Avm1Statement => {
  let s: Avm1Statement = traceOf(concat(lit(`${depth} deep: `), getVar("v")));
  for (let k = depth; k >= 1; k--) {
    s = withDo(initObject(["v", lit(k)]), s, ...(k === depth - 1 ? [note(`left ${depth}`)] : []));
  }

  return s;
};

// What With, Try and Throw do in a SWF of `version`, as adl traces it
// (docs/avm1.md, "With and Try"): a With's object on the scope chain while
// control stays in its body, its body skipped for undefined, null, or a
// chain already 15 deep; a jump out of a body, back before it or into it;
// Try's catch, its variable the catch body's own or a register, the
// finally after a throw, a Return or neither, and a throw again as control
// leaves it; the operand stack a throw cuts back; throws through calls,
// getters, watchers and conversions; Error; and a throw nothing catches,
// which ends its block and nothing else.
function avm1Control(version: number): Uint8Array {
  const o = initObject(["a", lit("oa")], ["x", lit("ox")]);
  const out = label();
  const back = label();
  const into = label();
  const tryBack = label();
  const tryInto = label();
  const finallyOut = label();
  const finallyOut2 = label();
  const returnOut = label();
  const pastOut = label();
  const pastEnd = label();
  const pastBack = label();
  const pastDone = label();
  const i = getVar("i");
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 3,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      block(
        note("-- with"),
        setVar("o", o),
        setVar("a", lit("root a")),
        withDo(
          getVar("o"),
          traceOf(getVar("a")),
          setVar("a", lit("set a")),
          setVar("nb", lit("nb")),
          local("dl", lit("dl")),
          local("x", lit("set x")),
        ),
        traceOf(member(getVar("o"), "a")),
        traceOf(member(getVar("o"), "nb")),
        traceOf(getVar("nb")),
        traceOf(member(getVar("o"), "dl")),
        traceOf(getVar("dl")),
        traceOf(member(getVar("o"), "x")),
        traceOf(getVar("a")),
        withDo(lit(undefined), note("not with undefined")),
        withDo(lit(null), note("not with null")),
        withDo(lit(5), traceOf(callFunction("toString")), traceOf(getVar("length"))),
        withDo(lit("abc"), traceOf(getVar("length"))),
        withDo(lit(true), traceOf(callFunction("toString"))),
        note("-- with: jumps"),
        setVar("i", lit(0)),
        withDo(getVar("o"), traceOf(getVar("a")), goTo(out), note("not after the jump")),
        at(out),
        traceOf(getVar("x")),
        at(back),
        traceOf(getVar("x")),
        setVar("i", op("Increment", i)),
        withDo(
          getVar("o"),
          traceOf(getVar("x")),
          code((a) => a.push("i").op("GetVariable").push(2).op("Less2").if(back)),
          note("the body's end"),
        ),
        goTo(into),
        withDo(getVar("o"), note("not run"), at(into), traceOf(getVar("x"))),
        note("-- with: depth"),
        withNest(13),
        withNest(14),
        note("in a function"),
        defineFn("deeper", [], withNest(12), withNest(13)),
        drop(callFunction("deeper")),
        // A function defined in 5 Withs, which from SWF 6 it closes over.
        [1, 2, 3, 4, 5].reduceRight<Avm1Statement>(
          (inner, k) => withDo(initObject(["v", lit(`closed over ${k}`)]), inner),
          defineFn("closure", [], withNest(7), withNest(8), traceOf(getVar("v"))),
        ),
        drop(callFunction("closure")),
        note("-- with: one action late"),
        withDo(
          getVar("o"),
          code((a) => a.push("a")),
        ),
        code((a) => a.op("GetVariable").trace()),
        withDo(
          getVar("o"),
          code((a) => a.push("a")),
        ),
        traceOf(getVar("a")),
        // A function defined by the first action past a body closes over its scope.
        withDo(getVar("o")),
        defineFn("late", [], traceOf(getVar("x"))),
        drop(callFunction("late")),
        withNest(13),
        defineFn("full", [], traceOf(getVar("v")), withNest(1)),
        drop(callFunction("full")),
        note("-- with: where control goes past a body"),
        // Only the first action past a body runs in its scope: one a jump reaches does not.
        withDo(
          getVar("o"),
          code((a) => a.push("x")),
          goTo(pastOut),
        ),
        note("not run"),
        at(pastOut),
        code((a) => a.op("GetVariable").trace()),
        withDo(
          getVar("o"),
          code((a) => a.push("x")),
          goTo(pastEnd),
        ),
        at(pastEnd),
        code((a) => a.op("GetVariable").trace()),
        // A jump back before the With finds no scope.
        setVar("i", lit(0)),
        code((a) => a.push("x")),
        at(pastBack),
        code((a) => a.op("GetVariable").trace()),
        setVar("i", op("Increment", i)),
        code((a) => a.push("i").op("GetVariable").push(2).op("Less2").op("Not").if(pastDone)),
        withDo(
          getVar("o"),
          code((a) => a.push("x")),
          goTo(pastBack),
        ),
        at(pastDone),
        // A With as the first action past a body keeps that scope under its own, and both come
        // off together; a jump from there back into the body keeps it too.
        setVar("p", initObject(["q", lit("pq")])),
        withDo(
          getVar("o"),
          code((a) => a.push("p").op("GetVariable")),
        ),
        withDo(
          code((a) => a),
          traceOf(getVar("x")),
          code((a) => a.push("x")),
        ),
        code((a) => a.op("GetVariable").trace()),
        traceOf(getVar("x")),
        setVar("i", lit(0)),
        code((a) => {
          const body = label();
          const end = label();
          a.push("o").op("GetVariable").with(end).label(body);
          a.push("x").op("GetVariable").trace();
          a.push("i", "i").op("GetVariable").op("Increment").op("SetVariable");
          return a.push("i").op("GetVariable").push(2).op("Less2").label(end).if(body);
        }),
        traceOf(getVar("x")),
        // A throw as the first action past a body keeps its scope over the catch body; a finally
        // reached by a throw or a Return keeps a scope only for its first action, and only where
        // that is the first action past the scope's body.
        tryDo(
          "e",
          [
            withDo(
              getVar("o"),
              code((a) => a.push("t")),
            ),
            code((a) => a.op("Throw")),
          ],
          [traceOf(getVar("x"))],
          null,
        ),
        tryDo(
          "e",
          [
            code((a) => a.push("x")),
            tryDo("i", [withDo(getVar("o"), throwOf(lit(1)))], null, [
              code((a) => a.op("GetVariable").trace()),
              traceOf(getVar("x")),
            ]),
          ],
          [],
          null,
        ),
        tryDo(
          "e",
          [
            code((a) => a.push("x")),
            tryDo("i", [withDo(getVar("o"), throwOf(lit(1))), note("not run")], null, [
              code((a) => a.op("GetVariable").trace()),
            ]),
          ],
          [],
          null,
        ),
        defineFn(
          "pastReturn",
          [],
          tryDo("e", [withDo(getVar("o"), ret(lit("x")))], null, [
            code((a) => a.op("GetVariable").trace()),
            traceOf(getVar("x")),
            code((a) => a.push("returned")),
          ]),
        ),
        traceOf(callFunction("pastReturn")),
        note("-- with: functions"),
        defineFn("g", [], withDo(getVar("o"), ret(getVar("x"))), note("not after return")),
        traceOf(callFunction("g")),
        defineFn(
          "h",
          [],
          withDo(getVar("o"), local("loc", lit("local")), setVar("sv", lit("set"))),
          traceOf(getVar("loc")),
        ),
        drop(callFunction("h")),
        traceOf(op("TypeOf", getVar("loc"))),
        traceOf(getVar("sv")),
        tryDo(
          "e",
          [withDo(getVar("o"), throwOf(getVar("a")))],
          [traceOf(getVar("e")), traceOf(getVar("x"))],
          null,
        ),
      ),
      block(
        note("-- try"),
        tryDo(
          "e",
          [note("try"), throwOf(lit("x")), note("not after the throw")],
          traceCaught("e"),
          [note("finally")],
        ),
        tryDo(
          "e",
          [note("runs off")],
          [note("the catch's bytes"), traceOf(getVar("e"))],
          [note("finally")],
          true,
        ),
        tryDo("e", [throwOf(lit(3))], [traceOf(op("TypeOf", getVar("e")))], null),
        tryDo(
          "e",
          [throwOf(initObject(["m", lit("an object")]))],
          [traceOf(member(getVar("e"), "m"))],
          null,
        ),
        tryDo("e", [throwOf(lit(undefined))], [traceOf(op("TypeOf", getVar("e")))], null),
        tryDo("e", [code((a) => a.op("Throw"))], [traceOf(op("TypeOf", getVar("e")))], null),
        note("-- try: finally"),
        tryDo(
          "o1",
          [tryDo("i1", [throwOf(lit("A"))], null, [note("inner finally")])],
          traceCaught("o1"),
          null,
        ),
        tryDo(
          "o2",
          [
            tryDo(
              "i2",
              [throwOf(lit("B"))],
              [traceOf(getVar("i2")), throwOf(lit("C"))],
              [note("inner finally")],
            ),
            note("not after"),
          ],
          traceCaught("o2"),
          null,
        ),
        tryDo(
          "o3",
          [tryDo("i3", [throwOf(lit("D"))], [throwOf(lit("E"))], null)],
          traceCaught("o3"),
          null,
        ),
        tryDo(
          "o4",
          [
            tryDo("i4", [throwOf(lit("F"))], null, [note("inner finally"), goTo(finallyOut)]),
            at(finallyOut),
            note("not after"),
          ],
          traceCaught("o4"),
          null,
        ),
        tryDo(
          "o5",
          [
            tryDo("i5", [note("no throw")], null, [note("inner finally"), goTo(finallyOut2)]),
            at(finallyOut2),
            note("after the jump"),
          ],
          traceCaught("o5"),
          null,
          true,
        ),
        note("-- try: return"),
        defineFn(
          "r1",
          [],
          tryDo("e", [ret(lit("from try"))], null, [note("finally")]),
          note("not after"),
        ),
        traceOf(callFunction("r1")),
        defineFn(
          "r2",
          [],
          tryDo("e", [throwOf(lit("x"))], [ret(lit("from catch"))], [note("finally")]),
        ),
        traceOf(callFunction("r2")),
        defineFn("r3", [], tryDo("e", [throwOf(lit("x"))], null, [ret(lit("from finally"))])),
        traceOf(callFunction("r3")),
        defineFn("r4", [], tryDo("e", [ret(lit("from try"))], null, [ret(lit("from finally"))])),
        traceOf(callFunction("r4")),
        defineFn(
          "r5",
          [],
          tryDo("e", [ret(lit("from try"))], null, [note("finally"), goTo(returnOut)]),
          at(returnOut),
          note("not after the jump"),
        ),
        traceOf(callFunction("r5")),
        defineFn(
          "r6",
          [],
          tryDo(
            "o",
            [tryDo("e", [ret(lit("inner"))], null, [note("inner finally")]), note("not after")],
            null,
            [note("outer finally")],
          ),
        ),
        traceOf(callFunction("r6")),
        defineFn(
          "r7",
          [],
          tryDo("e", [throwOf(lit("x"))], [ret(lit("from catch"))], [throwOf(lit("from finally"))]),
        ),
        tryDo("e", [traceOf(callFunction("r7"))], traceCaught("e"), null),
        // A Return cuts the stack back to the Try's height, its value left on top, for the finally.
        defineFn(
          "r8",
          [],
          code((a) => a.push("f0")),
          tryDo("e", [code((a) => a.push("j1", "j2", "from try").op("Return"))], null, [
            note("finally"),
          ]),
        ),
        code((a) => a.push("c1")),
        traceOf(callFunction("r8")),
        code((a) => a.trace().trace()),
      ),
      block(
        note("-- try: catch"),
        setVar("e", lit("outer")),
        tryDo(
          "e",
          [throwOf(lit("thrown"))],
          [
            traceOf(getVar("e")),
            setVar("e", lit("set in the catch")),
            local("cl", lit("local in the catch")),
            defineFn("cf", [], traceOf(getVar("e"))),
          ],
          null,
        ),
        traceOf(getVar("e")),
        traceOf(getVar("cl")),
        drop(callFunction("cf")),
        tryDo("x1", [throwOf(lit("x1"))], [], null),
        traceOf(op("TypeOf", getVar("x1"))),
        defineFn(
          "f",
          [],
          local("e", lit("local e")),
          tryDo("e", [throwOf(lit("in f"))], [traceOf(getVar("e"))], null),
          traceOf(getVar("e")),
        ),
        drop(callFunction("f")),
        tryDo("e", [throwOf(lit("x"))], [withNest(12), withNest(13)], null),
        setVar("pp", initObject()),
        tryDo("pp.q", [throwOf(lit("path"))], [traceOf(getVar("pp.q"))], null),
        traceOf(member(getVar("pp"), "q")),
        withDo(
          getVar("o"),
          tryDo("e", [throwOf(lit("in a with"))], [traceOf(getVar("e"))], null),
          traceOf(getVar("e")),
        ),
        // A throw in a With body keeps the With's object over the catch body, an action past it,
        // and an outer catch's body where the catch throws again.
        tryDo("e", [withDo(getVar("o"), throwOf(lit("x")))], [code((a) => a.push("x"))], null),
        code((a) => a.op("GetVariable").trace()),
        traceOf(getVar("x")),
        tryDo(
          "e",
          [tryDo("i", [withDo(getVar("o"), throwOf(lit("x")))], [throwOf(lit("y"))], null)],
          [traceOf(getVar("x")), traceOf(getVar("e")), traceOf(getVar("i"))],
          [traceOf(getVar("x"))],
        ),
        tryDo(1, [throwOf(lit("r1"))], [traceOf(reg(1))], null),
        traceOf(reg(1)),
        tryDo(7, [throwOf(lit("r7"))], [traceOf(reg(7))], null),
        defineFn2(
          "f2",
          4,
          0,
          [],
          tryDo(2, [throwOf(lit("local r2"))], [traceOf(reg(2))], null),
          traceOf(reg(2)),
          tryDo(5, [throwOf(lit("r5"))], [traceOf(reg(5))], null),
          tryDo(0, [throwOf(lit("r0"))], [traceOf(reg(0))], null),
        ),
        drop(callFunction("f2")),
        traceOf(reg(2)),
        note("-- try: the stack"),
        code((a) => a.push("below")),
        tryDo(
          "e",
          [code((a) => a.push("t1", "t2")), throwOf(lit("x"))],
          [code((a) => a.op("PushDuplicate").trace())],
          null,
        ),
        code((a) => a.trace().trace()),
        code((a) => a.push(1, 2, 3)),
        tryDo(
          "e",
          [code((a) => a.pop().pop()), throwOf(lit("x"))],
          [code((a) => a.op("PushDuplicate").trace())],
          null,
        ),
        code((a) => a.trace().trace()),
        defineFn(
          "pusher",
          [],
          code((a) => a.push("f1", "f2")),
          throwOf(lit("from pusher")),
        ),
        code((a) => a.push("under")),
        tryDo(
          "e",
          [drop(callFunction("pusher"))],
          [code((a) => a.op("PushDuplicate").trace())],
          null,
        ),
        code((a) => a.trace().trace()),
        code((a) => a.push("s1")),
        tryDo(
          "o",
          [
            code((a) => a.push("s2")),
            tryDo("i", [code((a) => a.push("s3")), throwOf(lit("y"))], null, [
              code((a) => a.op("PushDuplicate").trace()),
            ]),
          ],
          [code((a) => a.op("PushDuplicate").trace())],
          null,
        ),
        code((a) => a.trace().trace()),
      ),
      block(
        note("-- try: through calls"),
        defineFn("thrower", ["x"], throwOf(getVar("x"))),
        defineFn("mid", [], drop(callFunction("thrower", lit("deep"))), note("not after")),
        tryDo("e", [drop(callFunction("mid"))], traceCaught("e"), null),
        setVar("p", initObject()),
        drop(
          callMethod(
            getVar("p"),
            "addProperty",
            lit("got"),
            fnExpr([], throwOf(lit("getter"))),
            lit(null),
          ),
        ),
        tryDo("e", [traceOf(member(getVar("p"), "got"))], traceCaught("e"), null),
        drop(
          callMethod(
            getVar("p"),
            "addProperty",
            lit("put"),
            fnExpr([], ret(lit("got"))),
            fnExpr(["v"], throwOf(lit("setter"))),
          ),
        ),
        tryDo("e", [setMember(getVar("p"), "put", lit(1))], traceCaught("e"), null),
        traceOf(member(getVar("p"), "put")),
        setVar("ts", initObject()),
        setMember(getVar("ts"), "toString", fnExpr([], note("toString"), throwOf(lit("toString")))),
        tryDo("e", [traceOf(getVar("ts"))], traceCaught("e"), null),
        tryDo("e", [traceOf(concat(lit("in Add2 "), getVar("ts")))], traceCaught("e"), null),
        setVar("fn", fnExpr([])),
        setMember(getVar("fn"), "toString", fnExpr([], throwOf(lit("a function's toString")))),
        tryDo("e", [traceOf(getVar("fn"))], traceCaught("e"), null),
        setVar("ts2", initObject()),
        setMember(getVar("ts2"), "toString", fnExpr([], note("not the second toString"))),
        tryDo(
          "e",
          [traceOf(callMethod(initArray(getVar("ts"), getVar("ts2")), "join"))],
          traceCaught("e"),
          null,
        ),
        setMember(getVar("ts"), "valueOf", fnExpr([], throwOf(lit("valueOf")))),
        tryDo("e", [traceOf(op("Add2", getVar("ts"), lit(1)))], traceCaught("e"), null),
        tryDo(
          "e",
          [traceOf(callMethod(getVar("thrower"), "call", lit(null), lit("by call")))],
          traceCaught("e"),
          null,
        ),
        tryDo(
          "e",
          [traceOf(callMethod(getVar("thrower"), "apply", lit(null), initArray(lit("by apply"))))],
          traceCaught("e"),
          null,
        ),
        setVar("wt", initObject(["k", lit(1)])),
        drop(callMethod(getVar("wt"), "watch", lit("k"), fnExpr([], throwOf(lit("watcher"))))),
        tryDo("e", [setMember(getVar("wt"), "k", lit(2))], traceCaught("e"), null),
        traceOf(member(getVar("wt"), "k")),
        setVar("rs", initObject()),
        setMember(getVar("rs"), "__resolve", fnExpr([], throwOf(lit("__resolve")))),
        tryDo("e", [traceOf(member(getVar("rs"), "zz"))], traceCaught("e"), null),
        defineFn("Thrower", [], throwOf(lit("a constructor"))),
        tryDo("e", [traceOf(newObject("Thrower"))], traceCaught("e"), null),
        tryDo(
          "e",
          [setVar("q", callFunction("thrower", lit("an argument")))],
          traceCaught("e"),
          null,
        ),
        traceOf(op("TypeOf", getVar("q"))),
      ),
      block(
        note("-- Error"),
        traceOf(op("TypeOf", getVar("Error"))),
        keysOf(proto("Error")),
        keysOf(getVar("Error")),
        traceOf(member(proto("Error"), "message")),
        traceOf(member(proto("Error"), "name")),
        traceOf(op("Equals2", member(proto("Error"), "__proto__"), OBJECT_PROTO)),
        setVar("err", newObject("Error", lit("a message"))),
        traceOf(getVar("err")),
        traceOf(member(getVar("err"), "message")),
        traceOf(member(getVar("err"), "name")),
        traceOf(callMethod(getVar("err"), "toString")),
        keysOf(getVar("err")),
        traceOf(callMethod(getVar("err"), "hasOwnProperty", lit("message"))),
        traceOf(callMethod(getVar("err"), "hasOwnProperty", lit("name"))),
        traceOf(op("Equals2", member(getVar("err"), "__constructor__"), getVar("Error"))),
        traceOf(newObject("Error")),
        traceOf(callMethod(newObject("Error"), "hasOwnProperty", lit("message"))),
        traceOf(callMethod(newObject("Error", lit(undefined)), "hasOwnProperty", lit("message"))),
        traceOf(newObject("Error", lit(null))),
        traceOf(op("TypeOf", member(newObject("Error", lit(5)), "message"))),
        setMember(getVar("err"), "name", initObject()),
        traceOf(member(getVar("err"), "name")),
        traceOf(callFunction("Error", lit("called"))),
        traceOf(
          callMethod(
            member(proto("Error"), "toString"),
            "call",
            initObject(["message", lit("borrowed")]),
          ),
        ),
        traceOf(callMethod(member(proto("Error"), "toString"), "call", lit(5))),
        traceOf(concat(lit("in Add2: "), getVar("err"))),
        setVar("Sub", fnExpr([])),
        setMember(getVar("Sub"), "prototype", newObject("Error")),
        setMember(proto("Sub"), "name", lit("SubError")),
        traceOf(member(newObject("Sub", lit("not taken")), "name")),
        tryDo(
          "e",
          [throwOf(newObject("Error", lit("thrown")))],
          [traceOf(getVar("e")), traceOf(member(getVar("e"), "message"))],
          null,
        ),
      ),
      block(
        note("-- try: jumps"),
        setVar("i", lit(0)),
        at(tryBack),
        setVar("i", op("Increment", i)),
        ifThen(op("Equals2", i, lit(2)), note("thrown with no handler"), throwOf(lit("back"))),
        tryDo("e", [note("try"), goTo(tryBack)], traceCaught("e"), null),
        note("not after the try"),
      ),
      block(
        goTo(tryInto),
        tryDo(
          "e",
          [note("not run"), at(tryInto), note("into the try body"), throwOf(lit("in"))],
          traceCaught("e"),
          null,
        ),
        note("not after the throw"),
      ),
      block(
        note("-- uncaught"),
        code((a) => a.push("left")),
        throwOf(lit("U")),
        note("not after the throw"),
      ),
      block(
        note("the next block"),
        code((a) => a.trace().trace()),
      ),
      w.showFrame(),
      block(
        note("-- frame 2"),
        defineFn(
          "uncaught",
          [],
          code((a) => a.push("pushed")),
          throwOf(lit("U")),
          note("not after the throw"),
        ),
        code((a) => a.push("under")),
        drop(callFunction("uncaught")),
        note("not after the call"),
      ),
      block(
        note("the next block"),
        code((a) => a.trace().trace()),
      ),
      w.showFrame(),
      block(note("-- frame 3"), (a) => a.stop()),
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

// When content from Loader.loadBytes comes (scripts/LoaderBytesFrames.as):
// a small SWF, and a large one of 200 classes' ABC and a megabyte of
// sounds, each in the frame after the call whatever its size, as adl has
// it. Their bytes are DefineBinaryData bound to ByteArray subclasses, too
// large for the script's source.
function loaderBytesFrames(compile: Compile): Uint8Array {
  const bytesClass = (name: string) =>
    compile(
      name,
      `package { import flash.utils.ByteArray; public class ${name} extends ByteArray { public function ${name}() { super(); } } }`,
    );
  const inner = (name: string, body: string, tags: Uint8Array[]) =>
    w.swf({
      width: 100,
      height: 50,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        ...tags,
        w.doAbc(
          compile(
            name,
            `package { import flash.display.MovieClip; public class ${name} extends MovieClip { public function ${name}() { ${body} addFrameScript(0, function():void { trace("${name} frame 1"); }); } } }`,
          ),
          name,
        ),
        w.symbolClass([[0, name]]),
        w.showFrame(),
        w.end(),
      ],
    });
  const classes = Array.from(
    { length: 200 },
    (_, c) =>
      `package { public class Many${c} { public static function f(x:int):int { var y:int = x; for (var i:int = 0; i < 4; i++) { y = (y ^ i) + ${c}; } return y; } public function g():String { return "${c}"; } } }`,
  );
  const sounds = Array.from({ length: 4 }, (_, k) => {
    const data = new Uint8Array(250_000);
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 7 + k) & 0xff;
    }

    return w.defineSound(
      10 + k,
      { rate: 3, sixteen: true, stereo: true, samples: data.length / 4 },
      data,
    );
  });
  const small = inner("SmallInner", `trace("SmallInner made");`, []);
  const large = inner("LargeInner", `trace("LargeInner made", Many0.f(1) + Many199.f(2));`, [
    ...sounds,
    w.doAbc(compile("ManyClasses", classes.join("\n")), "ManyClasses"),
  ]);
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.binaryData(1, small),
      w.binaryData(2, large),
      w.doAbc(bytesClass("SmallBytes"), "SmallBytes"),
      w.doAbc(bytesClass("LargeBytes"), "LargeBytes"),
      w.doAbc(compile("LoaderBytesFrames"), "LoaderBytesFrames"),
      w.symbolClass([
        [1, "SmallBytes"],
        [2, "LargeBytes"],
        [0, "Main"],
      ]),
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

/** A sound the tests made (sounds/README.md). */
const soundFile = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`sounds/${name}`, import.meta.url)));

/** 16-bit little-endian samples, as uncompressed DefineSound data. */
function pcm16(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (const [i, v] of samples.entries()) {
    view.setInt16(i * 2, v, true);
  }

  return out;
}

const ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const ADPCM_STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/**
 * SWF's 4-bit ADPCM of 16-bit samples, a list a channel: the code size,
 * then packets of each channel's sample and step index and 4095 codes, as
 * a decoder steps through them.
 */
function adpcm(channels: number[][]): Uint8Array {
  const bytes: number[] = [];
  let acc = 0;
  let count = 0;
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++count === 8) {
        bytes.push(acc);
        acc = 0;
        count = 0;
      }
    }
  };

  put(2, 2);
  const frames = channels[0].length;
  const sample = channels.map(() => 0);
  const index = channels.map(() => 0);
  for (let i = 0; i < frames; i++) {
    if (i % 4096 === 0) {
      for (const [c, channel] of channels.entries()) {
        sample[c] = channel[i];
        index[c] = Math.min(index[c], 63);
        put(sample[c] & 0xffff, 16);
        put(index[c], 6);
      }

      continue;
    }

    for (const [c, channel] of channels.entries()) {
      const step = ADPCM_STEPS[index[c]];
      let diff = channel[i] - sample[c];
      const sign = diff < 0 ? 8 : 0;
      diff = Math.abs(diff);
      let code = 0;
      let delta = step >> 3;
      for (const [bit, part] of [
        [4, step],
        [2, step >> 1],
        [1, step >> 2],
      ]) {
        if (diff >= part) {
          code |= bit;
          diff -= part;
          delta += part;
        }
      }

      sample[c] = Math.max(-32768, Math.min(32767, sign ? sample[c] - delta : sample[c] + delta));
      index[c] = Math.max(0, Math.min(ADPCM_STEPS.length - 1, index[c] + ADPCM_INDEX[code]));
      put(code | sign, 4);
    }
  }

  if (count) {
    bytes.push(acc << (8 - count));
  }

  return new Uint8Array(bytes);
}

/** `n` samples of a sine of `period` samples, `amplitude` high. */
const sine = (n: number, period: number, amplitude: number) =>
  Array.from({ length: n }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * i) / period)));

/**
 * Sounds to extract (scripts/<script>.as): uncompressed ramps at three
 * rates and both sizes, ADPCM sines mono and stereo, the MP3s of sounds/
 * as DefineSounds, one with seekSamples, and the 44.1 kHz one's bytes,
 * plain and with a LAME header, as ByteArrays, bound to classes by name.
 */
export const extractSounds =
  (script: string) =>
  (compile: Compile): Uint8Array => {
    const ramp = (n: number, step: number, from = 0) =>
      Array.from({ length: n }, (_, i) => from + i * step);
    const stereo = ramp(100, 300, -15000).flatMap((v) => [v, -v / 2]);
    const mp3 = (bytes: Uint8Array, seek: number) => {
      const out = new Uint8Array(bytes.length + 2);
      new DataView(out.buffer).setInt16(0, seek, true);
      out.set(bytes, 2);
      return out;
    };
    const tone = soundFile("tone.mp3");
    const tone22 = soundFile("tone22.mp3");
    const sounds: [string, Uint8Array][] = [
      ["Pcm8", w.defineSound(1, { rate: 0, samples: 32 }, new Uint8Array(ramp(32, 8)))],
      [
        "Pcm16Stereo",
        w.defineSound(2, { rate: 3, sixteen: true, stereo: true, samples: 100 }, pcm16(stereo)),
      ],
      [
        "Pcm11",
        w.defineSound(3, { rate: 1, sixteen: true, samples: 50 }, pcm16(ramp(50, 600, -15000))),
      ],
      [
        "Pcm22",
        w.defineSound(4, { rate: 2, sixteen: true, samples: 50 }, pcm16(ramp(50, 600, -15000))),
      ],
      [
        "Mp3",
        w.defineSound(
          5,
          { format: 2, rate: 3, sixteen: true, stereo: true, samples: 11025 },
          mp3(tone, 1105),
        ),
      ],
      [
        "Mp3Whole",
        w.defineSound(
          6,
          { format: 2, rate: 3, sixteen: true, stereo: true, samples: 12672 },
          mp3(tone, 0),
        ),
      ],
      [
        "Mp3Mono22",
        w.defineSound(7, { format: 2, rate: 2, sixteen: true, samples: 5513 }, mp3(tone22, 0)),
      ],
    ];
    sounds.push(
      [
        "Adpcm22",
        w.defineSound(
          8,
          { format: 1, rate: 2, sixteen: true, samples: 9000 },
          adpcm([sine(9000, 50, 12000)]),
        ),
      ],
      [
        "Adpcm11Stereo",
        w.defineSound(
          9,
          { format: 1, rate: 1, sixteen: true, stereo: true, samples: 3000 },
          adpcm([sine(3000, 40, 9000), sine(3000, 25, -5000)]),
        ),
      ],
    );
    const tags = sounds.map(([, tag]) => tag);
    const classes = sounds.map(([name]) =>
      compile(name, `package { import flash.media.Sound; public class ${name} extends Sound {} }`),
    );
    return w.swf({
      width: 20,
      height: 20,
      frameRate: 24,
      frameCount: 3,
      tags: [
        w.fileAttributes(true),
        ...tags,
        w.binaryData(20, tone),
        w.binaryData(21, soundFile("tone-tagged.mp3")),
        w.doAbc(
          compile(
            "Mp3Tagged",
            "package { import flash.utils.ByteArray; public class Mp3Tagged extends ByteArray {} }",
          ),
          "Mp3Tagged",
        ),
        ...classes.map((abc, i) => w.doAbc(abc, sounds[i][0])),
        w.doAbc(
          compile(
            "Mp3Bytes",
            "package { import flash.utils.ByteArray; public class Mp3Bytes extends ByteArray {} }",
          ),
          "Mp3Bytes",
        ),
        w.doAbc(compile(script)),
        w.symbolClass([
          [0, script],
          // Each DefineSound's id, after its long tag header.
          ...sounds.map(([name, tag]): [number, string] => [tag[6] | (tag[7] << 8), name]),
          [20, "Mp3Bytes"],
          [21, "Mp3Tagged"],
        ]),
        w.showFrame(),
        w.showFrame(),
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

/**
 * "Stem", a font of upright bars: "1" to "6" a bar each, 15 to 100 units
 * of the em wide, so that at 20 pixels they run from under a third of a
 * pixel to two, and "l", "m", "a" and "W" with advances that are no whole
 * number of pixels at any of the cases' sizes; "a" then "l" kern.
 */
export const stemFont = (id: number, name = "Stem"): Uint8Array =>
  w.font3({
    id,
    name,
    ascent: 900,
    descent: 250,
    glyphs: [
      { char: " ", advance: 250, boxes: [] },
      ...[15, 25, 35, 50, 70, 100].map((width, i) => ({
        char: String(i + 1),
        advance: 300,
        boxes: [[150 - (width >> 1), -700, 150 - (width >> 1) + width, 0]] as [
          number,
          number,
          number,
          number,
        ][],
      })),
      { char: "l", advance: 230, boxes: [[70, -760, 130, 0]] },
      {
        char: "m",
        advance: 900,
        boxes: [
          [60, -470, 120, 0],
          [400, -470, 460, 0],
          [740, -470, 800, 0],
          [60, -520, 800, -470],
        ],
      },
      { char: "a", advance: 537, boxes: [[50, -500, 487, 0]] },
      { char: "W", advance: 1000, boxes: [[0, -700, 1000, 0]] },
    ],
    kerning: [["a", "l", -77]],
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

// Static text replaced in place: frame 2 puts text B with the move flag
// where text A was (depth 1), removes A and places B (2), does the first
// to a text a script touched (3), and a two-frame clip does the first on
// its own timeline, looping (4); a script sends a clip at depth 5 from
// its frame 1 to its frame 3, which does the first, past a frame that
// moves A. Frame 3 puts A back at depth 1 (scripts/StaticTextReplace.as).
function staticTextReplace(abc: Uint8Array): Uint8Array {
  const at = (x: number, y: number) => ({ tx: x * 20, ty: y * 20 });
  return w.swf({
    width: 330,
    height: 160,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      probeFont(9),
      w.staticText({
        id: 1,
        bounds: [0, 1400, -600, 100],
        records: [
          {
            font: 9,
            height: 600,
            color: 0x0000cc,
            x: 0,
            y: 0,
            glyphs: [
              [0, 320],
              [1, 440],
            ],
          },
        ],
      }),
      w.staticText({
        id: 2,
        bounds: [0, 1800, -400, 800],
        matrix: { tx: 100, ty: 200 },
        records: [
          {
            font: 9,
            height: 400,
            color: 0xcc0000,
            x: 0,
            y: 0,
            glyphs: [
              [4, 400],
              [2, 200],
            ],
          },
          { x: 200, y: 500, glyphs: [[1, 300]] },
        ],
      }),
      w.sprite(4, 2, [
        w.place({ depth: 1, character: 1 }),
        w.showFrame(),
        w.place({ depth: 1, move: true, character: 2 }),
        w.showFrame(),
        w.end(),
      ]),
      w.sprite(5, 3, [
        w.place({ depth: 1, character: 1 }),
        w.showFrame(),
        w.place({ depth: 1, move: true, matrix: { tx: 200 } }),
        w.showFrame(),
        w.place({ depth: 1, move: true, character: 2, matrix: { tx: 0 } }),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "StaticTextReplace"),
      w.symbolClass([[0, "Main"]]),
      w.place({ depth: 1, character: 1, matrix: at(10, 50) }),
      w.place({ depth: 2, character: 1, matrix: at(120, 50) }),
      w.place({ depth: 3, character: 1, matrix: at(230, 50) }),
      w.place({ depth: 4, character: 4, matrix: at(10, 110) }),
      w.place({ depth: 5, character: 5, matrix: at(120, 110) }),
      w.showFrame(),
      w.place({ depth: 1, move: true, character: 2 }),
      w.remove(2),
      w.place({ depth: 2, character: 2, matrix: at(120, 50) }),
      w.place({ depth: 3, move: true, character: 2 }),
      w.showFrame(),
      w.place({ depth: 1, move: true, character: 1 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Seven red squares and seven texts, each but the first given a property
// of another value by scripts/ScriptedTouch.as on frame 1 (visible,
// cacheAsBitmap, a mask of its own, blendMode the same and another, and
// visible set and set back), and a larger blue square or another text put
// in each one's place with the move flag on frame 2.
function scriptedTouch(abc: Uint8Array): Uint8Array {
  const at = (x: number, y: number) => ({ tx: x * 20, ty: y * 20 });
  const columns = [0, 1, 2, 3, 4, 5, 6];
  return w.swf({
    width: 320,
    height: 140,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      probeFont(9),
      square(1, 0xff0000, 400),
      square(2, 0x0000ff, 600),
      square(3, 0x00aa00, 200),
      square(6, 0x0000ff, 400),
      w.staticText({
        id: 4,
        bounds: [0, 800, -600, 100],
        records: [{ font: 9, height: 600, color: 0x0000cc, x: 0, y: 0, glyphs: [[1, 400]] }],
      }),
      w.staticText({
        id: 5,
        bounds: [0, 800, -400, 800],
        records: [
          { font: 9, height: 400, color: 0xcc0000, x: 0, y: 0, glyphs: [[4, 400]] },
          { x: 0, y: 500, glyphs: [[3, 300]] },
        ],
      }),
      w.doAbc(abc, "ScriptedTouch"),
      w.symbolClass([[0, "Main"]]),
      ...columns.map((i) => w.place({ depth: 1 + i, character: 1, matrix: at(10 + i * 44, 20) })),
      ...columns.map((i) => w.place({ depth: 8 + i, character: 4, matrix: at(10 + i * 44, 100) })),
      w.place({ depth: 15, character: 3, matrix: at(142, 20) }),
      w.place({ depth: 16, character: 3, matrix: at(142, 85) }),
      w.place({ depth: 17, character: 1, matrix: at(10, 60) }),
      w.place({ depth: 18, character: 1, matrix: at(54, 60) }),
      w.showFrame(),
      ...columns.map((i) => w.place({ depth: 1 + i, move: true, character: 2 })),
      ...columns.map((i) => w.place({ depth: 8 + i, move: true, character: 5 })),
      w.place({ depth: 17, move: true, character: 6 }),
      w.place({ depth: 18, move: true, character: 6 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Red squares and blue texts that Flash caches as bitmaps, given a blue
// square or a red text of the same bounds with the move flag on frame 2,
// then on frame 3 something that may draw them again
// (scripts/CacheReplace.as). Row 1, cached by the script: nothing, a
// larger square in their place, a colour transform, a scale, a move by
// the script, the cache turned off, off and on, a read of width, a move
// and a colour transform by the timeline. Row 2, texts: nothing, a read
// of text, of width. Row 3, cached for other reasons, each with the same
// bounds and then larger: a scrollRect, an opaqueBackground, a glow set
// by the script, which touch it, so that it takes neither. Row 4, the same
// by PlaceObject3's cacheAsBitmap, opaqueBackground and glow.
// Row 5: a clip whose child is cached and replaced, sent back to frame 1.
// Row 6, cached by PlaceObject3 and replaced: a shape in a clip the
// timeline scales on frame 3, a shape the script gives a glow on frame 3,
// one with a glow the timeline changes on frame 3, and a red square
// masked by one over it replaced by a triangle.
function cacheReplace(abc: Uint8Array): Uint8Array {
  const at = (x: number, y: number) => ({ tx: x * 20, ty: y * 20 });
  // Children named `names` from column `first` of row `y`, at depths of the row's.
  const row = (y: number, names: string[], character: number, extra = {}, first = 0) =>
    names.map((name, i) =>
      w.place({
        depth: y * 20 + first + i + 1,
        character,
        name,
        matrix: at(10 + (first + i) * 40, 10 + y * 45),
        ...extra,
      }),
    );
  const glow = { glows: [{ color: 0, blur: 2, strength: 1 }] };
  const c = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `c${i}`);
  return w.swf({
    width: 420,
    height: 275,
    frameRate: 24,
    frameCount: 5,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      probeFont(9),
      square(1, 0xff0000, 400),
      square(2, 0x0000ff, 600),
      square(3, 0x0000ff, 400),
      w.shape({
        id: 11,
        bounds: [0, 400, 0, 400],
        fills: [0x0000ff],
        paths: [
          {
            fill1: 1,
            commands: [{ move: [0, 0] }, { line: [400, 0] }, { line: [0, 400] }, { line: [0, 0] }],
          },
        ],
      }),
      w.staticText({
        id: 4,
        bounds: [0, 800, 0, 400],
        records: [{ font: 9, height: 400, color: 0x0000cc, x: 0, y: 300, glyphs: [[1, 400]] }],
      }),
      w.staticText({
        id: 5,
        bounds: [0, 800, 0, 400],
        records: [{ font: 9, height: 400, color: 0xcc0000, x: 0, y: 300, glyphs: [[4, 400]] }],
      }),
      w.sprite(7, 3, [
        w.place({ depth: 1, character: 1 }),
        w.showFrame(),
        w.place({ depth: 1, move: true, character: 3 }),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ]),
      w.sprite(10, 5, [
        w.place({ depth: 1, character: 1, cacheAsBitmap: true }),
        w.showFrame(),
        w.place({ depth: 1, move: true, character: 3 }),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc, "CacheReplace"),
      w.symbolClass([[0, "Main"]]),
      ...row(0, c, 1),
      ...row(1, ["t0", "t1", "t2"], 4),
      ...row(2, ["s0", "s1", "s2", "s3", "s4", "s5"], 1),
      ...row(3, ["p0", "p1"], 1, { cacheAsBitmap: true }),
      ...row(3, ["p2", "p3"], 1, { opaqueBackground: 0xffffffff }, 2),
      ...row(3, ["p4", "p5"], 1, glow, 4),
      ...row(4, ["r0"], 7),
      ...row(5, ["n0"], 10),
      ...row(5, ["n1"], 1, { cacheAsBitmap: true }, 1),
      ...row(5, ["n2"], 1, glow, 2),
      ...row(5, ["g"], 1, {}, 3),
      w.place({ depth: 110, character: 1, name: "m", matrix: at(130, 235), cacheAsBitmap: true }),
      w.showFrame(),
      ...c.map((_, i) => w.place({ depth: i + 1, move: true, character: 3 })),
      ...[0, 1, 2].map((i) => w.place({ depth: 21 + i, move: true, character: 5 })),
      ...[0, 1, 2, 3, 4, 5].flatMap((i) => [
        w.place({ depth: 41 + i, move: true, character: i % 2 ? 2 : 3 }),
        w.place({ depth: 61 + i, move: true, character: i % 2 ? 2 : 3 }),
      ]),
      w.place({ depth: 102, move: true, character: 3 }),
      w.place({ depth: 103, move: true, character: 3 }),
      w.place({ depth: 110, move: true, character: 11 }),
      w.showFrame(),
      w.place({ depth: 2, move: true, character: 2 }),
      w.place({ depth: 101, move: true, matrix: { a: 1.5, d: 1.5, ...at(10, 235) } }),
      w.place({ depth: 103, move: true, glows: [{ color: 0, blur: 4, strength: 1 }] }),
      w.place({ depth: 9, move: true, matrix: at(10 + 8 * 40 + 5, 10) }),
      w.place({ depth: 10, move: true, colorTransform: { mult: [1, 1, 1, 0.5] } }),
      w.showFrame(),
      w.showFrame(),
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

// Text in Stem with advanced anti-aliasing (scripts/TextAdvanced.as).
function textAdvanced(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 400,
    height: 300,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      stemFont(1),
      w.doAbc(abc, "TextAdvanced"),
      w.symbolClass([[0, "TextAdvanced"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Advanced text drawn every other way (scripts/TextAdvancedDraw.as): Stem
// as it is, with a medium and a thick CSM hint, and by a table of its own.
function textAdvancedDraw(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 400,
    height: 250,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      stemFont(1),
      stemFont(2, "StemM"),
      w.fontAlignZones(2, 1, 11),
      stemFont(3, "StemT"),
      w.fontAlignZones(3, 2, 11),
      stemFont(4, "StemTable"),
      w.doAbc(abc, "TextAdvancedDraw"),
      w.symbolClass([[0, "TextAdvancedDraw"]]),
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

/**
 * Large timeline shapes under colour transforms that change each frame, as
 * a tween fades a creature out to white, in a render group that has not
 * settled: batched copies on the first frame, before their shapes are
 * built, and drawn alone after (render/color.ts, showFor). Flat discs,
 * which the transform table draws with the transform in their rows
 * (render/table.ts), and a gradient and a bitmap with transparent pixels,
 * which Pixi's pipe draws with the colour shader; an offset, a fade, an
 * alpha multiplier and a negative one, a shape taking a transform and
 * another giving its up. No gradient stop is clamped, which Flash does
 * before the ramp and swf2es after.
 */
function colorAlone(): Uint8Array {
  // Of hundreds of vertices, as a creature's parts are, which a batched copy packs again for each
  // change of transform: a disc of 240 sides, and squares of 60 points a side.
  const round: w.PathCommand[] = [{ move: [300, 0] }];
  for (let k = 1; k <= 240; k++) {
    const a = (2 * Math.PI * k) / 240;
    round.push({ line: [Math.round(300 * Math.cos(a)), Math.round(300 * Math.sin(a))] });
  }

  const square: w.PathCommand[] = [{ move: [0, 0] }];
  const corners = [
    [0, 0],
    [800, 0],
    [800, 800],
    [0, 800],
    [0, 0],
  ];
  for (let side = 0; side < 4; side++) {
    const [x0, y0] = corners[side];
    const [x1, y1] = corners[side + 1];
    for (let k = 1; k <= 60; k++) {
      square.push({
        line: [Math.round(x0 + ((x1 - x0) * k) / 60), Math.round(y0 + ((y1 - y0) * k) / 60)],
      });
    }
  }

  const disc = (id: number, color: number) =>
    w.shape({
      id,
      bounds: [-300, 300, -300, 300],
      fills: [color],
      paths: [{ fill1: 1, commands: round }],
    });
  const box = (id: number, fill: w.ShapeSpec["fills"][number]) =>
    w.shape({
      id,
      bounds: [0, 800, 0, 800],
      fills: [fill],
      paths: [{ fill1: 1, commands: square }],
      version: 3,
    });
  // 4 by 4 premultiplied ARGB, a quarter of it transparent and a quarter half so.
  const pixels = Array.from({ length: 16 }, (_, i) =>
    i < 4 ? 0x00000000 : i < 8 ? 0x80400020 : i % 2 ? 0xff20c040 : 0xffe08020,
  );
  const data = pixels.flatMap((p) => [p >>> 24, (p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff]);
  const header = [4, 0, 5, 4, 0, 4, 0];
  const compressed = zlibCompress(Uint8Array.from(data));
  const body = new Uint8Array(header.length + compressed.length);
  body.set(header);
  body.set(compressed, header.length);
  const at = (x: number, y: number) => ({ tx: x * 20, ty: y * 20 });
  const fade = (alpha: number) => ({ mult: [0, 0, 0, alpha], add: [255, 255, 255, 0] });
  const frames = [
    [
      fade(1),
      { mult: [1, 1, 1, 1], add: [80, 0, -40, 0] },
      undefined,
      { mult: [1, 0.5, 1, 0.5], add: [0, 60, 0, 0] },
    ],
    [fade(0.6), { mult: [1, 1, 1, 1], add: [0, 90, 0, 0] }, fade(0.8), { mult: [1, 1, 1, 1] }],
    [
      fade(0.3),
      { mult: [-1, -1, -1, 1], add: [255, 255, 255, 0] },
      { mult: [1.5, 1, 1, 1], add: [0, 0, 0, -64] },
      { mult: [1, 1, 1, 1], add: [0, 0, 60, 0] },
    ],
  ];
  const tags: Uint8Array[] = [
    w.fileAttributes(true),
    w.backgroundColor(0x606060),
    disc(1, 0xe04030),
    disc(2, 0x30b050),
    box(3, {
      type: 0x10,
      matrix: { a: 800 / 32768, d: 800 / 32768, tx: 400, ty: 400 },
      stops: [
        [0, 0xff806040],
        [255, 0x403060a0],
      ],
    }),
    w.tag(36, body, true),
    box(5, { bitmap: 4, type: 0x43, matrix: { a: 200, d: 200 } }),
  ];
  // Four columns, one transform each: two discs, the gradient and the bitmap a column.
  const place = (frame: number) => {
    const out: Uint8Array[] = [];
    for (let column = 0; column < 4; column++) {
      const ct = frames[frame - 1][column];
      for (let row = 0; row < 4; row++) {
        const depth = 1 + column * 4 + row;
        const character = [1, 2, 3, 5][row];
        const x = 10 + column * 55 + (row < 2 ? 15 + row * 25 : (row - 2) * 27);
        const y = row < 2 ? 22 : 50;
        out.push(
          w.place({
            depth,
            ...(frame === 1 ? { character } : { move: true }),
            matrix: row < 2 ? at(x, y) : { a: 0.6, d: 0.6, ...at(x, y) },
            colorTransform: ct ?? (frame === 1 ? undefined : { mult: [1, 1, 1, 1] }),
          }),
        );
      }
    }

    return out;
  };
  for (let frame = 1; frame <= 3; frame++) {
    tags.push(...place(frame), w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: 230, height: 100, frameRate: 24, frameCount: 3, tags });
}

/**
 * Two rows of 48 small discs under offsets that change each frame, in a
 * render group that has not settled: one run of the transform table longer
 * than a run that takes its rows in uniforms, which uploads them, the
 * transform's flag among them, to the table's texture (render/table.ts).
 */
function colorAloneRuns(): Uint8Array {
  // A disc of 240 sides, large enough to be drawn alone under a transform (render/color.ts).
  const round: w.PathCommand[] = [{ move: [300, 0] }];
  for (let k = 1; k <= 240; k++) {
    const a = (2 * Math.PI * k) / 240;
    round.push({ line: [Math.round(300 * Math.cos(a)), Math.round(300 * Math.sin(a))] });
  }

  const disc = (id: number, color: number) =>
    w.shape({
      id,
      bounds: [-300, 300, -300, 300],
      fills: [color],
      paths: [{ fill1: 1, commands: round }],
    });
  const offsets = [
    [40, -30, 0],
    [-20, 50, 30],
    [0, 0, -60],
  ];
  const tags: Uint8Array[] = [
    w.fileAttributes(true),
    w.backgroundColor(0x606060),
    disc(1, 0xe04030),
    disc(2, 0x30b050),
  ];
  for (let frame = 1; frame <= 3; frame++) {
    for (let k = 0; k < 48; k++) {
      tags.push(
        w.place({
          depth: 1 + k,
          ...(frame === 1 ? { character: 1 + (k % 2) } : { move: true }),
          matrix: {
            a: 0.28,
            d: 0.28,
            tx: (10 + (k % 24) * 9) * 20,
            ty: (8 + Math.floor(k / 24) * 10) * 20,
          },
          colorTransform: { mult: [1, 1, 1, 1], add: [...offsets[frame - 1], 0] },
        }),
      );
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: 230, height: 26, frameRate: 24, frameCount: 3, tags });
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
  {
    name: "squashed-turns",
    swf: squashedTurns(),
    frames: 3,
    capture: [1, 2, 3],
    // The curved, turned lines anti-alias within a quarter pixel of Flash's, as for
    // `shared-lines`: 770 to 1050 pixels, through each part's own stretch or an even one alike.
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
    name: "static-text-replace",
    swf: staticTextReplace,
    script: "StaticTextReplace",
    frames: 3,
    capture: [1, 2, 3],
    tolerance: 32,
    maxOutliers: 60,
  },
  {
    name: "scripted-touch",
    swf: scriptedTouch,
    script: "ScriptedTouch",
    frames: 2,
    capture: [1, 2],
    tolerance: 32,
    maxOutliers: 60,
  },
  {
    name: "cache-replace",
    swf: cacheReplace,
    script: "CacheReplace",
    frames: 5,
    capture: [1, 2, 3, 4],
    tolerance: 32,
    maxOutliers: 60,
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
    table: true,
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
    name: "color-alone",
    swf: colorAlone(),
    frames: 3,
    capture: [1, 2, 3],
    // Within 3 a channel, Flash's 8.8 multipliers against floats, but for
    // the discs' edges, anti-aliased each rasteriser's way: up to 1,034
    // channels a frame. A shape in a wrong colour adds some 1,700.
    tolerance: 3,
    maxOutliers: 1100,
    table: true,
  },
  {
    name: "color-alone-runs",
    swf: colorAloneRuns(),
    frames: 3,
    capture: [1, 2, 3],
    // Within 3 a channel, Flash's 8.8 multipliers against floats, but for
    // the discs' edges, anti-aliased each rasteriser's way: up to 768
    // channels a frame. Played without the table, they must draw the same
    // pixels, which guards the rows read from the texture closer still.
    tolerance: 3,
    maxOutliers: 800,
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
    // Shadows and a bevel cast hundreds of pixels from small objects (scripts/FilterFarShadow.as):
    // padded as far as they reach, drawn whole.
    name: "filter-far-shadow",
    swf: (abc) => bare(abc, 1, "Main", 480, 60),
    script: "FilterFarShadow",
    frames: 1,
    capture: [1],
    // The page blurs at its four samples a pixel, as the filters case says.
    tolerance: 8,
    maxOutliers: 0,
  },
  {
    // Display objects with a shadow, bevel or gradient filter cast past what adl holds
    // (scripts/FilterFar.as): the GPU's padding stays what can be drawn.
    name: "filter-far",
    swf: (abc) => bare(abc, 1, "Main", 80, 60),
    script: "FilterFar",
    frames: 2,
    capture: [2],
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    // A shadow's and a bevel's distance past what adl holds, and NaN; inner filters'
    // rects; draw's matrix past the int's range; hitTest's points near it.
    name: "filter-distances",
    swf: (abc) => bare(abc, 1, "Main", 40, 40),
    script: "FilterDistances",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // The rects and points of BitmapData's operations, in place and not, on the GPU and not
    // (scripts/BitmapRects.as); shown, an opaque bitmap a copy in place left empty pixels in.
    name: "bitmap-rects",
    swf: (abc) => bare(abc, 1, "Main", 80, 32),
    script: "BitmapRects",
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
    name: "touch-natives",
    swf: (abc) => bare(abc, 1, "TouchNatives"),
    script: "TouchNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // The events' fields as scripts read and write them: playerglobal keeps
  // them in AS3, which must look to describeType, coercion, clone and
  // dispatch as Flash's natives do.
  {
    name: "event-fields",
    swf: (abc) => bare(abc, 1, "EventFields"),
    script: "EventFields",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Natives that keep a value or answer a constant (contextMenu, TextRenderer,
  // selectedText and others), and the errors a wrong argument gives.
  {
    name: "small-natives",
    swf: (abc) => bare(abc, 1, "SmallNatives"),
    script: "SmallNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // A field's selection after text, htmlText, appendText and replaceText.
  {
    name: "text-field-selection-moves",
    swf: (abc) => bare(abc, 1, "TextFieldSelectionMoves"),
    script: "TextFieldSelectionMoves",
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
    name: "number-formatter-natives",
    swf: (abc) => bare(abc, 1, "NumberFormatterNatives"),
    script: "NumberFormatterNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "currency-formatter-natives",
    swf: (abc) => bare(abc, 1, "CurrencyFormatterNatives"),
    script: "CurrencyFormatterNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "date-time-formatter-natives",
    swf: (abc) => bare(abc, 1, "DateTimeFormatterNatives"),
    script: "DateTimeFormatterNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "collator-natives",
    swf: (abc) => bare(abc, 1, "CollatorNatives"),
    script: "CollatorNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "string-tools-natives",
    swf: (abc) => bare(abc, 1, "StringToolsNatives"),
    script: "StringToolsNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "locale-id-natives",
    swf: (abc) => bare(abc, 1, "LocaleIDNatives"),
    script: "LocaleIDNatives",
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
    name: "sprite-hit-area",
    swf: (abc) => bare(abc, 1, "SpriteHitArea"),
    script: "SpriteHitArea",
    frames: 2,
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
    name: "draw-triangles",
    swf: (abc) => bare(abc, 2, "DrawTriangles", 400, 280),
    script: "DrawTriangles",
    frames: 2,
    capture: [1, 2],
    // The textures are adl's to a level where flat or smoothed, and to the texel but at a few
    // pixels where a perspective puts a pixel's corner exactly on a texel's edge, which adl's
    // fixed point rounds either way. The rest are edges: adl covers a 45° edge's pixel with 10
    // of its 16 samples where the page takes 6, as it does a path's fill, and strokes' ends and
    // joins, as in the other cases: some 680.
    tolerance: 32,
    maxOutliers: 700,
  },
  {
    name: "draw-triangles-culling",
    swf: (abc) => bare(abc, 3, "DrawTrianglesCulling", 400, 220),
    script: "DrawTrianglesCulling",
    frames: 3,
    capture: [1, 2],
    // Edges alone: a 45° edge through pixels' corners, where adl counts the samples on it and
    // the page does not (any fill's, as the draw-triangles case's), the 3D turn's, the glow's
    // and the lines' ends.
    tolerance: 32,
    maxOutliers: 440,
  },
  {
    name: "read-graphics-data",
    swf: (abc) => bare(abc, 1, "ReadGraphicsData"),
    script: "ReadGraphicsData",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sound-extract",
    build: extractSounds("SoundExtract"),
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
    table: true,
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
    name: "text-advanced",
    swf: textAdvanced,
    script: "TextAdvanced",
    frames: 1,
    capture: [1],
    tolerance: 64,
    maxOutliers: 40,
    // Saffron's CSM cutoffs: stems thickened, thickness and sharpness. Stem
    // has no alignment zones, so no gridFitType fits its stems to pixels;
    // the normal rows, whose edges are Flash's 4×4 samples, need the
    // tolerance.
  },
  {
    // The same text's layout alone, advanced text's pen in fractions of a twip.
    name: "text-advanced-layout",
    swf: textAdvanced,
    script: "TextAdvanced",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "text-advanced-draw",
    swf: textAdvancedDraw,
    script: "TextAdvancedDraw",
    frames: 1,
    capture: [1],
    // Its table set with TextRenderer stays in adl for the jobs after it.
    alone: true,
    tolerance: 8,
    maxOutliers: 0,
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
    name: "blend-formulas",
    swf: (abc) => bare(abc, 1, "BlendFormulas", 320, 210),
    script: "BlendFormulas",
    frames: 1,
    capture: [1],
    // Within 2 a channel: adl's rounding of the premultiplied source and of
    // the blend, which the GPU's blending and the blend filter round alike.
    tolerance: 2,
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
    name: "blend-direct-filtered",
    swf: (abc) => bare(abc, 1, "BlendDirectFiltered", 320, 160),
    script: "BlendDirectFiltered",
    frames: 4,
    capture: [1, 2, 3, 4],
    // Within 6 a channel: adl's rounding of the glows' blurs, and of the layer whose ground is
    // partly clear, as the blend filter draws them too.
    tolerance: 6,
    maxOutliers: 0,
  },
  {
    name: "blend-direct-clear",
    swf: (abc) => bare(abc, 1, "BlendDirectClear", 240, 80),
    script: "BlendDirectClear",
    frames: 3,
    capture: [1, 3],
    // Within 4 a channel: adl's rounding of the glows and of the blends.
    tolerance: 4,
    maxOutliers: 0,
  },
  {
    name: "stage-erase",
    swf: (abc) => bare(abc, 1, "StageErase", 240, 80),
    script: "StageErase",
    frames: 5,
    capture: [1, 2, 3, 4, 5],
    // Within 5 a channel: adl's rounding of the glows and of the blends, a subtracted glow's
    // faint edge the most.
    tolerance: 5,
    maxOutliers: 0,
  },
  {
    name: "blend-filtered-alpha",
    swf: (abc) => bare(abc, 1, "BlendFilteredAlpha", 320, 200),
    script: "BlendFilteredAlpha",
    frames: 2,
    capture: [1, 2],
    // Within 5 a channel: adl's rounding of the glows and of the blends, and a drop shadow's edge
    // a pixel wide. But for the corners of the glow under an alpha offset, some 30 channels up to
    // 10 off: each of the test page's samples there with any alpha takes the offset, where adl's
    // pixel has none; and a few of the shadow's corners.
    tolerance: 5,
    maxOutliers: 52,
  },
  {
    name: "filtered-colors",
    swf: (abc) => bare(abc, 1, "FilteredColors", 320, 240),
    script: "FilteredColors",
    frames: 2,
    capture: [1, 2],
    // Within 5 a channel but for some 170: the corners of a glow under an alpha offset, as in
    // blend-filtered-alpha, up to 49 off; a glow's edge along a mask's, 35; a bitmap's, 10.
    tolerance: 5,
    maxOutliers: 170,
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
    // backdrops through the Pixi fork's bounded resolves, which no
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
    name: "blend-layers",
    swf: (abc) => bare(abc, 1, "BlendLayers", 240, 100),
    script: "BlendLayers",
    frames: 3,
    capture: [1, 2, 3],
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
    name: "apply-filter-inner",
    swf: (abc) => bare(abc, 1, "ApplyFilterInner"),
    script: "ApplyFilterInner",
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
    // pixelDissolve's seeds and answers and perlinNoise's bases from AS3, as AVM1's (bitmap/ops.ts).
    name: "dissolve-noise",
    swf: (abc) => bare(abc, 1, "DissolveNoise"),
    script: "DissolveNoise",
    traced: true,
    frames: 1,
    capture: [],
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
    // Filters on objects that draw nothing draw nothing, glows, shadows and colour matrices alike.
    name: "filters-empty",
    swf: (abc) => bare(abc, 1, "FiltersEmpty", 330, 132),
    script: "FiltersEmpty",
    frames: 1,
    capture: [1],
    // As "filters": the page's samples against adl's whole pixels.
    tolerance: 8,
    maxOutliers: 0,
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
    // A filtered submenu, batched as a group of its own, shown beside the
    // filtered menu it is a child of (scripts/FilterMenu.as).
    name: "filter-menu",
    swf: (abc) => bare(abc, 4, "FilterMenu", 300, 330),
    script: "FilterMenu",
    frames: 4,
    capture: [2, 3, 4],
    // A host showing the stage twice its size, as a game's page shows it larger.
    zoom: 2,
    shown: true,
    // Flash draws the SWF built at that size, the script scaling the menu to it.
    flash: (abc) => bare(abc, 4, "FilterMenu", 600, 660),
    tolerance: 32,
    // The bevels' one-pixel edges around each menu, lit differently in adl,
    // up to about 3,800; the submenu cut short leaves about 371,000.
    maxOutliers: 7000,
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
    // Draws followed by scrolls, fills and copies on every frame (scripts/DrawScroll.as).
    name: "draw-scroll",
    swf: (abc) => bare(abc, 1, "DrawScroll", 512, 104),
    script: "DrawScroll",
    frames: 6,
    capture: [2, 4, 6],
    // The half-green square drawn over the opaque bitmap's blue rounds a level apart: the
    // draw's own compositing, the same whether the operations after it run on the GPU or not.
    tolerance: 1,
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
    // Edges and bitmaps at the stage's low quality (scripts/StageQuality.as). The bitmaps
    // are Flash's to 4 a channel; the edges are each rasteriser's own, up to some 500 outliers.
    name: "stage-quality-low",
    swf: (abc) => bare(abc, 1, "StageQuality", 290, 60),
    script: "StageQuality",
    frames: 1,
    capture: [1],
    quality: "low",
    tolerance: 4,
    maxOutliers: 640,
  },
  {
    // Edges and bitmaps at the stage's medium quality (scripts/StageQuality.as). The bitmaps
    // are Flash's to 4 a channel; the edges are each rasteriser's own, up to some 500 outliers.
    name: "stage-quality-medium",
    swf: (abc) => bare(abc, 1, "StageQuality", 290, 60),
    script: "StageQuality",
    frames: 1,
    capture: [1],
    quality: "medium",
    tolerance: 4,
    maxOutliers: 640,
  },
  {
    // Edges and bitmaps at the stage's high quality (scripts/StageQuality.as). The bitmaps
    // are Flash's to 4 a channel; the edges are each rasteriser's own, up to some 500 outliers.
    name: "stage-quality-high",
    swf: (abc) => bare(abc, 1, "StageQuality", 290, 60),
    script: "StageQuality",
    frames: 1,
    capture: [1],
    quality: "high",
    tolerance: 4,
    maxOutliers: 640,
  },
  {
    // Edges and bitmaps at the stage's best quality (scripts/StageQuality.as). The bitmaps
    // are Flash's to 4 a channel; the edges are each rasteriser's own, up to some 500 outliers.
    name: "stage-quality-best",
    swf: (abc) => bare(abc, 1, "StageQuality", 290, 60),
    script: "StageQuality",
    frames: 1,
    capture: [1],
    quality: "best",
    tolerance: 4,
    maxOutliers: 640,
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
  {
    name: "remove-reentry",
    swf: removeReentry,
    script: "RemoveReentry",
    frames: 2,
    capture: [2],
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
    name: "loader-bytes-frames",
    build: loaderBytesFrames,
    frames: 5,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
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
  {
    name: "current-domain",
    build: currentDomain,
    frames: 4,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Frame 1 is drawn at the outer SWF's INIT, before the AVM1 movies come at
  // that frame's end; the player draws the frame whole, with them.
  {
    name: "avm1-hello",
    swf: avm1Hello(),
    traced: true,
    frames: 4,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  ...[4, 5, 6, 7, 8, 10].map(
    (version): PlayerCase => ({
      name: `avm1-operators-swf${version}`,
      swf: avm1Operators(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7, 8, 10].map(
    (version): PlayerCase => ({
      name: `avm1-objects-swf${version}`,
      swf: avm1Objects(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7, 8, 10].map(
    (version): PlayerCase => ({
      name: `avm1-functions-swf${version}`,
      swf: avm1Functions(version),
      traced: true,
      frames: 3,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
      // Past its recursion limit Flash runs no AVM1 action again, a later SWF's neither.
      alone: true,
    }),
  ),
  ...[5, 6, 7, 8, 10].map(
    (version): PlayerCase => ({
      name: `avm1-control-swf${version}`,
      swf: avm1Control(version),
      traced: true,
      frames: 3,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...["array", "string", "number", "math", "classes", "broadcaster", "globals", "date"].flatMap(
    (name) =>
      [5, 6, 7, 8, 10].map(
        (version): PlayerCase => ({
          name: `avm1-${name}-swf${version}`,
          swf: avm1Script(name, version),
          traced: true,
          frames: 2,
          capture: [],
          tolerance: 0,
          maxOutliers: 0,
        }),
      ),
  ),
  ...[5, 6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-clips-swf${version}`,
      swf: avm1Clips(version),
      traced: true,
      frames: 4,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-gotos-swf${version}`,
      swf: avm1Gotos(version),
      traced: true,
      frames: 5,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[4, 5].map(
    (version): PlayerCase => ({
      name: `avm1-paths-swf${version}`,
      swf: avm1Paths(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-scopes-swf${version}`,
      swf: avm1Scopes(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  {
    name: "avm1-filters",
    swf: avm1Filters(),
    traced: true,
    frames: 2,
    capture: [2],
    // As the AS3 filters case: the page blurs at four samples a pixel, adl whole pixels.
    tolerance: 8,
    maxOutliers: 40,
  },
  {
    name: "avm1-clip-properties",
    swf: avm1ClipDrawn(),
    frames: 2,
    capture: [2],
    tolerance: 0,
    maxOutliers: 0,
  },
  ...[5, 6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-events-swf${version}`,
      swf: avm1Events(version),
      traced: true,
      frames: 6,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-construct-swf${version}`,
      swf: avm1Construct(version),
      traced: true,
      frames: 3,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-depths-swf${version}`,
      swf: avm1Depths(version),
      traced: true,
      frames: 3,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  {
    name: "avm1-initclip",
    swf: avm1Initclip(),
    traced: true,
    frames: 4,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  ...[6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-timers-swf${version}`,
      swf: avm1Timers(version),
      traced: true,
      frames: 8,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  {
    name: "avm1-recursion",
    swf: avm1Recursion(),
    traced: true,
    frames: 3,
    capture: [3],
    tolerance: 0,
    maxOutliers: 0,
    alone: true,
  },
  {
    name: "avm1-script-limits",
    swf: avm1ScriptLimits(),
    traced: true,
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
    alone: true,
  },
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
    name: "flip-zero-scale",
    swf: (abc) => bare(abc, 1, "FlipZeroScale", 160, 20),
    script: "FlipZeroScale",
    frames: 1,
    capture: [1],
    // The two boxes it draws as 3D objects, both drawn from a bitmap, smoothed: their edges'
    // levels differ by a little (render/three.ts).
    tolerance: 24,
    maxOutliers: 250,
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
  // Drawn in perspective from a bitmap of each 3D object (render/three.ts). The stages are 500
  // wide: adl draws with the focal length of a stage that wide, whatever the SWF's, where Flash
  // Player draws with its stage's, as its bounds and local3DToGlobal are in both.
  {
    name: "three-d-flip",
    swf: (abc) => bare(abc, 7, "ThreeDFlip", 500, 200),
    script: "ThreeDFlip",
    frames: 7,
    capture: [1, 2, 3, 4, 5, 6, 7],
    tolerance: 40,
    maxOutliers: 500,
  },
  {
    name: "three-d-scene",
    swf: (abc) => bare(abc, 2, "ThreeDScene", 500, 400),
    script: "ThreeDScene",
    frames: 2,
    capture: [1],
    tolerance: 40,
    maxOutliers: 500,
  },
  {
    name: "three-d-nested-turn",
    swf: (abc) => bare(abc, 4, "ThreeDNestedTurn", 500, 300),
    script: "ThreeDNestedTurn",
    frames: 4,
    capture: [1, 4],
    tolerance: 40,
    maxOutliers: 500,
  },
  {
    name: "three-d-behind-hit",
    swf: (abc) => bare(abc, 2, "ThreeDBehindHit", 500, 400),
    script: "ThreeDBehindHit",
    frames: 2,
    capture: [1],
    tolerance: 40,
    maxOutliers: 500,
  },
  {
    name: "three-d-blend-turn",
    swf: (abc) => bare(abc, 3, "ThreeDBlendTurn", 500, 200),
    script: "ThreeDBlendTurn",
    frames: 3,
    capture: [1, 3],
    tolerance: 40,
    maxOutliers: 400,
  },
  {
    name: "three-d-mixed",
    swf: (abc) => bare(abc, 1, "ThreeDMixed", 500, 400),
    script: "ThreeDMixed",
    frames: 1,
    capture: [1],
    tolerance: 40,
    maxOutliers: 400,
  },
  {
    name: "three-d-projection",
    swf: (abc) => bare(abc, 2, "ThreeDProjection", 500, 400),
    script: "ThreeDProjection",
    frames: 2,
    capture: [1],
    tolerance: 40,
    maxOutliers: 200,
  },
  {
    name: "three-d-mask",
    swf: (abc) => bare(abc, 1, "ThreeDMask", 500, 400),
    script: "ThreeDMask",
    frames: 1,
    capture: [1],
    // Flash's mask in a bitmap cuts at whole texels, ours at a quarter of one: an outside
    // mask's edges fall up to a texel apart.
    tolerance: 40,
    maxOutliers: 700,
  },
  {
    name: "three-d-mask-moving",
    swf: (abc) => bare(abc, 4, "ThreeDMaskMoving", 500, 400),
    script: "ThreeDMaskMoving",
    frames: 4,
    capture: [1, 2, 4],
    // As three-d-mask's: an outside mask's edges fall up to a texel apart.
    tolerance: 40,
    maxOutliers: 700,
  },
  {
    name: "three-d-matrix-shared",
    swf: (abc) => bare(abc, 1, "ThreeDMatrixShared", 100, 100),
    script: "ThreeDMatrixShared",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "three-d-matrix-silent",
    swf: (abc) => bare(abc, 3, "ThreeDMatrixSilent", 400, 420),
    script: "ThreeDMatrixSilent",
    frames: 3,
    capture: [1, 3],
    tolerance: 40,
    maxOutliers: 100,
  },
  {
    name: "three-d-mask-handover",
    swf: (abc) => bare(abc, 4, "ThreeDMaskHandover", 420, 420),
    script: "ThreeDMaskHandover",
    frames: 4,
    capture: [1, 2, 3, 4],
    // The turned cards' edges fall a pixel apart, as in three-d-mask.
    tolerance: 40,
    maxOutliers: 2500,
  },
  {
    name: "three-d-filter-blend",
    swf: (abc) => bare(abc, 1, "ThreeDFilterBlend", 500, 400),
    script: "ThreeDFilterBlend",
    frames: 1,
    capture: [1],
    tolerance: 24,
    maxOutliers: 100,
  },
  {
    name: "three-d-matrix",
    swf: (abc) => bare(abc, 1, "ThreeDMatrix", 500, 400),
    script: "ThreeDMatrix",
    frames: 1,
    capture: [1],
    tolerance: 24,
    maxOutliers: 50,
  },
  {
    name: "three-d-bounds",
    swf: (abc) => bare(abc, 3, "ThreeDBounds", 500, 400),
    script: "ThreeDBounds",
    frames: 3,
    capture: [2],
    // The edges of the cards under turned parents fall a pixel apart.
    tolerance: 40,
    maxOutliers: 700,
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
    name: "camera-microphone",
    swf: (abc) => bare(abc, 1, "CameraMicrophone"),
    script: "CameraMicrophone",
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
