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
        "as3:overlay:mouseUp",
        "one:outside",
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
