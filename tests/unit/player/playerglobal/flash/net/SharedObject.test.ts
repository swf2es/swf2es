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
    keys: () => [...stored.keys()],
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
  // Keyed by host, the SWF's path, and the name; a .sol file, AMF3 by default.
  const kept = stored.get("example.test/games/main.swf/kept") as Uint8Array;
  assert.deepEqual([...kept.subarray(0, 2)], [0x00, 0xbf]);
  assert.equal(new TextDecoder().decode(kept.subarray(6, 10)), "TCSO");
  assert.ok(stored.has("example.test//rooted"));

  // Read back by another player, as a later visit to the page would, its size the
  // file's: a 26-byte header for "kept", then 5, 9, 10 and 10 bytes of entries.
  // Clear takes the file out.
  assert.deepEqual(await run(abcs.get("SharedRead") as Uint8Array, url, storage), [
    "7 text 1,2 true 60",
    "1.5",
    "0",
  ]);
  assert.ok(!stored.has("example.test/games/main.swf/kept"));
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
  assert.deepEqual([...stored.keys()], ["example.test/main.swf/guarded#secure"]);
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
    "example.test/child/inner.swf/prefs",
    "example.test/outer.swf/prefs",
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
  assert.ok(stored.has("example.test/main.swf/later"));
});
