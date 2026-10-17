// TextFormat's AS2 face in node: its values as each SWF version converts
// them, and the formats a field's methods give and take.
import assert from "node:assert/strict";
import { test } from "node:test";
import { traces } from "../text-fields.ts";

test("TextFormat keeps what it sets, null for the rest, converted by the SWF's version", async () => {
  const source = `var f = new TextFormat("Arial", 12.7, 0xff0000, true, null, undefined, "u", "t", "CENTER", 1.6, -2, 3, 4);
trace(f.font + " " + f.size + " " + f.color + " " + f.bold + " " + f.italic + " " + f.underline + " " + f.url + " " + f.target + " " + f.align);
trace(f.leftMargin + " " + f.rightMargin + " " + f.indent + " " + f.leading + " " + f.tabStops + " " + f.display);
f.size = 2.5; f.leftMargin = -3; f.indent = NaN; f.align = "nowhere"; f.tabStops = [1.5, 2.5];
trace(f.size + " " + f.leftMargin + " " + f.indent + " " + f.align + " " + f.tabStops);
var o = {}; o.__proto__ = TextFormat.prototype; trace(o.font);`;
  assert.deepEqual(await traces([source], 8), [
    "Arial 12 16711680 true null null u t center",
    "1 -2 3 4 null block",
    "2 0 -2147483648 center 2,2",
    "undefined",
  ]);
  assert.deepEqual((await traces([source], 7))[2], "2 0 0 center 2,2");
});

test("setTextFormat formats a range, one character or the text, and new text takes getNewTextFormat's", async () => {
  assert.deepEqual(
    await traces([
      `var b = new TextFormat(); b.bold = true;
t.setTextFormat(1, 3, b); trace(t.getTextFormat(0, 1).bold + " " + t.getTextFormat(1, 3).bold + " " + t.getTextFormat().bold);
t.setTextFormat(4, b); trace(t.getTextFormat(4).bold + " " + t.getTextFormat(3).bold);
t.setNewTextFormat(b); t.text = "new"; trace(t.getTextFormat().bold + " " + t.getNewTextFormat().bold + " " + t.getNewTextFormat().size);
t.replaceText(1, 2, "XY"); trace(t.text);`,
    ]),
    ["false true null", "true false", "true true 12", "nXYw"],
  );
});
