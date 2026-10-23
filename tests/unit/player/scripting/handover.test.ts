// The primordial's compiled modules handed to a background worker
// (scripting/handover.ts): a worker on the same ABCs loads them and
// compiles nothing, they are the modules it would have compiled, and its
// compiler is then as if it had; one on other ABCs takes the libraries'
// only. Played in one thread, the worker's VM given what a thread is.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Codegen, createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { WorkerHost } from "../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../packages/player/dist/player.js";
import {
  type HandedModules,
  namesWorkerDomain,
} from "../../../../packages/player/dist/scripting/handover.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/player-handover/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A document class that makes a worker of its own SWF where it can, and traces either way. */
function workerSwf(name: string, extra = ""): Uint8Array {
  const abc = compiler(out)(
    name,
    `package {
  import flash.display.Sprite;
  import flash.system.Worker;
  import flash.system.WorkerDomain;

  public class ${name} extends Sprite {
    public function ${name}() {
      trace("${name} " + Worker.isSupported + " " + f(3));
      if (Worker.isSupported) {
        WorkerDomain.current.createWorker(loaderInfo.bytes).start();
      }
    }

    private function f(x:int):int { return x * 7; }
    ${extra}
  }
}`,
  );
  return bare(abc, 1, name);
}

/** `codegen`, counting the modules it compiles and keeping their text. */
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
      const logged = codegen.compileModuleLogged(...args);
      modules.push(logged.module);
      return logged;
    },
    compileLazyModule: (...args: Parameters<Codegen["compileLazyModule"]>) => {
      const module = codegen.compileLazyModule(...args);
      modules.push(module);
      return module;
    },
  });
  return { codegen: spy, modules };
}

/** Plays `swf` for a frame: its traces, the modules it compiled, and what a worker it started was handed. */
async function play(
  swf: Uint8Array,
  options: { host?: boolean; handed?: HandedModules | null } = {},
): Promise<{
  lines: string[];
  compiled: string[];
  handed: HandedModules | null;
  scripting: Scripting;
}> {
  const lines: string[] = [];
  const { codegen, modules } = counted(await createCodegen(wasm));
  let handed: HandedModules | null = null;
  const host: WorkerHost = {
    start(init) {
      handed = init.modules;
      return { post() {}, terminate() {} };
    },
  };
  const scripting = new Scripting(codegen, {
    print: (line) => lines.push(line),
    realTime: null,
    workerHost: options.host ? host : null,
    handedModules: options.handed ?? null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, scripting).start();
  return { lines, compiled: modules, handed, scripting };
}

test("a worker on the primordial's SWF loads its modules and compiles none", { skip }, async () => {
  const swf = workerSwf("Handed");
  const primordial = await play(swf, { host: true });
  assert.deepEqual(primordial.lines, ["Handed true 21"]);
  const handed = primordial.handed as HandedModules | null;
  assert.ok(handed);
  // builtin, playerglobal and the SWF's one ABC.
  assert.equal(handed.modules.length, 3);

  const fresh = await play(swf);
  const worker = await play(swf, { handed });
  assert.deepEqual(worker.lines, ["Handed false 21"]);
  assert.deepEqual(worker.compiled, []);
  // The modules handed are those the worker would have compiled.
  const texts = await Promise.all(
    handed.modules.map(([, m]) => (m.module instanceof Blob ? m.module.text() : m.module)),
  );
  assert.deepEqual(texts, fresh.compiled);

  // Its compiler, once used again, is as compiling them would have left it.
  const index = 2;
  assert.deepEqual(worker.scripting.codegen.context(index), fresh.scripting.codegen.context(index));
  assert.equal(
    worker.scripting.codegen.compileModule([], index),
    fresh.scripting.codegen.compileModule([], index),
  );

  primordial.scripting.destroy();
  fresh.scripting.destroy();
  worker.scripting.destroy();
});

test("a worker on other ABCs takes the libraries' modules only", { skip }, async () => {
  const primordial = await play(workerSwf("HandedA"), { host: true });
  const handed = primordial.handed as HandedModules | null;
  assert.ok(handed);

  const other = workerSwf("HandedB", "public function g():int { return 1; }");
  const fresh = await play(other);
  const worker = await play(other, { handed });
  assert.deepEqual(worker.lines, ["HandedB false 21"]);
  assert.deepEqual(worker.compiled, fresh.compiled.slice(2));

  primordial.scripting.destroy();
  fresh.scripting.destroy();
  worker.scripting.destroy();
});

test("a SWF that names no WorkerDomain keeps no modules to hand", { skip }, async () => {
  const abc = compiler(out)(
    "NoWorkers",
    `package { import flash.display.Sprite; public class NoWorkers extends Sprite {
  public function NoWorkers() { trace("none"); }
} }`,
  );
  const played = await play(bare(abc, 1, "NoWorkers"), { host: true });
  assert.deepEqual(played.lines, ["none"]);
  assert.equal(played.scripting.code.handedModules(), null);
  played.scripting.destroy();
});

test("namesWorkerDomain finds the name anywhere in an ABC's bytes", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(namesWorkerDomain([bytes("xxWorkerDomainyy")]), true);
  assert.equal(namesWorkerDomain([bytes("WorkerDomai"), bytes("n")]), false);
  assert.equal(namesWorkerDomain([bytes("WWorkerDomain")]), true);
  assert.equal(namesWorkerDomain([]), false);
});
