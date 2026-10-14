import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { playerNatives } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** Each value set, then what reads back: the sequences adl gave. */
async function sets(name: string, values: unknown[]): Promise<unknown[]> {
  const s = new Scripting(await createCodegen(wasm));
  const natives = playerNatives(s);
  const get = natives[`flash.text::TextRenderer.get:${name}`](s.rt);
  const set = natives[`flash.text::TextRenderer.set:${name}`](s.rt);
  return [
    get.call(null),
    ...values.map((v) => {
      try {
        set.call(null, v);
        return get.call(null);
      } catch {
        return "threw";
      }
    }),
  ];
}

test("TextRenderer keeps the settings adl takes, and drops the others", async () => {
  assert.deepEqual(
    await sets("displayMode", ["default", "lcd", "crt", "LCD", "", "lcd", null, undefined, "x"]),
    ["crt", "crt", "lcd", "crt", "crt", "crt", "lcd", "lcd", "lcd", "crt"],
  );
  assert.deepEqual(
    await sets("maxLevel", [0, 1, 2, 3, 5, 6, 7, 8, 100, 3, -1, 4.7]),
    [4, 4, 4, 4, 3, 3, 3, 7, 7, 7, 3, 3, 4],
  );
  assert.deepEqual(
    await sets("antiAliasType", [
      "normal",
      "advanced",
      "off",
      "default",
      "on",
      "x",
      "default",
      null,
    ]),
    ["default", "off", "off", "off", "default", "on", "off", "default", "threw"],
  );
});
