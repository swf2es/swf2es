// TextField and TextFormat's AS2 faces in node: fields a SWF places and
// createTextField makes, their properties and formats, and a field bound
// to a variable, compiled by the release codegen.wasm.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

const as1 = (source: string, version: number) =>
  w.doAction([...script(source, version)(flashAssembler()).end().bytes()]);

/**
 * What `frames` trace, each a frame's actions, in a SWF of `version` whose
 * root places field `t` showing "Hello" at depth 1, bound to `variable`
 * where given, and clip `mc` at depth 2.
 */
async function traces(frames: string[], version = 8, variable?: string): Promise<string[]> {
  const swf = w.swf({
    version,
    width: 200,
    height: 100,
    frameCount: frames.length,
    tags: [
      w.editText(1, "Hello", 2000, 400, 0, { variable }),
      w.sprite(2, 1, [w.showFrame(), w.end()]),
      w.place({ depth: 1, character: 1, name: "t" }),
      w.place({ depth: 2, character: 2, name: "mc" }),
      ...frames.flatMap((source) => [as1(source, version), w.showFrame()]),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const errors: unknown[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
    realTime: null,
  });
  const player = new Player(swf, null, avm1);
  await player.start();
  for (let i = 1; i < frames.length; i++) {
    player.tick();
  }

  assert.deepEqual(errors, []);
  return lines;
}

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
