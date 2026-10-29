// How the renderer draws text: where a field clips what it lays out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceTextResolution, overruns } from "../../../../packages/player/dist/scene/text.js";

test("device text resolves its largest stretch, including skew, reflection and screen pixels", () => {
  assert.equal(deviceTextResolution([1, 0, 0, 1], 1), 1);
  assert.equal(deviceTextResolution([3, 0, 0, 3], 1), 3);
  assert.equal(deviceTextResolution([1, 0, 0, -3], 2), 6);
  assert.equal(deviceTextResolution([1, 0, 2, 1], 1), 3);
  const angle = 0.2;
  assert.equal(
    deviceTextResolution([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle)], 1),
    1,
  );
  assert.equal(deviceTextResolution([0.25, 0, 0, 0.25], 4), 4);
});

test("device text caps magnification and rejects non-finite stretch without requesting huge textures", () => {
  assert.equal(deviceTextResolution([1000, 0, 0, 1000], 1), 8);
  assert.equal(deviceTextResolution([1000, 0, 0, 1000], 2), 16);
  assert.equal(deviceTextResolution([Number.POSITIVE_INFINITY, 0, 0, 1], 2), 2);
  assert.equal(deviceTextResolution([1, 0, 0, 1], Number.NaN), 1);
});

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
