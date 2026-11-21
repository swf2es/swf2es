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

test(`context menus snapshot after opening, dispatch once and expire on destroy`, {
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

function menuMovie(extra = ""): Uint8Array {
  const source = MENU_MOVIE + extra;
  return w.swf({
    version: 8,
    width: 300,
    height: 200,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
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
      // A LocalConnection of its own keeps the movie's VM past an unload, as in Flash.
      bytes: menuMovie('var lc = new LocalConnection(); lc.connect("_menuTest");'),
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
    // A menu open as its movie is unloaded calls nothing.
    const unloaded = player.contextMenu({ x: 50, y: 50 });
    lines.length = 0;
    s.rt.callProperty(player.root.object, s.rt.publicName("unload"));
    unloaded[0].select();
    assert.deepEqual(lines, []);
    // Nor one open as the player goes.
    const late = player.contextMenu({ x: 250, y: 150 });
    lines.length = 0;
    player.destroy();
    late[0].select();
    assert.deepEqual(lines, []);
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

/** An AVM1 SWF of 400 by 700 pixels whose one frame runs `source`. */
function avm1Swf(source: string): Uint8Array {
  return w.swf({
    version: 8,
    width: 400,
    height: 700,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A clip of 100 by 100 pixels at the origin, and `_root.menu` as `menu` makes it. */
const ART = `
function f() { trace("f"); }
var art = createEmptyMovieClip("art", 1);
art.beginFill(0x2266cc); art.moveTo(0, 0); art.lineTo(100, 0); art.lineTo(100, 100); art.lineTo(0, 100); art.endFill();
var cm = new ContextMenu(function(o, m) { trace("onSelect " + o); });
cm.hideBuiltInItems();`;

/** `source` played alone, its loads answered from `files`, as `play` gives it. */
async function alone(source: string, files: Record<string, Uint8Array> = {}) {
  const wasm = await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const lines: string[] = [];
  const errors: unknown[] = [];
  const avm1 = new Avm1(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
    realTime: null,
    audio: null,
    url: "http://example.test/main.swf",
    fetch: async (request) => {
      const bytes = files[request.url.slice(request.url.lastIndexOf("/") + 1)] ?? null;
      return { bytes, status: bytes ? 200 : 404, headers: [] };
    },
  });
  const player = new Player(avm1Swf(source), null, avm1);
  await player.start();
  for (let i = 0; i < 3; i++) {
    await avm1.settled();
    player.tick();
  }

  return { player, lines, errors };
}

// What the projector's menus showed over each probe's drawing, alone (screenshots): an item
// needs a function for its onSelect, a ContextMenuItem or not, and a caption that begins none of
// Flash's own entries and is no earlier one's; the first 15 such count, the hidden among them.
const MENUS: [string, string, string[]][] = [
  [
    "duplicates count once",
    `var c = ["Kx", "Kx", "Kx", "Kx", "Kx"]; for (var i = 1; i <= 14; i++) { c.push("K" + i); }
for (var i = 0; i < c.length; i++) { cm.customItems.push(new ContextMenuItem(c[i], f)); }`,
    ["Kx", ...Array.from({ length: 14 }, (_, i) => `K${i + 1}`)],
  ],
  [
    "hidden items count toward 15",
    `for (var i = 0; i < 5; i++) { var h = new ContextMenuItem("Hid" + i, f); h.visible = false; cm.customItems.push(h); }
for (var i = 1; i <= 16; i++) { cm.customItems.push(new ContextMenuItem("K" + i, f)); }`,
    Array.from({ length: 10 }, (_, i) => `K${i + 1}`),
  ],
  [
    "an item needs a function, not a class",
    `cm.customItems.push(new ContextMenuItem("Nnull", null));
cm.customItems.push(new ContextMenuItem("Nstr", "x"));
cm.customItems.push(new ContextMenuItem("Nfn", f));
cm.customItems.push({ caption: "Plain", onSelect: f, enabled: true, visible: true, separatorBefore: false });
var d = new ContextMenuItem("Dis", f); d.enabled = false; cm.customItems.push(d);
cm.customItems.push(new ContextMenuItem("Sep", f, true));`,
    ["Nfn", "Plain", "Dis", "Sep"],
  ],
  [
    "a caption may not begin Flash's own entries",
    `var c = ["Zoom", "Zoom In", "Print", "Prin", "Sett", "Settings", "About", "Abo", "Qual", "Quality", "Show", "Loop", "Rew", "Play", "Debug", "Global", "", "1", "10"];
for (var i = 0; i < c.length; i++) { cm.customItems.push(new ContextMenuItem(c[i], f)); }`,
    ["Global"],
  ],
  [
    "Flash keeps its own entries",
    `var c = ["High", "Medium", "Low", "Forward", "Back", "Show Redraw Regions", "Debugger", "Save", "Undo", "Cut", "Copy", "Paste", "Delete", "Z1"];
for (var i = 0; i < c.length; i++) { cm.customItems.push(new ContextMenuItem(c[i], f)); }`,
    ["High", "Medium", "Low", "Z1"],
  ],
  [
    "and names",
    `var c = ["Select All", "Open", "Copy link", "Movie not loaded", "My Adobe", "Macromedia x", "Flash Player x", "x Settings", "Settings", "Zoom Out", "Show All", "Print", "Loop", "Z2"];
for (var i = 0; i < c.length; i++) { cm.customItems.push(new ContextMenuItem(c[i], f)); }`,
    ["Z2"],
  ],
  [
    "case aside",
    `var c = ["Rewind", "Play", "Quality", "100%", "Adobe", "adobe", "high", "zoom", "Print...", "Settings...", "About", "Hi", "x Adobe x", "Z3"];
for (var i = 0; i < c.length; i++) { cm.customItems.push(new ContextMenuItem(c[i], f)); }`,
    ["high", "Hi", "Z3"],
  ],
];

for (const [name, items, captions] of MENUS) {
  test(`an AVM1 menu's items as Flash shows them: ${name}`, async () => {
    const { player, lines } = await alone(`${ART}\n${items}\n_root.menu = cm;`);
    try {
      const menu = player.contextMenu({ x: 20, y: 10 });
      assert.deepEqual(
        menu.map((item) => item.caption),
        captions,
      );
      assert.deepEqual(lines, ["onSelect _level0"]);
      if (name.startsWith("an item needs")) {
        assert.deepEqual(
          menu.map((item) => [item.enabled, item.separatorBefore]),
          [
            [true, false],
            [true, false],
            [false, false],
            [true, true],
          ],
        );
      }
    } finally {
      player.destroy();
    }
  });
}

// A movie of two levels, as the projector showed it: _level1's drawing, with no menu of its own,
// has _level0's. A choice shows at once (Player.changes), and none is made once the player is gone.
test("an AVM1 level with no menu has level 0's, and a choice shows at once", async () => {
  const { player, lines, errors } = await alone(
    `${ART}
cm.customItems.push(new ContextMenuItem("One", f));
_root.menu = cm;
loadMovieNum("level.swf", 1);`,
    {
      "level.swf": avm1Swf(`var box = createEmptyMovieClip("box", 1);
box.beginFill(0x22aa77); box.moveTo(150, 0); box.lineTo(250, 0); box.lineTo(250, 100); box.lineTo(150, 100); box.endFill();
trace("level " + this);`),
    },
  );
  try {
    assert.deepEqual(lines.splice(0), ["level _level1"]);
    assert.deepEqual(errors, []);
    const menu = player.contextMenu({ x: 200, y: 50 });
    assert.deepEqual(
      menu.map((item) => item.caption),
      ["One"],
    );
    assert.deepEqual(lines.splice(0), ["onSelect _level0"]);
    const changes = player.changes;
    menu[0].select();
    assert.deepEqual(lines.splice(0), ["f"]);
    assert.ok(player.changes > changes);
    const late = player.contextMenu({ x: 20, y: 10 });
    lines.length = 0;
    player.destroy();
    late[0].select();
    assert.deepEqual(lines, []);
  } finally {
    player.destroy();
  }
});

// A clip of a clip's named menu is its menu, as the projector showed it: its parent's clip
// named "menu" stops the walk, a menu of no onSelect and no items of its own, Flash's entries
// kept, not the root's ContextMenu.
test("a child clip named menu is its parent's menu, as in Flash", async () => {
  const { player, lines } = await alone(`${ART}
cm.customItems.push(new ContextMenuItem("Root item", f));
_root.menu = cm;
var child = art.createEmptyMovieClip("menu", 1);
child.beginFill(0x22aa77); child.moveTo(0, 0); child.lineTo(50, 0); child.lineTo(50, 50); child.lineTo(0, 50); child.endFill();`);
  try {
    const menu = player.contextMenu({ x: 20, y: 10 });
    assert.ok(menu.length > 0);
    assert.ok(menu.every((item) => item.caption.startsWith("Quality")));
    assert.deepEqual(lines, []);
  } finally {
    player.destroy();
  }
});
