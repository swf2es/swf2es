import { deflateSync } from "node:zlib";
// The player's shape cases (cases.ts): fills, lines, morphs, scale9,
// the drawing API and the stage's quality.
import { zlibCompress } from "../../../packages/format/dist/index.js";
import * as w from "../../swf-writer.ts";
import { bare, moved, type PlayerCase, probeFont, rectPath, square } from "./common.ts";

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
// turns with each, or, nearly even, through one even stretch (display/stretch.ts,
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

// Lines filled as DefineShape4 and DefineMorphShape2 fill them: a frame of
// a linear gradient with alpha stops, as drawn, scaled and turned; a ring
// of a radial gradient; a gradient hairline; a frame of a 4 by 4 bitmap,
// repeated and clipped; and a morph whose line's gradient turns and
// changes its colours, at three ratios.
function lineFills(): Uint8Array {
  const pixels: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const argb = (x + y) % 2 ? 0xff2040e0 : x < 2 ? 0xffe02020 : 0xfff0c000;
      pixels.push(argb >>> 24, (argb >> 16) & 0xff, (argb >> 8) & 0xff, argb & 0xff);
    }
  }

  const bitmap = w.tag(
    36,
    Uint8Array.from([9, 0, 5, 4, 0, 4, 0, ...zlibCompress(Uint8Array.from(pixels))]),
    true,
  );
  // A frame 60 by 40 pixels, 1200 by 800 twips, over a grey fill, its line filled with `fill`.
  const frame = (id: number, width: number, fill: w.BitmapFill | w.GradientFillSpec) =>
    w.shape({
      id,
      version: 4,
      bounds: [-200, 1400, -200, 1000],
      fills: [0xffd0d0d0],
      lines: [{ width, color: 0xff00ff00, fill }],
      paths: [{ fill1: 1, line: 1, commands: rectPath(0, 0, 60, 40) }],
    });
  const across = {
    type: 0x10,
    // The square across the frame's width.
    matrix: { a: 1200 / 32768, d: 1200 / 32768, tx: 600, ty: 400 },
    stops: [
      [0, 0x40ff0000],
      [255, 0xff0000ff],
    ],
  } satisfies w.GradientFillSpec;
  const ring = w.shape({
    id: 4,
    version: 4,
    bounds: [-200, 1400, -200, 1400],
    fills: [],
    lines: [
      {
        width: 240,
        color: 0xff00ff00,
        fill: {
          type: 0x12,
          matrix: { a: 1400 / 32768, d: 1400 / 32768, tx: 600, ty: 600 },
          spread: 1,
          stops: [
            [0, 0xffffff00],
            [128, 0xffff00ff],
            [255, 0xff00ffff],
          ],
        },
      },
    ],
    paths: [
      {
        fill1: 0,
        line: 1,
        commands: [
          { move: [600, 0] },
          { curve: [1200, 0, 1200, 600] },
          { curve: [1200, 1200, 600, 1200] },
          { curve: [0, 1200, 0, 600] },
          { curve: [0, 0, 600, 0] },
        ],
      },
    ],
  });
  const morph = w.morphShape({
    id: 7,
    version: 2,
    startBounds: [-200, 1400, -200, 1000],
    endBounds: [-200, 1400, -200, 1000],
    fills: [],
    lines: [
      {
        startWidth: 120,
        endWidth: 240,
        startColor: 0xff00ff00,
        endColor: 0xff00ff00,
        fill: {
          type: 0x10,
          startMatrix: { a: 1200 / 32768, d: 1200 / 32768, tx: 600, ty: 400 },
          endMatrix: { a: 0, b: 800 / 32768, c: -800 / 32768, d: 0, tx: 600, ty: 400 },
          stops: [
            [0, 0xffff0000, 0, 0xff00a000],
            [255, 0xff0000ff, 255, 0x40ffff00],
          ],
        },
      },
    ],
    start: [{ line: 1, commands: rectPath(0, 0, 60, 40) }],
    end: [rectPath(0, 0, 60, 40)],
  });
  return w.swf({
    width: 340,
    height: 230,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.backgroundColor(0xffffff),
      bitmap,
      frame(1, 160, across),
      // A hairline of the same gradient.
      frame(2, 0, across),
      frame(3, 240, { bitmap: 9, type: 0x42, matrix: { a: 60, d: 60, tx: -60, ty: -60 } }),
      ring,
      frame(5, 240, { bitmap: 9, type: 0x43, matrix: { a: 100, d: 100, tx: 200, ty: 100 } }),
      morph,
      w.place({ depth: 1, character: 1, matrix: { tx: 300, ty: 300 } }),
      w.place({
        depth: 2,
        character: 1,
        matrix: { a: 1.3, b: 0.75, c: -0.75, d: 1.3, tx: 2600, ty: 200 },
      }),
      w.place({ depth: 3, character: 2, matrix: { a: 1.5, d: 1.5, tx: 4410, ty: 310 } }),
      w.place({ depth: 4, character: 3, matrix: { tx: 300, ty: 1900 } }),
      w.place({ depth: 5, character: 4, matrix: { tx: 2000, ty: 1700 } }),
      w.place({ depth: 6, character: 5, matrix: { tx: 3700, ty: 1900 } }),
      w.place({ depth: 7, character: 7, ratio: 0, matrix: { tx: 300, ty: 3400 } }),
      w.place({ depth: 8, character: 7, ratio: 32768, matrix: { tx: 2200, ty: 3400 } }),
      w.place({ depth: 9, character: 7, ratio: 65535, matrix: { tx: 4100, ty: 3400 } }),
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
 * One fill's regions and holes: a square, then one with
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

/** Static shape masks keep their authored winding, unlike Graphics drawings used as masks. */
function staticMaskWinding(): Uint8Array {
  return w.swf({
    width: 220,
    height: 100,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.shape({
        id: 1,
        bounds: [0, 2000, 0, 2000],
        fills: [0xcc3300],
        paths: [rectPath(5, 5, 90, 90), rectPath(25, 25, 50, 50)].map((commands) => ({
          fill1: 1,
          commands,
        })),
      }),
      square(2, 0x0033cc, 2000),
      w.place({ depth: 1, character: 1 }),
      w.place({ depth: 2, character: 1, clipDepth: 3, matrix: { tx: 2200, ty: 0 } }),
      w.place({ depth: 3, character: 2, matrix: { tx: 2200, ty: 0 } }),
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

/**
 * Shapes drawn in runs, and what ends a run or draws in the middle of one: added and multiplied
 * shapes, drawn as layers; a layer, a run, then a layer whose first content is a layer of a shape;
 * squares filled alone under multiply and screen, which split a run by its blend mode; a gradient,
 * a blurred shape, a mask over two shapes, a shape whose lines are stroked anew each frame as it
 * turns stretched, a depth whose character is replaced each frame, a row of small shapes, moving
 * down, whose run is too long to pass its rows in uniforms, and after a layer a short run whose
 * rows follow the long one's.
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
 * a tween fades a creature out to white: flat discs, which draw with the
 * transform in their rows, and a gradient and a bitmap with transparent
 * pixels; an offset, a fade, an
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
 * Two rows of 48 small discs under offsets that change each frame: one
 * long run, whose rows, the transform's flag among them, go up together.
 */
function colorAloneRuns(): Uint8Array {
  // A disc of 240 sides.
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
/** Three 30 pixel panels of a bitmap skin, each a shape in a sprite with a grid, scaled 4 by 3. */
function scale9ShapeFills(): Uint8Array {
  // A rounded panel: a dark ring of corners round a checker, as premultiplied ARGB.
  const argb = new Uint8Array(30 * 30 * 4);
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 30; x++) {
      const d = Math.hypot(Math.max(0, 9 - x, x - 20), Math.max(0, 9 - y, y - 20));
      if (d <= 9.5) {
        const c = d > 6.5 ? 0x204080 : (x + y) & 1 ? 0xffd040 : 0xe06020;
        argb.set([255, c >> 16, (c >> 8) & 255, c & 255], (y * 30 + x) * 4);
      }
    }
  }

  const image = w.tag(36, Uint8Array.from([6, 0, 5, 30, 0, 30, 0, ...deflateSync(argb)]), true);
  // Clipped, not smoothed, a pixel 20 twips.
  const fill = { type: 0x43 as const, bitmap: 6, matrix: { a: 20, d: 20 } };
  const cells = [0, 1, 2].flatMap((j) => [0, 1, 2].map((i) => [i, j]));
  const rect = ([i, j]: number[], style: number) => ({
    fill1: style,
    commands: [
      { move: [i * 200, j * 200] as [number, number] },
      { line: [i * 200 + 200, j * 200] as [number, number] },
      { line: [i * 200 + 200, j * 200 + 200] as [number, number] },
      { line: [i * 200, j * 200 + 200] as [number, number] },
      { line: [i * 200, j * 200] as [number, number] },
    ],
  });
  const bounds: [number, number, number, number] = [0, 600, 0, 600];
  const shapes = [
    // Nine styles, one a region.
    w.shape({
      id: 1,
      bounds,
      fills: cells.map(() => fill),
      paths: cells.map((c, k) => rect(c, k + 1)),
    }),
    // One style, nine rectangles.
    w.shape({ id: 2, bounds, fills: [fill], paths: cells.map((c) => rect(c, 1)) }),
    // The corners one style, the rest another.
    w.shape({
      id: 3,
      bounds,
      fills: [fill, fill],
      paths: cells.map((c) => rect(c, c[0] !== 1 && c[1] !== 1 ? 1 : 2)),
    }),
  ];
  const tags = [w.fileAttributes(false), w.backgroundColor(0xffffff), image, ...shapes];
  shapes.forEach((_, k) => {
    tags.push(
      w.sprite(10 + k, 1, [w.place({ depth: 1, character: k + 1 }), w.showFrame(), w.end()]),
      w.scalingGrid(10 + k, 200, 400, 200, 400),
      w.place({
        depth: k + 1,
        character: 10 + k,
        matrix: { a: 4, d: 3, tx: (5 + k * 132) * 20, ty: 100 },
      }),
    );
  });
  tags.push(w.showFrame(), w.end());
  return w.swf({ width: 400, height: 110, frameCount: 1, tags });
}

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

export const shapeCases: PlayerCase[] = [
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
    name: "static-mask-winding",
    swf: staticMaskWinding(),
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "crossing-cones",
    swf: (abc) => bare(abc, 2, "Main", 256, 192),
    script: "CrossingCones",
    frames: 2,
    capture: [1, 2],
    tolerance: 32,
    maxOutliers: 80,
  },
  {
    name: "zoomed-cones",
    swf: (abc) => bare(abc, 61, "Main", 256, 192),
    script: "ZoomedCones",
    frames: 61,
    capture: [1, 9, 14, 27, 42, 53, 61],
    tolerance: 32,
    maxOutliers: 80,
  },
  {
    name: "crossing-fills",
    swf: (abc) => bare(abc, 3, "Main", 480, 360),
    script: "CrossingFills",
    frames: 3,
    capture: [1, 2, 3],
    tolerance: 32,
    maxOutliers: 500,
  },
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
  },
  {
    name: "color-alone-runs",
    swf: colorAloneRuns(),
    frames: 3,
    capture: [1, 2, 3],
    // Within 3 a channel, Flash's 8.8 multipliers against floats, but for
    // the discs' edges, anti-aliased each rasteriser's way: up to 768
    // channels a frame.
    tolerance: 3,
    maxOutliers: 800,
  },
  {
    // A SWF's own shapes with bitmap fills in sprites with a DefineScalingGrid: a fill style's
    // bitmap goes with what the style fills. Nine styles, one a region, keep the corners; one
    // style for nine rectangles is stretched whole, and so are the corners that share one.
    name: "scale9-shape-fills",
    swf: scale9ShapeFills,
    frames: 2,
    capture: [2],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // Bitmap fills in 9-slice panels (scripts/Scale9Fills.as): a fill's bitmap goes with its
    // fill, so a panel of nine fills keeps its corners, and one fill over them all is stretched
    // whole. Exact: the bitmaps are not smoothed and the edges are on whole pixels.
    name: "scale9-fills",
    swf: (abc) => bare(abc, 1, "Scale9Fills", 400, 200),
    script: "Scale9Fills",
    frames: 2,
    capture: [2],
    tolerance: 0,
    maxOutliers: 0,
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
    name: "line-fills",
    swf: lineFills(),
    frames: 1,
    capture: [1],
    // The lines' edges anti-alias within a pixel of Flash's, as for `shared-lines`, and the turned
    // frame's corners most: some 280 channels, where lines drawn in one colour are 31,000.
    tolerance: 32,
    maxOutliers: 400,
  },
  {
    name: "line-bitmaps",
    swf: (abc) => bare(abc, 1, "LineBitmaps", 420, 200),
    script: "LineBitmaps",
    frames: 1,
    capture: [1],
    // The bitmaps are Flash's texel for texel; the lines' edges and ends anti-alias apart, some
    // 490 channels, where lines drawn in one colour are 26,000.
    tolerance: 32,
    maxOutliers: 650,
  },
  {
    name: "line-gradients",
    swf: (abc) => bare(abc, 1, "LineGradients", 380, 280),
    script: "LineGradients",
    frames: 1,
    capture: [1],
    // The lines' edges anti-alias apart, and the ring's focal gradient differs about its focus
    // as a fill's does (`gradients`): some 1,050 channels, where lines drawn in one colour are
    // 21,000.
    tolerance: 32,
    maxOutliers: 1300,
  },
  {
    name: "hidden-render-groups",
    swf: (abc) => bare(abc, 8, "HiddenRenderGroups", 340, 190),
    script: "HiddenRenderGroups",
    frames: 8,
    capture: [1, 3, 4, 5, 6, 8],
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "hidden-strokes",
    swf: (abc) => bare(abc, 7, "HiddenStrokes", 300, 150),
    script: "HiddenStrokes",
    frames: 7,
    capture: [2, 4, 5, 7],
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "line-overlaps",
    swf: (abc) => bare(abc, 1, "LineOverlaps", 200, 80),
    script: "LineOverlaps",
    frames: 1,
    capture: [1],
    // Within 32 a channel but for 45° edges through pixels' corners, where adl counts the samples
    // on them and the page does not (as in draw-triangles); a part blended twice is 64 off.
    tolerance: 32,
    maxOutliers: 400,
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
    // A fill's edges as Flash covers them at high quality, at 1 and 3 times
    // (scripts/EdgeCoverage.as): curves, sharp corners, a sliver, a
    // translucent fill, and abutting fills within a Shape and across two,
    // without a seam either way. Each rasteriser shades its edge pixels its
    // own way: with SwiftShader's 4 samples some 780 are off Flash's 16 levels
    // by more than 16.
    name: "edge-coverage",
    swf: (abc) => bare(abc, 1, "EdgeCoverage", 400, 240),
    script: "EdgeCoverage",
    frames: 1,
    capture: [1],
    quality: "high",
    tolerance: 16,
    maxOutliers: 900,
  },
];
