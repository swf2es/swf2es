// The player's AS3 half in node, without a renderer: a document class
// compiled in the oracle's container, loaded through the release
// codegen.wasm, constructed on the root with the timeline's children in
// place, its frame scripts run in frame order.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../oracle/oracle.ts";
import type { MovieClip } from "../../../packages/player/dist/display.js";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { scripted } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compileScripts } from "../../player/scripts.ts";

// This package's own out directory: the player's tests run at the same time and use theirs.
const out = fileURLToPath(new URL("../out/player/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("a document class is constructed on the root and its frame scripts run in order", {
  skip,
}, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = compileScripts(["Main"], out).get("Main") as Uint8Array;
  const player = new Player(scripted(abc), scripting);
  await player.start();

  // Constructed with frame 1's children in place, then frame 1's script.
  assert.deepEqual(lines, ["Main 1 2 1 box 10", "frame 1 1 10"]);
  const root = player.root;
  assert.ok(root.object);
  assert.equal(root.object.$display, root);
  // A main movie's document class is constructed on the stage; a Loader's content is not (see the oracle).
  assert.equal(root.parent, player.stage);
  assert.ok(player.stage.object);
  const box = root.depths.get(1) as MovieClip;
  assert.ok(box.object);
  assert.equal(box.currentFrame, 1);

  player.tick();
  assert.deepEqual(lines.slice(2), ["frame 2 2 50"]);
  // The loop back to frame 1 runs its script again; the box is the same object.
  player.tick();
  assert.deepEqual(lines.slice(3), ["frame 1 1 10"]);
  assert.equal(root.depths.get(1), box);
});
