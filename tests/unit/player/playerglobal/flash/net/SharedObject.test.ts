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
const out = fileURLToPath(new URL("../../../../out/player-shared-object/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A document class, `Main` unless named, that runs `body` with `so`, a SharedObject, in scope. */
const script = (name: string, body: string, className = "Main") => ({
  name,
  source: `package {
  import flash.display.Sprite;
  import flash.net.SharedObject;
  import flash.utils.ByteArray;
  public class ${className} extends Sprite {
    public function ${className}() {
      ${body}
    }
  }
}`,
});

type Storage = NonNullable<ConstructorParameters<typeof Scripting>[1]>["storage"];

/** The trace of `abc`'s run in a player for a SWF at `url`, keeping its objects in `storage`. */
async function run(abc: Uint8Array, url: string, storage?: Storage): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    storage,
    url,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(bare(abc, 1), scripting).start();
  return lines;
}

/** Storage in a map, whose writes `refuse` makes throw. */
function mapStorage(refuse = false) {
  const stored = new Map<string, Uint8Array>();
  const storage = {
    get: (key: string) => stored.get(key) ?? null,
    set: (key: string, bytes: Uint8Array) => {
      if (refuse) {
        throw new Error("quota");
      }

      stored.set(key, bytes);
    },
    remove: (key: string) => {
      stored.delete(key);
    },
  };

  return { stored, storage };
}

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
  const { stored, storage } = mapStorage();
  const url = "http://example.test/games/main.swf";

  assert.deepEqual(await run(abcs.get("SharedWrite") as Uint8Array, url, storage), ["flushed"]);
  // Keyed by host, the SWF's path, the name, and #amf3 for an AMF3 .sol file, the default.
  const kept = stored.get("example.test/games/main.swf/kept#amf3") as Uint8Array;
  assert.deepEqual([...kept.subarray(0, 2)], [0x00, 0xbf]);
  assert.equal(new TextDecoder().decode(kept.subarray(6, 10)), "TCSO");
  assert.ok(stored.has("example.test//rooted#amf3"));

  // Read back by another player, as a later visit to the page would, its size the
  // file's: a 26-byte header for "kept", then 5, 9, 10 and 10 bytes of entries.
  // Clear takes the file out.
  assert.deepEqual(await run(abcs.get("SharedRead") as Uint8Array, url, storage), [
    "7 text 1,2 true 60",
    "1.5",
    "0",
  ]);
  assert.deepEqual([...stored.keys()], ["example.test//rooted#amf3"]);
});

/** Bytes from hex, spaces ignored. */
const fromHex = (hex: string) =>
  Uint8Array.from(hex.replaceAll(" ", "").match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/** A .sol file's header for `name` and AMF `version`, its length that of what follows it in `body`. */
function solHeader(name: string, version: number, body: number): string {
  const nameHex = Buffer.from(name).toString("hex");
  const length = 4 + 6 + 2 + name.length + 4 + body;
  return `00bf ${length.toString(16).padStart(8, "0")} 5443534f 0004 00000000 ${name.length.toString(16).padStart(4, "0")} ${nameHex} 0000000${version}`;
}

test("a SharedObject of AMF0 is adl's .sol file, its properties sharing one table of references", {
  skip,
}, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedAmf0",
        `var so:SharedObject = SharedObject.getLocal("amf0probe");
      so.objectEncoding = 0;
      var shared:Object = {k: 1};
      so.data.n = 1.5; so.data.s = "str"; so.data.o = shared; so.data.p = shared;
      so.data.a = [1, "x"]; so.data.u = undefined; so.data.nul = null;
      trace(so.flush(), so.size);`,
      ),
      script(
        "SharedAmf0Read",
        `var so:SharedObject = SharedObject.getLocal("amf0probe");
      var d:Object = so.data;
      trace(d.n, d.s, d.o.k, d.o === d.p, d.a, d.a.length, d.u, d.nul, "u" in d);`,
      ),
    ],
    out,
  );
  const { stored, storage } = mapStorage();
  const url = "http://example.test/main.swf";

  // adl's file for the same data, its properties in the order they were set.
  const body = [
    "0001 6e 00 3ff8000000000000 00",
    "0001 73 02 0003 737472 00",
    "0001 6f 03 0001 6b 00 3ff0000000000000 0000 09 00",
    "0001 70 07 0000 00",
    "0001 61 08 00000002 0001 30 00 3ff0000000000000 0001 31 02 0001 78 0000 09 00",
    "0001 75 06 00",
    "0003 6e756c 05 00",
  ].join(" ");
  const file = fromHex(`${solHeader("amf0probe", 0, fromHex(body).length)} ${body}`);
  assert.deepEqual(await run(abcs.get("SharedAmf0") as Uint8Array, url, storage), [
    `flushed ${file.length}`,
  ]);
  assert.deepEqual(stored.get("example.test/main.swf/amf0probe"), file);

  assert.deepEqual(await run(abcs.get("SharedAmf0Read") as Uint8Array, url, storage), [
    "1.5 str 1 true 1,x 2 undefined null true",
  ]);
});

