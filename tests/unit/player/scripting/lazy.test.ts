import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { readSwf } from "@swf2es/format";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { readLibrary } from "../../../../packages/player/dist/display/timeline.js";
import type { CachedModule, ModuleCache } from "../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/player-lazy/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (error) {
  skip = (error as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const compile = compiler(out);
const source = `package {
  import flash.display.Sprite;
  import flash.system.ApplicationDomain;
  import flash.system.fscommand;
  import flash.utils.getDefinitionByName;
  public class DeferredRoot extends Sprite {
    public function DeferredRoot() { trace("root", String.fromCharCode(9731)); }
    public static function later():Function {
      var offset:int = 7;
      return function(value:int = 3):Object {
        var items:Vector.<DeferredRoot> = new Vector.<DeferredRoot>();
        items.push(new DeferredRoot());
        fscommand("deferred");
        return {value:offset + value, item:items[0],
          domain:ApplicationDomain.currentDomain,
          definition:getDefinitionByName("DeferredRoot")};
      };
    }
  }
}`;
let movie: Uint8Array | undefined;
const swf = () => (movie ??= bare(compile("DeferredRoot", source), 1, "DeferredRoot"));

async function setup(lazyCompilation: boolean, moduleCache?: ModuleCache) {
  const codegen = await createCodegen(wasm);
  const bodies: number[] = [];
  const each = codegen.compileMethods.bind(codegen);
  codegen.compileMethods = (indices, index) => {
    bodies.push(...indices);
    return each(indices, index);
  };
  const lines: string[] = [];
  const callers: string[][] = [];
  const s = new Scripting(codegen, {
    lazyCompilation,
    moduleCache,
    print: (line) => lines.push(line),
    realTime: null,
    url: "https://main.test/movie.swf",
    fsCommand: (_command, _args, urls) => callers.push(urls),
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  return { s, codegen, bodies, lines, callers };
}

test("lazy factories preserve closures, defaults, types and their original code domain", {
  skip,
}, async () => {
  for (const lazy of [false, true]) {
    const { s, bodies, lines, callers } = await setup(lazy);
    const child = s.rt.childDomain(s.mainDomain);
    const bytes = readSwf(swf());
    const run = await s.code.link(bytes, child, "https://child.test/movie.swf", readLibrary(bytes));
    assert.equal(bodies.length, 0, "linking must not build unused factories");
    run();
    const cls = s.rt.classNamed("DeferredRoot", child);
    const before = bodies.length;
    const other = s.rt.childDomain(s.mainDomain);
    // Build while another domain is loading: the entry's cls table must still bind in child.
    const later = s.rt.loadInto(other, () => s.rt.callProperty(cls, s.rt.publicName("later")));
    assert.equal(bodies.length, before + (lazy ? 1 : 0));
    const compiled = bodies.length;
    for (let i = 0; i < 2; i++) {
      const result = s.rt.call(later, null);
      assert.equal(s.rt.getProperty(result, s.rt.publicName("value")), 10);
      assert.equal(s.rt.getProperty(result, s.rt.publicName("definition")), cls);
      const domain = s.rt.getProperty(result, s.rt.publicName("domain"));
      assert.equal((domain as { $domain?: unknown }).$domain, child);
      const item = s.rt.getProperty(result, s.rt.publicName("item"));
      assert.equal(s.rt.typeOf(item), "object");
    }

    s.rt.callProperty(cls, s.rt.publicName("later"));
    assert.equal(bodies.length, compiled, "a factory is compiled once even for new closures");
    assert.deepEqual(lines, ["root ☃", "root ☃"]);
    assert.deepEqual(callers, [["https://child.test/movie.swf"], ["https://child.test/movie.swf"]]);
    assert.equal(new Set(bodies).size, bodies.length);
  }
});

test("lazy cache misses keep partial modules out of the whole-module cache", { skip }, async () => {
  const stored: CachedModule[] = [];
  const cache: ModuleCache = {
    minBytes: 0,
    get: async () => undefined,
    put: async (_key, entry) => {
      stored.push(entry);
    },
    delete: async () => {},
  };
  const { s, bodies } = await setup(true, cache);
  for (let i = 0; i < 100 && stored.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(stored.length, 2);
  const before = stored.length;
  const player = new Player(swf(), s);
  await player.start();
  for (let i = 0; i < 20; i++) {
    player.tick();
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(bodies.length > 0);
  assert.equal(stored.length, before);
  assert.ok(stored.every((entry) => !entry.module.includes("function (rt, jit)")));
});

test("lazy mode consumes cached whole modules without compiling method entries", {
  skip,
}, async () => {
  const stored = new Map<string, CachedModule>();
  const cache: ModuleCache = {
    minBytes: 0,
    get: async (key) => stored.get(key),
    put: async (key, entry) => {
      stored.set(key, entry);
    },
    delete: async (key) => {
      stored.delete(key);
    },
  };
  const eager = await setup(false, cache);
  await new Player(swf(), eager.s).start();
  for (let i = 0; i < 100 && stored.size < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(stored.size, 3);
  const lazy = await setup(true, cache);
  await new Player(swf(), lazy.s).start();
  assert.deepEqual(lazy.lines, eager.lines);
  assert.equal(lazy.bodies.length, 0);
});

test("a deferred factory rejects a compiler reset instead of compiling another movie's body", {
  skip,
}, async () => {
  const { s, codegen } = await setup(true);
  const player = new Player(swf(), s);
  await player.start();
  const cls = s.rt.classNamed("DeferredRoot", s.mainDomain);
  codegen.reset();
  assert.throws(() => s.rt.callProperty(cls, s.rt.publicName("later")), /compiler was reset/);
});
