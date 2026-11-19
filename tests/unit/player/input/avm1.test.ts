// Native Flash Player 32's mouse delivery across an AS3 Loader and AVM1 content.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { mouseMovie } from "../../../avm1-input.ts";
import { picksMovie } from "../../../avm1-picks.ts";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/loaded-avm1-input/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

async function play(lazyCompilation: boolean, onTrace?: (line: string) => void) {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    lazyCompilation,
    print: (line) => {
      lines.push(line);
      onTrace?.(line);
    },
    realTime: null,
    url: "http://example.test/main.swf",
    fetch: async ({ url }) => ({
      bytes: mouseMovie(url.endsWith("two.swf") ? "two" : "one"),
      status: 200,
      headers: [],
    }),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(
    bare(compiler(out)("LoadedAvm1Input"), 1, "LoadedAvm1Input", 800, 600),
    scripting,
  );
  await player.start();
  const settle = async () => {
    await scripting.settled();
    player.tick();
  };
  await settle();
  assert.deepEqual(lines.splice(0), ["one:ready"]);
  const control = (command: string) =>
    scripting.rt.callProperty(player.root.object, scripting.rt.publicName("control"), command);
  const mouse = (type: "move" | "down" | "up", x = 70, y = 70) =>
    player.pointer?.handle(type, { x, y });
  return { player, scripting, lines, control, mouse, settle };
}

for (const lazy of [false, true]) {
  const mode = lazy ? "lazy" : "eager";
  test(`loaded AVM1 moves coalesce at the host boundary (${mode})`, { skip }, async () => {
    const p = await play(lazy);
    try {
      p.player.pointer?.post({ x: 300, y: 300 });
      p.player.pointer?.post({ x: 70, y: 70 });
      assert.deepEqual(p.lines, []);
      p.player.pointer?.flush();
      assert.deepEqual(p.lines, ["one:move:10,10", "one:over"]);
    } finally {
      p.player.destroy();
    }
  });

  test(`unloading from a loaded AVM1 mouse listener prevents its button press (${mode})`, {
    skip,
  }, async () => {
    let unload = () => {};
    const p = await play(lazy, (line) => {
      if (line === "one:down") {
        unload();
      }
    });
    unload = () => p.control("unload");
    try {
      p.mouse("move");
      p.lines.splice(0);
      p.mouse("down");
      p.mouse("up");
      assert.deepEqual(p.lines, ["one:down"]);
      assert.equal(p.scripting.avm1Input, null);
    } finally {
      p.player.destroy();
    }
  });

  test(`loaded AVM1 buttons take transformed clicks without AS3 Loader events (${mode})`, {
    skip,
  }, async () => {
    const p = await play(lazy);
    try {
      p.mouse("move");
      assert.equal(p.player.pointer?.cursor(), "pointer");
      const changes = p.player.changes;
      p.mouse("down");
      assert.equal(p.player.pointer?.captured, true);
      p.mouse("up");
      assert.equal(p.player.pointer?.captured, false);
      assert.ok(p.player.changes > changes);
      assert.deepEqual(p.lines.splice(0), [
        "one:move:10,10",
        "one:over",
        "one:down",
        "one:press",
        "one:up",
        "one:release",
      ]);
      p.control("transform");
      p.mouse("move", 180, 70);
      p.mouse("down", 180, 70);
      p.mouse("up", 180, 70);
      assert.deepEqual(p.lines, [
        "one:move:10,10",
        "one:down",
        "one:press",
        "one:up",
        "one:release",
      ]);
    } finally {
      p.player.destroy();
    }
  });

  for (const scenario of [
    "overlay",
    "overlayDisabled",
    "loaderDisabled",
    "childrenDisabled",
    "parentDisabled",
    "invisible",
    "remove",
    "second",
  ]) {
    test(`loaded AVM1 mouse routing: ${scenario} (${mode})`, { skip }, async () => {
      const p = await play(lazy);
      try {
        p.mouse("move", 300, 300);
        if (scenario === "overlayDisabled") {
          p.control("overlay");
        }
        p.control(scenario);
        await p.settle();
        p.lines.splice(0);
        p.mouse("move");
        p.mouse("down");
        p.mouse("up");
        let expected: string[];
        switch (scenario) {
          case "overlay":
            expected = [
              "one:move:10,10",
              "one:down",
              "as3:overlay:mouseDown",
              "one:up",
              "as3:overlay:mouseUp",
              "as3:overlay:click",
            ];
            break;
          case "childrenDisabled":
            expected = [
              "one:move:10,10",
              "one:down",
              "as3:loader:mouseDown",
              "one:up",
              "as3:loader:mouseUp",
              "as3:loader:click",
            ];
            break;
          case "parentDisabled":
          case "invisible":
          case "remove":
            expected = ["one:move:10,10", "one:down", "one:up"];
            break;
          case "second":
            expected = [
              "one:move:10,10",
              "two:move:10,10",
              "two:over",
              "one:down",
              "two:down",
              "two:press",
              "one:up",
              "two:up",
              "two:release",
            ];
            break;
          default:
            expected = [
              "one:move:10,10",
              "one:over",
              "one:down",
              "one:press",
              "one:up",
              "one:release",
            ];
        }
        assert.deepEqual(p.lines, expected);
      } finally {
        p.player.destroy();
      }
    });
  }

  test(`loaded AVM1 capture survives an overlay or leaving the movie (${mode})`, {
    skip,
  }, async () => {
    const p = await play(lazy);
    try {
      p.mouse("move");
      p.mouse("down");
      p.control("overlay");
      p.mouse("up");
      assert.deepEqual(p.lines.splice(0), [
        "one:move:10,10",
        "one:over",
        "one:down",
        "one:press",
        "one:up",
        "one:dragOut",
        // The movie's release first, as the projector traced it (LoadedAvm1Picks).
        "one:outside",
        "as3:overlay:mouseUp",
      ]);
      p.control("overlayOff");
      p.mouse("move", 300, 300);
      p.lines.splice(0);
      p.mouse("move");
      p.mouse("down");
      p.mouse("move", 300, 300);
      p.mouse("up", 300, 300);
      assert.deepEqual(p.lines, [
        "one:move:10,10",
        "one:over",
        "one:down",
        "one:press",
        "one:move:125,125",
        "one:dragOut",
        "one:up",
        "one:outside",
      ]);
    } finally {
      p.player.destroy();
    }
  });

  test(`loaded AVM1 idle hover, clipping and unload lifetime (${mode})`, { skip }, async () => {
    const p = await play(lazy);
    try {
      p.mouse("move");
      p.lines.splice(0);
      p.control("remove");
      p.player.tick();
      // Flash drops a detached hover silently; reattachment picks it again.
      assert.deepEqual(p.lines.splice(0), []);
      p.control("readd");
      p.player.tick();
      assert.deepEqual(p.lines.splice(0), ["one:over"]);
      p.control("overlay");
      p.player.tick();
      assert.deepEqual(p.lines.splice(0), ["one:out"]);
      p.control("overlayOff");
      p.player.tick();
      assert.deepEqual(p.lines.splice(0), ["one:over"]);
      p.control("scroll");
      p.player.tick();
      p.player.tick();
      assert.deepEqual(p.lines.splice(0), ["one:out"]);
      p.mouse("down");
      p.mouse("up");
      assert.deepEqual(p.lines.splice(0), ["one:down", "one:up"]);
      p.control("unload");
      assert.equal(p.scripting.avm1Input, null);
      p.mouse("move", 300, 300);
      p.mouse("down");
      p.mouse("up");
      assert.deepEqual(p.lines, []);
    } finally {
      p.player.destroy();
    }
  });

  test(`an AS3 mask clips loaded AVM1 button picks (${mode})`, { skip }, async () => {
    const p = await play(lazy);
    try {
      p.control("mask");
      p.player.tick();
      p.mouse("move");
      p.mouse("down");
      p.mouse("up");
      assert.deepEqual(p.lines, ["one:move:10,10", "one:down", "one:up"]);
    } finally {
      p.player.destroy();
    }
  });
}

