import assert from "node:assert/strict";
import { test } from "node:test";
import { TextObject } from "../../../packages/player/dist/display.js";
import { PixiView } from "../../../packages/player/dist/pixi.js";

test("a centered text field lays its text out within the field's width", () => {
  const field = new TextObject(null);
  field.width = 200;
  field.text = "Loading";
  field.align = "center";
  const view = new PixiView({} as ConstructorParameters<typeof PixiView>[0]);
  view.prepare(field);
  const text = view.stage.children[0].children[0].children[0];

  assert.equal(text.x, 100);
  assert.equal((text as unknown as { anchor: { x: number } }).anchor.x, 0.5);
});
