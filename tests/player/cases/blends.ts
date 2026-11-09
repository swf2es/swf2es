// The player's blend mode cases (cases.ts): each mode's formula, the
// layers kept and retired, their edges, subpixel moves and masks.
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

export const blendCases: PlayerCase[] = [
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
