// AMF0 in the player, past what the amf0 player case holds to Flash: a
// property a typed object read cannot set, which Flash says on the console
// and goes on from. The case leaves it out for the class's name in the
// message, which Flash writes flash.geom.Point (AvmCore::toErrorString).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compileScripts } from "../../../../../player/scripts.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../../../out/player-amf0/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** The trace of a document class that runs `body`. */
async function run(body: string): Promise<string[]> {
  const abc = compileScripts(
    [
      {
        name: "Amf0Read",
        source: `package {
  import flash.display.Sprite;
  import flash.geom.Point;
  import flash.net.registerClassAlias;
  import flash.utils.ByteArray;
  public class Main extends Sprite {
    public function Main() {
      ${body}
    }
  }
}`,
      },
    ],
    out,
  ).get("Amf0Read") as Uint8Array;
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(bare(abc, 1), scripting).start();
  return lines;
}

test("a typed object's property AMF0 cannot set is said on the console, and the rest are read", {
  skip,
}, async () => {
  // amf0.Point: length, read-only; z, which a Point lacks; then x = 5.
  const bytes = [
    0x10, 0, 10, 0x61, 0x6d, 0x66, 0x30, 0x2e, 0x50, 0x6f, 0x69, 0x6e, 0x74, 0, 6, 0x6c, 0x65, 0x6e,
    0x67, 0x74, 0x68, 0, 0x40, 0x14, 0, 0, 0, 0, 0, 0, 0, 1, 0x7a, 1, 1, 0, 1, 0x78, 0, 0x40, 0x14,
    0, 0, 0, 0, 0, 0, 0, 0, 9,
  ];
  const lines = await run(`registerClassAlias("amf0.Point", Point);
      var b:ByteArray = new ByteArray();
      b.objectEncoding = 0;
      for each (var x:int in [${bytes.join(",")}]) {
        b.writeByte(x);
      }
      b.position = 0;
      var p:Point = b.readObject();
      trace(p.x, b.position == b.length);`);

  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ReferenceError: Error #1074\b/);
  assert.match(lines[1], /^ReferenceError: Error #1056\b/);
  assert.equal(lines[2], "5 true");
});
