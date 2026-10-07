// Fuzzes codegen with malformed ABCs. The JIT compiles whatever a SWF
// holds, so for any bytes the compiler must reject them with a VerifyError
// or compile them, never trap: a trap kills the wasm instance. Each case is
// a seed ABC with a few mutations, added to a domain after the builtins
// avmshell loads; then
//
//   - the compiler did not trap;
//   - a module it accepted imports as an ES module;
//   - each method compiled alone, as the JIT compiles it, is byte for byte
//     its entry in the module (docs/architecture.md's JIT/AOT invariant);
//   - linked again by a rebuild, as when the compiler lets go of another
//     domain, its module is the same, as is that of a copy of it in a
//     domain evicted and revived given its bytes again.
//
// The seeds are the unit tests' hand-built ABCs and the conformance cases,
// compiled into this package's own out/. A case that fails is written to
// out/failures/ as an .abc to run again. The mutations come from a seeded
// generator, so a run repeats exactly:
//
//   node tests/fuzz/abc.ts [cases, 2000] [seed, 1]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containerEngine, libraries, runOracle } from "../../oracle/oracle.ts";
import type { Case } from "../unit/codegen/oracle-case.ts";
import { loadTesting } from "../unit/codegen/testing-module.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const caseCount = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 1);

let engine: string;
try {
  engine = containerEngine();
} catch (e) {
  console.log(`fuzz: skipped (${(e as Error).message})`);
  process.exit(0);
}

const builtins = libraries(["builtin", "shell_toplevel"], `${out}lib`, { engine }).map(
  (l) => l.abc,
);

// Seeds: what the unit tests build by hand, each an edge of the format or the
// verifier, and the conformance cases, ordinary compiled code.
const seeds: Uint8Array[] = [];
for (const [module, names] of [
  ["../unit/codegen/verify-cases.ts", ["verifyCases"]],
  ["../unit/codegen/link-cases.ts", ["linkCases", "resolveCases"]],
  ["../unit/codegen/typed-cases.ts", ["typedCases"]],
] as const) {
  const exports = await import(module);
  for (const name of names) {
    for (const c of exports[name] as Case[]) {
      seeds.push(c.abc);
    }
  }
}

const cases = `${here}../conformance/cases/`;
const compiled = runOracle(
  readdirSync(cases)
    .filter((f) => f.endsWith(".as"))
    .map((f) => ({ source: `${cases}${f}`, ascArgs: ["-md"] })),
  out,
  { engine },
);
for (const result of compiled) {
  if (result.compiled) {
    seeds.push(new Uint8Array(readFileSync(`${out}${result.name}.abc`)));
  }
}

