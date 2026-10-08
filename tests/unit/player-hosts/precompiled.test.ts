// Modules compiled ahead of time, played: the swf2es command writes each
// module under the key the player's module cache asks for, with the log
// the cache would keep, so that a player given them through
// precompiledModules compiles nothing, imported or evaluated, and traces
// as one that compiled; and where they are another compiler's, or one is
// missing, it compiles.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Codegen, createCodegen } from "@swf2es/codegen";
import { chainCaches, precompiledModules } from "@swf2es/player-hosts/precompiled";
import { containerEngine } from "../../../oracle/oracle.ts";
import type { CachedModule, ModuleCache } from "../../../packages/player/dist/hosts.js";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { bare } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compileScripts } from "../../player/scripts.ts";
import * as w from "../../swf-writer.ts";

const out = fileURLToPath(new URL("../out/player-precompiled/", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/cli/dist/main.js", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A compiler that counts the modules it compiles, as `identity` if given. */
async function counted(identity?: string): Promise<{ codegen: Codegen; compiled: () => number }> {
  const made = await createCodegen(wasm);
  const codegen: Codegen =
    identity === undefined ? made : Object.create(made, { identity: { value: identity } });
  let count = 0;
  const compileModule = made.compileModule.bind(made);
  const compileModuleLogged = made.compileModuleLogged.bind(made);
  codegen.compileModule = (hashes, index) => {
    count++;
    return compileModule(hashes, index);
  };
  codegen.compileModuleLogged = (hashes, index) => {
    count++;
    return compileModuleLogged(hashes, index);
  };
  return { codegen, compiled: () => count };
}

/** Play `swf`'s first frames with `cache`: what it traced and how many modules compiled. */
async function play(swf: Uint8Array, cache: ModuleCache | null, identity?: string, frames = 2) {
  const { codegen, compiled } = await counted(identity);
  const lines: string[] = [];
  const s = new Scripting(codegen, { print: (line) => lines.push(line), moduleCache: cache });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, s);
  await player.start();
  for (let frame = 2; frame <= frames; frame++) {
    await s.settled();
    player.tick();
  }

  return { lines, compiled: compiled() };
}

/** A cache in memory that asks for every module, however small. */
function memoryCache(store = new Map<string, CachedModule>()): ModuleCache {
  return {
    minBytes: 0,
    get: async (key) => store.get(key),
    put: async (key, entry) => {
      store.set(key, entry);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.ok(done(), "the cache never came to the state awaited");
}

// Two DoABCs: a large document class, which finds the other's class by
// name in its domain, and that one, smaller than the player's IndexedDB
// cache asks for, which a precompiled cache asks for too.
const helper = `package { public class Helper {
  public function hello():String { return "hello " + m3(2); }
  ${Array.from({ length: 5 }, (_, i) => `public function m${i}(x:Number):Number { return x * ${i}; }`).join("\n  ")}
} }`;
const main = `package {
  import flash.display.Sprite;
  import flash.system.ApplicationDomain;
  import flash.utils.getDefinitionByName;
  public class AotMain extends Sprite {
    public function AotMain() {
      var C:Class = getDefinitionByName("Helper") as Class;
      trace("AotMain", new C().hello(), ApplicationDomain.currentDomain.hasDefinition("AotMain"));
      addEventListener("enterFrame", function (e:*):void { trace("frame", m7(3)); });
    }
    ${Array.from({ length: 300 }, (_, i) => `public function m${i}(x:Number):Number { var a:Array = [${i}, x]; return a.length + x * ${i}; }`).join("\n    ")}
  }
}`;

let built: { swf: Uint8Array; dir: string; manifest: URL } | undefined;

/** The SWF, compiled ahead of time by the command with the libraries' modules into `dir`. */
function compiled() {
  if (built) {
    return built;
  }

  const abcs = compileScripts(
    [
      { name: "AotMain", source: main },
      { name: "Helper", source: helper },
    ],
    `${out}scripts`,
  );
  const swf = w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.doAbc(abcs.get("AotMain") as Uint8Array, "AotMain"),
      w.doAbc(abcs.get("Helper") as Uint8Array, "Helper"),
      w.symbolClass([[0, "AotMain"]]),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
  built = { swf, ...ahead("aot", swf) };
  return built;
}

/** `swf` compiled ahead of time by the command, with the libraries' modules, into `out`/`name`/. */
function ahead(name: string, swf: Uint8Array): { dir: string; manifest: URL } {
  libraryAbcs(`${out}libraries/`);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}${name}.swf`, swf);
  const dir = `${out}${name}/`;
  const libs = ["builtin", "playerglobal"].flatMap((n) => ["--lib", `${out}libraries/${n}.abc`]);
  const r = spawnSync(
    process.execPath,
    [cli, `${out}${name}.swf`, "-o", dir, "--emit-libraries", "-q", ...libs],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return { dir, manifest: pathToFileURL(`${dir}manifest.json`) };
}

const readText = (url: URL) => readFile(fileURLToPath(url), "utf8");

test("the command writes each module, its log and its key as the player's cache keeps them", {
  skip,
}, async () => {
  const { swf, dir } = compiled();
  const store = new Map<string, CachedModule>();
  await play(swf, memoryCache(store));
  await until(() => store.size === 4);

  const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, "utf8"));
  const entries = [...manifest.libraries, ...manifest.abcs];
  assert.equal(entries.length, 4);
  for (const e of entries) {
    const stored = store.get(e.key);
    assert.ok(stored, `no entry under ${e.module}'s key`);
    assert.equal(stored.module, readFileSync(dir + e.module, "utf8"));
    assert.equal(stored.log, readFileSync(dir + e.log, "utf8"));
    assert.deepEqual(stored.lengths, e.lengths);
  }
});

