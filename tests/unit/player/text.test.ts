// TextFields placed by a timeline, and how the renderer lays their text out.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TextObject } from "../../../packages/player/dist/display.js";
import { PixiView } from "../../../packages/player/dist/pixi.js";
import { Player } from "../../../packages/player/dist/player.js";
import * as w from "../../swf-writer.ts";

function placed(...definitions: Uint8Array[]): TextObject {
  const player = new Player(
    w.swf({
      width: 200,
      height: 100,
      frameCount: 1,
      tags: [...definitions, w.place({ depth: 1, character: 3 }), w.showFrame(), w.end()],
    }),
  );
  return player.root.depths.get(1) as TextObject;
}

test("a field's tag text is read as HTML where the tag says so, in the tag's font and format", () => {
  const field = placed(
    w.fontName(5, "Verdana", true),
    w.editText(3, "<p>one <font color='#ff0000'>two</font></p><p>three</p>", 4000, 1000, 2, {
      html: true,
      multiline: true,
      color: 0x336699,
      font: 5,
      fontHeight: 280,
    }),
  );
  assert.equal(field.text, "one two\rthree\r");
  assert.deepEqual([field.width, field.height, field.align], [200, 50, "center"]);
  const first = field.model.formats[0];
  assert.deepEqual(
    [first.font, first.bold, first.size, first.color],
    ["Verdana", true, 14, 0x336699],
  );
  assert.equal(field.model.formats[4].color, 0xff0000);
});

test("a centred field's text is drawn where its layout centres it, past the 2 pixel gutter", () => {
  const field = placed(w.editText(3, "Loading", 4000, 400, 2));
  const view = new PixiView({} as ConstructorParameters<typeof PixiView>[0]);
  view.prepare(field);
  const line = field.layout.lines[0];
  const text = view.stage.children[0].children[0].children[0].children[0] as unknown as {
    x: number;
  };
  assert.equal(text.x, line.x / 20);
  // Centred in the 196 pixels past the gutters: as far from the right edge as the left.
  assert.equal(line.x / 20 - 2, 200 - 2 - (line.x + line.width) / 20);
});

test("text a margin moves past its field's edge is clipped, though it is narrower than the field", async () => {
  const { overruns } = await import("../../../packages/player/dist/pixi.js");
  const field = { left: 0, top: 0, width: 100, height: 20 };
  // 30 pixels of text from an 80 pixel margin, past the 2 pixel gutter: out to 112.
  assert.equal(overruns(field, 82, 2, 30, 14), true);
  assert.equal(overruns(field, 2, 2, 30, 14), false);
  assert.equal(overruns(field, 2, -1, 30, 14), true);
});

test("a long append keeps a format for every character", async () => {
  const { TextModel } = await import("../../../packages/player/dist/text.js");
  const model = new TextModel();
  model.setText("ab");
  model.replace(2, 2, "x".repeat(200_000));
  assert.equal(model.text.length, 200_002);
  assert.equal(model.formats.length, 200_002);
  model.replace(1, 199_000, "y");
  assert.deepEqual([model.text.length, model.formats.length], [1_004, 1_004]);
});

test("a long unbroken word wraps between its characters in time that grows with it, not its square", async () => {
  const { layoutText } = await import("../../../packages/player/dist/text-layout.js");
  const { DEFAULT_FORMAT } = await import("../../../packages/player/dist/text.js");
  const n = 64_000;
  const started = performance.now();
  const layout = layoutText({
    text: "x".repeat(n),
    formats: new Array(n).fill(DEFAULT_FORMAT),
    defaultFormat: DEFAULT_FORMAT,
    width: 60,
    wordWrap: true,
    embedFonts: false,
    fonts: null,
  });
  // Node's stand-in device font: 6 pixels a character at 12, 9 to the 56 pixels inside the gutters.
  assert.equal(layout.lines.length, Math.ceil(n / 9));
  assert.ok(layout.lines.every((line, i) => line.start === i * 9));
  // Some 40 ms; measured again for each line it took seconds.
  assert.ok(performance.now() - started < 2000);
});

test("a password field is laid out, and so drawn, as asterisks, in an embedded font too", async () => {
  const { TextObject } = await import("../../../packages/player/dist/display.js");
  const { FontSet } = await import("../../../packages/player/dist/fonts.js");
  const { readFont, tags } = await import("../../../packages/format/dist/index.js");
  const bytes = w.font3({
    id: 1,
    name: "Probe",
    ascent: 800,
    descent: 200,
    glyphs: [
      { char: "a", advance: 500, boxes: [[0, -500, 400, 0]] },
      { char: "*", advance: 300, boxes: [[0, -500, 200, -300]] },
    ],
  });
  const fonts = new FontSet();
  fonts.add(
    readFont(bytes, { code: tags.DefineFont3, offset: 6, length: bytes.length - 6, long: true }),
  );
  const field = new TextObject(null);
  field.fonts = fonts;
  field.embedFonts = true;
  field.model.defaultFormat = { ...field.model.defaultFormat, font: "Probe", size: 20 };
  field.model.setText("aa");
  assert.equal(field.layout.width, 2 * 195);

  field.displayAsPassword = true;
  const chars = field.layout.lines[0].chars;
  assert.deepEqual(
    chars.map((c) => c.glyph?.code),
    [42, 42],
  );
  // 300 of 1024 at 20 pixels, 117 twips each, truncated.
  assert.equal(field.layout.width, 2 * 117);
});

test("text a horizontal scroll moves past the gutter is clipped", async () => {
  const { TextObject } = await import("../../../packages/player/dist/display.js");
  const field = new TextObject(null);
  field.model.setText("abc");
  const view = new PixiView({} as ConstructorParameters<typeof PixiView>[0]);
  view.prepare(field);
  const drawn = () =>
    view.stage.children[0].children[0].children.find((c) => c.children.length > 0) as unknown as {
      mask: unknown;
    };
  assert.ok(!drawn().mask);

  field.scrollH = 30;
  field.invalidate(4);
  view.prepare(field);
  assert.ok(drawn().mask);
});
