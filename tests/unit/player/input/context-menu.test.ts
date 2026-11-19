import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Avm1 } from "../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { flashAssembler, script } from "../../../avm1-script.ts";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compileScripts } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

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

// An AVM1 movie AS3 loaded, whose root and one clip have menus of their
// own, right-clicked in Flash Player 32's projector, the items chosen with
// keys: a click on the movie's drawing shows the menu of the nearest of the
// clip and its parents that has one, its onSelect called first with that
// clip; one on the empty stage shows AS3's root's.
const MENU_MOVIE = `
var art = createEmptyMovieClip("art", 1);
art.beginFill(0x2266cc); art.moveTo(0, 0); art.lineTo(100, 0); art.lineTo(100, 100); art.lineTo(0, 100); art.endFill();
var c = createEmptyMovieClip("c", 2);
c._x = 150;
c.beginFill(0x22aa77); c.moveTo(0, 0); c.lineTo(60, 0); c.lineTo(60, 40); c.lineTo(0, 40); c.endFill();
c.onRelease = function() { trace("avm1:c.onRelease"); };
var cm = new ContextMenu(function(o, m) { trace("avm1:root onSelect " + o); });
cm.hideBuiltInItems();
cm.customItems.push(new ContextMenuItem("Avm1 root item", function(o, it) { trace("avm1:root item " + o); }));
_root.menu = cm;
var cm2 = new ContextMenu(function(o, m) { trace("avm1:c onSelect " + o); });
cm2.customItems.push(new ContextMenuItem("Avm1 c item", function(o, it) { trace("avm1:c item " + o); }));
c.menu = cm2;
trace("avm1:ready " + typeof ContextMenu);
`;

function menuMovie(): Uint8Array {
  return w.swf({
    version: 8,
    width: 300,
    height: 200,
    frameCount: 1,
    tags: [
      w.doAction([...script(MENU_MOVIE, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

test("a loaded AVM1 movie's own menus show over its drawing, AS3's elsewhere", {
  skip,
}, async () => {
  const wasm = await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const abc = compileScripts(["LoadedAvm1Menu"], out).get("LoadedAvm1Menu") as Uint8Array;
  const lines: string[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    url: "http://example.test/main.swf",
    fetch: async () => ({
      bytes: menuMovie(),
      status: 200,
      headers: [],
    }),
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "LoadedAvm1Menu", 300, 200), s);
  try {
    await player.start();
    for (let i = 0; i < 3; i++) {
      await s.settled();
      player.tick();
    }

    assert.deepEqual(lines.splice(0), ["avm1:ready function"]);
    const captions = (items: { caption: string }[]) => items.map((item) => item.caption);
    // The root's, its built-in items hidden.
    const root = player.contextMenu({ x: 50, y: 50 });
    assert.deepEqual(captions(root), ["Avm1 root item"]);
    assert.deepEqual(lines.splice(0), ["avm1:root onSelect _root"]);
    root[0].select();
    assert.deepEqual(lines.splice(0), ["avm1:root item _root"]);
    // The clip's own, its built-in items kept.
    const clip = player.contextMenu({ x: 180, y: 20 });
    assert.equal(clip[0].caption, "Avm1 c item");
    assert.ok(clip.length > 1);
    assert.deepEqual(lines.splice(0), ["avm1:c onSelect _root.c"]);
    clip[0].select();
    assert.deepEqual(lines.splice(0), ["avm1:c item _root.c"]);
    // AS3's, off the movie.
    const stage = player.contextMenu({ x: 250, y: 150 });
    assert.deepEqual(captions(stage), ["As3 item"]);
    stage[0].select();
    assert.deepEqual(lines.splice(0), [
      "as3:menuSelect owner [object LoadedAvm1Menu] target [object LoadedAvm1Menu]",
      "as3:item owner [object LoadedAvm1Menu] target [object LoadedAvm1Menu]",
    ]);
  } finally {
    player.destroy();
  }
});

// The same movie played alone, as the projector showed it: the empty stage
// has the root's menu.
test("an AVM1 movie's menus: the clip's, or the root's, the empty stage's too", async () => {
  const wasm = await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const lines: string[] = [];
  const avm1 = new Avm1(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    audio: null,
  });
  const player = new Player(menuMovie(), null, avm1);
  try {
    await player.start();
    player.tick();
    assert.deepEqual(lines.splice(0), ["avm1:ready function"]);
    assert.equal(player.contextMenu({ x: 180, y: 20 })[0].caption, "Avm1 c item");
    assert.deepEqual(lines.splice(0), ["avm1:c onSelect _level0.c"]);
    const stage = player.contextMenu({ x: 250, y: 150 });
    assert.deepEqual(
      stage.map((item) => item.caption),
      ["Avm1 root item"],
    );
    stage[0].select();
    assert.deepEqual(lines.splice(0), ["avm1:root onSelect _level0", "avm1:root item _level0"]);
  } finally {
    player.destroy();
  }
});
