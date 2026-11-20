// The player's blend mode cases (cases.ts): each mode's formula, the
// layers kept and retired, their edges, subpixel moves and masks.
import { zlibCompress } from "../../../packages/format/dist/index.js";
import * as w from "../../swf-writer.ts";
import { bare, type PlayerCase, square } from "./common.ts";

// A cached blend layer retired after an erase makes the stage nonopaque.
function blendLayerRetirement(): Uint8Array {
  const tags = [
    w.fileAttributes(true),
    w.backgroundColor(0xffffff),
    square(1, 0x336699, 5000),
    square(2, 0xff3300, 600),
    square(3, 0x33ff66, 600),
    w.sprite(4, 1, [
      w.place({ depth: 1, character: 2 }),
      w.place({ depth: 2, character: 3, matrix: { tx: 300, ty: 300 } }),
      w.showFrame(),
      w.end(),
    ]),
    w.place({ depth: 1, character: 1 }),
    w.place({ depth: 2, character: 4, blendMode: 3, matrix: { tx: 400, ty: 400 } }),
    w.place({ depth: 3, character: 4, blendMode: 9, matrix: { tx: 2200, ty: 400 } }),
    w.showFrame(),
  ];
  for (let frame = 1; frame <= 3; frame++) {
    if (frame === 1) {
      // Offscreen so it changes the stage's blend policy without covering art.
      tags.push(w.place({ depth: 4, character: 2, blendMode: 12, matrix: { tx: -2000 } }));
    } else if (frame === 3) {
      tags.push(w.remove(4));
    }

    tags.push(
      w.place({ depth: 2, move: true, matrix: { tx: 400 + frame * 20, ty: 400 } }),
      w.place({ depth: 3, move: true, matrix: { tx: 2200 + frame * 20, ty: 400 } }),
      w.showFrame(),
    );
  }

  tags.push(w.end());
  return w.swf({ width: 200, height: 100, frameRate: 24, frameCount: 4, tags });
}

