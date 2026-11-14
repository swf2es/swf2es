// The background compiler (scripting/compiler.ts): the ABCs of the SWFs a
// player loads compile on a thread of their own to the very modules the
// page's thread compiles, in whatever domains they load, the page's
// compiler then as if it had compiled them, and the thread's as large; a
// thread that does not start or fails leaves them to the page's thread;
// and lazy compilation never uses one. The thread runs in this one, on a
// MessageChannel, as a Web Worker would run it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { type Codegen, createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { CompilerHost } from "../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { BackgroundCompiler } from "../../../../packages/player/dist/scripting/compiler.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import {
  type CompilerOp,
  type FromCompiler,
  runCompilerThread,
} from "../../../../packages/player/dist/workers/compiler.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compileScripts } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/player-compiler/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/**
 * LoadA defines LoadA, whose twice doubles; LoadB defines a LoadA of its
 * own, whose twice triples, and calls it: in a domain that sees A's, B's
 * code binds to A's, which its module then links.
 */
const sources = {
  CompilerHostMain: `package {
  import flash.display.Sprite;
  public class CompilerHostMain extends Sprite {}
}`,
  LoadA: `package {
  import flash.display.Sprite;
  public class LoadA extends Sprite {
    public function LoadA() { trace("A " + twice(4)); }
    public static function twice(x:int):int { return x * 2; }
  }
}`,
  LoadB: `package {
  public class LoadA {
    public static function twice(x:int):int { return x * 3; }
  }
}
package {
  import flash.display.Sprite;
  public class LoadB extends Sprite {
    public function LoadB() { trace("B " + LoadA.twice(5)); }
  }
}`,
};

let abcs: Map<string, Uint8Array> | null = null;
function scripts(): Map<string, Uint8Array> {
  abcs ??= compileScripts(
    Object.entries(sources).map(([name, source]) => ({ name, source })),
    out,
  );
  return abcs;
}

/** The thread's side on a MessageChannel, as a Web Worker runs it: the modules it compiled for the page, and what it was posted. */
interface TestHost extends CompilerHost {
  compiled: string[];
  batches: CompilerOp[][];
  started: number;
}

function threadHost(
  options: { verify?: boolean; refuse?: boolean; failAtCompile?: boolean } = {},
): TestHost {
  const host: TestHost = {
    verify: options.verify,
    compiled: [],
    batches: [],
    started: 0,
    start(receive, failed) {
      host.started++;
      if (options.refuse) {
        throw new Error("no workers here");
      }

      const { port1, port2 } = new MessageChannel();
      runCompilerThread({
        post: (message) => port2.postMessage(message),
        listen: (take) => {
          port2.on("message", take);
        },
      });
      port1.on("message", (message: FromCompiler) => {
        if (message.type === "compiled") {
          host.compiled.push(message.module);
        }

        receive(message);
      });
      port1.postMessage({ codegen: wasm });
      // Listening refs a port: a test that fails before its player goes does not hang.
      port1.unref();
      port2.unref();
      let failing = false;
      return {
        post: (batch, transfer) => {
          host.batches.push(batch);
          if (options.failAtCompile && batch.some((op) => op.op === "compile" && op.id !== null)) {
            failing = true;
            queueMicrotask(() => failed(new Error("the thread went")));
          }

          if (!failing) {
            port1.postMessage(batch, transfer);
          }
        },
        terminate: () => {
          port1.close();
        },
      };
    },
  };
  return host;
}

