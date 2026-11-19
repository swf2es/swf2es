// Native Flash Player 32's keyboard and focus across an AS3 Loader and the
// AVM1 movie it holds: the traces of LoadedAvm1Keys over keysMovie, typed
// into with real keys in the Windows debug projector.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { keysMovie } from "../../../avm1-input.ts";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/loaded-avm1-keys/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** Flash's key codes and characters of the keys typed. */
const KEYS: Record<string, [number, number]> = {
  Tab: [9, 9],
  Shift: [16, 0],
};

async function play(focused: boolean) {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    url: "http://example.test/main.swf",
    fetch: async () => ({ bytes: keysMovie(focused), status: 200, headers: [] }),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(
    bare(compiler(out)("LoadedAvm1Keys"), 1, "LoadedAvm1Keys", 320, 240),
    scripting,
  );
  await player.start();
  await scripting.settled();
  player.tick();
  assert.deepEqual(lines.splice(0).at(-1), "avm1:ready");
  const click = (x: number, y: number) => {
    player.pointer?.handle("move", { x, y });
    player.pointer?.handle("down", { x, y });
    player.pointer?.handle("up", { x, y });
  };
  /** Keys as typed, a letter or a name; "Shift+Tab" holds Shift down over Tab. */
  const type = (...keys: string[]) => {
    for (const key of keys) {
      const shift = key.startsWith("Shift+");
      const name = shift ? key.slice(6) : key;
      const [keyCode, charCode] = KEYS[name] ?? [
        name.toUpperCase().charCodeAt(0),
        name.charCodeAt(0),
      ];
      if (shift) {
        player.keyboard?.handle("down", { keyCode: 16, charCode: 0, shiftKey: true });
      }

      player.keyboard?.handle("down", { keyCode, charCode, shiftKey: shift });
      player.keyboard?.handle("up", { keyCode, charCode, shiftKey: shift });
      if (shift) {
        player.keyboard?.handle("up", { keyCode: 16, charCode: 0 });
      }
    }
  };
  return { player, lines, click, type };
}

// Where the projector's pointer pressed: AVM1's field f, button b and clip s, the AS3 field, and
// the empty stage.
const F: [number, number] = [60, 23];
const BUTTON: [number, number] = [230, 25];
const CLIP: [number, number] = [230, 75];
const AS3: [number, number] = [60, 123];
const EMPTY: [number, number] = [280, 201];

