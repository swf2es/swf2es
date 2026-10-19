import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import type { FetchRequest } from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../../../out/file-reference/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

async function setup(options: ConstructorParameters<typeof Scripting>[1] = {}) {
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
    ...options,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(source, 1, "FilesRoot"), scripting);
  await player.start();
  const rt = scripting.rt;
  const file = rt.construct(rt.classNamed("flash.net::FileReference"));
  const get = (name: string) => rt.getProperty(file, rt.publicName(name));
  const call = (name: string, ...args: avm2.Value[]) =>
    rt.callProperty(file, rt.publicName(name), ...args);
  const frame = async () => {
    await scripting.settled();
    player.tick();
  };

  return { player, scripting, rt, file, get, call, frame };
}

test("AS3 selected files load into ByteArray and lists construct FileReference instances", async () => {
  const { player, scripting, rt, file, get, call } = await setup();
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

test("upload completion preserves loaded ByteArray edits and position", async () => {
  const { player, rt, get, call, frame } = await setup({
    fetch: async () => ({ bytes: new Uint8Array(), status: 200, headers: [] }),
  });
  try {
    call("browse");
    await frame();
    call("load");
    await frame();
    const data = get("data");
    const bytes = avm2.bytesOf(rt, data);
    bytes.position = 0;
    bytes.write(Uint8Array.of(90));
    bytes.position = 2;
    const request = rt.construct(
      rt.classNamed("flash.net::URLRequest"),
      "https://example.test/upload",
    );
    call("upload", request);
    await frame();
    assert.equal(get("data"), data);
    assert.equal(bytes.position, 2);
    assert.deepEqual(bytes.buffer.slice(0, bytes.length), Uint8Array.of(90, 0, 255));
  } finally {
    player.destroy();
  }
});

test("a load completion listener can start a second load into a fresh ByteArray", async () => {
  const { player, rt, file, get, call, frame } = await setup();
  try {
    call("browse");
    await frame();
    const loaded: avm2.Value[] = [];
    file.$listeners = new Map([
      [
        "complete",
        [
          {
            fn: {
              $f: () => {
                loaded.push(get("data"));
                if (loaded.length === 1) {
                  call("load");
                }
              },
            },
            capture: false,
            priority: 0,
          },
        ],
      ],
    ]);
    call("load");
    await frame();
    await frame();
    assert.equal(loaded.length, 2);
    assert.notEqual(loaded[0], loaded[1]);
    for (const data of loaded) {
      const bytes = avm2.bytesOf(rt, data);
      assert.deepEqual(bytes.buffer.slice(0, bytes.length), Uint8Array.of(65, 0, 255));
    }
  } finally {
    player.destroy();
  }
});

for (const ending of ["cancel", "ioError"] as const) {
  test(`an upload cannot populate the ByteArray of a reload ended by ${ending}`, async () => {
    let reads = 0;
    const { player, rt, get, call, frame } = await setup({
      fetch: async () => ({ bytes: new Uint8Array(), status: 200, headers: [] }),
      fileHost: {
        browse: async () => [
          {
            name: "a.txt",
            size: 3,
            modificationDate: 123,
            read: async () => {
              if (++reads === 2 && ending === "ioError") {
                throw new Error("reload failed");
              }

              return Uint8Array.of(65, 0, 255);
            },
          },
        ],
        save: async () => null,
      },
    });
    try {
      call("browse");
      await frame();
      call("load");
      await frame();
      assert.notEqual(get("data"), null);
      call("load");
      if (ending === "cancel") {
        call("cancel");
      }

      await frame();
      assert.equal(get("data"), null);
      const request = rt.construct(
        rt.classNamed("flash.net::URLRequest"),
        "https://example.test/upload",
      );
      call("upload", request);
      await frame();
      assert.equal(get("data"), null);
    } finally {
      player.destroy();
    }
  });
}

test("regular uploads and downloads ignore requestHeaders and retain POST data", async () => {
  const asked: FetchRequest[] = [];
  const { player, rt, call, frame } = await setup({
    fileHost: {
      browse: async () => [
        {
          name: "a.txt",
          size: 3,
          modificationDate: 123,
          read: async () => Uint8Array.of(65, 0, 255),
        },
      ],
      save: async (name) => ({ name, write: async () => {} }),
    },
    fetch: async (request) => {
      asked.push(request);
      return { bytes: new TextEncoder().encode("ok"), status: 200, headers: [] };
    },
  });
  try {
    call("browse");
    await frame();
    const request = rt.construct(
      rt.classNamed("flash.net::URLRequest"),
      "https://example.test/transfer",
    );
    rt.setProperty(request, rt.publicName("method"), "POST");
    rt.setProperty(request, rt.publicName("data"), "x=a%26b");
    const headers = [
      rt.construct(rt.classNamed("flash.net::URLRequestHeader"), "X-Swf-Header", "ignored"),
      rt.construct(rt.classNamed("flash.net::URLRequestHeader"), "Content-Type", "text/plain"),
    ];
    rt.setProperty(request, rt.publicName("requestHeaders"), rt.array(headers));
    call("upload", request);
    await frame();
    assert.equal(asked.length, 1);
    assert.equal(asked[0].headers.length, 1);
    assert.equal(asked[0].headers[0][0], "Content-Type");
    assert.match(asked[0].headers[0][1], /^multipart\/form-data; boundary=/);
    const form = await new Response(asked[0].body?.slice().buffer, {
      headers: asked[0].headers.map(([name, value]) => [name, value]),
    }).formData();
    assert.equal(form.get("x"), "a&b");
    call("download", request, "download.txt");
    await frame();
    await frame();
    assert.equal(asked.length, 2);
    assert.equal(asked[1].method, "POST");
    assert.deepEqual(asked[1].headers, [["Content-Type", "application/x-www-form-urlencoded"]]);
    assert.equal(new TextDecoder().decode(asked[1].body as Uint8Array), "x=a%26b");
    call("uploadUnencoded", request);
    await frame();
    assert.deepEqual(asked[2].headers, [
      ["X-Swf-Header", "ignored"],
      ["Content-Type", "text/plain"],
    ]);
  } finally {
    player.destroy();
  }
});
