// Stage's dimensions and property behaviour, checked in native Flash Player 32.
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

async function play(source: string, version = 8) {
  const bytes = w.swf({
    version,
    width: 600,
    height: 400,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, version)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const errors: unknown[] = [];
  const vm = new Avm1(codegen, {
    audio: null,
    realTime: null,
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
  });
  const player = new Player(bytes, null, vm);
  await player.start();
  assert.deepEqual(errors, []);

  return { lines, player };
}

for (const version of [5, 6, 7, 8]) {
  test(`Stage exposes the player's size and is a broadcaster from SWF 6 (SWF ${version})`, async () => {
    const { lines, player } = await play(
      `trace(typeof Stage + " " + Stage + " " + (Stage.__proto__ == Object.prototype));
trace(Stage.width + " " + Stage.height);
var names = []; for (var k in Stage) { if (k == "width" || k == "height") { names.push(k); } }
trace(names.sort().join(","));
trace(typeof Stage.addListener + " " + typeof Stage.removeListener + " " + typeof Stage.broadcastMessage);
trace(Stage.Width);
ASSetPropFlags(Stage, "addListener,removeListener,broadcastMessage,_listeners", 0, 128);
trace(typeof Stage.addListener + " " + typeof Stage.removeListener);`,
      version,
    );

    assert.deepEqual(lines, [
      "object [object Object] true",
      "600 400",
      "height,width",
      version < 6 ? "undefined undefined undefined" : "function function function",
      version <= 6 ? "600" : "undefined",
      "function function",
    ]);
    player.destroy();
  });

  test(`Stage dimensions ignore assignment and can be deleted (SWF ${version})`, async () => {
    const { lines, player } = await play(
      `Stage.width = 12; Stage.height = 34;
trace(Stage.width + " " + Stage.height);
ASSetPropFlags(Stage, "width,height", 0, 7);
Stage.width = 56; Stage.height = 78;
trace(Stage.width + " " + Stage.height);
trace((delete Stage.width) + " " + (delete Stage.height));
trace(typeof Stage.width + " " + typeof Stage.height);
Stage.width = 12; Stage.height = 34;
trace(Stage.width + " " + Stage.height);`,
      version,
    );

    assert.deepEqual(lines, ["600 400", "600 400", "true true", "undefined undefined", "12 34"]);
    player.destroy();
  });
}

test("a camera can translate the root using Stage dimensions without changing them", async () => {
  const { lines, player } = await play(
    `var cam = createEmptyMovieClip("cam", 1); cam._x = 115; cam._y = 200;
var view = new flash.geom.Transform(cam);
var camera = new flash.geom.Transform(_root);
var m = view.matrix;
m.invert(); m.translate(Stage.width * 0.5, Stage.height * 0.5);
camera.matrix = m;
trace(_root._x + " " + _root._y + " " + Stage.width + " " + Stage.height);`,
  );

  assert.deepEqual(lines, ["185 0 600 400"]);
  assert.ok(Object.values(player.root.matrix).every(Number.isFinite));
  player.destroy();
});
