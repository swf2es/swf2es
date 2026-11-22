// Times module cache keys over a long session, as the player takes one for
// each ABC it loads (packages/player/src/scripting/code.ts): the player's
// libraries, then LOADS small ABCs (the conformance cases, compiled by ASC
// in the oracle's image), each keyed by codegen's moduleKey and compiled,
// either all into the main movie's application domain (shared), so that
// the compiler's log every key names keeps growing, or each into a child
// domain of its own (children). Prints, a window of loads at a time, the
// time a key took, its text's length and what taking it allocated, sampled
// by V8's heap profiler, collected objects included.
//
//   node tests/bench/module-keys.ts [--loads N] [--window N] [--codegen DIR] [--heap-profile FILE]
//     [shared] [children]
//
// --codegen names another build's codegen dist/, with its index.js and
// codegen.wasm, to compare two; --heap-profile writes each mode's last
// window's sampled allocations to FILE.<mode>.heapprofile, for DevTools.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { containerEngine, runOracle } from "../../oracle/oracle.ts";
import { libraryAbcs } from "../player/libraries.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(["--loads", "--window", "--codegen", "--heap-profile"]);
const modes = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const LOADS = Number(option("loads") ?? 1000);
const WINDOW = Number(option("window") ?? 200);
const heapProfile = option("heap-profile");
const dir = option("codegen") ?? `${here}../../packages/codegen/dist/`;
const codegenModule = await import(pathToFileURL(`${dir.replace(/\/$/, "")}/index.js`).href);
const { createCodegen, libraryLog, moduleKey } = codegenModule;

const engine = containerEngine();
const out = `${here}out/module-keys/`;
const cases = `${here}../conformance/cases/`;
const pool: Uint8Array[] = [];
for (const result of runOracle(
  readdirSync(cases)
    .filter((f) => f.endsWith(".as"))
    .sort()
    .map((f) => ({ source: `${cases}${f}`, ascArgs: ["-md"] })),
  out,
  { engine, run: false },
)) {
  if (result.compiled) {
    pool.push(new Uint8Array(readFileSync(`${out}${result.name}.abc`)));
  }
}

const roots = libraryAbcs();
const wasm = await WebAssembly.compile(readFileSync(`${dir.replace(/\/$/, "")}/codegen.wasm`));
const session = new Session();
session.connect();
await session.post("HeapProfiler.enable");

interface Window {
  loads: number;
  ms: number;
  chars: number;
  bytes: number;
}

/** The bytes allocated under frames named `name` in a sampled profile's tree. */
// biome-ignore lint/suspicious/noExplicitAny: the profile's nodes as the inspector gives them
function under(node: any, name: string, inside = false): number {
  const now = inside || node.callFrame.functionName === name;
  let total = now ? node.selfSize : 0;
  for (const child of node.children) {
    total += under(child, name, now);
  }

  return total;
}

async function run(mode: string): Promise<Window[]> {
  const codegen = await createCodegen(wasm);
  codegen.reset();
  const hashes: string[] = [];
  const builtins: boolean[] = [];
  const add = (abc: Uint8Array, builtin: boolean, domain: number) => {
    if (codegen.add(abc, builtin, domain) !== 0) {
      return -1;
    }

    hashes.push(`h${hashes.length}`);
    builtins.push(builtin);
    return hashes.length - 1;
  };
  for (const abc of roots) {
    const index = add(abc, true, 0);
    moduleKey(codegen, index, { hashes, builtins }, null);
    codegen.compileModuleLogged(hashes, index);
  }

  const main = codegen.childDomain(0);
  let libraries: { count: number; digest: string } | null = null;
  const windows: Window[] = [];
  let window: Window = { loads: 0, ms: 0, chars: 0, bytes: 0 };
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let load = 0; load < LOADS; load++) {
    const domain = mode === "shared" ? main : codegen.childDomain(main);
    const index = add(pool[load % pool.length], false, domain);
    if (index < 0) {
      continue;
    }

    libraries ??= {
      count: roots.length,
      digest: createHash("sha256")
        .update(libraryLog(codegen, index, roots.length), "utf8")
        .digest("hex"),
    };
    const started = performance.now();
    const key: string | null = moduleKey(codegen, index, { hashes, builtins }, libraries);
    window.ms += performance.now() - started;
    window.chars += key?.length ?? 0;
    window.loads++;
    codegen.compileModuleLogged(hashes, index);
    if (window.loads === WINDOW) {
      const { profile } = await session.post("HeapProfiler.stopSampling");
      window.bytes = under(profile.head, "moduleKey");
      if (heapProfile) {
        writeFileSync(`${heapProfile}.${mode}.heapprofile`, JSON.stringify(profile));
      }

      windows.push(window);
      window = { loads: 0, ms: 0, chars: 0, bytes: 0 };
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
  }

  await session.post("HeapProfiler.stopSampling");
  return windows;
}

for (const mode of modes.length ? modes : ["shared", "children"]) {
  const windows = await run(mode);
  console.log(`${mode}: ${pool.length} ABCs in turn, ${LOADS} loads`);
  console.log("  loads        key µs   key chars   key KB allocated");
  windows.forEach((w, k) => {
    const from = k * WINDOW;
    const range = `${from}–${from + w.loads}`.padEnd(12);
    const us = ((w.ms * 1000) / w.loads).toFixed(1).padStart(9);
    const chars = Math.round(w.chars / w.loads)
      .toString()
      .padStart(11);
    const kb = (w.bytes / w.loads / 1024).toFixed(2).padStart(12);
    console.log(`  ${range} ${us} ${chars} ${kb}`);
  });
}

session.disconnect();
