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

test("a centred field's text is centred in it, past its 2 pixel gutter from the top", () => {
  const field = placed(w.editText(3, "Loading", 4000, 400, 2));
  const view = new PixiView({} as ConstructorParameters<typeof PixiView>[0]);
  view.prepare(field);
  const text = view.stage.children[0].children[0].children[0] as unknown as {
    x: number;
    y: number;
    anchor: { x: number };
  };
  assert.deepEqual([text.x, text.y, text.anchor.x], [100, 2, 0.5]);
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