// A timeline fades a shape, and the same shape inside an explicit layer. Only the latter
// colours its rectangles together, as the parent clip's alpha changes.
function blendLayerFade(): Uint8Array {
  const rect = (x: number, y: number): w.PathCommand[] => [
    { move: [x, y] },
    { line: [x + 640, y] },
    { line: [x + 640, y + 480] },
    { line: [x, y + 480] },
    { line: [x, y] },
  ];
  const tags = [
    w.backgroundColor(0xffffff),
    w.shape({
      id: 1,
      bounds: [0, 960, 0, 720],
      fills: [0xff0000, 0x00ff00],
      paths: [
        { fill1: 1, commands: rect(0, 0) },
        { fill1: 2, commands: rect(320, 240) },
      ],
    }),
    w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
    w.sprite(3, 1, [w.place({ depth: 1, character: 2, blendMode: 2 }), w.showFrame(), w.end()]),
  ];
  const alphas = [1, 0.5, 0, 0.75];
  for (let frame = 0; frame < alphas.length; frame++) {
    for (let side = 0; side < 2; side++) {
      tags.push(
        w.place({
          depth: side + 1,
          character: frame === 0 ? side + 2 : undefined,
          move: frame !== 0,
          matrix: { tx: 200 + side * 1400, ty: 200 },
          colorTransform: { mult: [1, 1, 1, alphas[frame]] },
        }),
      );
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: 140, height: 60, frameRate: 24, frameCount: alphas.length, tags });
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
 * blendFills' shapes each the only child of a clip in a blend mode, the
 * usual way a SWF blends its art: the slant inside its clip, turned,
 * coloured and faded there; the disc in a faded clip; the three a clip
 * deeper; the disc scaled; the bitmaps; the three in a coloured clip; and,
 * as a control, the slant beside the square over another.
 */
function spriteFills(
  tags: Uint8Array[],
  turn: (angle: number, scale: number) => { a: number; b: number; c: number; d: number },
  cachedRows: boolean,
): Uint8Array {
  const turned = turn((23 * Math.PI) / 180, 0.85);
  const about = {
    ...turned,
    tx: 320 - (turned.a * 320 + turned.c * 320),
    ty: 320 - (turned.b * 320 + turned.d * 320),
  };
  const colored = { mult: [0.8, 1, 0.6, 1], add: [30, -20, 10, 0] };
  const faded = { mult: [1, 1, 1, 0.6] };
  // Each row's children, in the clip's space, and the clip's colour; cacheAsBitmap on the clip,
  // or the shape blended itself, not in a clip.
  type Row = {
    children: w.PlaceSpec[];
    color?: w.PlaceSpec["colorTransform"];
    cached?: boolean;
    bare?: boolean;
  };
  const cachedOnes: Row[] = [
    // The slant blended in a clip as below, which finds its fills apart for every instance.
    { children: [{ depth: 1, character: 10, matrix: { tx: 60, ty: 40 } }] },
    { children: [{ depth: 1, character: 10, matrix: { tx: 60, ty: 40 } }], cached: true },
    { children: [{ depth: 1, character: 410, matrix: { tx: 60, ty: 40 } }] },
    { children: [{ depth: 1, character: 10, matrix: { tx: 60, ty: 40 }, cacheAsBitmap: true }] },
    { children: [{ depth: 1, character: 10 }], bare: true },
    // One fill, and a bitmap as an authoring tool places one, a rectangle filled with it, in a
    // kept clip: they draw alike either way, straight, as before.
    { children: [{ depth: 1, character: 420 }], cached: true },
    { children: [{ depth: 1, character: 421, matrix: { tx: 60, ty: 40 } }], cached: true },
  ];
  const rows: Row[] = cachedRows
    ? cachedOnes
    : [
        { children: [{ depth: 1, character: 10, matrix: { tx: 60, ty: 40 } }] },
        { children: [{ depth: 1, character: 10, matrix: about }] },
        { children: [{ depth: 1, character: 10, colorTransform: colored }] },
        { children: [{ depth: 1, character: 10, colorTransform: faded }] },
        { children: [{ depth: 1, character: 11 }], color: faded },
        { children: [{ depth: 1, character: 400 }] },
        { children: [{ depth: 1, character: 11, matrix: { a: 0.9, d: 0.9, tx: 30, ty: 30 } }] },
        { children: [{ depth: 1, character: 13 }] },
        { children: [{ depth: 1, character: 12 }], color: colored },
        {
          children: [
            { depth: 1, character: 10, matrix: { a: 0.5, d: 0.5 } },
            { depth: 2, character: 16, matrix: { a: 0.5, d: 0.5, tx: 320, ty: 320 } },
          ],
        },
      ];
  tags.push(
    w.shape({
      id: 420,
      bounds: [0, 640, 0, 640],
      fills: [0x40d0f0],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [320, 20] },
            { line: [620, 250] },
            { line: [500, 620] },
            { line: [130, 600] },
            { line: [30, 230] },
            { line: [320, 20] },
          ],
        },
      ],
    }),
    w.shape({
      id: 421,
      bounds: [0, 480, 0, 480],
      fills: [{ bitmap: 20, type: 0x43, matrix: { a: 60, d: 60 } }],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [480, 0] },
            { line: [480, 480] },
            { line: [0, 480] },
            { line: [0, 0] },
          ],
        },
      ],
    }),
    w.sprite(400, 1, [w.place({ depth: 1, character: 12 }), w.showFrame(), w.end()]),
    w.sprite(410, 1, [
      w.place({ depth: 1, character: 10, cacheAsBitmap: true }),
      w.showFrame(),
      w.end(),
    ]),
  );
  for (let r = 0; r < rows.length; r++) {
    tags.push(
      w.sprite(200 + r * 10, 1, [
        ...rows[r].children.map((child) => w.place(child)),
        w.showFrame(),
        w.end(),
      ]),
    );
  }

  tags.push(w.place({ depth: 1, character: 1 }), w.place({ depth: 2, character: 2 }));
  let depth = 10;
  for (let i = 0; i < FILL_MODES.length; i++) {
    for (let r = 0; r < rows.length; r++) {
      const { bare, cached, color } = rows[r];
      tags.push(
        w.place({
          depth: depth++,
          character: bare ? 10 : 200 + r * 10,
          blendMode: FILL_MODES[i],
          matrix: { tx: (8 + i * 44) * 20, ty: (8 + r * 40) * 20 },
          colorTransform: color,
          cacheAsBitmap: cached || bare,
        }),
      );
    }
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({
    width: 400,
    height: cachedRows ? 290 : 410,
    frameRate: 24,
    frameCount: 1,
    tags,
  });
}

