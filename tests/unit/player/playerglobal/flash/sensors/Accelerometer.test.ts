// flash.sensors.Accelerometer as Flash Player 32 and adl (AIR 51.3) have
// it on a desktop: unsupported, muted, and an interval refused below zero
// only, NaN taken.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import {
  builtinLibrary,
  playerglobalLibrary,
  playerNatives,
} from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("an Accelerometer is unsupported and muted, and refuses an interval below zero", async () => {
  const s = new Scripting(await createCodegen(wasm));
  await s.loadLibraries([builtinLibrary, playerglobalLibrary]);
  const natives = playerNatives(s);
  const call = (key: string, ...args: unknown[]) =>
    (natives[`flash.sensors::Accelerometer${key}`](s.rt) as (...a: unknown[]) => unknown).call(
      {},
      ...args,
    );
  assert.equal(call(".get:isSupported"), false);
  assert.equal(call("#get:muted"), true);

  const set = (interval: number): string => {
    try {
      call("#setRequestedUpdateInterval", interval);
      return "set";
    } catch (e) {
      return s.rt.toString(e as never);
    }
  };
  // A release player's text: the debugger's adds the message.
  const refused = "ArgumentError: Error #1508";
  assert.deepEqual([100, 0, -1, Number.NaN, Number.NEGATIVE_INFINITY, 0.5].map(set), [
    "set",
    "set",
    refused,
    "set",
    refused,
    "set",
  ]);
});
