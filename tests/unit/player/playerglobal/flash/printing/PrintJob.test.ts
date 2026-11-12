// flash.printing.PrintJob: the player prints nothing, and says so, as Flash
// says where there is no printing.
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

test("PrintJob is not supported", async () => {
  const s = new Scripting(await createCodegen(wasm));
  assert.equal(
    playerNatives(s)["flash.printing::PrintJob.get:isSupported"](s.rt).call(null),
    false,
  );
});
