// TextField.StyleSheet in node: its styles, their TextFormats, and a
// field's HTML styled by it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { traces } from "../text-fields.ts";

test("a StyleSheet keeps its styles and their TextFormats, and styles a field's HTML", async () => {
  assert.deepEqual(
    await traces([
      `var s = new TextField.StyleSheet();
trace(s.parseCSS(".red { color: #FF0000; font-size: 20px; }  p { text-align: center; }") + " " + s.getStyleNames());
trace(s.getStyle(".red").fontSize + " " + s._styles[".red"].size + " " + s._styles.p.align + " " + s.getStyle("none"));
var f = s.transform({fontWeight: "bold", marginLeft: "-4", kerning: "true"}); trace(f.bold + " " + f.leftMargin + " " + f.kerning + " " + s.transform());
t.styleSheet = s; t.htmlText = '<span class="red">a</span>';
trace(t.htmlText + " " + t.text + " " + t.getTextFormat(0).color + " " + t.getTextFormat(0).size);
t.styleSheet = _root; trace(t.styleSheet + " " + t.htmlText);`,
    ]),
    [
      "true p,.red",
      "20px 20 center null",
      "true 0 true null",
      '<span class="red">a</span> a 16711680 20',
      "undefined a",
    ],
  );
});
