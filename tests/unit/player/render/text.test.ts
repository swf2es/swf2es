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
