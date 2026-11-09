// The player's text cases (cases.ts): static text, fonts, text fields'
// layout and drawing, and the advanced engine.
import { readFileSync } from "node:fs";
import * as w from "../../swf-writer.ts";
import type { Compile } from "../scripts.ts";
import { bare, type PlayerCase, probeFont, stemFont } from "./common.ts";

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
  const template = readFileSync(
    new URL("../scripts/LoadedFont.as.template", import.meta.url),
    "utf8",
  );
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
    new URL("../scripts/FontRegistration.as.template", import.meta.url),
    "utf8",
  );
  const abc = compile(
    "FontRegistration",
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return bare(abc, 3, "FontRegistration");
}

// Legacy glyphs with narrow codes, wide codes, and no character table.
function legacyStaticTexts(abc?: Uint8Array): Uint8Array {
  const glyphs: w.GlyphSpec[] = [
    {
      char: "A",
      advance: 0,
      boxes: [
        [0, -800, 200, 0],
        [200, -800, 700, -600],
      ],
    },
    { char: "Ω", advance: 0, boxes: [[100, -600, 600, 0]] },
  ];
  const tags: Uint8Array[] = [w.backgroundColor(0x000000)];
  for (let i = 0; i < 3; i++) {
    const font = i + 1;
    const text = i + 4;
    tags.push(
      w.font1(font, glyphs),
      w.staticText({
        id: text,
        bounds: [0, 4000, -1200, 0],
        records: [
          {
            font,
            height: 1200,
            color: [0x00ff00, 0x00ffff, 0xffff00][i],
            glyphs: [
              [0, 1600],
              [1, 1600],
              [0, 1600],
            ],
          },
        ],
      }),
      w.place({ depth: i + 1, character: text, matrix: { tx: 400, ty: 1400 + i * 1600 } }),
    );
    if (i < 2) {
      tags.push(
        w.fontInfo(font, "Legacy", i === 0 ? [65, 90] : [65, 0x3a9], {
          version: i === 0 ? 1 : 2,
        }),
      );
    }
  }

  if (abc) {
    tags.unshift(w.fileAttributes(true));
    tags.push(w.doAbc(abc, "LegacyStaticTextProbe"), w.symbolClass([[0, "LegacyStaticTextProbe"]]));
  }

  return w.swf({
    version: abc ? 10 : 6,
    width: 280,
    height: 260,
    frameCount: 1,
    tags: [...tags, w.showFrame(), w.end()],
  });
}

// Static text in Probe, defined before its font: two lines in two colours,
// and a DefineText2 turned and scaled by its
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

function textAdvancedMirrored(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 360,
    height: 160,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      stemFont(1),
      w.doAbc(abc, "TextAdvancedMirrored"),
      w.symbolClass([[0, "TextAdvancedMirrored"]]),
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

export const textCases: PlayerCase[] = [
  {
    name: "legacy-static-text",
    swf: legacyStaticTexts(),
    frames: 1,
    capture: [1],
    tolerance: 32,
    maxOutliers: 100,
  },
  {
    name: "legacy-static-text-probe",
    swf: legacyStaticTexts,
    script: "LegacyStaticTextProbe",
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
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
    name: "static-text-probe",
    swf: staticTextProbe,
    script: "StaticTextProbe",
    frames: 2,
    capture: [1],
    tolerance: 32,
    maxOutliers: 20,
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
  // A size set on a field that fits itself, fitted again only when asked or drawn (adl).
  {
    name: "text-autosize-later",
    swf: (abc) => bare(abc, 1, "TextAutoSizeLater"),
    script: "TextAutoSizeLater",
    frames: 3,
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
    name: "font-registration",
    build: fontRegistration,
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
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
    name: "text-advanced-mirrored",
    swf: textAdvancedMirrored,
    script: "TextAdvancedMirrored",
    frames: 1,
    capture: [1],
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
    name: "text-fields",
    swf: (abc) => bare(abc, 1, "TextFields"),
    script: "TextFields",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "loaded-font",
    build: loadedFont,
    frames: 3,
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
];
