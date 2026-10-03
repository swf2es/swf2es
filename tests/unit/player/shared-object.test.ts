import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../oracle/oracle.ts";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { bare } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compileScripts } from "../../player/scripts.ts";

const out = fileURLToPath(new URL("../out/player/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A document class that runs `body` with `so`, a SharedObject, in scope. */
const script = (name: string, body: string) => ({
  name,
  source: `package {
  import flash.display.Sprite;
  import flash.net.SharedObject;
  public class Main extends Sprite {
    public function Main() {
      ${body}
    }
  }
}`,
});

test("a SharedObject's data is kept in the host's storage, as Flash's AMF3 .sol file, from one run to the next", {
  skip,
}, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedWrite",
        `var so:SharedObject = SharedObject.getLocal("kept");
      so.data.n = 7; so.data.s = "text"; so.data.a = [1, 2]; so.data.o = {x: true};
      trace(so.flush());
      var root:SharedObject = SharedObject.getLocal("rooted", "/");
      root.data.d = 1.5;
      root.flush();`,
      ),
      script(
        "SharedRead",
        `var so:SharedObject = SharedObject.getLocal("kept");
      trace(so.data.n, so.data.s, so.data.a, so.data.o.x, so.size);
      trace(SharedObject.getLocal("rooted", "/").data.d);
      so.clear();
      trace(SharedObject.getLocal("missing").size);`,
      ),
    ],
    out,
  );
  const stored = new Map<string, Uint8Array>();
  const storage = {
    get: (key: string) => stored.get(key) ?? null,
    set: (key: string, bytes: Uint8Array) => stored.set(key, bytes),
    remove: (key: string) => stored.delete(key),
    keys: () => [...stored.keys()],
  };
  const run = async (name: string): Promise<string[]> => {
    const lines: string[] = [];
    const scripting = new Scripting(await createCodegen(wasm), {
      print: (line) => lines.push(line),
      storage,
      url: "http://example.test/games/main.swf",
    });
    await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
    await new Player(bare(abcs.get(name) as Uint8Array, 1), scripting).start();
    return lines;
  };

  assert.deepEqual(await run("SharedWrite"), ["flushed"]);
  // Keyed by host, the SWF's path, and the name; a .sol file, AMF3 by default.
  const kept = stored.get("example.test/games/main.swf/kept") as Uint8Array;
  assert.deepEqual([...kept.subarray(0, 2)], [0x00, 0xbf]);
  assert.equal(new TextDecoder().decode(kept.subarray(6, 10)), "TCSO");
  assert.ok(stored.has("example.test//rooted"));

  // Read back by another player, as a later visit to the page would, its size the
  // file's: a 26-byte header for "kept", then 5, 9, 10 and 10 bytes of entries.
  // Clear takes the file out.
  assert.deepEqual(await run("SharedRead"), ["7 text 1,2 true 60", "1.5", "0"]);
  assert.ok(!stored.has("example.test/games/main.swf/kept"));
});
