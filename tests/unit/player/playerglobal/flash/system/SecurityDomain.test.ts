// flash.system.SecurityDomain.domainID: the main SWF's URL as SHA-256 in
// upper-case hex, as adl (AIR 51.3) gives it for its application's SWF,
// whose URL is app:/ and its file's name.
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

test("domainID is the main SWF's URL hashed, as adl gave it", async () => {
  const id = async (url: string) => {
    const s = new Scripting(await createCodegen(wasm), { url });
    return playerNatives(s)["flash.system::SecurityDomain#get:domainID"](s.rt).call({});
  };

  assert.equal(
    await id("app:/Harness-8589cead26e5b12d.swf"),
    "942B81CF9ED5044107E4352CF0A7EEB387E0913F16C177E581852BF5266E035F",
  );
  assert.notEqual(await id("https://example.com/a.swf"), await id("https://example.com/b.swf"));
});
