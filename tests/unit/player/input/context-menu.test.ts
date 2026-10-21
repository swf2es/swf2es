import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compileScripts } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/player-context-menu/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (error) {
  skip = (error as Error).message;
}

for (const lazyCompilation of [false, true]) {
  test(`context menus snapshot after opening, dispatch once and expire on destroy (lazy=${lazyCompilation})`, {
    skip,
  }, async () => {
    const wasm = await WebAssembly.compile(
      readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
    );
    const source = readFileSync(
      new URL("../../../web/scripts/ContextMenuTest.as", import.meta.url),
      "utf8",
    );
    const abc = compileScripts([{ name: "ContextMenuTest", source }], out).get(
      "ContextMenuTest",
    ) as Uint8Array;
    const lines: string[] = [];
    const errors: unknown[] = [];
    const s = new Scripting(await createCodegen(wasm), {
      lazyCompilation,
      print: (line) => lines.push(line),
      onUncaught: (error) => errors.push(error),
      externalInterface: { callOut: () => "<null/>", addCallback: () => {} },
    });
    await s.loadLibraries(libraryAbcs(`${out}libraries/`));
    const player = new Player(bare(abc, 1, "ContextMenuTest", 200, 120), s);
    await player.start();
    const mode = (value: string) =>
      s.rt.callProperty(player.root.object, s.rt.publicName("menuMode"), value);
    try {
      const first = player.contextMenu({ x: 45, y: 45 });
      assert.deepEqual(
        first.map((item) => [item.caption, item.enabled]),
        [
          ["Action 1", true],
          ["Disabled", false],
          ["<b>Literal</b>", true],
        ],
      );
      assert.deepEqual(lines.splice(0), ["menuSelect child owner false false 2"]);
      first[1].select();
      assert.deepEqual(lines, []);
      mode("hidden");
      const second = player.contextMenu({ x: 45, y: 45 });
      assert.deepEqual(
        second.map((item) => item.caption),
        ["Disabled", "<b>Literal</b>"],
      );
      lines.length = 0;
      // A later menu or a mutation of the item does not rewrite an already-open snapshot.
      assert.equal(first[0].caption, "Action 1");
      first[0].select();
      first[0].select();
      assert.deepEqual(lines.splice(0), ["menuItemSelect child owner false false 2"]);
      const root = player.contextMenu({ x: 160, y: 90 });
      assert.equal(root[0].caption, "Root action");
      assert.deepEqual(lines.splice(0), ["menuSelect root1 root1 false false 2"]);
      mode("visible");
      mode("throw");
      const throwing = player.contextMenu({ x: 45, y: 45 });
      assert.equal(throwing[0].caption, "Action 4");
      assert.equal(errors.length, 1);
      lines.length = 0;
      player.destroy();
      throwing[0].select();
      assert.deepEqual(lines, []);
      assert.deepEqual(player.contextMenu({ x: 45, y: 45 }), []);
    } finally {
      player.destroy();
    }
  });
}