test("a SharedObject of AMF3 shares one writer's tables across its properties, names too, as adl", {
  skip,
}, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedAmf3",
        `var so:SharedObject = SharedObject.getLocal("amf3probe");
      var shared:Object = {k: 1};
      so.data.o = shared; so.data.p = shared; so.data.s = "str"; so.data.t = "str";
      trace(so.flush(), so.size);`,
      ),
      script(
        "SharedAmf3Read",
        `var d:Object = SharedObject.getLocal("amf3probe").data;
      trace(d.o.k, d.o === d.p, d.s, d.t);`,
      ),
    ],
    out,
  );
  const { stored, storage } = mapStorage();
  const url = "http://example.test/main.swf";

  // The names are strings of the table: "str" the second time is a reference to the fifth.
  const body = "036f 0a0b01036b040101 00 0370 0a00 00 0373 0607737472 00 0374 0608 00";
  const file = fromHex(`${solHeader("amf3probe", 3, fromHex(body).length)} ${body}`);
  assert.deepEqual(await run(abcs.get("SharedAmf3") as Uint8Array, url, storage), ["flushed 60"]);
  assert.deepEqual(stored.get("example.test/main.swf/amf3probe#amf3"), file);

  assert.deepEqual(await run(abcs.get("SharedAmf3Read") as Uint8Array, url, storage), [
    "1 true str str",
  ]);
});

test("an AMF3 save of swf2es 0.1.16, under the key alone with tables for each value, reads back as it was written", {
  skip,
}, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedLegacy",
        `var so:SharedObject = SharedObject.getLocal("legacy");
      var d:Object = so.data;
      trace(d.list[0].a, d.list[1].a, d.more[1].a, d.same[0] === d.same[1], d.same[1].k);
      trace(so.flush());`,
      ),
    ],
    out,
  );
  const { stored, storage } = mapStorage();
  const url = "http://example.test/main.swf";

  // As 0.1.16 wrote list = [{a: "x"}, {a: "x"}], more = [{a: "y"}, {a: "y"}]
  // and same = [o, o]: each name inline, each value by a writeObject of its
  // own, so its second object's "a", "x" and traits, and o the second time,
  // are references into its own tables. Read with one table for the file,
  // "a" would be the name "list".
  const body = [
    "09 6c697374 09 05 01 0a 0b 01 03 61 06 03 78 01 0a 01 00 06 02 01 00",
    "09 6d6f7265 09 05 01 0a 0b 01 03 61 06 03 79 01 0a 01 00 06 02 01 00",
    "09 73616d65 09 05 01 0a 0b 01 03 6b 04 01 01 0a 02 00",
  ].join(" ");
  stored.set(
    "example.test/main.swf/legacy",
    fromHex(`${solHeader("legacy", 3, fromHex(body).length)} ${body}`),
  );
  const lines = ["x x y true 1", "flushed"];
  assert.deepEqual(await run(abcs.get("SharedLegacy") as Uint8Array, url, storage), lines);

  // Its flush wrote it in Flash's form under the AMF3 key, and took the old one away.
  assert.deepEqual([...stored.keys()], ["example.test/main.swf/legacy#amf3"]);
  assert.deepEqual(await run(abcs.get("SharedLegacy") as Uint8Array, url, storage), lines);
});

