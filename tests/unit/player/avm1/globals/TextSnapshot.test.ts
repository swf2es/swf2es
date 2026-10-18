// TextSnapshot's AS2 face in node: a clip's static texts' text in the
// order they are drawn, read, found and counted as Flash's are (the
// corpus's textsnapshot_* tests).
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

const box = (char: string) => ({
  char,
  advance: 500,
  boxes: [[0, -500, 400, 0]] as [number, number, number, number][],
});

/** A static text of the font's glyphs `indices` (A is 0). */
const text = (id: number, indices: number[]) =>
  w.staticText({
    id,
    bounds: [0, 2000, -400, 100],
    records: [{ font: 1, height: 400, x: 0, y: 0, glyphs: indices.map((i) => [i, 200]) }],
  });

/** What `source` traces in a SWF whose root shows "ABC" at depth 1 and "DE" at depth 3, placed first. */
async function play(source: string): Promise<string[]> {
  const swf = w.swf({
    version: 8,
    width: 200,
    height: 100,
    frameCount: 1,
    tags: [
      w.font3({ id: 1, name: "Box", ascent: 800, descent: 200, glyphs: [..."ABCDE"].map(box) }),
      text(2, [0, 1, 2]),
      text(3, [3, 4]),
      w.place({ depth: 3, character: 3 }),
      w.place({ depth: 1, character: 2 }),
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const avm1 = new Avm1(codegen, { print: (line) => lines.push(line), realTime: null });
  await new Player(swf, null, avm1).start();
  return lines;
}

test("a snapshot counts and reads its clip's static texts in the order they are drawn", async () => {
  assert.deepEqual(
    await play(`var ts = new TextSnapshot(_root);
trace(ts.getCount()); trace(ts.getCount(1));
trace(ts.getText(0, 100)); trace(ts.getText(0, 100, true) == "ABC\\nDE");
trace(ts.getText(1, 3)); trace(ts.getText(3, 1)); trace(ts.getText(100, 200)); trace(ts.getText(-5, 0));
trace(ts.getText(0)); trace(ts.getText(0, 1, true, 1));
trace(this.getTextSnapshot().getText(0, 2));`),
    ["5", "undefined", "ABCDE", "true", "BC", "D", "E", "A", "undefined", "undefined", "AB"],
  );
});

test("findText finds from an index on, ASCII's case aside unless asked", async () => {
  assert.deepEqual(
    await play(`var ts = new TextSnapshot(_root);
trace(ts.findText(0, "cd", false)); trace(ts.findText(0, "cd", true)); trace(ts.findText(3, "CD", true));
trace(ts.findText(0, "", false)); trace(ts.findText(-1, "A", true)); trace(ts.findText(0, "A"));`),
    ["2", "-1", "-1", "-1", "-1", "undefined"],
  );
});

test("a snapshot of nothing answers undefined; its methods are enumerable from SWF 6", async () => {
  assert.deepEqual(
    await play(`var ts = new TextSnapshot(); trace(ts.getCount()); trace(ts.getText(0, 1));
var names = []; for (var p in TextSnapshot.prototype) { names.push(p); } trace(names.join());`),
    [
      "undefined",
      "undefined",
      "getTextRunInfo,setSelectColor,findText,hitTestTextNearPos,getSelectedText,getText,getSelected,setSelected,getCount",
    ],
  );
});
