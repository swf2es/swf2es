// The CSS font a device font is drawn in: by its name, then by the kind
// the browser falls back to where the machine has no font of that name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cssFont } from "../../../../packages/player/dist/text/fonts.js";

test("Flash's own device fonts are the browser's of their kind", () => {
  assert.equal(cssFont("_sans", 12, false, false), '12px "Arial", "Helvetica", sans-serif');
  assert.equal(cssFont("_serif", 12, true, false), 'bold 12px "Times New Roman", "Times", serif');
  assert.equal(
    cssFont("_typewriter", 12, false, true),
    'italic 12px "Courier New", "Courier", monospace',
  );
});

test("a well-known system font falls back to a font of its kind", () => {
  assert.equal(cssFont("Tahoma", 11, false, false), '11px "Tahoma", sans-serif');
  assert.equal(cssFont("VERDANA", 11, false, false), '11px "VERDANA", sans-serif');
  assert.equal(cssFont("Courier New", 11, false, false), '11px "Courier New", monospace');
});

test("any other font falls back to serif, as Flash's default is", () => {
  assert.equal(cssFont("Georgia", 11, false, false), '11px "Georgia", serif');
  assert.equal(cssFont("No Such Font", 11, false, false), '11px "No Such Font", serif');
});
