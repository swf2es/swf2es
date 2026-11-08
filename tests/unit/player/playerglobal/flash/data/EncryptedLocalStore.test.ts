// flash.data.EncryptedLocalStore as adl (AIR 51.3) has it: items kept
// whole and given back as copies at position 0, a name of none or of empty
// bytes null, the errors of a null or empty name and of null data; and the
// host's store, which keeps the items from one play to the next. adl traced
// the same checks (~/.cache/swf2es/adl-filewrite's Probe3).
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import { memoryStore } from "../../../../../../packages/player/dist/hosts.js";
import type { EncryptedStoreHost } from "../../../../../../packages/player/dist/index.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { playerglobalLibrary } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../../../out/player-els/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** Play `source` as an AIR application with `store`, its first frame: what it traced. */
async function play(
  name: string,
  source: string,
  store: EncryptedStoreHost | undefined,
): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    air: true,
    encryptedStore: store,
    application: { descriptor: "<application/>", id: "test", arguments: [], currentDirectory: out },
  });
  await scripting.loadLibraries([libraryAbcs(`${out}libraries/`)[0], playerglobalLibrary]);
  const player = new Player(bare(compiler(out)(name, source), 1, name), scripting);
  try {
    await player.start();
  } catch (e) {
    lines.push(`UNCAUGHT ${(e as { stack?: string }).stack ?? e}`);
  } finally {
    player.destroy();
  }

  return lines;
}

const preamble = `package {
  import flash.data.EncryptedLocalStore;
  import flash.display.Sprite;
  import flash.utils.ByteArray;
  import flash.utils.getQualifiedClassName;`;

const helpers = `
    private function t(label:String, f:Function):void {
      try {
        trace(label + ": " + f());
      } catch (e:Error) {
        trace(label + ": THROWS " + getQualifiedClassName(e).replace(/^.*::/, "") + " " + e.errorID);
      }
    }

    private static function bytesOf(a:Array):ByteArray {
      var b:ByteArray = new ByteArray();
      for each (var v:int in a) { b.writeByte(v); }
      return b;
    }`;

test("EncryptedLocalStore keeps items as adl's does", { skip }, async () => {
  rmSync(out, { recursive: true, force: true });
  const lines = await play(
    "Items",
    `${preamble}
  public class Items extends Sprite {${helpers}

    public function Items() {
      t("isSupported", function ():* { return EncryptedLocalStore.isSupported; });
      t("set/get", function ():* { var b:ByteArray = bytesOf([1, 2, 3]); EncryptedLocalStore.setItem("k", b); b[0] = 9; var g:ByteArray = EncryptedLocalStore.getItem("k"); return "pos " + g.position + " len " + g.length + " [0] " + g[0] + " origpos " + b.position; });
      t("get missing", function ():* { return EncryptedLocalStore.getItem("missing"); });
      t("set null", function ():* { EncryptedLocalStore.setItem("n", null); return "set"; });
      t("set empty name", function ():* { EncryptedLocalStore.setItem("", bytesOf([1])); return "set"; });
      t("get empty name", function ():* { return EncryptedLocalStore.getItem(""); });
      t("get null name", function ():* { return EncryptedLocalStore.getItem(null); });
      t("set empty bytes", function ():* { EncryptedLocalStore.setItem("e", new ByteArray()); return EncryptedLocalStore.getItem("e"); });
      t("set from the middle", function ():* { var b:ByteArray = bytesOf([1, 2, 3]); b.position = 2; EncryptedLocalStore.setItem("p", b); return EncryptedLocalStore.getItem("p").length + " origpos " + b.position; });
      t("remove", function ():* { EncryptedLocalStore.removeItem("k"); return EncryptedLocalStore.getItem("k"); });
      t("remove missing", function ():* { EncryptedLocalStore.removeItem("zz"); return "removed"; });
      t("strongly bound", function ():* { EncryptedLocalStore.setItem("s", bytesOf([4]), true); return EncryptedLocalStore.getItem("s").length; });
      t("reset", function ():* { EncryptedLocalStore.reset(); return EncryptedLocalStore.getItem("p"); });
    }
  }
}
`,
    undefined,
  );
  assert.deepEqual(lines, [
    "isSupported: true",
    "set/get: pos 0 len 3 [0] 1 origpos 3",
    "get missing: null",
    "set null: THROWS ArgumentError 2007",
    "set empty name: THROWS ArgumentError 2085",
    "get empty name: THROWS ArgumentError 2085",
    "get null name: THROWS ArgumentError 2007",
    "set empty bytes: null",
    "set from the middle: 3 origpos 2",
    "remove: null",
    "remove missing: removed",
    "strongly bound: 1",
    "reset: null",
  ]);
});

test("the host's store keeps the items from one play to the next", { skip }, async () => {
  const store = memoryStore();
  const run = (name: string) =>
    play(
      name,
      `${preamble}
  public class ${name} extends Sprite {
    public function ${name}() {
      var before:ByteArray = EncryptedLocalStore.getItem("runs");
      var runs:int = before ? before.readInt() : 0;
      var after:ByteArray = new ByteArray();
      after.writeInt(runs + 1);
      EncryptedLocalStore.setItem("runs", after);
      trace("runs " + runs);
    }
  }
}
`,
      store,
    );
  assert.deepEqual(await run("First"), ["runs 0"]);
  assert.deepEqual(await run("Second"), ["runs 1"]);
  assert.deepEqual([...(store.getItem("runs") ?? [])], [0, 0, 0, 2]);
});