/** Resolves once `background`'s thread has said it started. */
async function started(background: BackgroundCompiler): Promise<void> {
  while (!(background as unknown as { started: boolean }).started) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** `codegen`, keeping the modules compiled on the page's thread. */
function counted(codegen: Codegen): { codegen: Codegen; modules: string[] } {
  const modules: string[] = [];
  const spy = Object.create(codegen) as Codegen;
  Object.assign(spy, {
    compileModule: (...args: Parameters<Codegen["compileModule"]>) => {
      const module = codegen.compileModule(...args);
      modules.push(module);
      return module;
    },
    compileModuleLogged: (...args: Parameters<Codegen["compileModuleLogged"]>) => {
      const compiled = codegen.compileModuleLogged(...args);
      modules.push(compiled.module);
      return compiled;
    },
  });
  return { codegen: spy, modules };
}

/**
 * The main SWF, then A and B loaded one at a time into domains that see
 * one another's or not, A's domain evicted after it links and revived as
 * B loads into it: what they traced, the modules compiled here (the main
 * SWF's ones `before` loads), and the scripting.
 */
async function play(
  host: CompilerHost | null,
  lazyCompilation = false,
): Promise<{ lines: string[]; modules: string[]; before: number; scripting: Scripting }> {
  const lines: string[] = [];
  const { codegen, modules } = counted(await createCodegen(wasm));
  const scripting = new Scripting(codegen, {
    print: (line) => lines.push(line),
    realTime: null,
    compileHost: host,
    lazyCompilation,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = scripts();
  const player = new Player(
    bare(abc.get("CompilerHostMain") as Uint8Array, 1, "CompilerHostMain"),
    scripting,
  );
  await player.start();
  const before = modules.length;

  const rt = scripting.rt;
  const main = scripting.mainDomain;
  const d1 = rt.childDomain(main);
  const loads: [string, ReturnType<typeof rt.childDomain>][] = [
    ["LoadA", d1],
    ["LoadB", d1],
    ["LoadB", rt.childDomain(d1)],
    ["LoadB", rt.childDomain(main)],
    ["LoadA", main],
    ["LoadB", rt.childDomain(main)],
  ];
  for (const [name, domain] of loads) {
    const loader = rt.construct(rt.classNamed("flash.display::Loader"));
    player.root.addChildAt(loader.$display, 0);
    scripting.loads.requestLoad(loader, bare(abc.get(name) as Uint8Array, 1, name), domain);
    await scripting.settled();
    player.tick();
    // The first load starts the thread: the rest go to it once it has.
    const background = scripting.code.background;
    if (background?.available) {
      await started(background);
    }
  }

  // Compactions asked for, done.
  await new Promise((resolve) => setTimeout(resolve, 10));
  player.destroy();
  return { lines, modules, before, scripting };
}

test("a loaded SWF's modules compile on the thread to what the page's thread compiles", {
  skip,
}, async () => {
  const here = await play(null);
  assert.deepEqual(here.lines, ["A 8", "B 10", "B 10", "B 15", "A 8", "B 10"]);
  // B's module where it sees A's LoadA links A's ABC: what is loaded before counts.
  const loaded = here.modules.slice(here.before);
  assert.notEqual(loaded[1], loaded[3]);

  const host = threadHost();
  const away = await play(host);
  assert.deepEqual(away.lines, here.lines);
  // The libraries and the main SWF compiled here, as without the thread,
  // and the first load, which starts it, and any while it starts.
  assert.equal(away.before, here.before);
  assert.equal(host.started, 1);
  const there = host.compiled.length;
  assert.equal(there, 5);
  assert.deepEqual(away.modules, here.modules.slice(0, here.modules.length - there));
  // The rest compiled there, byte for byte.
  assert.deepEqual(host.compiled, here.modules.slice(here.modules.length - there));
});

test("evictions, revivals and compactions are the thread's too", { skip }, async () => {
  const host = threadHost();
  const { scripting } = await play(host);
  // Stopped with the player.
  assert.equal((scripting.code.background as BackgroundCompiler).available, false);
  const ops = host.batches.flat().map((op) => op.op);
  for (const op of ["evict", "revive", "compact", "child", "add"] as const) {
    assert.ok(ops.includes(op), `no ${op}`);
  }
});

test("a thread's memory follows the page's compiler's", { skip }, async () => {
  const host = threadHost();
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    compileHost: host,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = scripts();
  const player = new Player(
    bare(abc.get("CompilerHostMain") as Uint8Array, 1, "CompilerHostMain"),
    scripting,
  );
  await player.start();
  const rt = scripting.rt;
  for (let k = 0; k < 8; k++) {
    const loader = rt.construct(rt.classNamed("flash.display::Loader"));
    scripting.loads.requestLoad(
      loader,
      bare(abc.get("LoadB") as Uint8Array, 1, "LoadB"),
      rt.childDomain(scripting.mainDomain),
    );
    await scripting.settled();
    player.tick();
    await started(scripting.code.background as BackgroundCompiler);
  }

  await new Promise((resolve) => setTimeout(resolve, 10));
  const background = scripting.code.background as BackgroundCompiler;
  const page = scripting.codegen.usage();
  const thread = await background.usage();
  assert.ok(thread);
  assert.equal(thread.live, page.live);
  assert.equal(thread.dead, page.dead);
  assert.equal(host.compiled.length, 7);
  player.destroy();
});

test("a module the thread compiles is compared with one compiled here, where asked", {
  skip,
}, async () => {
  const here = await play(null);
  const host = threadHost({ verify: true });
  const away = await play(host);
  assert.deepEqual(away.lines, here.lines);
  assert.equal(host.compiled.length, 5);
  // Compiled here too, to compare.
  assert.deepEqual(away.modules, here.modules);
});

test("without a thread, or once it fails, loaded SWFs compile here alike", { skip }, async () => {
  const here = await play(null);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    const refused = await play(threadHost({ refuse: true }));
    assert.deepEqual(refused.lines, here.lines);
    assert.deepEqual(refused.modules, here.modules);
    assert.equal((refused.scripting.code.background as BackgroundCompiler).available, false);

    const failing = threadHost({ failAtCompile: true });
    const failed = await play(failing);
    assert.deepEqual(failed.lines, here.lines);
    assert.deepEqual(failed.modules, here.modules);
    assert.deepEqual(failing.compiled, []);
  } finally {
    console.warn = warn;
  }

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /compile on the page's thread/);
});

test("lazy compilation uses no thread", { skip }, async () => {
  const host = threadHost();
  const lazy = await play(host, true);
  assert.equal(host.started, 0);
  assert.equal(lazy.scripting.code.background, null);
  assert.deepEqual(lazy.lines, ["A 8", "B 10", "B 10", "B 15", "A 8", "B 10"]);
});

test("calls made while a compile is out wait for it, or have it done here first", {
  skip,
}, async () => {
  const abc = scripts();
  const libraries = libraryAbcs(`${out}libraries/`);
  const a = abc.get("LoadA") as Uint8Array;
  const b = abc.get("LoadB") as Uint8Array;

  // The reference: every call on one compiler, in order.
  const reference = await createCodegen(wasm);
  const hashes = ["lib0", "lib1", "a", "b", "b2"];
  reference.reset();
  for (const library of libraries) {
    reference.add(library, true, 0);
  }

  reference.compileModule(hashes, 0);
  const refLibrary = reference.compileModuleLogged(hashes, 1).module;
  const r1 = reference.childDomain(0);
  reference.add(a, false, r1);
  const refA = reference.compileModuleLogged(hashes, 2).module;
  reference.evictDomain(r1);
  reference.compact();
  const r2 = reference.childDomain(0);
  reference.add(b, false, r2);
  const refB = reference.compileModuleLogged(hashes, 3).module;
  const r3 = reference.childDomain(r2);
  reference.add(b, false, r3);
  const refB2 = reference.compileModuleLogged(hashes, 4).module;

  const host = threadHost();
  const background = new BackgroundCompiler(await createCodegen(wasm), host);
  const c = background.codegen;
  c.reset();
  for (const library of libraries) {
    c.add(library, true, 0);
  }

  c.compileModule(hashes, 0);
  // The first compile asked for starts the thread and is made here.
  assert.equal((await background.compile(hashes, 1)).module, refLibrary);
  await started(background);
  const d1 = c.childDomain(0);
  c.add(a, false, d1);
  const asked = background.compile(hashes, 2);
  // These wait for A's compile.
  c.evictDomain(d1);
  c.compact();
  // This cannot: A is compiled here first, the thread's answer let go.
  const d2 = c.childDomain(0);
  assert.equal((await asked).module, refA);
  c.add(b, false, d2);
  assert.equal((await background.compile(hashes, 3)).module, refB);
  const d3 = c.childDomain(d2);
  c.add(b, false, d3);
  assert.equal((await background.compile(hashes, 4)).module, refB2);
  assert.deepEqual([d1, d2, d3], [r1, r2, r3]);
  assert.deepEqual(c.context(4), reference.context(4));

  const thread = await background.usage();
  assert.ok(thread);
  assert.equal(thread.live, reference.usage().live);
  assert.equal(thread.dead, reference.usage().dead);
  assert.ok(background.available);
  background.stop();
});
