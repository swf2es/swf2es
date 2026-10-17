// TextField's AS2 face in node: fields a SWF places and createTextField
// makes, and their properties.
import assert from "node:assert/strict";
import { test } from "node:test";
import { traces } from "../text-fields.ts";

test("a placed field is a TextField, a broadcaster that hears itself first", async () => {
  assert.deepEqual(
    await traces([
      `trace((t.__proto__ == TextField.prototype) + " " + typeof t + " " + t);
trace(t.text + " " + t.length + " " + t.type + " " + t.getDepth() + " " + t._listeners[0]._name);`,
    ]),
    ["true object _level0.t", "Hello 5 input -16383 t"],
  );
});

test("createTextField places a field in whole pixels, which only a SWF 8 gets back", async () => {
  assert.deepEqual(
    await traces([
      `var f = createTextField("f", 5, 2.7, 3.2, 50.9, 20);
trace(f + " " + f._x + " " + f._y + " " + f._width + " " + f._height);
f._height = 3.94; trace(f._height);
trace(this.createTextField("g", 6, 0, 0, 10, 10) + " " + g.getDepth() + " " + g.text.length);`,
    ]),
    ["_level0.f 2 3 50 20", "3.9", "_level0.g 6 0"],
  );
  assert.deepEqual(await traces([`trace(createTextField("f", 5, 0, 0, 10, 10) + " " + f);`], 7), [
    "undefined _level0.f",
  ]);
});

test("text, htmlText and the field's flags read and write the field, which a script removes only at its depths", async () => {
  assert.deepEqual(
    await traces([
      `t.text = "a\\nb"; trace(escape(t.text));
t.html = true; t.multiline = true; t.htmlText = "<b>x</b>";
trace(t.text + " " + t.getTextFormat(0).bold + " " + t.html);
t.autoSize = true; trace(t.autoSize); t.autoSize = "CENTER"; trace(t.autoSize); t.autoSize = "x"; trace(t.autoSize);
t.type = "DYNAMIC"; trace(t.type); t.type = "other"; trace(t.type);
trace(t.maxChars + " " + t.restrict + " " + t.variable + " " + t.tabIndex);
t.maxChars = 4; t.restrict = ""; t.tabIndex = -4; trace(t.maxChars + " " + t.restrict + " " + t.tabIndex);
t.textColor = 0x1ff0000; trace(t.textColor + " " + t.getTextFormat().color);
t.removeTextField(); createTextField("r", 9, 0, 0, 1, 1); r.removeTextField(); trace(t + " " + r);`,
    ]),
    [
      "a%0Db",
      "x true true",
      "left",
      "center",
      "none",
      "dynamic",
      "dynamic",
      "null null null undefined",
      "4 null 4294967292",
      "16711680 16711680",
      "_level0.t undefined",
    ],
  );
});
