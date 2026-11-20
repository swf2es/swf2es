// A library's module, and what compiling it fixes in the domain, depend on
// the series of the API version the compiler runs at, not on the version:
// a library's names take their versions from its own marks, moved into the
// series, and only user ABCs' public names take the domain's. moduleKey
// relies on it, keying such a module by its series, so that a site's SWFs
// of several versions share the libraries' modules.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { isAirApiVersion } from "@swf2es/format";
import {
  airLibrary,
  builtinLibrary,
  playerglobalLibrary,
} from "../../../packages/player/dist/playerglobal/libraries.js";

const wasmPath = fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"));
const module = await WebAssembly.compile(await readFile(wasmPath));

/** VM_ALLVERSIONS to AIR_20_0: every version ABCs run at. */
const VERSIONS = Array.from({ length: 52 }, (_, v) => v);

test("the libraries compile alike at every API version of a series", async () => {
  const codegen = await createCodegen(module);
  const libraries = [builtinLibrary, playerglobalLibrary, airLibrary];
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const compiled = (version: number) => {
    codegen.reset(version);
    return libraries.map((abc) => {
      assert.equal(codegen.add(abc, true), 0);
      const { module, log } = codegen.compileModuleLogged();
      return `${digest(module)} ${log === null ? "-" : digest(log)}`;
    });
  };

  const bySeries = new Map<boolean, string[]>();
  for (const version of VERSIONS) {
    const air = isAirApiVersion(version);
    const modules = compiled(version);
    const first = bySeries.get(air);
    if (first === undefined) {
      bySeries.set(air, modules);
    } else {
      assert.equal(
        modules.join(),
        first.join(),
        `API version ${version} against its series' first`,
      );
    }
  }

  // The series differ: AIR's names are VM-internal to Flash Player's.
  assert.notEqual(bySeries.get(true)?.join(), bySeries.get(false)?.join());
});
