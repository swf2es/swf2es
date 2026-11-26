// Compile time of a reference build of the compiler (a git ref, the tag
// zig-last-parity by default; tests/parity/reference.ts builds it) against
// this tree's, the release builds, interleaved, each module written a part
// at a time as the host writes it:
//
//   - libraries: builtin's and playerglobal's modules;
//   - conformance: each case's ABC (tests/golden/abcs/) in a child domain of
//     avmshell's libraries, dropped after;
//   - avm1: the determinism checks' AVM1 blocks, each SWF's module;
//   - local: SWF2ES_LOCAL_SWFS's SWFs, space-separated paths, reported by
//     number only: an AS3 SWF's ABCs in a child domain of the player's
//     libraries, dropped after, or an AVM1 SWF's module;
//   - rebuild: the libraries and every conformance case live and compiled,
//     saved, then loaded and rebuilt (each verified again) in a fresh
//     instance, as a compaction moves it.
//
// Prints each group's median and quartiles for both, and the candidate's
// ratio to the reference; a group whose output differs in size says so.
// Run under the machine lock, the machine otherwise idle.
//
//   node tests/bench/codegen-compile.ts [--reference <ref>] [--runs N]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellToplevelLibrary } from "../../packages/cli/dist/shell-toplevel-library.js";
import { API_VERSION } from "../../packages/codegen/dist/index.js";
import { type CodegenExports, instantiate } from "../../packages/codegen/dist/zig.js";
import { isAs3, readActions, readDoAbc, readSwf } from "../../packages/format/dist/index.js";
import {
  builtinLibrary,
  playerglobalLibrary,
} from "../../packages/player/dist/playerglobal/libraries.js";
import { type Avm1Swf, avm1Swfs } from "../conformance/determinism-avm1.ts";
import { referenceBuild } from "../parity/reference.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const ref = option("--reference", "zig-last-parity");
const runs = Number(option("--runs", "7"));

const reference = referenceBuild(ref);
const builds: Record<string, WebAssembly.Module> = {
  reference: await WebAssembly.compile(readFileSync(join(reference.dir, "codegen.wasm"))),
  candidate: await WebAssembly.compile(
    readFileSync(join(root, "packages/codegen/dist/codegen.wasm")),
  ),
};

type Compiler = CodegenExports & { panicked(): string | null };

const abcsOf = (file: string): Uint8Array[] => {
  const swf = readSwf(new Uint8Array(readFileSync(file)));
  return swf.tags
    .filter((t) => t.code === 72 || t.code === 82)
    .map((t) => readDoAbc(swf.bytes, t).abc);
};
const conformanceDir = join(root, "tests/golden/abcs/conformance");
const conformance = readdirSync(conformanceDir)
  .filter((f) => f.endsWith(".abc"))
  .sort()
  .map((f) => [new Uint8Array(readFileSync(join(conformanceDir, f)))]);
const avm1 = avm1Swfs(false);
/** A local SWF: its ABCs, or its AVM1 action blocks. */
const local = (process.env.SWF2ES_LOCAL_SWFS ?? "")
  .split(" ")
  .filter(Boolean)
  .map((file, i): Uint8Array[] | Avm1Swf => {
    const swf = readSwf(new Uint8Array(readFileSync(file)));
    if (isAs3(swf)) {
      return abcsOf(file);
    }

    const { version, blocks } = readActions(swf);
    return {
      name: `local ${i}`,
      bytes: swf.bytes,
      version,
      offsets: Int32Array.from(blocks, (b) => b.offset),
      lengths: Int32Array.from(blocks, (b) => b.length),
    };
  });

/** AVM1 SWFs' modules, each kept: ms and bytes. */
async function actions(build: string, swfs: Avm1Swf[]) {
  const c = await instantiate(builds[build]);
  let ms = 0;
  let bytes = 0;
  for (const swf of swfs) {
    const t = performance.now();
    c.actionsModuleBytes(swf.bytes, swf.offsets, swf.lengths, swf.version, false);
    ms += performance.now() - t;
    bytes += c.outputLength();
  }

  return { ms, bytes };
}

const PLAYER = [builtinLibrary, playerglobalLibrary];
const SHELL = [builtinLibrary, shellToplevelLibrary];

/** A fresh instance with `libraries` added, each a builtin of the root. */
async function domain(build: string, libraries: Uint8Array[]): Promise<Compiler> {
  const c = await instantiate(builds[build]);
  c.domainReset(API_VERSION);
  for (const abc of libraries) {
    if (c.domainAdd(abc, true, 0) !== 0) {
      throw new Error("a library did not link");
    }
  }

  return c;
}

/** ABC `index`'s module, a part at a time: the bytes it wrote. */
function compileOne(c: Compiler, index: number): number {
  c.domainModuleBytes("", index, false, false);
  let bytes = c.outputLength();
  while (!c.domainModuleDone()) {
    c.domainModuleMoreBytes();
    bytes += c.outputLength();
  }

  return bytes;
}