test("deleteAll and getDiskUsage reach no SWF's saves, its own or another site's, as Flash refuses them", {
  skip,
}, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedSave",
        `var so:SharedObject = SharedObject.getLocal("prefs");
      so.data.n = 1;
      so.flush();
      SharedObject.getLocal("prefs", "/").data.n = 2;
      SharedObject.getLocal("prefs", "/").flush();`,
      ),
      script(
        "SharedSweep",
        `var urls:Array = ["", "/", "a.example", "a.example/", "b.example", "http://b.example/",
        "http://b.example/two/b.swf", null];
      for each (var url:* in urls) {
        for each (var f:Function in [SharedObject.deleteAll, SharedObject.getDiskUsage]) {
          try {
            trace(f(url));
          } catch (e:Error) {
            trace(e.errorID);
          }
        }
      }`,
      ),
    ],
    out,
  );
  const { stored, storage } = mapStorage();
  const save = abcs.get("SharedSave") as Uint8Array;
  await run(save, "http://a.example/one/a.swf", storage);
  await run(save, "http://b.example/two/b.swf", storage);
  const before = new Map(stored);
  assert.equal(before.size, 4);

  // Two SWFs of the same page's origin, from either site: "" or another
  // host's name would have matched every save, or the other site's.
  for (const url of ["http://a.example/one/a.swf", "http://b.example/two/b.swf"]) {
    assert.deepEqual(await run(abcs.get("SharedSweep") as Uint8Array, url, storage), [
      ...Array(14).fill("2014"),
      "2007",
      "2007",
    ]);
  }

  assert.deepEqual(stored, before);
});

test("a SharedObject holds values too large to spread into one call", { skip }, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedLarge",
        `var so:SharedObject = SharedObject.getLocal("large");
      var b:ByteArray = new ByteArray();
      b.length = 150000;
      b[149999] = 9;
      so.data.b = b;
      trace(so.size, so.flush());`,
      ),
      script(
        "SharedLargeRead",
        `var b:ByteArray = SharedObject.getLocal("large").data.b;
      trace(b.length, b[149999]);`,
      ),
    ],
    out,
  );
  const { storage } = mapStorage();
  const url = "http://example.test/main.swf";

  // A 27-byte header for "large", the name's 2 bytes, the ByteArray's marker,
  // 3-byte length and bytes, and the 0 after it.
  assert.deepEqual(await run(abcs.get("SharedLarge") as Uint8Array, url, storage), [
    "150034 flushed",
  ]);
  assert.deepEqual(await run(abcs.get("SharedLargeRead") as Uint8Array, url, storage), [
    "150000 9",
  ]);
});

test("a secure SharedObject is for a SWF that came over HTTPS, kept apart", { skip }, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedSecure",
        `try {
        var so:SharedObject = SharedObject.getLocal("guarded", null, true);
        so.data.n = 1;
        trace(so.flush(), so === SharedObject.getLocal("guarded"));
      } catch (e:Error) {
        trace(e.errorID);
      }`,
      ),
    ],
    out,
  );
  const { stored, storage } = mapStorage();
  const abc = abcs.get("SharedSecure") as Uint8Array;

  assert.deepEqual(await run(abc, "https://example.test/main.swf", storage), ["flushed false"]);
  assert.deepEqual([...stored.keys()], ["example.test/main.swf/guarded#secure#amf3"]);
  assert.deepEqual(await run(abc, "http://example.test/main.swf", storage), ["2134"]);
});

test("a flush the storage refuses is Error #2130", { skip }, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedRefused",
        `var so:SharedObject = SharedObject.getLocal("refused");
      so.data.n = 1;
      try {
        so.flush();
      } catch (e:Error) {
        trace(e.errorID);
      }`,
      ),
    ],
    out,
  );

  assert.deepEqual(
    await run(
      abcs.get("SharedRefused") as Uint8Array,
      "http://example.test/main.swf",
      mapStorage(true).storage,
    ),
    ["2130"],
  );
});

test("a host whose localStorage throws when read keeps SharedObjects in memory", {
  skip,
}, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedBlocked",
        `var so:SharedObject = SharedObject.getLocal("blocked");
      so.data.n = 1;
      trace(so.flush(), SharedObject.getLocal("blocked").data.n);`,
      ),
    ],
    out,
  );
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("blocked", "SecurityError");
    },
  });
  try {
    assert.deepEqual(
      await run(abcs.get("SharedBlocked") as Uint8Array, "http://example.test/main.swf"),
      ["flushed 1"],
    );
  } finally {
    if (had) {
      Object.defineProperty(globalThis, "localStorage", had);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
});