/**
 * The modes of blendFills' columns: multiply, overlay, add, screen, hard
 * light, darken, lighten, difference and invert.
 */
const FILL_MODES = [3, 13, 8, 4, 14, 6, 5, 7, 10];

// Shapes of several fills that meet, each alone in a blend mode, over a
// gradient crossed by pale bands: two solid fills split along a slant,
// upright and turned; a disc of one in a square of another, which meet
// along curves; three that meet at a point, one part clear; two fills of
// one bitmap, sampled differently; the slant again with a line over its
// edges; a radial gradient's disc in a solid square; the disc and the
// three inside clips of their own, one faded, one coloured; and two fills
// over each other. A column a mode (FILL_MODES), a row each.
function blendFills(inSprites = false, cachedRows = false): Uint8Array {
  const poly = (points: [number, number][]): w.PathCommand[] =>
    points.map((p, i) => (i === 0 ? { move: p } : { line: p }));
  // A circle clockwise from its east, in eight curves: its inside on the right of its edges.
  const circle = (cx: number, cy: number, r: number): w.PathCommand[] => {
    const commands: w.PathCommand[] = [{ move: [cx + r, cy] }];
    const out = r / Math.cos(Math.PI / 8);
    for (let k = 0; k < 8; k++) {
      const mid = ((k + 0.5) * Math.PI) / 4;
      const end = ((k + 1) * Math.PI) / 4;
      commands.push({
        curve: [
          Math.round(cx + out * Math.cos(mid)),
          Math.round(cy + out * Math.sin(mid)),
          Math.round(cx + r * Math.cos(end)),
          Math.round(cy + r * Math.sin(end)),
        ],
      });
    }

    return commands;
  };
  const SIZE = 640;
  const bounds: [number, number, number, number] = [0, SIZE, 0, SIZE];
  // Split from (0, 120) to (640, 520): `above` over the slant, `below` under it.
  const slant = (above: number, below: number, line?: number) => [
    {
      fill1: above,
      line,
      commands: poly([
        [0, 120],
        [0, 0],
        [SIZE, 0],
        [SIZE, 520],
      ]),
    },
    {
      fill1: below,
      line,
      commands: poly([
        [SIZE, 520],
        [SIZE, SIZE],
        [0, SIZE],
        [0, 120],
      ]),
    },
    {
      fill0: above,
      fill1: below,
      line,
      commands: poly([
        [0, 120],
        [SIZE, 520],
      ]),
    },
  ];
  // The square around a disc, the disc's edge between them.
  const disc = (outside: number, inside: number) => [
    {
      fill1: outside,
      commands: poly([
        [0, 0],
        [SIZE, 0],
        [SIZE, SIZE],
        [0, SIZE],
        [0, 0],
      ]),
    },
    { fill0: outside, fill1: inside, commands: circle(320, 330, 230) },
  ];
  const pixels: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const argb = (x + y) % 2 ? 0xff3060c0 : x < 4 ? 0xfff0c040 : 0xffe04080;
      pixels.push(argb >>> 24, (argb >> 16) & 0xff, (argb >> 8) & 0xff, argb & 0xff);
    }
  }

  const turn = (angle: number, scale: number) => ({
    a: scale * Math.cos(angle),
    b: scale * Math.sin(angle),
    c: -scale * Math.sin(angle),
    d: scale * Math.cos(angle),
  });
  const ground = w.shape({
    id: 1,
    version: 3,
    bounds: [0, 8000, 0, 8200],
    fills: [
      {
        type: 0x10,
        matrix: { ...turn(0.5, 9000 / 32768), tx: 4000, ty: 4100 },
        stops: [
          [0, 0xff101828],
          [90, 0xffe0d0a0],
          [170, 0xff306090],
          [255, 0xfff0f0e0],
        ],
      },
    ],
    paths: [
      {
        fill1: 1,
        commands: poly([
          [0, 0],
          [8000, 0],
          [8000, 8200],
          [0, 8200],
          [0, 0],
        ]),
      },
    ],
  });
  const bands: w.ShapeSpec["paths"] = [];
  for (let x = 0; x < 11500; x += 280) {
    bands.push({
      fill1: 1,
      commands: poly([
        [x, 0],
        [x + 100, 0],
        [x + 100 - 3300, 8200],
        [x - 3300, 8200],
        [x, 0],
      ]),
    });
  }

  const shapes = [
    w.shape({
      id: 2,
      version: 3,
      bounds: [-3300, 11600, 0, 8200],
      fills: [0x70ffffff],
      paths: bands,
    }),
    w.shape({ id: 10, bounds, fills: [0x2848a0, 0xf0c858], paths: slant(1, 2) }),
    w.shape({ id: 11, bounds, fills: [0xc03020, 0x40d0f0], paths: disc(1, 2) }),
    // Meeting at (280, 360): over it to the left, to the right, and below, clear in part.
    w.shape({
      id: 12,
      version: 3,
      bounds,
      fills: [0xff20a050, 0xfff0e8f8, 0x99e04040],
      paths: [
        {
          fill1: 1,
          commands: poly([
            [0, 200],
            [0, 0],
            [400, 0],
          ]),
        },
        {
          fill1: 2,
          commands: poly([
            [400, 0],
            [SIZE, 0],
            [SIZE, 560],
          ]),
        },
        {
          fill1: 3,
          commands: poly([
            [SIZE, 560],
            [SIZE, SIZE],
            [0, SIZE],
            [0, 200],
          ]),
        },
        {
          fill0: 1,
          fill1: 2,
          commands: poly([
            [280, 360],
            [400, 0],
          ]),
        },
        {
          fill0: 2,
          fill1: 3,
          commands: poly([
            [280, 360],
            [SIZE, 560],
          ]),
        },
        {
          fill0: 3,
          fill1: 1,
          commands: poly([
            [280, 360],
            [0, 200],
          ]),
        },
      ],
    }),
    w.tag(
      36,
      Uint8Array.from([20, 0, 5, 8, 0, 8, 0, ...zlibCompress(Uint8Array.from(pixels))]),
      true,
    ),
    w.shape({
      id: 13,
      bounds,
      fills: [
        { bitmap: 20, type: 0x42, matrix: { a: 60, d: 60 } },
        { bitmap: 20, type: 0x42, matrix: { a: 40, d: 40, tx: 100, ty: 60 } },
      ],
      paths: slant(1, 2),
    }),
    w.shape({
      id: 14,
      bounds,
      fills: [0x2848a0, 0xf0c858],
      lines: [{ width: 40, color: 0x601020 }],
      paths: slant(1, 2, 1),
    }),
    w.shape({
      id: 15,
      version: 3,
      bounds,
      fills: [
        0xffd04020,
        {
          type: 0x12,
          matrix: { a: 240 / 16384, d: 240 / 16384, tx: 320, ty: 330 },
          stops: [
            [0, 0xfff8f0a0],
            [255, 0xff2040a0],
          ],
        },
      ],
      paths: disc(1, 2),
    }),
    // A square over another, which a layer of a SWF's shape may hold too: blended as one picture.
    w.shape({
      id: 16,
      bounds,
      fills: [0x2848a0, 0xf0c858],
      paths: [
        {
          fill1: 1,
          commands: poly([
            [0, 0],
            [440, 0],
            [440, 440],
            [0, 440],
            [0, 0],
          ]),
        },
        {
          fill1: 2,
          commands: poly([
            [200, 200],
            [SIZE, 200],
            [SIZE, SIZE],
            [200, SIZE],
            [200, 200],
          ]),
        },
      ],
    }),
  ];
  const tags: Uint8Array[] = [w.backgroundColor(0x808080), ground, ...shapes];
  if (inSprites) {
    return spriteFills(tags, turn, cachedRows);
  }

  // Each mode's disc and three in clips of their own, the clips coloured.
  for (let i = 0; i < FILL_MODES.length; i++) {
    for (const [k, character] of [11, 12].entries()) {
      tags.push(
        w.sprite(100 + k * 20 + i, 1, [
          w.place({ depth: 1, character, blendMode: FILL_MODES[i] }),
          w.showFrame(),
          w.end(),
        ]),
      );
    }
  }

  tags.push(w.place({ depth: 1, character: 1 }), w.place({ depth: 2, character: 2 }));
  let depth = 10;
  for (let i = 0; i < FILL_MODES.length; i++) {
    const x = (8 + i * 44) * 20;
    const at = (row: number) => (8 + row * 40) * 20;
    const blendMode = FILL_MODES[i];
    const turned = turn((23 * Math.PI) / 180, 0.85);
    const rows: w.PlaceSpec[] = [
      { depth: 0, character: 10, blendMode, matrix: { tx: x, ty: at(0) } },
      {
        depth: 0,
        character: 10,
        blendMode,
        // About the square's centre, a little smaller.
        matrix: {
          ...turned,
          tx: x + 320 - (turned.a * 320 + turned.c * 320),
          ty: at(1) + 320 - (turned.b * 320 + turned.d * 320),
        },
      },
      { depth: 0, character: 11, blendMode, matrix: { tx: x, ty: at(2) } },
      { depth: 0, character: 12, blendMode, matrix: { tx: x, ty: at(3) } },
      { depth: 0, character: 13, blendMode, matrix: { tx: x, ty: at(4) } },
      { depth: 0, character: 14, blendMode, matrix: { tx: x, ty: at(5) } },
      { depth: 0, character: 15, blendMode, matrix: { tx: x, ty: at(6) } },
      { depth: 0, character: 16, blendMode, matrix: { tx: x, ty: at(9) } },
      {
        depth: 0,
        character: 100 + i,
        matrix: { tx: x, ty: at(7) },
        colorTransform: { mult: [1, 1, 1, 0.6] },
      },
      {
        depth: 0,
        character: 120 + i,
        matrix: { tx: x, ty: at(8) },
        colorTransform: { mult: [0.8, 1, 0.6, 1], add: [30, -20, 10, 0] },
      },
    ];
    for (const row of rows) {
      tags.push(w.place({ ...row, depth: depth++ }));
    }
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({ width: 400, height: 410, frameRate: 24, frameCount: 1, tags });
}