test("a SWF plays from its precompiled modules, compiling none, evaluated or imported", {
  skip,
}, async () => {
  const { swf, manifest } = compiled();
  const expected = await play(swf, null);
  assert.deepEqual(expected.lines, ["AotMain hello 6 true", "frame 23"]);

  for (const importModules of [false, true]) {
    const cache = precompiledModules(manifest, { read: readText, importModules });
    const aot = await play(swf, cache);
    assert.equal(aot.compiled, 0, `importModules: ${importModules}`);
    assert.deepEqual(aot.lines, expected.lines);
  }
});

test("another compiler's precompiled modules, or one missing, are compiled", { skip }, async () => {
  const { swf, dir, manifest } = compiled();
  const expected = (await play(swf, null)).lines;

  const other = await play(swf, precompiledModules(manifest, { read: readText }), "another");
  assert.equal(other.compiled, 4);
  assert.deepEqual(other.lines, expected);

  // The first ABC's module gone, imported or read: that one compiles, and
  // the second, whose key its compile leaves alike, does not.
  const edited = JSON.parse(readFileSync(`${dir}manifest.json`, "utf8"));
  edited.abcs[0].module = "missing.js";
  writeFileSync(`${dir}missing.json`, JSON.stringify(edited));
  for (const importModules of [false, true]) {
    const missing = precompiledModules(pathToFileURL(`${dir}missing.json`), {
      read: readText,
      importModules,
    });
    const played = await play(swf, missing);
    assert.equal(played.compiled, 1, `importModules: ${importModules}`);
    assert.deepEqual(played.lines, expected);
  }

  // A manifest of another format, or none, names nothing.
  edited.manifestVersion = 1;
  writeFileSync(`${dir}v1.json`, JSON.stringify(edited));
  const v1 = precompiledModules(pathToFileURL(`${dir}v1.json`), { read: readText });
  assert.equal((await play(swf, v1)).compiled, 4);
  const none = precompiledModules(pathToFileURL(`${dir}none.json`), { read: readText });
  assert.equal((await play(swf, none)).compiled, 4);
});

test("chained, precompiled modules come first, and what they lack is cached", {
  skip,
}, async () => {
  const { swf, manifest } = compiled();
  const store = new Map<string, CachedModule>();
  const chain = () =>
    chainCaches(precompiledModules(manifest, { read: readText }), memoryCache(store));

  const first = await play(swf, chain(), "another");
  assert.equal(first.compiled, 4);
  await until(() => store.size === 4);
  assert.equal((await play(swf, chain(), "another")).compiled, 0);

  assert.equal((await play(swf, chain())).compiled, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.size, 4);
});

test("a module imported into two sibling domains is two modules, each its domain's", {
  skip,
}, async () => {
  // A child compiled as a main movie, loaded twice into new children of
  // the root, as the main movie's domain is: each load's key is the main
  // movie's, so both are imported, and each must find its own class.
  const child = `package {
    import flash.display.Sprite;
    import flash.events.Event;
    import flash.system.ApplicationDomain;
    public class AotChild extends Sprite {
      private var frames:int = 0;
      public function AotChild() { addEventListener(Event.ENTER_FRAME, check); }
      private function check(e:Event):void {
        if (++frames == 3) {
          trace("child", ApplicationDomain.currentDomain.getDefinition("AotChild") === AotChild);
        }
      }
    }
  }`;
  const childAbc = compileScripts([{ name: "AotChild", source: child }], `${out}scripts`).get(
    "AotChild",
  ) as Uint8Array;
  const childSwf = bare(childAbc, 1, "AotChild");
  const { manifest } = ahead("child", childSwf);
  const decode = readFileSync(
    new URL("../../player/scripts/Loads.as.template", import.meta.url),
    "utf8",
  );
  const decoder = decode.slice(decode.indexOf("    /** Base64"), decode.lastIndexOf("  }\n}"));
  const parent = `package {
    import flash.display.Loader;
    import flash.display.Sprite;
    import flash.system.ApplicationDomain;
    import flash.system.LoaderContext;
    import flash.utils.ByteArray;
    public class AotParent extends Sprite {
      public function AotParent() {
        for (var i:int = 0; i < 2; i++) {
          var loader:Loader = new Loader();
          loader.loadBytes(decode("${Buffer.from(childSwf).toString("base64")}"),
            new LoaderContext(false, new ApplicationDomain(null)));
          addChild(loader);
        }
      }
${decoder}
    }
  }`;
  const parentAbc = compileScripts([{ name: "AotParent", source: parent }], `${out}scripts`).get(
    "AotParent",
  ) as Uint8Array;
  const swf = bare(parentAbc, 1, "AotParent");

  const expected = await play(swf, null, undefined, 8);
  assert.deepEqual(expected.lines, ["child true", "child true"]);
  const cache = precompiledModules(manifest, { read: readText, importModules: true });
  const imported = await play(swf, cache, undefined, 8);
  // The parent's module alone compiles.
  assert.equal(imported.compiled, 1);
  assert.deepEqual(imported.lines, expected.lines);
});