/** Each group of ABCs in a child domain of `libraries`, compiled, dropped after: ms and bytes. */
async function groups(build: string, libraries: Uint8Array[], sets: Uint8Array[][]) {
  const c = await domain(build, libraries);
  let added = libraries.length;
  let ms = 0;
  let bytes = 0;
  for (const abcs of sets) {
    const child = c.domainChild(0);
    const indices: number[] = [];
    for (const abc of abcs) {
      if (c.domainAdd(abc, false, child) === 0) {
        indices.push(added++);
      }
    }

    const t = performance.now();
    for (const i of indices) {
      bytes += compileOne(c, i);
    }

    ms += performance.now() - t;
    c.domainDrop(child);
  }

  return { ms, bytes };
}

/** The libraries and every conformance case live, saved, loaded and rebuilt in a fresh instance. */
async function rebuild(build: string) {
  const c = await domain(build, PLAYER);
  let added = PLAYER.length;
  for (const [abc] of conformance) {
    added += c.domainAdd(abc, false, c.domainChild(0)) === 0 ? 1 : 0;
  }

  // Compiled, so that the rebuild verifies each again.
  for (let i = 0; i < added; i++) {
    compileOne(c, i);
  }

  const view = (address: number) =>
    new Uint8Array(c.memory.buffer, address >>> 0, c.outputLength()).slice();
  const state = view(c.domainSaveBytes());
  const abcs: [number, Uint8Array][] = [];
  for (let i = 0; i < added; i++) {
    const at = c.domainSavedAbcBytes(i);
    if (at) {
      abcs.push([i, view(at)]);
    }
  }

  const into = await instantiate(builds[build]);
  const t = performance.now();
  if (!into.domainLoad(state)) {
    throw new Error("the saved domain did not load");
  }

  for (const [i, abc] of abcs) {
    into.domainLoadAbc(i, abc);
  }

  let step = into.domainLoadRebuild() ? into.domainRebuildStep() : -1;
  while (step === 0) {
    step = into.domainRebuildStep();
  }

  if (step !== 1) {
    throw new Error("the rebuild failed");
  }

  return { ms: performance.now() - t, bytes: into.memory.buffer.byteLength };
}

const GROUPS: [string, (build: string) => Promise<{ ms: number; bytes: number }>][] = [
  [
    "libraries",
    async (build) => {
      const c = await domain(build, PLAYER);
      const t = performance.now();
      const bytes = compileOne(c, 0) + compileOne(c, 1);
      return { ms: performance.now() - t, bytes };
    },
  ],
  ["conformance", (build) => groups(build, SHELL, conformance)],
  ["avm1", (build) => actions(build, avm1)],
  ...local.map((swf, i): [string, (build: string) => Promise<{ ms: number; bytes: number }>] => [
    `local ${i}`,
    (build) => (Array.isArray(swf) ? groups(build, PLAYER, [swf]) : actions(build, [swf])),
  ]),
  ["rebuild", rebuild],
];

const times = new Map<string, number[]>();
const sizes = new Map<string, number>();
const order = Object.keys(builds);
for (let run = 0; run < runs; run++) {
  for (const [name, measure] of GROUPS) {
    // Interleaved, each run starting with the other build.
    for (const build of run % 2 ? [...order].reverse() : order) {
      const { ms, bytes } = await measure(build);
      const key = `${build} ${name}`;
      times.set(key, [...(times.get(key) ?? []), ms]);
      sizes.set(key, bytes);
    }
  }
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { median: q(0.5), q1: q(0.25), q3: q(0.75) };
};
console.log(`${ref} (${reference.commit.slice(0, 9)}) against this tree, ${runs} runs`);
for (const [name] of GROUPS) {
  const a = stat(times.get(`reference ${name}`) ?? []);
  const b = stat(times.get(`candidate ${name}`) ?? []);
  const same =
    name === "rebuild" || sizes.get(`reference ${name}`) === sizes.get(`candidate ${name}`);
  console.log(
    `${name.padEnd(12)} reference ${a.median.toFixed(1)} ms (${a.q1.toFixed(1)}-${a.q3.toFixed(1)}), ` +
      `candidate ${b.median.toFixed(1)} ms (${b.q1.toFixed(1)}-${b.q3.toFixed(1)}), ` +
      `${(b.median / a.median).toFixed(3)}${same ? "" : ", OUTPUT DIFFERS IN SIZE"}`,
  );
}

const size = (file: string) => readFileSync(file).length;
console.log(
  `codegen.wasm: reference ${size(join(reference.dir, "codegen.wasm"))} bytes, ` +
    `candidate ${size(join(root, "packages/codegen/dist/codegen.wasm"))} bytes`,
);
