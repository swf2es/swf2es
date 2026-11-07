// AIR_DEFINITIONS, the definitions only AIR has, as the runtime has them:
// each found by name with Scripting's `air` on and its library loaded,
// and not without. UPDATE_AIR_DEFINITIONS=1 writes air-definitions.ts anew.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../oracle/oracle.ts";
import { AIR_DEFINITIONS } from "../../../packages/player/dist/air-definitions.js";
import {
  airLibrary,
  playerglobalLibrary,
} from "../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../player/libraries.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../out/player-air-definitions/", import.meta.url));
const source = fileURLToPath(
  new URL("../../../packages/player/src/air-definitions.ts", import.meta.url),
);

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

test("AIR_DEFINITIONS is what AIR's libraries define and the web's do not", { skip }, async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const builtin = libraryAbcs(`${out}libraries/`)[0];
  const scripting = async (air: boolean) => {
    const s = new Scripting(await createCodegen(wasm), { realTime: null, air });
    await s.loadLibraries(
      air ? [builtin, playerglobalLibrary, airLibrary] : [builtin, playerglobalLibrary],
    );
    return s;
  };
  const found = (s: Scripting, name: string) => {
    try {
      return s.rt.definitionNamed(name, s.rt.root) !== undefined;
    } catch {
      return false;
    }
  };
  const air = await scripting(true);
  const web = await scripting(false);
  const only = air.rt
    .definitionNames(air.rt.root)
    .filter((name) => found(air, name) && !found(web, name))
    .sort();
  if (process.env.UPDATE_AIR_DEFINITIONS) {
    const text = readFileSync(source, "utf8");
    const list = only.map((name) => `  "${name}",`).join("\n");
    writeFileSync(source, text.replace(/new Set\(\[\n[\s\S]*?\n\]\)/, `new Set([\n${list}\n])`));
  }

  assert.deepEqual([...AIR_DEFINITIONS].sort(), only);
});
