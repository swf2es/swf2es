import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { FetchRequest } from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compileScripts } from "../../../../../player/scripts.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../../../out/player-security/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

const source = `package {
  import flash.display.*;
  import flash.media.Sound;
  import flash.net.*;
  import flash.system.Security;
  public class Main extends Sprite {
    public function Main() {
      trace(Security.sandboxType);
      Security.loadPolicyFile("policies/crossdomain.xml");
      Security.loadPolicyFile("xmlsocket://example.test:5000");
      new URLLoader().load(new URLRequest("data.txt"));
      new Loader().load(new URLRequest("child.swf"));
      new Sound().load(new URLRequest("song.mp3"));
      sendToURL(new URLRequest("ping"));
    }
  }
}`;

test("Security names the host's sandbox, hands it the policy files, and each request says what it is for", {
  skip,
}, async () => {
  const [abc] = compileScripts([{ name: "Main", source }], out).values();
  const lines: string[] = [];
  const policies: string[] = [];
  const sent: FetchRequest[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    url: "http://example.test/games/main.swf",
    sandboxType: "localWithNetwork",
    loadPolicyFile: (url) => policies.push(url),
    fetch: async (request) => {
      sent.push(request);
      return { bytes: null, status: 404, headers: [] };
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(bare(abc, 1), scripting).start();
  await scripting.settled();

  assert.deepEqual(lines, ["localWithNetwork"]);
  assert.deepEqual(policies, [
    "http://example.test/games/policies/crossdomain.xml",
    "xmlsocket://example.test:5000",
  ]);
  assert.deepEqual(sent.map(({ url, purpose }) => [url, purpose]).sort(), [
    ["http://example.test/games/child.swf", "content"],
    ["http://example.test/games/data.txt", "data"],
    ["http://example.test/games/ping", "send"],
    ["http://example.test/games/song.mp3", "content"],
  ]);
});

test("a SWF is remote where the host does not say", async () => {
  const scripting = new Scripting(await createCodegen(wasm));
  assert.equal(scripting.sandboxType, "remote");
  assert.equal(scripting.loadPolicyFile, null);
});
