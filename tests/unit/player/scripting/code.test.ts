// The host's module cache: a module compiled once is read back, byte for
// byte what the compiler wrote, by a later player; keyed by the compiler
// and by every ABC the module's domain sees, those after it included; and
// a cache that fails or gives what is not a module is compiled past.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Codegen, createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { CachedModule, ModuleCache } from "../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { scripted } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../out/player-code/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A cache in memory, over `store`. */
function memoryCache(store = new Map<string, CachedModule>()) {
  const cache: ModuleCache = {
    async get(key) {
      return store.get(key);
    },
    async put(key, entry) {
      store.set(key, entry);
    },
  };
  return { cache, store };
}

/** A compiler that keeps every module it writes, as `identity` if given. */
async function counted(identity?: string | null): Promise<{ codegen: Codegen; modules: string[] }> {
  const made = await createCodegen(wasm);
  const codegen: Codegen =
    identity === undefined ? made : Object.create(made, { identity: { value: identity } });
  const modules: string[] = [];
  const compileModule = made.compileModule.bind(made);
  const compileModuleLogged = made.compileModuleLogged.bind(made);
  codegen.compileModule = (hashes, index) => {
    const module = compileModule(hashes, index);
    modules.push(module);
    return module;
  };
  codegen.compileModuleLogged = (hashes, index) => {
    const logged = compileModuleLogged(hashes, index);
    modules.push(logged.module);
    return logged;
  };
  return { codegen, modules };
}

/** Wait until `done`, as the cache's puts follow a load, not within it. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.ok(done(), "the cache was never given the modules");
}

/** Play `swf` for its first frame with `cache`: what it traced, the modules compiled, and its scripting. */
async function play(swf: Uint8Array, cache: ModuleCache | null, identity?: string | null) {
  const { codegen, modules } = await counted(identity);
  const lines: string[] = [];
  const scripting = new Scripting(codegen, {
    print: (line) => lines.push(line),
    moduleCache: cache,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, scripting).start();
  return { lines, modules, scripting };
}

const modulesOf = (store: Map<string, CachedModule>) => [...store.values()].map((e) => e.module);

test("modules are compiled once, then read from the cache as compiled", { skip }, async () => {
  const swf = scripted(compiler(out)("Main"));
  const { cache, store } = memoryCache();

  const first = await play(swf, cache);
  // builtin, playerglobal and the SWF's.
  assert.equal(first.modules.length, 3);
  await until(() => store.size === 3);
  assert.deepEqual(modulesOf(store).sort(), [...first.modules].sort());

  const second = await play(swf, cache);
  assert.equal(second.modules.length, 0);
  assert.deepEqual(second.lines, first.lines);
  assert.deepEqual(second.lines, (await play(swf, null)).lines);
  // Their logs replayed, the compiler's domain is as compiling them left it.
  assert.deepEqual(second.scripting.codegen.context(2), first.scripting.codegen.context(2));
});

test("another compiler's modules are not reused, and one without an identity uses none", {
  skip,
}, async () => {
  const swf = scripted(compiler(out)("Main"));
  const { cache, store } = memoryCache();
  await play(swf, cache);
  await until(() => store.size === 3);

  const other = await play(swf, cache, "another compiler");
  assert.equal(other.modules.length, 3);
  await until(() => store.size === 6);

  const asked: string[] = [];
  const watched: ModuleCache = {
    get: (key) => {
      asked.push(key);
      return cache.get(key);
    },
    put: (key, entry) => cache.put(key, entry),
  };
  const none = await play(swf, watched, null);
  assert.equal(none.modules.length, 3);
  assert.deepEqual(asked, []);
});

test("a cache that fails, or gives what is not a module, is compiled past", { skip }, async () => {
  const swf = scripted(compiler(out)("Main"));
  const expected = (await play(swf, null)).lines;
  const { cache, store } = memoryCache();
  await play(swf, cache);
  await until(() => store.size === 3);

  // Truncated: compiled again, and stored whole again.
  for (const [key, entry] of store) {
    store.set(key, { ...entry, module: entry.module.slice(0, entry.module.length / 2) });
  }

  const truncated = await play(swf, cache);
  assert.equal(truncated.modules.length, 3);
  assert.deepEqual(truncated.lines, expected);
  await until(() => modulesOf(store).every((m) => truncated.modules.includes(m)));

  const failing: ModuleCache = {
    get: () => Promise.reject(new Error("unreadable")),
    put: () => Promise.reject(new Error("full")),
  };
  const failed = await play(swf, failing);
  assert.equal(failed.modules.length, 3);
  assert.deepEqual(failed.lines, expected);
});

test("a cached module the runtime refuses is compiled, and stored again", { skip }, async () => {
  const swf = scripted(compiler(out)("Main"));
  const { cache, store } = memoryCache();
  const first = await play(swf, cache);
  await until(() => store.size === 3);

  // builtin's module everywhere: it evaluates, but loads after no other ABC.
  const builtin = first.modules[0];
  for (const [key, entry] of store) {
    store.set(key, { ...entry, module: builtin });
  }

  const refused = await play(swf, cache);
  assert.equal(refused.modules.length, 2);
  assert.deepEqual(refused.lines, first.lines);
  await until(() => modulesOf(store).sort().join() === [...first.modules].sort().join());
});

test("a module's key names the ABCs added after it in its domain", { skip }, async () => {
  const compile = compiler(out);
  const main = compile(
    "CacheMain",
    "package { import flash.display.Sprite; public class CacheMain extends Sprite { public function CacheMain() { trace('main'); } } }",
  );
  const withAbc = (name: string) =>
    w.swf({
      width: 100,
      height: 50,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        w.doAbc(main, "CacheMain"),
        w.doAbc(compile(name, `package { public class ${name} {} }`), name),
        w.symbolClass([[0, "CacheMain"]]),
        w.showFrame(),
        w.end(),
      ],
    });
  const { cache, store } = memoryCache();
  await play(withAbc("CacheExtraA"), cache);
  await until(() => store.size === 4);

  // The libraries are read; CacheMain, the same ABC but before another, is compiled.
  const other = await play(withAbc("CacheExtraB"), cache);
  assert.equal(other.modules.length, 2);
  assert.deepEqual(other.lines, ["main"]);
});
