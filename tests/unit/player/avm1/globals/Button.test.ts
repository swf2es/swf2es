// Button's AS2 face in node: a button's prototype, its depth, and a class
// registered for its symbol, which a button does not take.
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

const as1 = (source: string) => w.doAction([...script(source, 6)(flashAssembler()).end().bytes()]);

test("a button is a Button, whose depth it gives, and a class registered for its symbol is not its", async () => {
  const lines: string[] = [];
  const swf = w.swf({
    version: 6,
    width: 10,
    height: 10,
    frameCount: 1,
    tags: [
      w.shape({
        id: 1,
        bounds: [0, 200, 0, 200],
        fills: [0xff0000],
        paths: [{ fill1: 1, commands: [{ move: [0, 0] }, { line: [200, 0] }, { line: [0, 200] }] }],
      }),
      w.button(2, 1, []),
      w.exportAssets([[2, "button"]]),
      as1(`Object.registerClass("button", function () { trace("constructed"); });`),
      w.place({ depth: 3, character: 2, name: "b" }),
      as1(
        `trace(typeof b + " " + (b.__proto__ == Button.prototype) + " " + b.getDepth() + " " + b.enabled + " " + b.useHandCursor);`,
      ),
      w.showFrame(),
      w.end(),
    ],
  });
  const player = new Player(swf, null, new Avm1(codegen, { print: (line) => lines.push(line) }));
  await player.start();

  assert.deepEqual(lines, ["object true -16381 true true"]);
});