// Native Flash Player 32's picks, hover and cursor across an AS3 Loader and
// the AVM1 movie it holds: LoadedAvm1Picks over picksMovie, played in the
// Windows debug projector under real moves, clicks and keys (XTest on Xvfb),
// the cursor read from X (XFixes) at each "cursor" step, Flash's arrow and
// hand being the player's default and pointer. adl takes no pointer.
/**
 * What the projector was given: the pointer moved, pressed and released at
 * stage points, a wait of so many milliseconds (frames of the host's 24 a
 * second here), a key that shows or hides the host's overlay, and the
 * cursor read.
 */
type Step =
  | ["move" | "down" | "click", number, number]
  | ["up"]
  | ["wait", number]
  | ["key"]
  | ["cursor", string];

const STEPS: Step[] = [
  ["wait", 1500],
  ["move", 300, 220],
  ["wait", 200],
  ["cursor", "empty"],
  ["move", 20, 20],
  ["wait", 200],
  ["cursor", "b"],
  ["move", 110, 20],
  ["wait", 200],
  ["cursor", "c"],
  ["move", 200, 20],
  ["wait", 200],
  ["cursor", "inner"],
  ["move", 150, 85],
  ["wait", 200],
  ["cursor", "p"],
  ["move", 105, 65],
  ["wait", 200],
  ["cursor", "q"],
  ["move", 20, 70],
  ["wait", 200],
  ["cursor", "a"],
  ["move", 200, 70],
  ["wait", 200],
  ["cursor", "box"],
  ["move", 110, 20],
  ["wait", 200],
  ["cursor", "c2"],
  ["move", 300, 220],
  ["wait", 200],
  ["cursor", "empty2"],
  ["move", 300, 220],
  ["wait", 100],
  ["click", 20, 20],
  ["wait", 150],
  ["click", 110, 20],
  ["wait", 150],
  ["click", 200, 20],
  ["wait", 150],
  ["click", 150, 85],
  ["wait", 150],
  ["click", 105, 65],
  ["wait", 150],
  ["click", 20, 70],
  ["wait", 150],
  ["click", 200, 70],
  ["wait", 150],
  ["click", 300, 220],
  ["wait", 150],
  ["down", 110, 20],
  ["move", 115, 25],
  ["move", 300, 220],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 300, 220],
  ["move", 110, 20],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 200, 70],
  ["move", 110, 20],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["down", 110, 20],
  ["move", 200, 70],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["move", 300, 220],
  ["move", 300, 220],
  ["wait", 100],
  ["down", 110, 20],
  ["wait", 100],
  ["key"],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["key"],
  ["wait", 100],
  ["move", 300, 220],
  ["wait", 100],
  ["down", 110, 20],
  ["wait", 100],
  ["key"],
  ["wait", 100],
  ["move", 115, 25],
  ["wait", 100],
  ["up"],
  ["wait", 150],
  ["key"],
  ["wait", 100],
  ["move", 300, 220],
  ["move", 20, 120],
  ["wait", 200],
  ["cursor", "h"],
  ["click", 20, 120],
  ["wait", 150],
  ["move", 110, 120],
  ["wait", 200],
  ["cursor", "e"],
  ["click", 110, 120],
  ["wait", 150],
  ["move", 300, 220],
  ["wait", 200],
  ["cursor", "empty3"],
];

