// The player's filter cases (cases.ts): each kind drawn and applied,
// nested, cached, reaching far and zoomed.
import * as w from "../../swf-writer.ts";
import { bare, circlePath, type PlayerCase, probeFont, rectPath, square } from "./common.ts";

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

// Thin repeated geometry under wide blurs and glows, as in wideFilters: stripes
// half a stage pixel wide, hatching, a checkerboard of half pixels and
// text-like strokes, whose coverage a coarser drawing of the object would
// get wrong in bulk (a blur shrinks only what it reads, by averaging whole
// texels); and a shadow of no passes that hides its object, drawn
// antialiased as it is.
function thinFilters(zoom: number): Uint8Array {
  const at = (x: number, y: number) => ({ a: zoom, d: zoom, tx: x * 20 * zoom, ty: y * 20 * zoom });
  const z = (blur: number) => blur * zoom;
  const stripes: w.PathCommand[] = [];
  for (let x = 0; x < 40; x++) {
    stripes.push(...rectPath(x + 0.1, 0, 0.5, 40));
  }

  const hatching: w.PathCommand[] = [];
  for (let x = 0; x < 30; x += 1.3) {
    const [l, r] = [Math.round(x * 20), Math.round((x + 0.35) * 20)];
    hatching.push(
      { move: [l, 0] },
      { line: [r, 0] },
      { line: [r + 400, 800] },
      { line: [l + 400, 800] },
      { line: [l, 0] },
    );
  }

  const checker: w.PathCommand[] = [];
  for (let y = 0; y < 20; y += 0.5) {
    for (let x = 0; x < 20; x += 0.5) {
      if (((x + y) * 2) % 2 === 0) {
        checker.push(...rectPath(x, y, 0.5, 0.5));
      }
    }
  }

  const text: w.PathCommand[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 8; column++) {
      const [x, y] = [column * 5, row * 13];
      text.push(
        ...rectPath(x, y, 0.6, 9),
        ...rectPath(x + 2, y, 0.6, 9),
        ...rectPath(x, y + 4, 2.6, 0.6),
      );
    }
  }

  const shape = (id: number, commands: w.PathCommand[]) =>
    w.shape({
      id,
      bounds: [0, 1100, 0, 800],
      fills: [0xffffff],
      paths: [{ fill1: 1, commands }],
    });
  return w.swf({
    width: 300 * zoom,
    height: 160 * zoom,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.backgroundColor(0x102030),
      shape(1, stripes),
      shape(2, hatching),
      shape(3, checker),
      shape(4, text),
      w.place({ depth: 1, character: 1, matrix: at(10, 10), blurs: [z(64)], quality: 1 }),
      w.place({
        depth: 2,
        character: 2,
        matrix: at(70, 10),
        blurs: [z(27)],
        quality: 2,
      }),
      w.place({
        depth: 3,
        character: 3,
        matrix: at(140, 15),
        glows: [{ color: 0x33ccff, blur: z(27), strength: 2.37 }],
        quality: 2,
      }),
      w.place({
        depth: 4,
        character: 4,
        matrix: at(190, 10),
        glows: [{ color: 0xff6600, blur: z(64), strength: 1 }],
        quality: 1,
      }),
      w.place({
        depth: 5,
        character: 1,
        matrix: at(30, 105),
        shadows: [{ blur: z(64), distance: 0, angle: 0, hide: true }],
        quality: 0,
      }),
      w.place({ depth: 6, character: 3, matrix: at(140, 110), blurs: [z(64)], quality: 1 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Wide filters on a stage a host shows `zoom` times its size, as an
// animation's light effects draw them: glows 27 and 68 wide in two passes,
// a streak glow 68 across and 5 down, a blur 30 wide and a shadow 24 wide
// in three. Their runs go coarser than
// the screen (@swf2es/render's blurShrink), which must not show against
// adl's frame of the SWF built `zoom` times larger.
function wideFilters(zoom: number): Uint8Array {
  const at = (x: number, y: number) => ({ a: zoom, d: zoom, tx: x * 20 * zoom, ty: y * 20 * zoom });
  const z = (blur: number) => blur * zoom;
  return w.swf({
    width: 300 * zoom,
    height: 160 * zoom,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.backgroundColor(0x102030),
      w.shape({
        id: 1,
        bounds: [0, 800, 0, 400],
        fills: [0xffffff],
        paths: [{ fill1: 1, commands: rectPath(0, 0, 40, 20) }],
      }),
      w.shape({
        id: 2,
        bounds: [-300, 300, -300, 300],
        fills: [0xffcc00],
        paths: [{ fill1: 1, commands: rectPath(-15, -15, 30, 30) }],
      }),
      w.shape({
        id: 3,
        bounds: [0, 600, 0, 600],
        fills: [0xcc2200],
        paths: [{ fill1: 1, commands: rectPath(0, 0, 30, 30) }],
      }),
      w.place({
        depth: 1,
        character: 1,
        matrix: at(30, 30),
        glows: [{ color: 0x33ccff, blur: z(27), strength: 2 }],
        quality: 2,
      }),
      w.place({
        depth: 2,
        character: 2,
        matrix: at(150, 50),
        glows: [{ color: 0xff6600, blur: z(68), strength: 1.5 }],
        quality: 2,
      }),
      w.place({ depth: 3, character: 3, matrix: at(220, 25), blurs: [z(30)], quality: 3 }),
      w.place({
        depth: 5,
        character: 1,
        matrix: at(190, 125),
        glows: [{ color: 0xffffff, blur: z(68), blurY: z(5), strength: 2.27 }],
        quality: 2,
      }),
      w.place({
        depth: 4,
        character: 1,
        matrix: at(40, 110),
        shadows: [{ blur: z(24), distance: z(10), angle: 45 }],
        quality: 3,
      }),
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

export const filterCases: PlayerCase[] = [
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
    // A filtered Shape in a 9-slice panel whose slice moves as a sibling grows
    // (scripts/SliceFiltered.as): stretched whole, not sliced, as adl draws it.
    name: "slice-filtered",
    swf: (abc) => bare(abc, 3, "SliceFiltered", 320, 120),
    script: "SliceFiltered",
    frames: 3,
    capture: [1, 3],
    // The glow's and the rounded corners' edges anti-alias within a pixel of Flash's.
    tolerance: 32,
    maxOutliers: 200,
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
    // An inner drop shadow that hides its object draws as a knocked-out one, on screen and
    // through applyFilter (scripts/FilterInnerHide.as): its object was drawn under it.
    name: "filter-inner-hide",
    swf: (abc) => bare(abc, 1, "Main", 400, 200),
    script: "FilterInnerHide",
    frames: 1,
    capture: [1],
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
    // Filtered objects in filtered objects: the renderer draws the inner ones a level before
    // the outer, side by side, and composites them into the outer's content.
    name: "filters-nested",
    swf: (abc) => bare(abc, 1, "FiltersNested", 300, 200),
    script: "FiltersNested",
    frames: 1,
    capture: [1],
    // As "filters": the page's samples against adl's whole pixels, up to 12 a channel in the
    // shadow of 0.6 alpha round the two glows, and along the multiplied shadow's edge.
    tolerance: 12,
    maxOutliers: 0,
  },
  {
    // As "filters-nested" at low quality, where nothing is multisampled: the multiplied shadow
    // copies what is below it out of its outer layer's page as it is.
    name: "filters-nested-low",
    swf: (abc) => bare(abc, 1, "FiltersNested", 300, 200),
    script: "FiltersNested",
    quality: "low",
    frames: 1,
    capture: [1],
    tolerance: 12,
    maxOutliers: 0,
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
    name: "wide-filters",
    swf: wideFilters(1),
    frames: 1,
    capture: [1],
    zoom: 3,
    shown: true,
    flash: wideFilters(3),
    tolerance: 8,
    maxOutliers: 0,
  },
  {
    name: "thin-filters",
    swf: thinFilters(1),
    frames: 1,
    capture: [1],
    zoom: 3,
    shown: true,
    flash: thinFilters(3),
    tolerance: 8,
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
];
