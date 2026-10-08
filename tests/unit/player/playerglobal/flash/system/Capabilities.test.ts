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

test("Capabilities reads each player's captured screen values", async () => {
  const first = new Scripting(await createCodegen(wasm), {
    screenCapabilities: {
      screenResolutionX: 1536,
      screenResolutionY: 864,
      pixelAspectRatio: 1,
      screenDPI: 72,
    },
  });
  const second = new Scripting(await createCodegen(wasm), {
    screenCapabilities: {
      screenResolutionX: 2560,
      screenResolutionY: 1440,
      pixelAspectRatio: 1.25,
      screenDPI: 96,
    },
  });
  const dpiOnly = new Scripting(await createCodegen(wasm), {
    screenCapabilities: { screenDPI: 96 },
  });
  const values = (s: Scripting) => {
    const natives = playerNatives(s);
    return ["screenResolutionX", "screenResolutionY", "pixelAspectRatio", "screenDPI"].map((name) =>
      natives[`flash.system::Capabilities.get:${name}`](s.rt).call(null),
    );
  };

  assert.deepEqual(values(first), [1536, 864, 1, 72]);
  assert.deepEqual(values(second), [2560, 1440, 1.25, 96]);
  assert.deepEqual(values(dpiOnly), [0, 0, 1, 96]);
  assert.deepEqual(values(first), [1536, 864, 1, 72]);
});
