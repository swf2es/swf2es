// Native Flash Player 32's one focus across an AS3 host and the two AVM1
// movies its Loaders hold: the traces of LoadedAvm1Focus over focusMovie,
// clicked and typed into with real input in the Windows debug projector.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { focusMovie } from "../../../avm1-input.ts";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/loaded-avm1-focus/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const template = await readFile(
  new URL("../../../player/scripts/LoadedAvm1Focus.as.template", import.meta.url),
  "utf8",
);

type Movie = Parameters<typeof focusMovie>[0];

/** Flash's key codes of the keys pressed: F2 to F7 run the movies' commands. */
const KEYS: Record<string, [number, number]> = {
  Tab: [9, 9],
  Shift: [16, 0],
  F2: [113, 0],
  F3: [114, 0],
  F4: [115, 0],
  F5: [116, 0],
  F6: [117, 0],
  F7: [118, 0],
};

async function play(m1: Movie = {}, m2: Movie = {}, movies = 2) {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    url: "http://example.test/main.swf",
    fetch: async ({ url }) => ({
      bytes: url.endsWith("m2.swf")
        ? focusMovie({ id: "m2", ...m2 })
        : focusMovie({ id: "m1", ...m1 }),
      status: 200,
      headers: [],
    }),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const source = template.replaceAll("@@MOVIES@@", String(movies)).replace("@@SCHEDULE@@", "");
  const player = new Player(
    bare(
      compiler(out)(
        `LoadedAvm1Focus${movies}`,
        source.replaceAll("LoadedAvm1Focus", `LoadedAvm1Focus${movies}`),
      ),
      1,
      `LoadedAvm1Focus${movies}`,
      400,
      200,
    ),
    scripting,
  );
  await player.start();
  // The movies load one after the other.
  for (let i = 0; i < 5 && lines.filter((line) => line.endsWith(":ready")).length < movies; i++) {
    await scripting.settled();
    player.tick();
  }

  assert.deepEqual(lines.splice(0), ["m1:ready", "m2:ready"].slice(0, movies));
  const click = (x: number, y: number) => {
    player.pointer?.handle("move", { x, y });
    player.pointer?.handle("down", { x, y });
    player.pointer?.handle("up", { x, y });
  };
  /** A press and a release with no move to them first, as Ruffle's recorded input has them. */
  const press = (x: number, y: number) => {
    player.pointer?.handle("down", { x, y });
    player.pointer?.handle("up", { x, y });
  };
  /** Keys pressed, by name; "Shift+Tab" holds Shift down over Tab. */
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
  /** LoadedAvm1Focus.control, as the Flash probe's timers called it between keys. */
  const control = async (command: string) => {
    scripting.rt.callProperty(player.root.object, scripting.rt.publicName("control"), command);
    await scripting.settled();
    player.tick();
  };
  return { player, scripting, lines, click, press, type, control };
}

// Where the projector's pointer pressed: the movies' fields, the AS3 field and sprite, nothing.
const M1F: [number, number] = [60, 22];
const M1G: [number, number] = [60, 62];
const M2F: [number, number] = [260, 22];
const AS3FIELD: [number, number] = [60, 122];
const AS3BTN: [number, number] = [250, 125];
const EMPTY: [number, number] = [380, 190];

type Step = [string, ...(string | number)[]];

/** The Flash probe's steps, played: its timers' commands are control's. */
async function run(p: Awaited<ReturnType<typeof play>>, steps: Step[]): Promise<string[]> {
  for (const [op, a, b] of steps) {
    switch (op) {
      case "click":
        p.click(a as number, b as number);
        break;
      case "press":
        p.press(a as number, b as number);
        break;
      case "key":
        p.type(a as string);
        break;
      case "type":
        p.type(...(a as string));
        break;
      case "control":
        await p.control(a as string);
        break;
    }
  }

  return p.lines;
}

const tab = (n: number): Step[] => Array.from({ length: n }, (): Step => ["key", "Tab"]);
const controls = (...commands: string[]): Step[] => commands.map((c): Step => ["control", c]);

// The keys the movies' Key listeners run commands by (focusMovie's keys).
const M1_KEYS = {
  113: 'log("F2"); Selection.setFocus(f);',
  114: "selection();",
  115: 'log("F4"); Selection.setFocus(null);',
  116: 'log("F5"); Selection.setSelection(1, 3); selection();',
};
const M2_KEYS = { 117: "selection();", 118: 'log("F7"); Selection.setFocus(g);' };