test("keys type into a loaded AVM1 movie's focused field with no AS3 KeyboardEvent, and Tab moves through both movies' fields", {
  skip,
}, async () => {
  const p = await play(false);
  try {
    p.click(...F);
    p.type("a", "b", "Tab", "c", "Tab", "d");
    p.click(...AS3);
    p.type("e", "Tab", "x");
    p.click(...EMPTY);
    p.type("z");
    assert.deepEqual(p.lines, [
      "avm1:f.onSetFocus null",
      "avm1:keyDown 65",
      "avm1:changed f=a",
      "avm1:keyUp 65",
      "avm1:keyDown 66",
      "avm1:changed f=ab",
      "avm1:keyUp 66",
      "avm1:keyDown 9",
      "avm1:f.onKillFocus g",
      "avm1:g.onSetFocus f",
      "avm1:keyUp 9",
      "avm1:keyDown 67",
      "avm1:changed g=c",
      "avm1:keyUp 67",
      "avm1:keyDown 9",
      "avm1:g.onKillFocus null",
      "as3:focusIn as3field related null focus as3field",
      "as3:keyUp as3field code 9 focus as3field",
      "avm1:keyUp 9",
      "as3:keyDown as3field code 68 focus as3field",
      "avm1:keyDown 68",
      "as3:textInput as3field text d focus as3field",
      "as3:change as3field=d",
      "as3:keyUp as3field code 68 focus as3field",
      "avm1:keyUp 68",
      "as3:keyDown as3field code 69 focus as3field",
      "avm1:keyDown 69",
      "as3:textInput as3field text e focus as3field",
      "as3:change as3field=de",
      "as3:keyUp as3field code 69 focus as3field",
      "avm1:keyUp 69",
      "as3:keyDown as3field code 9 focus as3field",
      "avm1:keyDown 9",
      "as3:keyFocusChange as3field related null focus as3field",
      "avm1:f.onSetFocus null",
      "as3:focusOut as3field related null focus null",
      "avm1:keyUp 9",
      "avm1:keyDown 88",
      "avm1:changed f=x",
      "avm1:keyUp 88",
      "avm1:f.onKillFocus null",
      "as3:keyDown stage code 90 focus null",
      "avm1:keyDown 90",
      "as3:keyUp stage code 90 focus null",
      "avm1:keyUp 90",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("a field a loaded AVM1 movie focuses itself takes keys, and a click elsewhere gives them to AS3", {
  skip,
}, async () => {
  const p = await play(true);
  try {
    p.type("a", "b");
    p.click(...EMPTY);
    p.type("s");
    p.click(...AS3);
    p.type("r");
    p.click(...EMPTY);
    p.type("u");
    assert.deepEqual(p.lines, [
      "avm1:keyDown 65",
      "avm1:changed f=a",
      "avm1:keyUp 65",
      "avm1:keyDown 66",
      "avm1:changed f=ab",
      "avm1:keyUp 66",
      "avm1:f.onKillFocus null",
      "as3:keyDown stage code 83 focus null",
      "avm1:keyDown 83",
      "as3:keyUp stage code 83 focus null",
      "avm1:keyUp 83",
      "as3:mouseFocusChange stage related as3field focus null",
      "as3:focusIn as3field related null focus as3field",
      "as3:keyDown as3field code 82 focus as3field",
      "avm1:keyDown 82",
      "as3:textInput as3field text r focus as3field",
      "as3:change as3field=r",
      "as3:keyUp as3field code 82 focus as3field",
      "avm1:keyUp 82",
      "as3:mouseFocusChange as3field related null focus as3field",
      "as3:focusOut as3field related null focus null",
      "as3:keyDown stage code 85 focus null",
      "avm1:keyDown 85",
      "as3:keyUp stage code 85 focus null",
      "avm1:keyUp 85",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("with nothing focused keys go to the stage and Key's listeners, and Shift+Tab goes back from AVM1 to AS3", {
  skip,
}, async () => {
  const p = await play(false);
  try {
    p.type("q");
    p.click(...EMPTY);
    p.type("w");
    p.click(...AS3);
    p.type("r", "Tab", "t", "Shift+Tab", "y");
    assert.deepEqual(p.lines, [
      "as3:keyDown stage code 81 focus null",
      "avm1:keyDown 81",
      "as3:keyUp stage code 81 focus null",
      "avm1:keyUp 81",
      "as3:keyDown stage code 87 focus null",
      "avm1:keyDown 87",
      "as3:keyUp stage code 87 focus null",
      "avm1:keyUp 87",
      "as3:mouseFocusChange stage related as3field focus null",
      "as3:focusIn as3field related null focus as3field",
      "as3:keyDown as3field code 82 focus as3field",
      "avm1:keyDown 82",
      "as3:textInput as3field text r focus as3field",
      "as3:change as3field=r",
      "as3:keyUp as3field code 82 focus as3field",
      "avm1:keyUp 82",
      "as3:keyDown as3field code 9 focus as3field",
      "avm1:keyDown 9",
      "as3:keyFocusChange as3field related null focus as3field",
      "avm1:f.onSetFocus null",
      "as3:focusOut as3field related null focus null",
      "avm1:keyUp 9",
      "avm1:keyDown 84",
      "avm1:changed f=t",
      "avm1:keyUp 84",
      "avm1:keyDown 16",
      "avm1:keyDown 9",
      "avm1:f.onKillFocus null",
      "as3:focusIn as3field related null focus as3field",
      "as3:keyUp as3field code 9 focus as3field",
      "avm1:keyUp 9",
      "as3:keyUp as3field code 16 focus as3field",
      "avm1:keyUp 16",
      "as3:keyDown as3field code 89 focus as3field",
      "avm1:keyDown 89",
      "as3:textInput as3field text y focus as3field",
      "as3:change as3field=y",
      "as3:keyUp as3field code 89 focus as3field",
      "avm1:keyUp 89",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("a press on a loaded AVM1 movie's button moves no focus; one on its drawn clip is one on its Loader", {
  skip,
}, async () => {
  const p = await play(false);
  try {
    p.click(...BUTTON);
    p.type("a");
    p.click(...AS3);
    p.type("b");
    p.click(...BUTTON);
    p.type("c");
    p.click(...CLIP);
    p.type("d");
    p.click(...AS3);
    p.click(...CLIP);
    p.type("e");
    p.click(...F);
    p.click(...BUTTON);
    p.type("h");
    assert.deepEqual(p.lines, [
      "avm1:b.onPress",
      "as3:keyDown stage code 65 focus null",
      "avm1:keyDown 65",
      "as3:keyUp stage code 65 focus null",
      "avm1:keyUp 65",
      "as3:mouseFocusChange stage related as3field focus null",
      "as3:focusIn as3field related null focus as3field",
      "as3:keyDown as3field code 66 focus as3field",
      "avm1:keyDown 66",
      "as3:textInput as3field text b focus as3field",
      "as3:change as3field=b",
      "as3:keyUp as3field code 66 focus as3field",
      "avm1:keyUp 66",
      "as3:mouseFocusChange as3field related null focus as3field",
      "avm1:b.onPress",
      "as3:keyDown as3field code 67 focus as3field",
      "avm1:keyDown 67",
      "as3:textInput as3field text c focus as3field",
      "as3:change as3field=bc",
      "as3:keyUp as3field code 67 focus as3field",
      "avm1:keyUp 67",
      "as3:mouseFocusChange as3field related instance1 focus as3field",
      "as3:focusOut as3field related null focus null",
      "as3:keyDown stage code 68 focus null",
      "avm1:keyDown 68",
      "as3:keyUp stage code 68 focus null",
      "avm1:keyUp 68",
      "as3:mouseFocusChange stage related as3field focus null",
      "as3:focusIn as3field related null focus as3field",
      "as3:mouseFocusChange as3field related instance1 focus as3field",
      "as3:focusOut as3field related null focus null",
      "as3:keyDown stage code 69 focus null",
      "avm1:keyDown 69",
      "as3:keyUp stage code 69 focus null",
      "avm1:keyUp 69",
      "avm1:f.onSetFocus null",
      "avm1:b.onPress",
      "avm1:keyDown 72",
      "avm1:changed f=h",
      "avm1:keyUp 72",
    ]);
  } finally {
    p.player.destroy();
  }
});
