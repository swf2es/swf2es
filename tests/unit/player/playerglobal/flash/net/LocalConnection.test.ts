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

test("LocalConnection and a null XMLSocket host name the SWF's host, localhost for a file", async () => {
  const domains = async (url?: string) => {
    const s = new Scripting(await createCodegen(wasm), url === undefined ? {} : { url });
    const natives = playerNatives(s);
    return [
      natives["flash.net::LocalConnection#get:domain"](s.rt).call({}),
      natives["flash.net::XMLSocket#get:flash.net:XMLSocket::domain"](s.rt).call({}),
    ];
  };

  assert.deepEqual(await domains("https://www.example.com:8443/a/b.swf?x=1"), [
    "www.example.com",
    "www.example.com",
  ]);
  assert.deepEqual(await domains("http://127.0.0.1/x.swf"), ["127.0.0.1", "127.0.0.1"]);
  assert.deepEqual(await domains("file:///home/me/x.swf"), ["localhost", "localhost"]);
  assert.deepEqual(await domains(), ["localhost", "localhost"]);
});
