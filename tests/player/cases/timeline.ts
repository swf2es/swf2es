// The player's timeline cases (cases.ts): depths, loops, rewinds,
// gotos, scenes and labels, buttons, masks and the order of construction.
import { readFileSync } from "node:fs";
import * as w from "../../swf-writer.ts";
import type { Compile } from "../scripts.ts";
import { as1, bare, circlePath, loops, type PlayerCase, rectPath, square } from "./common.ts";

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

function frameLabelAliases(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 100,
    height: 100,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.doAbc(abc, "FrameLabelAliases"),
      w.symbolClass([[0, "Main"]]),
      w.frameLabel("initial"),
      w.showFrame(),
      w.frameLabel("first"),
      w.frameLabel("second"),
      w.frameLabel("repeat"),
      w.showFrame(),
      w.frameLabel("repeat"),
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
  const template = readFileSync(
    new URL("../scripts/FreshClips.as.template", import.meta.url),
    "utf8",
  );
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

// PlaceObject4 metadata belongs to each new instance, survives moves and
// rewinds, and appears after its constructor but before ADDED.
function placeMetadata(abc: Uint8Array): Uint8Array {
  // AMF3 dynamic object {kwy: value}, shared as bytes but decoded per instance.
  const metadata = (value: string) =>
    new Uint8Array([
      10,
      11,
      1,
      7,
      107,
      119,
      121,
      6,
      value.length * 2 + 1,
      ...new TextEncoder().encode(value),
      1,
    ]);
  const first = metadata("first");

  return w.swf({
    version: 36,
    width: 160,
    height: 60,
    frameCount: 6,
    tags: [
      w.fileAttributes(true),
      square(3, 0xff0000, 400),
      square(4, 0x0000ff, 400),
      w.sprite(1, 1, [w.place({ depth: 1, character: 3 }), w.showFrame(), w.end()]),
      w.sprite(2, 1, [w.place({ depth: 1, character: 4 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "PlaceMetadata"),
      w.symbolClass([
        [0, "Main"],
        [1, "MetadataChild"],
        [2, "MetadataChild"],
      ]),
      w.place({ depth: 1, character: 1, name: "a", metaData: first, matrix: { tx: 100, ty: 200 } }),
      w.place({ depth: 2, character: 1, name: "b", metaData: first, matrix: { tx: 800, ty: 200 } }),
      w.place({ depth: 3, character: 1, name: "plain", matrix: { tx: 1500, ty: 200 } }),
      w.showFrame(),
      w.place({ depth: 1, move: true, metaData: metadata("move") }),
      w.place({ depth: 2, move: true, matrix: { tx: 800, ty: 400 } }),
      w.showFrame(),
      w.place({ depth: 1, character: 2, move: true, metaData: metadata("replace") }),
      w.remove(2),
      w.place({
        depth: 2,
        character: 1,
        name: "b",
        metaData: metadata("new"),
        matrix: { tx: 800, ty: 200 },
      }),
      w.showFrame(),
      w.showFrame(),
      w.place({
        depth: 4,
        character: 1,
        name: "skip",
        metaData: metadata("skipped"),
        matrix: { tx: 2200, ty: 200 },
      }),
      w.showFrame(),
      w.place({ depth: 4, move: true, metaData: metadata("ignored") }),
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

/**
 * Alpha masks on the timeline and in AVM1 (alpha-masks-avm1): a red square
 * masked by a half-transparent one, the mask a timeline layer's (clipDepth)
 * with both cached by PlaceObject3, and neither; then by setMask from a SWF
 * 8's script, both cached, and neither. A mask whose alpha counts shows the
 * red at half strength, a stencil's at full.
 */
function alphaMasksAvm1(): Uint8Array {
  const red = (id: number) =>
    w.shape({
      id,
      bounds: [0, 1600, 0, 1600],
      fills: [0xffff0000],
      version: 3,
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [1600, 0] },
            { line: [1600, 1600] },
            { line: [0, 1600] },
            { line: [0, 0] },
          ],
        },
      ],
    });
  const half = w.shape({
    id: 2,
    bounds: [0, 1600, 0, 1600],
    fills: [0x800000ff],
    version: 3,
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [1600, 0] },
          { line: [1600, 1600] },
          { line: [0, 1600] },
          { line: [0, 0] },
        ],
      },
    ],
  });
  const layer = (depth: number, x: number, cached: boolean) => [
    w.place({
      depth,
      character: 2,
      clipDepth: depth + 1,
      cacheAsBitmap: cached,
      matrix: { tx: x, ty: 200 },
    }),
    w.place({ depth: depth + 1, character: 1, cacheAsBitmap: cached, matrix: { tx: x, ty: 200 } }),
  ];
  return w.swf({
    version: 8,
    width: 400,
    height: 100,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(false),
      w.backgroundColor(0xffffff),
      red(1),
      half,
      ...layer(1, 200, true),
      ...layer(3, 2200, false),
      as1(
        `function pair(n, x, cached) {
  var r = _root.createEmptyMovieClip("r" + n, 10 + n * 2);
  r.beginFill(0xff0000); r.moveTo(x, 10); r.lineTo(x + 80, 10); r.lineTo(x + 80, 90); r.lineTo(x, 90); r.endFill();
  var m = _root.createEmptyMovieClip("m" + n, 11 + n * 2);
  m.beginFill(0x0000ff, 50); m.moveTo(x, 10); m.lineTo(x + 80, 10); m.lineTo(x + 80, 90); m.lineTo(x, 90); m.endFill();
  r.setMask(m);
  r.cacheAsBitmap = cached;
  m.cacheAsBitmap = cached;
}
pair(0, 210, true);
pair(1, 310, false);`,
        8,
      ),
      w.showFrame(),
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

const looped = { frames: 4, capture: [1, 3, 4], tolerance: 0, maxOutliers: 0 };

const rewound = { frames: 3, capture: [1, 2, 3], tolerance: 0, maxOutliers: 0 };

export const timelineCases: PlayerCase[] = [
  { name: "depths", swf: depths, frames: 3, capture: [1, 2, 3], tolerance: 0, maxOutliers: 0 },
  { name: "loops", swf: loops(true), ...looped },
  { name: "loops-avm1", swf: loops(false), ...looped },
  { name: "rewinds", swf: rewinds(true), ...rewound },
  { name: "rewinds-avm1", swf: rewinds(false), ...rewound },
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
    name: "frame-label-aliases",
    swf: frameLabelAliases,
    script: "FrameLabelAliases",
    frames: 2,
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
    name: "place-metadata",
    swf: placeMetadata,
    script: "PlaceMetadata",
    frames: 6,
    capture: [1, 6],
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
    name: "mask-ancestors",
    swf: (abc) => bare(abc, 6, "MaskAncestors", 360, 60),
    script: "MaskAncestors",
    frames: 6,
    capture: [2, 3, 4, 5, 6],
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "alpha-masks",
    swf: (abc) => bare(abc, 2, "AlphaMasks", 400, 300),
    script: "AlphaMasks",
    frames: 2,
    capture: [2],
    // Flash rounds a mask's alpha on whole bytes, a level or two from the
    // GPU's: a half-transparent mask leaves 129 of green and blue over the
    // white where swf2es leaves 127, the container's overlap 66 where it
    // leaves 64. No edge differs.
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "alpha-masks-avm1",
    swf: alphaMasksAvm1,
    frames: 2,
    capture: [2],
    // The half-transparent mask's alpha rounded as alpha-masks' is: 129
    // of green and blue in Flash, 128 here.
    tolerance: 1,
    maxOutliers: 0,
  },
  {
    name: "size-of-empty",
    swf: (abc) => bare(abc, 1, "SizeOfEmpty", 400, 300),
    script: "SizeOfEmpty",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
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
];
