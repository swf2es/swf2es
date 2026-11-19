// An AVM1 movie's own pointer, played alone: presses dragged between
// buttons and clips that do and do not track as a menu's, as Flash Player
// 32's Windows debug projector traced dragsMovie under real presses.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { DRAG_STEPS, DRAGS_ALONE, dragsMovie } from "../../../avm1-picks.ts";

test("a press reaches other buttons only where it and they track as a menu's, as in Flash", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const lines: string[] = [];
  const avm1 = new Avm1(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    audio: null,
  });
  const player = new Player(dragsMovie(), null, avm1);
  try {
    await player.start();
    player.tick();
    let x = 0;
    let y = 0;
    for (const step of DRAG_STEPS) {
      switch (step[0]) {
        case "move":
        case "down":
          [, x, y] = step;
          player.pointer?.handle("move", { x, y });
          if (step[0] === "down") {
            player.pointer?.handle("down", { x, y, button: 0 });
          }

          break;
        case "up":
          player.pointer?.handle("up", { x, y, button: 0 });
          break;
        case "wait":
          for (let i = Math.max(1, Math.round(step[1] / (1000 / 24))); i > 0; i--) {
            player.tick();
          }

          break;
      }
    }

    assert.deepEqual(lines, DRAGS_ALONE);
  } finally {
    player.destroy();
  }
});