/** What the projector traced. */
const FLASH = [
  "avm1:ready",
  "avm1:b.onRollOver",
  "avm1:b.onRollOut",
  "avm1:c.onRollOver",
  "avm1:c.onRollOut",
  "avm1:n.inner.onRollOver",
  "avm1:n.inner.onRollOut",
  "avm1:p.onRollOver",
  "avm1:p.onRollOut",
  "as3:rollOver ldr@ldr related null",
  "as3:mouseOver ldr@stage related null",
  "as3:mouseOut ldr@stage related box",
  "as3:rollOut ldr@ldr related box",
  "as3:rollOver box@box related ldr",
  "as3:mouseOver box@stage related ldr",
  "avm1:c.onRollOver",
  "as3:mouseOut box@stage related null",
  "as3:rollOut box@box related null",
  "avm1:c.onRollOut",
  "avm1:b.onRollOver",
  "avm1:mouseDown 20,20",
  "avm1:b.onPress",
  "avm1:mouseUp",
  "avm1:b.onRelease",
  "avm1:b.onRollOut",
  "avm1:c.onRollOver",
  "avm1:mouseDown 110,20",
  "avm1:c.onPress",
  "avm1:mouseUp",
  "avm1:c.onRelease",
  "avm1:c.onRollOut",
  "avm1:n.inner.onRollOver",
  "avm1:mouseDown 200,20",
  "avm1:n.inner.onPress",
  "avm1:mouseUp",
  "avm1:n.inner.onRelease",
  "avm1:n.inner.onRollOut",
  "avm1:p.onRollOver",
  "avm1:mouseDown 150,85",
  "avm1:p.onPress",
  "avm1:mouseUp",
  "avm1:p.onRelease",
  "avm1:mouseDown 105,65",
  "avm1:p.onPress",
  "avm1:mouseUp",
  "avm1:p.onRelease",
  "avm1:p.onRollOut",
  "as3:rollOver ldr@ldr related null",
  "as3:mouseOver ldr@stage related null",
  "avm1:mouseDown 20,70",
  "as3:mouseDown ldr@stage related null",
  "avm1:mouseUp",
  "as3:mouseUp ldr@stage related null",
  "as3:click ldr@stage related null",
  "as3:mouseOut ldr@stage related box",
  "as3:rollOut ldr@ldr related box",
  "as3:rollOver box@box related ldr",
  "as3:mouseOver box@stage related ldr",
  "avm1:mouseDown 200,70",
  "as3:mouseDown box@stage related null",
  "avm1:mouseUp",
  "as3:mouseUp box@stage related null",
  "as3:click box@stage related null",
  "as3:mouseOut box@stage related null",
  "as3:rollOut box@box related null",
  "avm1:mouseDown 300,220",
  "as3:mouseDown stage@stage related null",
  "avm1:mouseUp",
  "as3:mouseUp stage@stage related null",
  "as3:click stage@stage related null",
  "avm1:c.onRollOver",
  "avm1:mouseDown 110,20",
  "avm1:c.onPress",
  "avm1:c.onDragOut",
  "avm1:mouseUp",
  "avm1:c.onReleaseOutside",
  "as3:mouseUp stage@stage related null",
  "avm1:mouseDown 300,220",
  "as3:mouseDown stage@stage related null",
  "avm1:mouseUp",
  "avm1:c.onRollOver",
  "avm1:c.onRollOut",
  "as3:rollOver box@box related null",
  "as3:mouseOver box@stage related null",
  "avm1:mouseDown 200,70",
  "as3:mouseDown box@stage related null",
  "as3:mouseOut box@stage related null",
  "as3:rollOut box@box related null",
  "avm1:mouseUp",
  "avm1:c.onRollOver",
  "avm1:mouseDown 110,20",
  "avm1:c.onPress",
  "avm1:c.onDragOut",
  "as3:rollOver box@box related null",
  "as3:mouseOver box@stage related null",
  "avm1:mouseUp",
  "avm1:c.onReleaseOutside",
  "as3:mouseUp box@stage related null",
  "as3:mouseOut box@stage related null",
  "as3:rollOut box@box related null",
  "avm1:c.onRollOver",
  "avm1:mouseDown 110,20",
  "avm1:c.onPress",
  "as3:overlay true",
  "avm1:c.onDragOut",
  "as3:mouseOver overlay@stage related null",
  "avm1:mouseUp",
  "avm1:c.onReleaseOutside",
  "as3:mouseUp overlay@stage related null",
  "as3:overlay false",
  "avm1:c.onRollOver",
  "as3:mouseOut overlay@stage related null",
  "avm1:c.onRollOut",
  "avm1:c.onRollOver",
  "avm1:mouseDown 110,20",
  "avm1:c.onPress",
  "as3:overlay true",
  "avm1:c.onDragOut",
  "as3:mouseOver overlay@stage related null",
  "avm1:mouseUp",
  "avm1:c.onReleaseOutside",
  "as3:mouseUp overlay@stage related null",
  "as3:overlay false",
  "avm1:c.onRollOver",
  "as3:mouseOut overlay@stage related null",
  "avm1:c.onRollOut",
  "avm1:h.onRollOver",
  "avm1:mouseDown 20,120",
  "avm1:h.onPress",
  "avm1:mouseUp",
  "avm1:h.onRelease",
  "avm1:h.onRollOut",
  "avm1:mouseDown 110,120",
  "avm1:mouseUp",
];