/**
 * Blends drawn straight onto what is below one after another, whose
 * rectangles meet or not, over bands under a checkerboard: a row of them
 * near each other; four far apart, two in each corner; a chain of each
 * meeting the one before, then one meeting the one before that alone,
 * past an add between; the same in a clip drawn as a layer and in a
 * glowing clip, held; on a second frame each moved by part of a pixel.
 */
function blendShared(): Uint8Array {
  const rect = (x: number, y: number, width: number, height: number): w.PathCommand[] => [
    { move: [x, y] },
    { line: [x + width, y] },
    { line: [x + width, y + height] },
    { line: [x, y + height] },
    { line: [x, y] },
  ];
  const cells: w.PathCommand[][] = [];
  for (let row = 0; row < 12; row++) {
    for (let col = row % 2; col < 24; col += 2) {
      cells.push(rect(col * 400, row * 400, 400, 400));
    }
  }

  const bands = [0x203050, 0xc08040, 0x60a0c0, 0xe0e0d0];
  const tags: Uint8Array[] = [
    w.fileAttributes(true),
    w.backgroundColor(0x808080),
    w.shape({
      id: 1,
      bounds: [0, 9600, 0, 4800],
      fills: bands,
      paths: bands.map((_, k) => ({ fill1: k + 1, commands: rect(k * 2400, 0, 2400, 4800) })),
    }),
    w.shape({
      id: 2,
      version: 3,
      bounds: [0, 9600, 0, 4800],
      fills: [0x80f0e8d0],
      paths: cells.map((commands) => ({ fill1: 1, commands })),
    }),
  ];
  // Squares of 30 pixels, part clear, and colours of their own.
  const colours = [0xd0ff4020, 0xff40c060, 0xa02060ff, 0xffe0e040, 0xc0a040e0, 0xff30d0d0];
  for (let k = 0; k < colours.length; k++) {
    tags.push(
      w.shape({
        id: 3 + k,
        version: 3,
        bounds: [0, 600, 0, 600],
        fills: [colours[k]],
        paths: [{ fill1: 1, commands: rect(0, 0, 600, 600) }],
      }),
    );
  }

  // Overlay, hard light, difference, lighten, darken, invert; add between.
  const modes = [13, 14, 7, 5, 6, 10];
  const ADD = 8;
  // x, y in pixels, mode, each in its order.
  const row: [number, number, number][] = [10, 50, 90, 130, 170].map((x, k) => [x, 10, modes[k]]);
  const apart: [number, number, number][] = [
    [8, 160, modes[0]],
    [362, 8, modes[1]],
    [40, 166, modes[2]],
    [330, 14, modes[3]],
  ];
  const chain: [number, number, number][] = [
    [220, 60, modes[0]],
    [240, 70, modes[1]],
    [260, 60, modes[2]],
    [300, 60, ADD],
    [280, 76, modes[4]],
    [252, 100, modes[5]],
  ];
  const inner: [number, number, number][] = [
    [0, 0, modes[0]],
    [40, 4, modes[1]],
    [20, 20, modes[2]],
    [80, 0, modes[3]],
  ];
  const sprites = (id: number, at: [number, number, number][]) =>
    w.sprite(id, 1, [
      ...at.map(([x, y, mode], k) =>
        w.place({
          depth: k + 1,
          character: 3 + (k % colours.length),
          matrix: { tx: x * 20, ty: y * 20 },
          blendMode: mode,
        }),
      ),
      w.showFrame(),
      w.end(),
    ]);
  tags.push(sprites(20, inner), sprites(21, inner));
  tags.push(w.place({ depth: 1, character: 1 }), w.place({ depth: 2, character: 2 }));
  const placed = [...row, ...apart, ...chain];
  const at = (k: number, frame: number) => ({
    tx: placed[k][0] * 20 + frame * ((k % 3) * 7 + 3),
    ty: placed[k][1] * 20 + frame * ((k % 2) * 9 + 4),
  });
  for (let k = 0; k < placed.length; k++) {
    tags.push(
      w.place({
        depth: 3 + k,
        character: 3 + (k % colours.length),
        matrix: at(k, 0),
        blendMode: placed[k][2],
      }),
    );
  }

  const first = 3 + placed.length;
  tags.push(
    w.place({ depth: first, character: 20, matrix: { tx: 2000, ty: 2600 }, blendMode: 2 }),
    w.place({
      depth: first + 1,
      character: 21,
      matrix: { tx: 6000, ty: 2600 },
      glows: [{ color: 0x000000, blur: 4, strength: 1 }],
    }),
    w.showFrame(),
  );
  for (let k = 0; k < placed.length; k++) {
    tags.push(w.place({ depth: 3 + k, move: true, matrix: at(k, 1) }));
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({ width: 480, height: 240, frameRate: 24, frameCount: 2, tags });
}

export const blendCases: PlayerCase[] = [
  {
    // Blends drawn direct one after another share one copy of what is below while their
    // rectangles meet nothing drawn since it was made; one that meets another sees it.
    name: "blend-shared",
    swf: blendShared(),
    frames: 2,
    capture: [1, 2],
    tolerance: 3,
    maxOutliers: 0,
  },
  {
    // The same multisampled, where the copy is made where the rectangles lie, those far apart
    // apart.
    name: "blend-shared-antialias",
    swf: blendShared(),
    frames: 2,
    capture: [1, 2],
    antialias: true,
    // The squares' edges moved by part of a pixel on the second frame, multisampled otherwise
    // than adl anti-aliases them: 437 channels past 8, up to 19, drawn alike with each blend's
    // copy its own. A blend that read a copy gone stale would be off over its whole square.
    tolerance: 8,
    maxOutliers: 480,
  },
  {
    // Shapes of fills that meet, drawn through their layers on the first frame and, where they do
    // not overlap, straight onto what is below from the second, once they have stood a frame.
    name: "blend-fills",
    swf: blendFills(),
    frames: 2,
    capture: [1, 2],
    // Their edges, anti-aliased otherwise than adl's, as `blend-shapes`': 280 channels past 32,
    // up to 76, in hard light, difference and darken, which turn an edge's shade the most. Two
    // fills that overlap blended one after the other, not as one picture, would add 375.
    tolerance: 32,
    maxOutliers: 300,
  },
  {
    // The same drawn as the web element draws, a pixel a stage pixel, its edges by multisampling
    // alone: where two fills meet in a pixel, adl blends each by what it covers, as the samples
    // drawn straight onto the stage do, not the pixel they make together, as a layer does.
    name: "blend-fills-host",
    swf: blendFills(),
    frames: 2,
    capture: [2],
    antialias: true,
    draw: true,
    // 220 channels past 48, up to 93: the turned slant's edge and the rows that keep their
    // layers the most. Through layers, 514; fills that overlap blended one after the other, 508.
    tolerance: 48,
    maxOutliers: 260,
  },
  {
    // As `blend-fills-host`, each shape the only child of a clip in the blend mode, as a SWF
    // blends its art: adl blends its fills by what each covers as it does a shape's own.
    name: "blend-sprite-fills-host",
    swf: blendFills(true),
    frames: 2,
    capture: [2],
    antialias: true,
    draw: true,
    // 136 channels past 48, up to 102. Through the clips' layers, 450.
    tolerance: 48,
    maxOutliers: 160,
  },
  {
    // As `blend-sprite-fills-host`, with cacheAsBitmap on the clip, on a clip between, on the shape
    // in it, and on a shape blended itself: adl blends the bitmap it keeps as one picture, with a
    // seam where its fills meet, so each keeps its layer, though the same shape blended in a clip
    // above is drawn without one. A shape of one fill and a bitmap's rectangle in kept clips draw
    // alike either way, and are drawn without.
    name: "blend-sprite-cached-host",
    swf: blendFills(true, true),
    frames: 2,
    capture: [2],
    antialias: true,
    draw: true,
    // 101 channels past 48, up to 96: 72 in the rows of fills that meet, which drawn straight onto
    // the stage where the bitmap is kept make 112, difference, lighten and their seams the most;
    // and 29 in the one fill's edges in add and difference, drawn straight as before, where add
    // clamps each sample's sum rather than the pixel's.
    tolerance: 48,
    maxOutliers: 115,
  },
  {
    // The same multisampled, where each sample of a pixel two fills share blends apart.
    name: "blend-fills-antialias",
    swf: blendFills(),
    frames: 2,
    capture: [1, 2],
    antialias: true,
    // As `blend-fills`: 214 channels past 32, up to 69.
    tolerance: 32,
    maxOutliers: 240,
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
    name: "blend-layer-retirement",
    swf: blendLayerRetirement(),
    frames: 4,
    capture: [1, 2, 3, 4],
    tolerance: 3,
    maxOutliers: 0,
  },
  {
    name: "blend-layer-fade",
    swf: blendLayerFade(),
    frames: 4,
    capture: [1, 2, 3, 4],
    tolerance: 2,
    maxOutliers: 0,
  },
  {
    name: "blend-layer-colors",
    swf: (abc) => bare(abc, 1, "BlendLayerColors", 580, 170),
    script: "BlendLayerColors",
    frames: 6,
    capture: [1, 2, 3, 4, 5, 6],
    tolerance: 3,
    // A newly isolated drawing's alpha offset exposes 76 edge pixels of linear sampling,
    // at most 16 in two channels; its interiors and the other frames stay within 3.
    maxOutliers: 152,
  },
  {
    name: "blend-drift",
    swf: blendDrift(),
    frames: 8,
    capture: [1, 2, 3, 4, 5, 6, 7, 8],
    // A resolution of 6, where a renderer's arithmetic may land a hair off whole pixels.
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
    name: "blend-bitmaps",
    swf: (abc) => bare(abc, 1, "BlendBitmaps", 400, 140),
    script: "BlendBitmaps",
    frames: 3,
    capture: [1, 3],
    // Within 7 a channel: adl's rounding of overlay.
    tolerance: 7,
    maxOutliers: 0,
  },
  {
    name: "blend-shapes",
    swf: (abc) => bare(abc, 1, "BlendShapes", 400, 200),
    script: "BlendShapes",
    frames: 3,
    capture: [1, 3],
    // Their edges, anti-aliased otherwise than adl's; within, each blend as adl's.
    tolerance: 32,
    maxOutliers: 150,
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
    // backdrops resolved out of multisampled targets, which no other case
    // runs. Within 3 a channel, as drawn without multisampling:
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
    // Blends that read what is behind, kept as layers while they stand, blended again each frame.
    name: "blend-kept",
    swf: (abc) => bare(abc, 1, "BlendKept", 240, 120),
    script: "BlendKept",
    frames: 7,
    capture: [1, 2, 3, 4, 5, 6, 7],
    tolerance: 8,
    maxOutliers: 0,
  },
  {
    // Blends moved by parts of a pixel frame after frame, drawn where they are each frame.
    name: "blend-subpixel",
    swf: (abc) => bare(abc, 1, "BlendSubpixel", 240, 100),
    script: "BlendSubpixel",
    frames: 8,
    capture: [1, 2, 3, 4, 5, 6, 7, 8],
    tolerance: 8,
    maxOutliers: 0,
  },
  {
    // The same on a stage shown half as large again, its pixels parts of the target's.
    name: "blend-subpixel-zoomed",
    swf: (abc) => bare(abc, 1, "BlendSubpixel", 240, 100),
    script: "BlendSubpixel",
    frames: 8,
    capture: [1, 2, 3, 4, 5, 6, 7, 8],
    zoom: 1.5,
    tolerance: 8,
    maxOutliers: 0,
  },
  {
    // Blends standing still while masks outside them, on their children or on them, move or change.
    name: "blend-outside-mask",
    swf: (abc) => bare(abc, 1, "BlendOutsideMask", 240, 120),
    script: "BlendOutsideMask",
    frames: 6,
    capture: [1, 2, 3, 4, 5, 6],
    tolerance: 8,
    maxOutliers: 0,
  },
  {
    // The same multisampled: a kept layer resolved into a copy, what is behind resolved as copied.
    name: "blend-kept-antialias",
    swf: (abc) => bare(abc, 1, "BlendKept", 240, 120),
    script: "BlendKept",
    frames: 7,
    capture: [1, 2, 3, 4, 5, 6, 7],
    antialias: true,
    tolerance: 8,
    maxOutliers: 0,
  },
];
