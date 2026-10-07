// The host's module cache: a module compiled once is read back, byte for
// byte what the compiler wrote, by a later player, its log replayed;
// keyed by the compiler and by every ABC the module's domain sees, those
// after it included, and read again by its key taken anew when another
// load comes between; a cache that fails or gives what is not a whole
// module is compiled past; and an ABC too small to gain from it never asks.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Codegen, createCodegen } from "@swf2es/codegen";
import { readSwf } from "@swf2es/format";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { readLibrary } from "../../../../packages/player/dist/display/timeline.js";
import type { CachedModule, ModuleCache } from "../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare, scripted } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { type Compile, compiler } from "../../../player/scripts.ts";
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
    async delete(key) {
      store.delete(key);
    },
  };
  return { cache, store };
}

/** `cache`, its reads' keys listed in `asked`. */
function watched(cache: ModuleCache, asked: string[]): ModuleCache {
  return {
    ...cache,
    get: (key) => {
      asked.push(key);
      return cache.get(key);
    },
  };
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

  assert.ok(done(), "the cache never came to the state awaited");
}

/** A scripting with the libraries loaded, through a counted compiler: it, its trace and the modules compiled. */
async function scripting(cache: ModuleCache | null, identity?: string | null) {
  const { codegen, modules } = await counted(identity);
  const lines: string[] = [];
  const s = new Scripting(codegen, { print: (line) => lines.push(line), moduleCache: cache });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  return { s, lines, modules };
}

/** Play `swf` for its first frame with `cache`: what it traced, the modules compiled, and its scripting. */
async function play(swf: Uint8Array, cache: ModuleCache | null, identity?: string | null) {
  const { s, lines, modules } = await scripting(cache, identity);
  await new Player(swf, s).start();
  return { lines, modules, scripting: s };
}

/**
 * Class `name`'s source, a Sprite of 400 methods besides its constructor,
 * which traces its name and 5: an ABC larger than the smallest the cache
 * is asked for.
 */
function large(name: string): string {
  const members = Array.from(
    { length: 400 },
    (_, i) =>
      `public function m${i}(x:Number):Number { var a:Array = ["${name}", ${i}, x]; return a.length + x * ${i}; }`,
  );
  return `package { import flash.display.Sprite; public class ${name} extends Sprite {
    public function ${name}() { trace("${name}", m1(2)); }
    ${members.join("\n    ")}
  } }`;
}

let compiles: Compile | undefined;
const compile: Compile = (name, source) => {
  compiles ??= compiler(out);
  return compiles(name, source);
};

/** The SWF whose document class is the large class `name`. */
const largeSwf = (name: string) => bare(compile(name, large(name)), 1, name);

const modulesOf = (store: Map<string, CachedModule>) => [...store.values()].map((e) => e.module);

test("modules are compiled once, then read from the cache as compiled", { skip }, async () => {
  const swf = largeSwf("CacheMain");
  const { cache, store } = memoryCache();

  const first = await play(swf, cache);
  // builtin, playerglobal and the SWF's.
  assert.equal(first.modules.length, 3);
  await until(() => store.size === 3);
  assert.deepEqual(modulesOf(store).sort(), [...first.modules].sort());

  const second = await play(swf, cache);
  assert.equal(second.modules.length, 0);
  assert.deepEqual(second.lines, ["CacheMain 5"]);
  assert.deepEqual(second.lines, first.lines);
  assert.deepEqual(second.lines, (await play(swf, null)).lines);
  // Their logs replayed, the compiler's domain is as compiling them left it.
  assert.deepEqual(second.scripting.codegen.context(2), first.scripting.codegen.context(2));
});

test("an ABC smaller than the cache gains from is compiled, the cache not asked", {
  skip,
}, async () => {
  const swf = scripted(compile("Main"));
  const { cache, store } = memoryCache();
  const asked: string[] = [];
  await play(swf, watched(cache, asked));
  await until(() => store.size === 2);

  const again = await play(swf, watched(cache, asked));
  // Main's alone, an ABC of some hundred bytes; the libraries' read.
  assert.equal(again.modules.length, 1);
  assert.equal(asked.length, 4);
});

test("another compiler's modules are not reused, and one without an identity uses none", {
  skip,
}, async () => {
  const swf = largeSwf("CacheMain");
  const { cache, store } = memoryCache();
  await play(swf, cache);
  await until(() => store.size === 3);

  const other = await play(swf, cache, "another compiler");
  assert.equal(other.modules.length, 3);
  await until(() => store.size === 6);

  const asked: string[] = [];
  const none = await play(swf, watched(cache, asked), null);
  assert.equal(none.modules.length, 3);
  assert.deepEqual(asked, []);
});

test("a cache that fails, or gives what is not a whole module, is compiled past", {
  skip,
}, async () => {
  const swf = largeSwf("CacheMain");
  const expected = (await play(swf, null)).lines;
  const { cache, store } = memoryCache();
  const first = await play(swf, cache);
  await until(() => store.size === 3);
  const stored = new Map(store);

  // Cut short, the module, or the log at a line's end, their lengths as
  // stored: compiled again, and stored whole again.
  for (const cut of ["module", "log"] as const) {
    for (const [key, entry] of stored) {
      const text = entry[cut];
      const end = cut === "module" ? text.length / 2 : text.indexOf("\n");
      store.set(key, { ...entry, [cut]: text.slice(0, end) });
    }

    const truncated = await play(swf, cache);
    assert.equal(truncated.modules.length, 3, cut);
    assert.deepEqual(truncated.lines, expected);
    await until(() =>
      [...store].every(
        ([k, e]) => e.log === stored.get(k)?.log && first.modules.includes(e.module),
      ),
    );
  }

  const failing: ModuleCache = {
    get: () => Promise.reject(new Error("unreadable")),
    put: () => Promise.reject(new Error("full")),
    delete: () => Promise.reject(new Error("gone")),
  };
  const failed = await play(swf, failing);
  assert.equal(failed.modules.length, 3);
  assert.deepEqual(failed.lines, expected);
});

