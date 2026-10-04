// The names playerglobal's natives and hooks register under, every one: a
// move of natives between the record and the class style must leave the
// set as it was. natives-keys.json was recorded from the natives as records;
// a new native adds its key there, by hand or with UPDATE_PLAYER_KEYS=1.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { playerHooks, playerNatives } from "../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";

const file = fileURLToPath(new URL("natives-keys.json", import.meta.url));

test("playerglobal's natives and hooks register under the recorded names, no more and no fewer", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const s = new Scripting(await createCodegen(wasm));
  const keys = {
    natives: Object.keys(playerNatives(s)).sort(),
    hooks: Object.keys(playerHooks(s)).sort(),
  };
  if (process.env.UPDATE_PLAYER_KEYS) {
    writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`);
  }

  const recorded: typeof keys = JSON.parse(readFileSync(file, "utf8"));
  for (const kind of ["natives", "hooks"] as const) {
    const missing = recorded[kind].filter((k) => !keys[kind].includes(k));
    const extra = keys[kind].filter((k) => !recorded[kind].includes(k));
    assert.deepEqual({ kind, missing, extra }, { kind, missing: [], extra: [] });
  }
});

test("updateAfterEvent of mouse, key and timer events asks for a redraw, and throws no longer", async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const s = new Scripting(await createCodegen(wasm));
  const natives = playerNatives(s);
  for (const cls of ["MouseEvent", "KeyboardEvent", "TimerEvent"]) {
    const method = natives[`flash.events::${cls}#updateAfterEvent`](s.rt) as (
      this: unknown,
    ) => void;
    method.call({});
  }

  assert.equal(s.updates, 3);
});
