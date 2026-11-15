// flash.display.NativeMenu's natives: isSupported, AIR's alone, and display,
// which shows the menu through the host's Scripting.showMenu after the
// events adl dispatched before its menu (preparing, then displaying, to the
// menu and each item it shows); a choice dispatches select from the item up
// through the menus, a ContextMenuItem's menuItemSelect. The rest of the
// menus is AS3, held to adl by the player's native-menu-natives case.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { MenuItem } from "../../../../../../packages/player/dist/input/context-menu.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { playerglobalLibrary } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../../../out/player-native-menu/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const SOURCE = readFileSync(new URL("./MenuDisplay.as", import.meta.url), "utf8");

interface Shown {
  items: MenuItem[];
  x: number;
  y: number;
}

/** MenuDisplay played, in AIR or not, and what it traced and showed; the host takes no menu with `host` false. */
async function play(air: boolean, host = true) {
  const lines: string[] = [];
  const shown: Shown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    air,
  });
  await s.loadLibraries([libraryAbcs(`${out}libraries/`)[0], playerglobalLibrary]);
  if (host) {
    s.showMenu = (items, x, y) => shown.push({ items, x, y });
  }

  const player = new Player(bare(compiler(out)("MenuDisplay", SOURCE), 1, "MenuDisplay"), s);
  await player.start();
  const call = (name: string) => s.rt.callProperty(player.root.object, s.rt.publicName(name));
  return { lines, shown, player, call };
}

const view = (items: MenuItem[]) =>
  items.map((item) => [item.caption, item.enabled, !!item.separatorBefore, !!item.checked]);

test("display shows a menu after preparing and displaying, and a choice selects up the menus", {
  skip,
}, async () => {
  const { lines, shown, player, call } = await play(true);
  try {
    assert.deepEqual(lines.splice(0), ["isSupported true builtIn false"]);
    call("open");
    assert.deepEqual(lines.splice(0), [
      "menu preparing a menu 2 false",
      "a preparing a 2 false",
      "b preparing b 2 false",
      "c preparing c 2 false",
      "S preparing S 2 false",
      "menu displaying a menu 2 false",
      "a displaying a 2 false",
      "b displaying b 2 false",
      "c displaying c 2 false",
      "S displaying S 2 false",
      "returned",
    ]);
    assert.equal(shown.length, 1);
    const [{ items, x, y }] = shown;
    assert.deepEqual([x, y], [12, 34]);
    assert.deepEqual(view(items), [
      ["a", true, false, false],
      ["b", true, true, true],
      ["c", false, false, false],
      ["S ▸", false, false, false],
    ]);

    items[2].select();
    assert.deepEqual(lines, []);
    items[1].select();
    items[0].select();
    assert.deepEqual(lines.splice(0), [
      "b select b 2 true",
      "menu select b 3 true",
      "top select b 3 true",
    ]);

    call("openContext");
    assert.deepEqual(lines.splice(0), [
      "context preparing context 2 false",
      "shown preparing shown 2 false",
      "context displaying context 2 false",
      "shown displaying shown 2 false",
    ]);
    assert.deepEqual(view(shown[1].items), [["shown", true, true, false]]);
    shown[1].items[0].select();
    assert.deepEqual(lines.splice(0), ["shown menuItemSelect shown 2 false"]);

    call("openNull");
    assert.deepEqual(lines.splice(0), [
      "[class TypeError] 2007 Error #2007: Parameter stage must be non-null.",
    ]);
    assert.equal(shown.length, 2);

    call("open");
    const last = shown[2].items;
    player.destroy();
    lines.length = 0;
    last[0].select();
    assert.deepEqual(lines, []);
  } finally {
    player.destroy();
  }
});

test("outside AIR NativeMenu is not supported and a ContextMenu has Flash Player's items", {
  skip,
}, async () => {
  const { lines, player } = await play(false);
  try {
    assert.deepEqual(lines, ["isSupported false builtIn true"]);
  } finally {
    player.destroy();
  }
});

test("with no host to show it, display dispatches its events and shows nothing", {
  skip,
}, async () => {
  const { lines, shown, player, call } = await play(true, false);
  try {
    lines.length = 0;
    call("open");
    assert.equal(lines.at(-1), "returned");
    assert.equal(lines.length, 11);
    assert.deepEqual(shown, []);
  } finally {
    player.destroy();
  }
});