test("a chain reads the next cache's entry where the first's fails, and survives a throw", {
  skip,
}, async () => {
  const { swf, dir } = compiled();
  const expected = (await play(swf, null)).lines;
  const edited = JSON.parse(readFileSync(`${dir}manifest.json`, "utf8"));
  edited.abcs[0].lengths[0] += 1;
  edited.abcs[1].module = "missing.js";
  writeFileSync(`${dir}stale.json`, JSON.stringify(edited));
  const store = new Map<string, CachedModule>();
  // A cache whose put and delete throw at the call, before the one that keeps.
  const throwing: ModuleCache = {
    get: async () => undefined,
    put: () => {
      throw new Error("full");
    },
    delete: () => {
      throw new Error("gone");
    },
  };
  for (const importModules of [false, true]) {
    store.clear();
    const chain = () =>
      chainCaches(
        precompiledModules(pathToFileURL(`${dir}stale.json`), { read: readText, importModules }),
        throwing,
        memoryCache(store),
      );

    // The SWF's failing modules, both evaluated, the missing one imported
    // (an import's length is not checked), are compiled and kept; then read
    // from the next cache, which the failed entries' deletions leave alone.
    const failing = importModules ? 1 : 2;
    const first = await play(swf, chain());
    assert.equal(first.compiled, failing, `importModules: ${importModules}`);
    await until(() => store.size === failing);
    const second = await play(swf, chain());
    assert.equal(second.compiled, 0, `importModules: ${importModules}`);
    assert.deepEqual(second.lines, expected);
    assert.equal(store.size, failing);
  }
});

test("precompiled modules are read by URLs of their keys", { skip }, async () => {
  const { dir, manifest } = compiled();
  const entry = JSON.parse(readFileSync(`${dir}manifest.json`, "utf8")).abcs[0];
  const asked: string[] = [];
  const cache = precompiledModules(manifest, {
    read: (url) => {
      asked.push(url.href);
      return readText(url);
    },
    importModules: true,
  });
  const got = await cache.get(entry.key);
  assert.equal(got?.url, `${pathToFileURL(dir + entry.module).href}?${entry.key}`);
  assert.ok(asked.includes(`${pathToFileURL(dir + entry.log).href}?${entry.key}`));
});

test("a chain gives a deletion to the member whose entry was rejected, however reads overlap", async () => {
  const member = (name: string) => {
    const store = new Map<string, CachedModule>([
      ["k", { module: name, log: "", lengths: [name.length, 0] }],
    ]);
    const deleted: string[] = [];
    const cache: ModuleCache = {
      get: async (key) => store.get(key),
      put: async (key, entry) => {
        store.set(key, entry);
      },
      delete: async (key) => {
        deleted.push(key);
        store.delete(key);
      },
    };
    return { store, deleted, cache };
  };

  // Two reads answered by the first member, both rejected.
  let a = member("a");
  let b = member("b");
  let chain = chainCaches(a.cache, b.cache);
  const [first, second] = await Promise.all([chain.get("k"), chain.get("k")]);
  await chain.delete("k", first);
  await chain.delete("k", second);
  assert.deepEqual(a.deleted, ["k", "k"]);
  assert.deepEqual(b.deleted, []);

  // Interleaved: the first read's retry reads the second member's entry
  // before the second read rejects the first member's.
  a = member("a");
  b = member("b");
  chain = chainCaches(a.cache, b.cache);
  const one = await chain.get("k");
  const two = await chain.get("k");
  await chain.delete("k", one);
  const retried = await chain.get("k");
  await chain.delete("k", two);
  assert.equal(retried?.module, "b");
  assert.deepEqual(b.deleted, []);
  assert.ok(b.store.has("k"));
});

test("a precompiled module deleted is not answered again", { skip }, async () => {
  const { dir, manifest } = compiled();
  const { key } = JSON.parse(readFileSync(`${dir}manifest.json`, "utf8")).abcs[0];
  const cache = precompiledModules(manifest, { read: readText });
  assert.ok(await cache.get(key));
  await cache.delete(key);
  assert.equal(await cache.get(key), undefined);
});