test("a loaded SWF's SharedObject is its own, by its URL, not the main SWF's", {
  skip,
}, async () => {
  const abcs = compileScripts(
    [
      script(
        "SharedOuter",
        `var so:SharedObject = SharedObject.getLocal("prefs");
      so.data.who = "outer";
      so.flush();
      var loader:flash.display.Loader = new flash.display.Loader();
      loader.load(new flash.net.URLRequest("child/inner.swf"));
      addChild(loader);`,
      ),
      script(
        "SharedInner",
        `var so:SharedObject = SharedObject.getLocal("prefs");
      trace(so.data.who, SharedObject.getLocal("prefs", "/child") !== null);
      so.data.who = "inner";
      so.flush();`,
        // Not Main, which the child's domain would find in its parent's.
        "Inner",
      ),
    ],
    out,
  );
  const { stored, storage } = mapStorage();
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    storage,
    url: "http://example.test/outer.swf",
    fetch: async () => ({
      bytes: bare(abcs.get("SharedInner") as Uint8Array, 1, "Inner"),
      status: 200,
      headers: [],
    }),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abcs.get("SharedOuter") as Uint8Array, 1), scripting);
  await player.start();
  await scripting.settled();
  player.tick();

  // The child's own path, under which "/child" is one of its directories.
  assert.deepEqual(lines, ["undefined true"]);
  assert.deepEqual([...stored.keys()].sort(), [
    "example.test/child/inner.swf/prefs#amf3",
    "example.test/outer.swf/prefs#amf3",
  ]);
});

test("a destroyed player writes the SharedObjects its scripts left unflushed, as Flash did on unload", {
  skip,
}, async () => {
  const abc = compileScripts(
    [script("SharedUnflushed", `SharedObject.getLocal("later").data.n = 3;`, "SharedUnflushed")],
    out,
  ).get("SharedUnflushed") as Uint8Array;
  const { stored, storage } = mapStorage();
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    storage,
    url: "http://example.test/main.swf",
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "SharedUnflushed"), scripting);
  await player.start();
  assert.equal(stored.size, 0);

  player.destroy();
  assert.ok(stored.has("example.test/main.swf/later#amf3"));
});

test("a player writes the SharedObjects its scripts left unflushed as its page goes, and plays on", {
  skip,
}, async () => {
  const abc = compileScripts(
    [script("SharedUnflushed", `SharedObject.getLocal("later").data.n = 3;`, "SharedUnflushed")],
    out,
  ).get("SharedUnflushed") as Uint8Array;
  const { stored, storage } = mapStorage();
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    storage,
    url: "http://example.test/main.swf",
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "SharedUnflushed"), scripting);
  await player.start();
  assert.equal(stored.size, 0);

  player.saveSharedObjects();
  const written = stored.get("example.test/main.swf/later#amf3");
  assert.ok(written);
  player.saveSharedObjects();
  assert.equal(stored.get("example.test/main.swf/later#amf3"), written);
  player.tick();
  player.destroy();
});

test("destroy leaves a save it could not read, and one the SWF did not change, as they were", {
  skip,
}, async () => {
  const abc = compileScripts(
    [
      script(
        "SharedOnlyReads",
        `trace(SharedObject.getLocal("broken").size, SharedObject.getLocal("kept").data.n);`,
        "SharedOnlyReads",
      ),
      script(
        "SharedKeeps",
        `var so:SharedObject = SharedObject.getLocal("kept"); so.data.n = 5; so.flush();`,
      ),
    ],
    out,
  );
  const { stored, storage } = mapStorage();
  const url = "http://example.test/main.swf";
  await run(abc.get("SharedKeeps") as Uint8Array, url, storage);
  const kept = stored.get("example.test/main.swf/kept#amf3");
  // Bytes no .sol reader takes: a save of a format the player cannot read.
  const broken = Uint8Array.of(1, 2, 3, 4);
  stored.set("example.test/main.swf/broken", broken);
  let writes = 0;
  const counted = {
    ...storage,
    set: (key: string, bytes: Uint8Array) => {
      writes++;
      storage.set(key, bytes);
    },
    remove: (key: string) => {
      writes++;
      storage.remove(key);
    },
  };

  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    storage: counted,
    url,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(
    bare(abc.get("SharedOnlyReads") as Uint8Array, 1, "SharedOnlyReads"),
    scripting,
  );
  await player.start();
  player.destroy();

  assert.deepEqual(lines, ["0 5"]);
  assert.equal(writes, 0);
  assert.equal(stored.get("example.test/main.swf/broken"), broken);
  assert.equal(stored.get("example.test/main.swf/kept#amf3"), kept);
});
