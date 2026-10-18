// How the renderer draws text: where a field clips what it lays out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { overruns } from "../../../../packages/player/dist/render/text.js";

test("text a margin moves past its field's edge is clipped, though it is narrower than the field", () => {
  const field = { left: 0, top: 0, width: 100, height: 20 };
  // 30 pixels of text from an 80 pixel margin, past the 2 pixel gutter: out to 112.
  assert.equal(overruns(field, 82, 2, 30, 14), true);
  assert.equal(overruns(field, 2, 2, 30, 14), false);
  assert.equal(overruns(field, 2, -1, 30, 14), true);
});

test("text that only meets its field's edge, the field's size rounded off from twips, is not clipped", () => {
  // An autosized field of 1202 twips of text and its gutters: advanced text, thickened, had its
  // last glyph clipped by a rounding error of the field's width in pixels.
  const width = (1202 + 80) / 20;
  const inner = { left: 2, top: 2, width: width - 4, height: 20 };
  assert.equal(overruns(inner, 2, 2, 1202 / 20, 14), false);
  assert.equal(overruns(inner, 2, 2, 1203 / 20, 14), true);
});
