// Every native the libraries the player loads declare has an implementation,
// but those unimplemented-natives.json lists: a native without one throws
// "not supported yet" when called (Runtime.native), which a declaration
// alone never shows. The natives are read from the modules codegen writes
// for the libraries, `rt.native("name", ...)` for each method flagged
// native in the ABC, so the names are those the runtime looks up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../../oracle/oracle.ts";
import {
  airLibrary,
  playerglobalLibrary,
  playerNatives,
} from "../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../player/libraries.ts";

interface Group {
  why: string;
  natives: string[];
}

const allowlist: Record<string, Group | string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("unimplemented-natives.json", import.meta.url)), "utf8"),
);

// builtin.abc comes out of the oracle's image.
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

/** The natives of each library, as the player loads them: builtin, playerglobal, then AIR's. */
async function declaredNatives(wasm: WebAssembly.Module): Promise<Map<string, string[]>> {
  const codegen = await createCodegen(wasm);
  // Flash Player's playerglobal stands in for ours under SWF2ES_PLAYERGLOBAL=adobe: not here.
  const libraries: [string, Uint8Array][] = [
    ["builtin", libraryAbcs()[0]],
    ["playerglobal", playerglobalLibrary],
    ["air", airLibrary],
  ];
  codegen.reset();
  for (const [name, abc] of libraries) {
    assert.equal(codegen.add(abc, true), 0, `${name} links`);
  }

  const declared = new Map<string, string[]>();
  for (const [i, [name]] of libraries.entries()) {
    const module = codegen.compileModule([], i);
    const names = [...module.matchAll(/rt\.native\(("(?:[^"\\]|\\.)*")/g)].map(
      (m) => JSON.parse(m[1]) as string,
    );
    assert.ok(names.length > 0, `${name} declares natives`);
    declared.set(name, names);
  }

  return declared;
}

test("every native the player's libraries declare is implemented or allowlisted", {
  skip,
}, async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const declared = await declaredNatives(wasm);
  const s = new Scripting(await createCodegen(wasm));
  const implemented = new Set([
    ...Object.keys(avm2.builtinNatives(s.rt)),
    ...Object.keys(playerNatives(s)),
  ]);

  const listed = new Map<string, string>();
  for (const [group, entry] of Object.entries(allowlist)) {
    if (typeof entry === "string") {
      continue;
    }

    for (const name of entry.natives) {
      assert.ok(!listed.has(name), `${name} is listed under ${listed.get(name)} and ${group}`);
      listed.set(name, group);
    }
  }

  const all = new Set([...declared.values()].flat());
  const unimplemented = [...all].filter((n) => !implemented.has(n));
  assert.deepEqual(
    {
      // Implement them, or list them under why they are not.
      unlisted: unimplemented.filter((n) => !listed.has(n)),
      // Take them off the list: it only shrinks.
      implemented: [...listed.keys()].filter((n) => implemented.has(n)),
      undeclared: [...listed.keys()].filter((n) => !all.has(n)),
    },
    { unlisted: [], implemented: [], undeclared: [] },
  );
});