/** The cursor at each "cursor" step. */
const CURSORS = [
  "cursor empty default",
  "cursor b pointer",
  "cursor c pointer",
  "cursor inner pointer",
  "cursor p pointer",
  "cursor q pointer",
  "cursor a default",
  "cursor box pointer",
  "cursor c2 pointer",
  "cursor empty2 default",
  "cursor h default",
  "cursor e default",
  "cursor empty3 default",
];

test("picks, hover and the cursor cross between an AS3 host and a loaded AVM1 movie as in Flash", {
  skip,
}, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    url: "http://example.test/main.swf",
    fetch: async () => ({ bytes: picksMovie(), status: 200, headers: [] }),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(
    bare(compiler(out)("LoadedAvm1Picks"), 1, "LoadedAvm1Picks", 320, 240),
    scripting,
  );
  try {
    await player.start();
    await scripting.settled();
    let cursor = "default";
    if (player.pointer) {
      player.pointer.onCursor = (c) => {
        cursor = c;
      };
    }

    let x = 0;
    let y = 0;
    for (const step of STEPS) {
      switch (step[0]) {
        case "move":
        case "down":
        case "click":
          [, x, y] = step;
          player.pointer?.handle("move", { x, y });
          if (step[0] !== "move") {
            player.pointer?.handle("down", { x, y, button: 0 });
          }

          if (step[0] === "click") {
            player.pointer?.handle("up", { x, y, button: 0 });
          }

          break;
        case "up":
          player.pointer?.handle("up", { x, y, button: 0 });
          break;
        case "wait":
          for (let i = Math.max(1, Math.round(step[1] / (1000 / 24))); i > 0; i--) {
            player.tick();
            await scripting.settled();
          }

          break;
        case "key":
          player.keyboard?.handle("down", { keyCode: 79, charCode: 111 });
          player.keyboard?.handle("up", { keyCode: 79, charCode: 111 });
          break;
        case "cursor":
          lines.push(`cursor ${step[1]} ${cursor}`);
          break;
      }
    }

    assert.deepEqual(
      lines.filter((line) => !line.startsWith("cursor ")),
      FLASH,
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith("cursor ")),
      CURSORS,
    );
  } finally {
    player.destroy();
  }
});
