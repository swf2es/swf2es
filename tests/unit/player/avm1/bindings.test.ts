// Text fields bound to AVM1 variables in node, and the focused field's
// selection.
import assert from "node:assert/strict";
import { test } from "node:test";
import { traces } from "./text-fields.ts";

test("a bound field and its variable show each other's changes, and Selection finds its selection", async () => {
  assert.deepEqual(
    await traces(
      [
        `trace(v + " " + t.variable); v = "set"; trace(t.text); t.text = "typed"; trace(v);
t.variable = "mc.w"; trace(mc.w); mc.w = "inner"; trace(t.text + " " + v);
Selection.setFocus(t); trace(Selection.getFocus() + " " + Selection.getBeginIndex() + " " + Selection.getEndIndex());
Selection.setSelection(1, 3); t.replaceSel("_"); trace(t.text + " " + Selection.getCaretIndex());`,
      ],
      8,
      "v",
    ),
    ["Hello v", "set", "typed", "Hello", "inner typed", "_level0.t 0 5", "i_er 2"],
  );
});

test("a field whose variable's clip is not there yet is bound as a clip of that name is made", async () => {
  assert.deepEqual(
    await traces(
      [
        `createEmptyMovieClip("other", 5); trace(t.text);
createEmptyMovieClip("later", 6); trace(later.x + " " + t.text); later.x = "y"; trace(t.text);
later.removeMovieClip(); createEmptyMovieClip("later", 7); later.x = "z"; trace(t.text);`,
      ],
      8,
      "later.x",
    ),
    ["Hello", "undefined Hello", "y", "z"],
  );
});

test("a throw from the variable's toString as the field binds does not stop the field being made", async () => {
  assert.deepEqual(
    await traces(
      [
        `v = {toString: function () { throw "no"; }}; trace("set");`,
        `trace(typeof t + " " + t._name);`,
      ],
      8,
      "v",
      1,
    ),
    ["set", "object t"],
  );
});