test("a log that fails part way is compiled past, and its entry goes", { skip }, async () => {
  const swf = largeSwf("CacheMain");
  const { cache, store } = memoryCache();
  const first = await play(swf, cache);
  await until(() => store.size === 3);

  // The SWF's module's log: its first entry, then one of traits there are not.
  const [key, entry] = [...store].find(([, e]) => e.module === first.modules[2]) ?? [];
  assert.ok(key && entry);
  const log = `${entry.log.split("\n")[0]}\n2 0 1 99999`;
  store.set(key, { ...entry, log, lengths: [entry.module.length, log.length] });

  const replayed = await play(swf, cache);
  assert.equal(replayed.modules.length, 1);
  assert.deepEqual(replayed.lines, first.lines);
  // Gone, and not stored again: what compiled after the partial replay is not that key's.
  await until(() => !store.has(key));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.size, 2);
});

test("a cached module the runtime refuses is compiled, and its entry goes", { skip }, async () => {
  const swf = largeSwf("CacheMain");
  const { cache, store } = memoryCache();
  const first = await play(swf, cache);
  await until(() => store.size === 3);

  // builtin's module everywhere: it evaluates, but loads after no other ABC.
  const builtin = first.modules[0];
  for (const [key, entry] of store) {
    store.set(key, { ...entry, module: builtin, lengths: [builtin.length, entry.log.length] });
  }

  const refused = await play(swf, cache);
  assert.equal(refused.modules.length, 2);
  assert.deepEqual(refused.lines, first.lines);
  await until(() => store.size === 1);

  // Missed, compiled and stored by the next load, read by the one after.
  await play(swf, cache);
  await until(() => store.size === 3);
  assert.equal((await play(swf, cache)).modules.length, 0);
});

test("a cached module that loads part of itself and throws fails the load, and goes", {
  skip,
}, async () => {
  const swf = largeSwf("CacheMain");
  const { cache, store } = memoryCache();
  const first = await play(swf, cache);
  await until(() => store.size === 3);

  // The SWF's module, loaded into its domain, then throwing.
  const [key, entry] = [...store].find(([, e]) => e.module === first.modules[2]) ?? [];
  assert.ok(key && entry);
  const at = entry.module.lastIndexOf("return A;");
  assert.ok(at > 0);
  const module = `${entry.module.slice(0, at)}throw new Error("poisoned");${entry.module.slice(at + 9)}`;
  store.set(key, { ...entry, module, lengths: [module.length, entry.log.length] });

  await assert.rejects(play(swf, cache), /poisoned/);
  await until(() => !store.has(key));

  const again = await play(swf, cache);
  assert.equal(again.modules.length, 1);
  assert.deepEqual(again.lines, first.lines);
});

test("a load that comes between a module's read and its replay leaves its key, if it sees none of it", {
  skip,
}, async () => {
  const child = readSwf(largeSwf("CacheChild"));
  const between = readSwf(largeSwf("CacheBetween"));
  const store = new Map<string, CachedModule>();
  // Link the child's SWF into a domain under the main one, and with
  // `interleave`, while its module is read, another SWF into a sibling of
  // that domain, which changes the compiler's domain but not what the
  // child's sees: how many times the child's was compiled. (The player
  // links one SWF at a time; a SWF linked into a domain the child's sees,
  // between its adding and its loading, the runtime refuses in any case.)
  const link = async (interleave: boolean) => {
    const { cache } = memoryCache(store);
    let armed = false;
    let holding: (() => void) | null = null;
    const slow: ModuleCache = {
      ...cache,
      get: async (key) => {
        const entry = await cache.get(key);
        if (armed) {
          armed = false;
          await new Promise<void>((r) => {
            holding = r;
          });
        }

        return entry;
      },
    };
    const { s, modules } = await scripting(slow);
    const before = modules.length;
    armed = interleave;
    const linking = s.code.link(
      child,
      s.rt.childDomain(s.mainDomain),
      "child.swf",
      readLibrary(child),
    );
    if (interleave) {
      while (holding === null) {
        await new Promise((r) => setTimeout(r, 1));
      }

      const revision = s.codegen.revision();
      const sibling = s.rt.childDomain(s.mainDomain);
      await s.code.link(between, sibling, "between.swf", readLibrary(between));
      assert.notEqual(s.codegen.revision(), revision);
      (holding as () => void)();
    }

    await linking;
    return modules.slice(before).filter((m) => m.includes("CacheChild")).length;
  };

  assert.equal(await link(false), 1);
  await until(() => store.size === 3);
  assert.equal(await link(true), 0);
});

test("a module's key names the ABCs added after it in its domain", { skip }, async () => {
  const main = compile("CacheMain", large("CacheMain"));
  const withAbc = (name: string) =>
    w.swf({
      width: 100,
      height: 50,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        w.doAbc(main, "CacheMain"),
        w.doAbc(compile(name, large(name)), name),
        w.symbolClass([[0, "CacheMain"]]),
        w.showFrame(),
        w.end(),
      ],
    });
  const { cache, store } = memoryCache();
  await play(withAbc("CacheExtraA"), cache);
  await until(() => store.size === 4);

  // The libraries are read; CacheMain, the same ABC but before another, is compiled, and the other.
  const other = await play(withAbc("CacheExtraB"), cache);
  assert.equal(other.modules.length, 2);
  assert.deepEqual(other.lines, ["CacheMain 5"]);
});
