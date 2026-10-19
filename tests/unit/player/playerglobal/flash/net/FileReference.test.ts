import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../../../out/file-reference/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("AS3 selected files load into ByteArray and lists construct FileReference instances", async () => {
  const source = compiler(out)(
    "FilesRoot",
    "package { import flash.display.Sprite; public class FilesRoot extends Sprite {} }",
  );
  const scripting = new Scripting(await createCodegen(wasm), {
    audio: null,
    fileHost: {
      browse: async () => [
        {
          name: "a.txt",
          size: 3,
          modificationDate: 123,
          read: async () => Uint8Array.of(65, 0, 255),
        },
      ],
      save: async () => null,
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(source, 1, "FilesRoot"), scripting);
  await player.start();
  const rt = scripting.rt;
  const file = rt.construct(rt.classNamed("flash.net::FileReference"));
  const get = (name: string) => rt.getProperty(file, rt.publicName(name));
  const call = (name: string, ...args: avm2.Value[]) =>
    rt.callProperty(file, rt.publicName(name), ...args);
  const events: string[] = [];
  file.$listeners = new Map(
    ["select", "open", "progress", "complete"].map((type) => [
      type,
      [{ fn: { $f: () => events.push(type) }, capture: false, priority: 0 }],
    ]),
  );
  assert.equal(get("data"), null);
  assert.throws(() => get("name"));
  assert.equal(call("browse"), true);
  await scripting.loads.settled();
  assert.deepEqual(events, []);
  player.tick();
  assert.deepEqual(events, ["select"]);
  assert.equal(get("name"), "a.txt");
  assert.equal(get("size"), 3);
  assert.equal(get("type"), ".txt");
  assert.equal(get("extension"), "txt");
  call("load");
  assert.equal(get("data"), null);
  await scripting.loads.settled();
  player.tick();
  const data = get("data");
  assert.equal(rt.traitsOf(data).name, "flash.utils::ByteArray");
  const bytes = avm2.bytesOf(rt, data);
  assert.equal(bytes.position, 0);
  assert.deepEqual(bytes.buffer.slice(0, bytes.length), Uint8Array.of(65, 0, 255));
  assert.deepEqual(events, ["select", "open", "progress", "complete"]);
  const list = rt.construct(rt.classNamed("flash.net::FileReferenceList"));
  assert.equal(rt.getProperty(list, rt.publicName("fileList")), null);
  rt.callProperty(list, rt.publicName("browse"));
  await scripting.loads.settled();
  player.tick();
  const files = rt.getProperty(list, rt.publicName("fileList")).$a;
  assert.equal(files.length, 1);
  assert.equal(rt.traitsOf(files[0]).name, "flash.net::FileReference");
  assert.equal(rt.getProperty(files[0], rt.publicName("name")), "a.txt");
  player.destroy();
});