/** mulberry32: a small generator whose sequence the seed fixes. */
function generator(start: number): () => number {
  let s = start >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = generator(seed);
const below = (n: number) => Math.floor(random() * n);

// Values at the edges of what the format's fields hold: u8 and u30 bounds,
// and bytes that start a longer u30.
const EDGES = [0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe, 0x3f, 0x40];

/**
 * A few mutations of `abc`: bytes flipped, set to edge values, inserted,
 * deleted or copied from elsewhere. Most land in the file's last part,
 * where method bodies are, so the verifier sees code it must reject.
 */
function mutate(abc: Uint8Array): Uint8Array {
  let bytes = [...abc];
  const count = 1 + below(4);
  for (let m = 0; m < count; m++) {
    const n = bytes.length;
    if (n === 0) {
      break;
    }

    const at = random() < 0.7 ? Math.floor(n * 0.6) + below(Math.ceil(n * 0.4)) : below(n);
    switch (below(6)) {
      case 0:
        bytes[at] ^= 1 << below(8);
        break;
      case 1:
        bytes[at] = EDGES[below(EDGES.length)];
        break;
      case 2:
        bytes.splice(at, 0, below(256));
        break;
      case 3:
        bytes.splice(at, 1 + below(4));
        break;
      case 4: {
        const from = below(n);
        const length = 1 + below(16);
        bytes.splice(at, 0, ...bytes.slice(from, from + length));
        break;
      }
      default:
        bytes[at] = below(256);
        break;
    }
  }

  if (bytes.length > 1 << 20) {
    bytes = bytes.slice(0, 1 << 20);
  }

  return new Uint8Array(bytes);
}

/** Entries as domainModuleEntries and domainEmitEach write them: body, U+0001, entry, U+0002. */
function parseEntries(text: string): Map<number, string> {
  const entries = new Map<number, string>();
  for (const item of text.split("\u0002")) {
    const at = item.indexOf("\u0001");
    if (at > 0) {
      entries.set(Number(item.slice(0, at)), item.slice(at + 1));
    }
  }

  return entries;
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const builtinHashes = builtins.map(sha);
// pnpm test:checked's build checks every array access: a read past a
// table's end, which the release build does not catch, traps there.
const build = process.env.SWF2ES_CHECKED ? "dist-test-checked" : "dist-test";
let testing = await loadTesting(build);
const failures: string[] = [];
let accepted = 0;
let slowest = { ms: 0, at: -1 };

function fail(abc: Uint8Array, why: string): void {
  mkdirSync(`${out}failures`, { recursive: true });
  const name = `${out}failures/${sha(abc).slice(0, 16)}.abc`;
  writeFileSync(name, abc);
  failures.push(`${why}: ${name}`);
}

const started = Date.now();
for (let k = 0; k < caseCount; k++) {
  const abc = mutate(seeds[below(seeds.length)]);
  const t0 = performance.now();
  try {
    testing.domainReset(50);
    for (const b of builtins) {
      testing.domainAdd(b, true);
    }

    if (testing.domainAdd(abc, false) !== 0) {
      continue;
    }

    accepted++;
    const module: string = testing.domainModule([...builtinHashes, sha(abc)].join("\n"));
    // Imported as the player imports it: an ES module, strict, where
    // await is reserved; its body only defines the function it exports.
    try {
      await import(`data:text/javascript;base64,${Buffer.from(module).toString("base64")}`);
    } catch (e) {
      fail(abc, `a module that does not parse (${(e as Error).message})`);
      continue;
    }

    const want = parseEntries(testing.domainModuleEntries());
    const got = parseEntries(testing.domainEmitEach([...want.keys()].join(","), false));
    for (const [body, entry] of want) {
      if (got.get(body) !== entry) {
        fail(abc, `method body ${body} compiled alone differs from its entry`);
        break;
      }
    }

    const child = testing.domainChild(0);
    if (testing.domainAdd(abc, false, child) !== 0) {
      continue;
    }

    const index = builtins.length;
    const hashes = [...builtinHashes, sha(abc), sha(abc)].join("\n");
    const copy: string = testing.domainModule(hashes, index + 1, false);
    testing.domainEvict(child);
    if (!testing.domainRebuild()) {
      fail(abc, "a rebuild did not link it again");
      continue;
    }

    if (testing.domainModule(hashes, index, false) !== module) {
      fail(abc, "its module changed after a rebuild");
    } else if (
      testing.domainRestore(index + 1, abc) !== 0 ||
      testing.domainRevive(child) !== 1 ||
      testing.domainModule(hashes, index + 1, false) !== copy
    ) {
      fail(abc, "a copy in a revived domain did not compile as it did");
    }
  } catch (e) {
    // A trap leaves the instance unusable: start a new one.
    fail(abc, `the compiler trapped (${(e as Error).message})`);
    testing = await loadTesting(build);
  } finally {
    const ms = performance.now() - t0;
    if (ms > slowest.ms) {
      slowest = { ms, at: k };
    }
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const summary = `${caseCount} cases from ${seeds.length} seeds (seed ${seed}), ${accepted} accepted, slowest ${slowest.ms.toFixed(0)} ms`;
if (failures.length) {
  console.log(failures.slice(0, 20).join("\n"));
  console.log(`fuzz: ${failures.length} failed of ${summary} (${seconds} s)`);
  process.exit(1);
}

console.log(`fuzz: ${summary}, all well (${seconds} s)`);
