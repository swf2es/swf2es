// What the player's cases share: the case's shape, the builders more than one
// area's cases use, and those other tests build their SWFs with (cases.ts).
import { tags } from "../../../packages/format/dist/index.js";
import { Avm1Assembler, type SimpleAction } from "../../avm1-assembler.ts";
import { flashAssembler, script } from "../../avm1-script.ts";
import * as w from "../../swf-writer.ts";
import type { Compile } from "../scripts.ts";

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
  /** Played as AIR plays it, AIR's API defined (Scripting's `air`); Flash's harness is AIR's. */
  air?: boolean;
  /** An AVM1 SWF whose trace must match Flash's. */
  traced?: boolean;
  /**
   * A known gap: what Flash does that the player does not yet. The case is
   * left out of the default run and runs, expected to fail, when named.
   */
  gap?: string;
}

export const square = (id: number, color: number, size = 1000) =>
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

// A three-frame sprite on frame 1 of a two-frame root. When the root loops
// the sprite keeps playing rather than starting over, so its square is at
// its third position on root frame 3 and back at its first on frame 4.
export function loops(as3: boolean): Uint8Array {
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

/** An AVM1 block of what `write` assembles, and End. */
export const avm1 = (write: (a: Avm1Assembler) => Avm1Assembler): number[] => [
  ...write(new Avm1Assembler()).end().bytes(),
];

/** AVM1 code that leaves a value on the stack, for the cases of objects. */
export type Avm1Expr = (a: Avm1Assembler) => Avm1Assembler;

export const op =
  (action: SimpleAction, ...operands: Avm1Expr[]): Avm1Expr =>
  (a) =>
    operands.reduce((b, e) => e(b), a).op(action);

/** Statements of the cases of objects, each a function of the assembler. */
export type Avm1Statement = (a: Avm1Assembler) => Avm1Assembler;

export const block = (...statements: Avm1Statement[]) =>
  w.doAction(avm1((a) => statements.reduce((b, s) => s(b), a)));

/** A function's body of statements. */
export const body = (...statements: Avm1Statement[]) =>
  statements.reduce((b, s) => s(b), new Avm1Assembler());

/** A DoAction of AS1 source, as Flash's compiler writes it for a SWF of `version`. */
export const as1 = (source: string, version: number) =>
  w.doAction([...script(source, version)(flashAssembler()).end().bytes()]);

let controlLabels = 0;

export const label = () => `c${controlLabels++}`;

export const at =
  (name: string): Avm1Statement =>
  (a) =>
    a.label(name);

/** Bytes as they are, for the stack's cases. */
export const code =
  (write: (a: Avm1Assembler) => Avm1Assembler): Avm1Statement =>
  (a) =>
    write(a);

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

/** A rectangle's path, in pixels. */
export function rectPath(x: number, y: number, width: number, height: number): w.PathCommand[] {
  const [l, t, r, b] = [x * 20, y * 20, (x + width) * 20, (y + height) * 20];
  return [{ move: [l, t] }, { line: [r, t] }, { line: [r, b] }, { line: [l, b] }, { line: [l, t] }];
}

/** A circle's path, in pixels: eight quadratics, as Flash's drawCircle; an ellipse `r` by `ry`. */
export function circlePath(cx: number, cy: number, r: number, ry = r): w.PathCommand[] {
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

export const moved = { frames: 2, capture: [1, 2], tolerance: 32, maxOutliers: 500 };