test("every movie's Selection listeners hear each move of the one focus, AS3's as from null to null, and a move between movies names the other movie's field", {
  skip,
}, async () => {
  const p = await play();
  try {
    const lines = await run(p, [
      ["click", ...AS3FIELD],
      ["click", ...AS3BTN],
      ["click", ...EMPTY],
      ["click", ...M1F],
      ["click", ...M2F],
      ["click", ...M1G],
      ...tab(6),
    ]);
    assert.deepEqual(lines, [
      "as3:mouseFocusChange stage related as3field focus null",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:mouseFocusChange as3field related as3btn focus as3field",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3field related as3btn focus as3btn",
      "as3:focusIn as3btn related as3field focus as3btn",
      "as3:mouseFocusChange as3btn related null focus as3btn",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3btn related null focus null",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "m1:f.onKillFocus f",
      "m2:f.onSetFocus f",
      "m1:Selection.onSetFocus f f",
      "m2:Selection.onSetFocus f f",
      "m2:f.onKillFocus g",
      "m1:g.onSetFocus f",
      "m1:Selection.onSetFocus f g",
      "m2:Selection.onSetFocus f g",
      "m1:g.onKillFocus g",
      "m2:g.onSetFocus g",
      "m1:Selection.onSetFocus g g",
      "m2:Selection.onSetFocus g g",
      "m2:g.onKillFocus null",
      "m1:Selection.onSetFocus g null",
      "m2:Selection.onSetFocus g null",
      "as3:focusIn as3field related null focus as3field",
      "as3:keyFocusChange as3field related as3btn focus as3field",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3field related as3btn focus as3btn",
      "as3:focusIn as3btn related as3field focus as3btn",
      "as3:keyFocusChange as3btn related null focus as3btn",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3btn related null focus null",
      "m1:f.onKillFocus f",
      "m2:f.onSetFocus f",
      "m1:Selection.onSetFocus f f",
      "m2:Selection.onSetFocus f f",
      "m2:f.onKillFocus g",
      "m1:g.onSetFocus f",
      "m1:Selection.onSetFocus f g",
      "m2:Selection.onSetFocus f g",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("a press with no move first takes the focus to a movie's field as one after a move does", {
  skip,
}, async () => {
  const p = await play();
  try {
    const lines = await run(p, [
      ["press", ...AS3FIELD],
      ["press", ...M1F],
      ["press", ...M2F],
    ]);
    assert.deepEqual(lines, [
      "as3:mouseFocusChange stage related as3field focus null",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:mouseFocusChange as3field related null focus as3field",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3field related null focus null",
      "m1:f.onKillFocus f",
      "m2:f.onSetFocus f",
      "m1:Selection.onSetFocus f f",
      "m2:Selection.onSetFocus f f",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("a movie's Selection reads the one focus wherever it is, moves it from another movie, and setFocus(null) takes it from any", {
  skip,
}, async () => {
  const p = await play({ keys: M1_KEYS }, { keys: M2_KEYS });
  try {
    const lines = await run(p, [
      ...controls("focus:as3field", "select:1:4", "focus:as3btn", "focus:null", "focus:as3field"),
      ["key", "F3"],
      ["key", "F6"],
      ["key", "F2"],
      ["key", "F3"],
      ["key", "F6"],
      ["key", "F5"],
      ["key", "F7"],
      ["key", "F3"],
      ["key", "F6"],
      ["key", "F4"],
      ["key", "F6"],
      ...controls("focus:null", "focus:as3field"),
      ["key", "F3"],
      ["key", "F6"],
    ]);
    assert.deepEqual(lines, [
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:focus:as3field focus as3field selection 0,0",
      "as3:select:1:4 focus as3field selection 1,4",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3field related as3btn focus as3btn",
      "as3:focusIn as3btn related as3field focus as3btn",
      "as3:focus:as3btn focus as3btn selection 1,4",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3btn related null focus null",
      "as3:focus:null focus null selection 1,4",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:focus:as3field focus as3field selection 1,4",
      "m1:getFocus as3field begin 1 end 4 caret 4",
      "m2:getFocus as3field begin 1 end 4 caret 4",
      "m1:F2",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3field related null focus null",
      "m1:getFocus f begin 0 end 6 caret 6",
      "m2:getFocus f begin 0 end 6 caret 6",
      "m1:F5",
      "m1:getFocus f begin 1 end 3 caret 3",
      "m2:F7",
      "m1:f.onKillFocus g",
      "m2:g.onSetFocus f",
      "m1:Selection.onSetFocus f g",
      "m2:Selection.onSetFocus f g",
      "m1:getFocus g begin 0 end 6 caret 6",
      "m2:getFocus g begin 0 end 6 caret 6",
      "m1:F4",
      "m2:g.onKillFocus null",
      "m1:Selection.onSetFocus g null",
      "m2:Selection.onSetFocus g null",
      "m2:getFocus null begin -1 end -1 caret -1",
      "as3:focus:null focus null selection 1,4",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:focus:as3field focus as3field selection 1,4",
      "m1:getFocus as3field begin 1 end 4 caret 4",
      "m2:getFocus as3field begin 1 end 4 caret 4",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("a movie's Selection selects in AS3's focused field, names AS3's focused sprite, and its setFocus(null) takes AS3's focus", {
  skip,
}, async () => {
  const p = await play({ keys: M1_KEYS }, { keys: M2_KEYS });
  try {
    const lines = await run(p, [
      ...controls("focus:as3field", "select:1:4"),
      ["key", "F3"],
      ["key", "F5"],
      ["key", "F6"],
      ...controls("focus:as3btn"),
      ["key", "F3"],
      ["key", "F6"],
      ...controls("focus:as3field"),
      ["key", "F4"],
      ["key", "F3"],
      ["click", ...M1F],
      ["click", 260, 62],
    ]);
    assert.deepEqual(lines, [
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:focus:as3field focus as3field selection 0,0",
      "as3:select:1:4 focus as3field selection 1,4",
      "m1:getFocus as3field begin 1 end 4 caret 4",
      "m1:F5",
      "m1:getFocus as3field begin 1 end 3 caret 3",
      "m2:getFocus as3field begin 1 end 3 caret 3",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3field related as3btn focus as3btn",
      "as3:focusIn as3btn related as3field focus as3btn",
      "as3:focus:as3btn focus as3btn selection 1,3",
      "m1:getFocus as3btn begin -1 end -1 caret -1",
      "m2:getFocus as3btn begin -1 end -1 caret -1",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3btn related as3field focus as3field",
      "as3:focusIn as3field related as3btn focus as3field",
      "as3:focus:as3field focus as3field selection 1,3",
      "m1:F4",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3field related null focus null",
      "m1:getFocus null begin -1 end -1 caret -1",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "m1:f.onKillFocus g",
      "m2:g.onSetFocus f",
      "m1:Selection.onSetFocus f g",
      "m2:Selection.onSetFocus f g",
    ]);
  } finally {
    p.player.destroy();
  }
});

// Tab from nothing round the order, then presses on m1's f, AS3's field, m2's f and nothing.
const TABS: Step[] = [
  ...tab(7),
  ["click", ...M1F],
  ["click", ...AS3FIELD],
  ["click", ...M2F],
  ["click", ...EMPTY],
];

test("Tab orders AS3's objects and the movies' by tabIndex as numbers together, equal ones as the display list has them", {
  skip,
}, async () => {
  const p = await play({ start: "f.tabIndex = 2; g.tabIndex = 5;" }, { start: "f.tabIndex = 4;" });
  try {
    const lines = await run(p, [...controls("tabIndex:as3field:3", "tabIndex:as3btn:1"), ...TABS]);
    assert.deepEqual(lines, [
      "as3:tabIndex:as3field:3 focus null selection 0,0",
      "as3:tabIndex:as3btn:1 focus null selection 0,0",
      "as3:keyFocusChange stage related as3btn focus null",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3btn related null focus as3btn",
      "as3:keyFocusChange as3btn related null focus as3btn",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3btn related null focus null",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
      "as3:focusIn as3field related null focus as3field",
      "as3:keyFocusChange as3field related null focus as3field",
      "m2:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3field related null focus null",
      "m2:f.onKillFocus g",
      "m1:g.onSetFocus f",
      "m1:Selection.onSetFocus f g",
      "m2:Selection.onSetFocus f g",
      "m1:g.onKillFocus null",
      "m1:Selection.onSetFocus g null",
      "m2:Selection.onSetFocus g null",
      "as3:focusIn as3btn related null focus as3btn",
      "as3:keyFocusChange as3btn related null focus as3btn",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3btn related null focus null",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
      "as3:focusIn as3field related null focus as3field",
      "as3:mouseFocusChange as3field related null focus as3field",
      "m2:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3field related null focus null",
      "m2:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
    ]);
  } finally {
    p.player.destroy();
  }

  const q = await play(
    { start: "f.tabIndex = 2; g.tabIndex = -1;" },
    { start: "f.tabIndex = 0; g.tabIndex = 2;" },
  );
  try {
    const lines = await run(q, [...controls("tabIndex:as3field:2", "tabIndex:as3btn:-1"), ...TABS]);
    assert.deepEqual(lines, [
      "as3:tabIndex:as3field:2 focus null selection 0,0",
      "as3:tabIndex:as3btn:-1 focus null selection 0,0",
      "m2:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "m2:f.onKillFocus f",
      "m1:f.onSetFocus f",
      "m1:Selection.onSetFocus f f",
      "m2:Selection.onSetFocus f f",
      "m1:f.onKillFocus g",
      "m2:g.onSetFocus f",
      "m1:Selection.onSetFocus f g",
      "m2:Selection.onSetFocus f g",
      "m2:g.onKillFocus null",
      "m1:Selection.onSetFocus g null",
      "m2:Selection.onSetFocus g null",
      "as3:focusIn as3field related null focus as3field",
      "as3:keyFocusChange as3field related null focus as3field",
      "m2:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3field related null focus null",
      "m2:f.onKillFocus f",
      "m1:f.onSetFocus f",
      "m1:Selection.onSetFocus f f",
      "m2:Selection.onSetFocus f f",
      "m1:f.onKillFocus g",
      "m2:g.onSetFocus f",
      "m1:Selection.onSetFocus f g",
      "m2:Selection.onSetFocus f g",
      "m2:g.onKillFocus f",
      "m1:f.onSetFocus g",
      "m1:Selection.onSetFocus g f",
      "m2:Selection.onSetFocus g f",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
      "as3:focusIn as3field related null focus as3field",
      "as3:mouseFocusChange as3field related null focus as3field",
      "m2:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3field related null focus null",
      "m2:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
    ]);
  } finally {
    q.player.destroy();
  }
});

test("a tabIndex on AS3's objects alone, or on a movie's alone, leaves the rest out of Tab's order", {
  skip,
}, async () => {
  const p = await play();
  try {
    const lines = await run(p, [...controls("tabIndex:as3btn:1"), ...TABS]);
    assert.deepEqual(lines, [
      "as3:tabIndex:as3btn:1 focus null selection 0,0",
      "as3:keyFocusChange stage related as3btn focus null",
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3btn related null focus as3btn",
      "as3:keyFocusChange as3btn related as3btn focus as3btn",
      "as3:keyFocusChange as3btn related as3btn focus as3btn",
      "as3:keyFocusChange as3btn related as3btn focus as3btn",
      "as3:keyFocusChange as3btn related as3btn focus as3btn",
      "as3:keyFocusChange as3btn related as3btn focus as3btn",
      "as3:keyFocusChange as3btn related as3btn focus as3btn",
      "as3:mouseFocusChange as3btn related null focus as3btn",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3btn related null focus null",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
      "as3:focusIn as3field related null focus as3field",
      "as3:mouseFocusChange as3field related null focus as3field",
      "m2:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3field related null focus null",
      "m2:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
    ]);
  } finally {
    p.player.destroy();
  }

  const q = await play({
    start: "g.tabIndex = 1;",
    keys: {
      9: 'var p = Selection.getFocus(); log("tab " + (p == null ? p : p.substr(p.lastIndexOf(".") + 1)));',
    },
  });
  try {
    const lines = await run(q, [...tab(4), ["click", ...AS3FIELD], ...tab(3)]);
    assert.deepEqual(lines, [
      "m1:tab null",
      "m1:g.onSetFocus null",
      "m1:Selection.onSetFocus null g",
      "m2:Selection.onSetFocus null g",
      "m1:tab g",
      "m1:tab g",
      "m1:tab g",
      "m1:g.onKillFocus null",
      "m1:Selection.onSetFocus g null",
      "m2:Selection.onSetFocus g null",
      "as3:focusIn as3field related null focus as3field",
      "m1:tab as3field",
      "as3:keyFocusChange as3field related null focus as3field",
      "m1:g.onSetFocus null",
      "m1:Selection.onSetFocus null g",
      "m2:Selection.onSetFocus null g",
      "as3:focusOut as3field related null focus null",
      "m1:tab g",
      "m1:tab g",
    ]);
  } finally {
    q.player.destroy();
  }
});

// m1's second Selection listener takes the focus back to f where a move leaves nothing in a movie
// focused, once F2 turns it on.
const KEEP: Movie = {
  start:
    'var keepOn = false; var keep = {}; keep.onSetFocus = function(o, n) { if (keepOn && n == null) { log("keep"); Selection.setFocus(f); } }; Selection.addListener(keep);',
  keys: { 113: 'keepOn = true; log("keepOn");', 114: "selection();" },
};
const M2_SELECTION: Movie = { keys: { 117: "selection();" } };

test("a Selection listener that takes the focus as AS3's field takes it leaves one focus, the movie's field's", {
  skip,
}, async () => {
  // Flash Player 32 tells these, the field hearing a focusOut and no focusIn, the later movies'
  // listeners the move they heard. Then its stage.focus is null and Selection names f, as here,
  // but its keys type into the AS3 field, and Selection's indices are that field's: the player
  // keeps the one focus whole, f's.
  const flash = [
    "m1:keepOn",
    "as3:mouseFocusChange stage related as3field focus null",
    "m1:Selection.onSetFocus null null",
    "m1:keep",
    "m1:f.onSetFocus null",
    "m1:Selection.onSetFocus null f",
    "m2:Selection.onSetFocus null f",
    "as3:focusOut as3field related null focus null",
    "m2:Selection.onSetFocus null null",
  ];
  const p = await play(KEEP, M2_SELECTION);
  try {
    const lines = await run(p, [
      ["key", "F2"],
      ["click", ...AS3FIELD],
      ["key", "F3"],
      ["key", "F6"],
      ["type", "x"],
      ["control", "state"],
    ]);
    assert.deepEqual(lines, [
      ...flash,
      "m1:getFocus f begin 0 end 6 caret 6",
      "m2:getFocus f begin 0 end 6 caret 6",
      "m1:changed f=x",
      "as3:text mnopqr",
      "as3:state focus null selection 6,6",
    ]);
  } finally {
    p.player.destroy();
  }

  // stage.focus set by a script: the same, with no mouseFocusChange.
  const q = await play(KEEP, M2_SELECTION);
  try {
    const lines = await run(q, [
      ["key", "F2"],
      ["control", "focus:as3field"],
      ["key", "F3"],
    ]);
    assert.deepEqual(lines, [
      ...[
        "m1:keepOn",
        "m1:Selection.onSetFocus null null",
        "m1:keep",
        "m1:f.onSetFocus null",
        "m1:Selection.onSetFocus null f",
        "m2:Selection.onSetFocus null f",
        "as3:focusOut as3field related null focus null",
        "m2:Selection.onSetFocus null null",
      ],
      "as3:focus:as3field focus null selection 0,0",
      "m1:getFocus f begin 0 end 6 caret 6",
    ]);
  } finally {
    q.player.destroy();
  }
});

test("a field's onKillFocus that focuses it again moves nothing, and the move to another movie's field goes on", {
  skip,
}, async () => {
  const p = await play(
    {
      start:
        'var back = false; f.onKillFocus = function(n) { log("f.onKillFocus " + nameOf(n)); if (back) { back = false; log("back"); Selection.setFocus(f); } };',
      keys: { 113: 'back = true; log("backOn");', 114: "selection();" },
    },
    M2_SELECTION,
  );
  try {
    const lines = await run(p, [
      ["click", ...M1F],
      ["key", "F2"],
      ["click", ...M2F],
      ["key", "F3"],
      ["key", "F6"],
      ["type", "y"],
    ]);
    assert.deepEqual(lines, [
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "m1:backOn",
      "m1:f.onKillFocus f",
      "m1:back",
      "m2:f.onSetFocus f",
      "m1:Selection.onSetFocus f f",
      "m2:Selection.onSetFocus f f",
      "m1:getFocus f begin 6 end 6 caret 6",
      "m2:getFocus f begin 6 end 6 caret 6",
      "m2:changed f=abcdefy",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("a movie unloaded with the focus tells its field and every movie's Selection listeners", {
  skip,
}, async () => {
  const p = await play({}, M2_SELECTION);
  try {
    const lines = await run(p, [
      ["click", ...M1F],
      ["control", "unload:1"],
      ["key", "F6"],
      ["type", "z"],
      ["key", "F6"],
    ]);
    // Flash Player 32 tells them once unload() has returned, after the host's trace of it.
    assert.deepEqual(lines, [
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
      "as3:unload:1 focus null selection 0,0",
      "m2:getFocus null begin -1 end -1 caret -1",
      "m2:getFocus null begin -1 end -1 caret -1",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("a listener that takes the focus as AS3's moves from one object to another leaves the first a focusOut too", {
  skip,
}, async () => {
  const p = await play(KEEP, M2_SELECTION);
  try {
    const lines = await run(p, [
      ["control", "focus:as3field"],
      ["key", "F2"],
      ["control", "focus:as3btn"],
      ["key", "F3"],
      ["key", "F6"],
      ["control", "state"],
      ["type", "x"],
      ["key", "F3"],
    ]);
    assert.deepEqual(lines, [
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:focus:as3field focus as3field selection 0,0",
      "m1:keepOn",
      "m1:Selection.onSetFocus null null",
      "m1:keep",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3btn related null focus null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3field related null focus null",
      "as3:focus:as3btn focus null selection 0,0",
      "m1:getFocus f begin 0 end 6 caret 6",
      "m2:getFocus f begin 0 end 6 caret 6",
      "as3:text mnopqr",
      "as3:state focus null selection 0,0",
      "m1:changed f=x",
      "m1:getFocus f begin 1 end 1 caret 1",
    ]);
    // The field the focus left draws no caret, and keeps no hook to give it up by.
    const field = (p.player.root as unknown as { children: { name: string }[] }).children.find(
      (c) => c.name === "as3field",
    ) as unknown as { focused: boolean; focusDrop: unknown };
    assert.equal(p.scripting.focus, null);
    assert.equal(field.focused, false);
    assert.equal(field.focusDrop, null);
  } finally {
    p.player.destroy();
  }
});

/** m1, whose f's onKillFocus focuses `to`. */
const killTo = (to: string): Movie => ({
  start: `f.onKillFocus = function(n) { log("f.onKillFocus " + nameOf(n)); Selection.setFocus(${to}); };`,
  keys: { 114: "selection();" },
});

test("a field's onKillFocus that moves the focus elsewhere hears it once, and the move under way goes on", {
  skip,
}, async () => {
  // Flash Player 32 kills f again at each move, till its AVM1 stack overflows; then a press on
  // the AS3 field leaves it the focus, as here, and one on g leaves nothing focused.
  const p = await play(killTo("g"), M2_SELECTION);
  try {
    const lines = await run(p, [
      ["click", ...M1F],
      ["click", ...AS3FIELD],
      ["key", "F3"],
      ["type", "x"],
      ["control", "state"],
    ]);
    assert.deepEqual(lines, [
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
      "as3:focusIn as3field related null focus as3field",
      "m1:getFocus as3field begin 6 end 6 caret 6",
      "as3:text mnopqrx",
      "as3:state focus as3field selection 7,7",
    ]);
  } finally {
    p.player.destroy();
  }

  const q = await play(killTo("null"), M2_SELECTION);
  try {
    const lines = await run(q, [
      ["click", ...M1F],
      ["click", ...M1G],
      ["key", "F3"],
    ]);
    assert.deepEqual(lines, [
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "m1:f.onKillFocus g",
      "m1:g.onSetFocus f",
      "m1:Selection.onSetFocus f g",
      "m2:Selection.onSetFocus f g",
      "m1:getFocus g begin 6 end 6 caret 6",
    ]);
  } finally {
    q.player.destroy();
  }
});

test("a movie unloaded with the focus takes none back as its listeners hear it go", {
  skip,
}, async () => {
  const p = await play({ ...KEEP, keys: { 113: 'keepOn = true; log("keepOn");' } }, M2_SELECTION);
  try {
    const lines = await run(p, [
      ["click", ...M1F],
      ["key", "F2"],
      ["control", "unload:1"],
      ["key", "F6"],
      ["control", "state"],
    ]);
    // Flash Player 32 tells them once unload() has returned, and finds no f to focus.
    assert.deepEqual(lines, [
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "m1:keepOn",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m1:keep",
      "m2:Selection.onSetFocus f null",
      "as3:unload:1 focus null selection 0,0",
      "m2:getFocus null begin -1 end -1 caret -1",
      "as3:text mnopqr",
      "as3:state focus null selection 0,0",
    ]);
  } finally {
    p.player.destroy();
  }
});

/** The steps of a move from AS3's field to its sprite whose focusOut focuses `to` once. */
const ON_OUT = (to: string): Step[] => [
  ["control", "focus:as3field"],
  ["control", `onOut:as3btn:${to}`],
  ["key", "F2"],
  ["control", "focus:as3btn"],
  ["control", "state"],
  ["key", "F3"],
  ["type", "x"],
  ["key", "F3"],
];

test("a focus a focusOut listener gives AS3 as a Selection listener took it is taken back the same way", {
  skip,
}, async () => {
  const p = await play(KEEP, M2_SELECTION);
  try {
    const lines = await run(p, ON_OUT("as3field"));
    assert.deepEqual(lines, [
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:focus:as3field focus as3field selection 0,0",
      "as3:onOut:as3btn:as3field focus as3field selection 0,0",
      "m1:keepOn",
      "m1:Selection.onSetFocus null null",
      "m1:keep",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3btn related null focus null",
      "as3:onOut as3btn focuses as3field",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m1:keep",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3field related null focus null",
      "m2:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus null null",
      "as3:focusOut as3field related null focus null",
      "as3:focus:as3btn focus null selection 0,0",
      "as3:text mnopqr",
      "as3:state focus null selection 0,0",
      "m1:getFocus f begin 0 end 6 caret 6",
      "m1:changed f=x",
      "m1:getFocus f begin 1 end 1 caret 1",
    ]);
  } finally {
    p.player.destroy();
  }
});

test("an object a focusOut listener focuses as a Selection listener took the focus keeps it whole", {
  skip,
}, async () => {
  // m1's listener takes the focus once, and the sprite's focusOut gives it to the field.
  const once: Movie = {
    ...KEEP,
    start: (KEEP.start as string).replace("{ log(", "{ keepOn = false; log("),
  };
  const p = await play(once, M2_SELECTION);
  try {
    const lines = await run(p, ON_OUT("as3field"));
    // Flash Player 32 sends the field a second focusIn, and a focusOut and a focusIn naming
    // itself, and types into m1's f while stage.focus and Selection name the field: the player
    // leaves the field the one focus, with no more events.
    assert.deepEqual(lines, [
      "m1:Selection.onSetFocus null null",
      "m2:Selection.onSetFocus null null",
      "as3:focusIn as3field related null focus as3field",
      "as3:focus:as3field focus as3field selection 0,0",
      "as3:onOut:as3btn:as3field focus as3field selection 0,0",
      "m1:keepOn",
      "m1:Selection.onSetFocus null null",
      "m1:keep",
      "m1:f.onSetFocus null",
      "m1:Selection.onSetFocus null f",
      "m2:Selection.onSetFocus null f",
      "as3:focusOut as3btn related null focus null",
      "as3:onOut as3btn focuses as3field",
      "m1:f.onKillFocus null",
      "m1:Selection.onSetFocus f null",
      "m2:Selection.onSetFocus f null",
      "as3:focusIn as3field related null focus as3field",
      "m2:Selection.onSetFocus null null",
      "as3:focus:as3btn focus as3field selection 0,0",
      "as3:text mnopqr",
      "as3:state focus as3field selection 0,0",
      "m1:getFocus as3field begin 0 end 0 caret 0",
      "m1:getFocus as3field begin 1 end 1 caret 1",
    ]);
    const field = (p.player.root as unknown as { children: { name: string }[] }).children.find(
      (c) => c.name === "as3field",
    ) as unknown as { focused: boolean; focusDrop: unknown };
    assert.equal(p.scripting.focus, field);
    assert.equal(field.focused, true);
    assert.notEqual(field.focusDrop, null);
  } finally {
    p.player.destroy();
  }
});
