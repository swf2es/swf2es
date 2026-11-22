// The parity harness (docs/zig-codegen.md, section 5): the compiler in
// AssemblyScript, the oracle until it is deleted, and the compiler in Zig
// fed the same calls, their results compared byte for byte; and Zig's
// poison build, which fills freed memory with 0xAA, against Zig's own,
// which differ only where output reads memory nothing wrote. A suite runs
// on the release builds, or on the test builds for the dumps each stage
// ports. Each names the exports it calls: one that calls an export Zig's
// does not have yet is reported as not ported, and skipped. A case that
// throws is recorded as its result, so one failure stops nothing.
//
// expected.json lists the suites that must be the same: one that differs,
// or is no longer ported, fails, and so does one the same but not listed. Each compiler's results go to out/, and
// where a case's large result (a module) differs, both, with the first
// line they differ at.
//
//   node tests/parity/run.ts [suite...]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIR_API_VERSION, API_VERSION } from "@swf2es/codegen";
import { airLibrary, builtinLibrary, playerglobalLibrary } from "@swf2es/player/libraries";
import { instantiate as instantiateAs } from "../../packages/codegen/dist/codegen.js";
import {
  type CodegenExports,
  instantiate as instantiateZig,
  SIGNATURES,
} from "../../packages/codegen/dist/zig.js";
import { bindTesting, zigTestingModule } from "../unit/codegen/zig-testing.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = fileURLToPath(new URL("out/", import.meta.url));
const expected: string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("expected.json", import.meta.url)), "utf8"),
);

/**
 * A suite's results: a line a case, large results by their digests. The
 * bytes of a large result are kept only for the cases named in `capture`,
 * which a second run asks for where the digests differ, so that a suite
 * of a corpus does not hold every module of three compilers.
 */
class Results {
  readonly lines: string[] = [];
  readonly blobs = new Map<string, Uint8Array>();

  readonly capture: ReadonlySet<string>;

  constructor(capture: ReadonlySet<string> = new Set()) {
    this.capture = capture;
  }

  /** Case `name`'s result, or what it threw. */
  case(name: string, run: () => string | number | boolean): void {
    try {
      this.lines.push(`${name}: ${run()}`);
    } catch (error) {
      const e = error as Error;
      this.lines.push(`${name}: threw ${e?.name}: ${e?.message}`);
    }
  }

  /** A large result, as its length and digest; its bytes too where they are asked for. */
  blob(name: string, bytes: Uint8Array): string {
    if (this.capture.has(name)) {
      this.blobs.set(name, bytes.slice());
    }

    return `${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}`;
  }
}

/** asc's glue for either build; the test build's exports beyond are reached by name. */
// biome-ignore lint/suspicious/noExplicitAny: the test builds' exports are untyped, as asc's bindings
type Compiler = CodegenExports & Record<string, any>;

interface Suite {
  name: string;
  /** The release builds, or the test builds with their dumps. */
  build: "release" | "testing";
  /** The exports it calls. */
  needs: string[];
  run(compiler: Compiler, results: Results): void;
}

/** The ABCs there are without the oracle: the libraries the player ships, and the tests' own. */
function abcs(): [string, Uint8Array][] {
  const found: [string, Uint8Array][] = [
    ["builtin", builtinLibrary],
    ["playerglobal", playerglobalLibrary],
    ["air", airLibrary],
  ];
  for (const dir of ["tests/player/fixtures", "tests/unit/codegen/fixtures"]) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".abc"))) {
      found.push([`${dir}/${file}`, new Uint8Array(readFileSync(join(root, dir, file)))]);
    }
  }

  return found;
}

/** Byte strings no ABC starts with: every length to five, and seeded random ones. */
function odd(): [string, Uint8Array][] {
  const found: [string, Uint8Array][] = [];
  for (let length = 0; length <= 5; length++) {
    found.push([`length ${length}`, Uint8Array.of(16, 0, 46, 0, 1).subarray(0, length)]);
  }

  let state = 1;
  for (let i = 0; i < 1000; i++) {
    const bytes = new Uint8Array(4);
    for (let k = 0; k < 4; k++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[k] = state & 0xff;
    }

    found.push([`random ${i}`, bytes]);
  }

  return found;
}

/** What a call handed out. */
const handed = (c: Compiler, address: number) =>
  new Uint8Array(c.memory.buffer, address >>> 0, c.outputLength());

/** The libraries added as the player adds them, each one's module, source map and entries. */
function libraries(c: Compiler, r: Results, version: number, list: [string, Uint8Array][]): void {
  r.case(`reset ${version}`, () => {
    c.domainReset(version);
    return "done";
  });
  for (const [name, abc] of list) {
    r.case(`add ${name} at ${version}`, () => c.domainAdd(abc, true, 0));
  }

  for (const [index, [name]] of list.entries()) {
    r.case(`module ${name} at ${version}`, () => {
      const parts = [handed(c, c.domainModuleBytes("", index, true, false))];
      while (!c.domainModuleDone()) {
        parts[parts.length - 1] = parts[parts.length - 1].slice();
        c.__collect();
        parts.push(handed(c, c.domainModuleMoreBytes()));
      }

      return r.blob(`module ${name} at ${version}`, Buffer.concat(parts));
    });
    r.case(`source map ${name} at ${version}`, () =>
      r.blob(`source map ${name} at ${version}`, Buffer.from(c.domainSourceMap())),
    );
    r.case(`entries ${name} at ${version}`, () =>
      r.blob(`entries ${name} at ${version}`, Buffer.from(c.domainModuleEntries())),
    );
    c.__collect();
  }
}

const SUITES: Suite[] = [
  {
    name: "version",
    build: "release",
    needs: ["compilerVersion"],
    run: (c, r) => r.case("compilerVersion", () => c.compilerVersion()),
  },
  {
    name: "abcVersion",
    build: "release",
    needs: ["abcVersion"],
    run: (c, r) => {
      for (const [name, bytes] of [...abcs(), ...odd()]) {
        r.case(name, () => c.abcVersion(bytes));
      }
    },
  },
  {
    name: "libraries",
    build: "release",
    needs: [
      "domainReset",
      "domainAdd",
      "domainModuleBytes",
      "domainModuleMoreBytes",
      "domainModuleDone",
      "domainSourceMap",
      "domainModuleEntries",
    ],
    run: (c, r) => {
      const fp: [string, Uint8Array][] = [
        ["builtin", builtinLibrary],
        ["playerglobal", playerglobalLibrary],
      ];
      libraries(c, r, API_VERSION, fp);
      libraries(c, r, AIR_API_VERSION, [...fp, ["air", airLibrary]]);
    },
  },
];

const compile = (path: string) => WebAssembly.compile(readFileSync(join(root, path)));
const modules = {
  as: await compile("packages/codegen/dist/codegen.wasm"),
  asTesting: await compile("packages/codegen/dist-test/testing.wasm"),
  zig: await compile("packages/codegen/dist/codegen-zig.wasm"),
  zigTesting: await zigTestingModule(false),
  poison: await zigTestingModule(true),
};
const { instantiate: instantiateAsTesting } = await import(
  new URL("../../packages/codegen/dist-test/testing.js", import.meta.url).href
);
const exported = (module: WebAssembly.Module) =>
  new Set(WebAssembly.Module.exports(module).map((e) => e.name));
const has = { release: exported(modules.zig), testing: exported(modules.zigTesting) };

/** Fresh instances of the three, as a host makes one, for each suite. */
async function instances(build: Suite["build"]): Promise<Record<string, Compiler>> {
  return build === "release"
    ? {
        as: await instantiateAs(modules.as, { env: {} }),
        zig: await instantiateZig(modules.zig),
        poison: await bindTesting(modules.poison),
      }
    : {
        as: await instantiateAsTesting(modules.asTesting, { env: {} }),
        zig: await bindTesting(modules.zigTesting),
        poison: await bindTesting(modules.poison),
      };
}

let failed = 0;
for (const [name, module] of Object.entries(modules)) {
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  if (name !== "as" && name !== "asTesting" && imports.join() !== "env.abort") {
    console.log(`${name} imports ${imports.join(", ")}, not env.abort alone`);
    failed++;
  }
}

const exports = Object.keys(SIGNATURES);
const ported = exports.filter((name) => has.release.has(name));
console.log(
  `parity: Zig's compiler has ${ported.length} of codegen.wasm's ${exports.length} exports`,
);

/** The first line two lists differ at, or -1. */
function differs(a: string[], b: string[]): number {
  const at = a.findIndex((line, i) => line !== b[i]);
  return at >= 0 ? at : a.length === b.length ? -1 : Math.min(a.length, b.length);
}

/**
 * Two compilers' large result of case `key`, run again with its bytes
 * kept: their first differing line, both written to out/ beside each other.
 */
async function showBlobs(suite: Suite, key: string, aName: string, bName: string): Promise<string> {
  const fresh = await instances(suite.build);
  const [a, b] = [new Results(new Set([key])), new Results(new Set([key]))];
  suite.run(fresh[aName], a);
  suite.run(fresh[bName], b);
  const [aBytes, bBytes] = [a.blobs.get(key), b.blobs.get(key)];
  if (!aBytes || !bBytes) {
    return "";
  }

  const dir = join(out, suite.name);
  mkdirSync(dir, { recursive: true });
  const file = key.replace(/[^\w.-]+/g, "-");
  writeFileSync(join(dir, `${file}.${aName}`), aBytes);
  writeFileSync(join(dir, `${file}.${bName}`), bBytes);
  const aLines = Buffer.from(aBytes).toString("latin1").split("\n");
  const bLines = Buffer.from(bBytes).toString("latin1").split("\n");
  const at = differs(aLines, bLines);
  return `\n    ${key}, line ${at + 1} (out/${suite.name}/${file}.*):\n      ${aName}: ${aLines[at]?.slice(0, 200)}\n      ${bName}: ${bLines[at]?.slice(0, 200)}`;
}

const wanted = process.argv.slice(2);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const report: Record<string, string> = {};
for (const suite of SUITES.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
  const missing = suite.needs.filter((name) => !has[suite.build].has(name));
  if (missing.length > 0) {
    report[suite.name] = `not ported: ${missing.join(", ")}`;
    console.log(`  ${suite.name}: not ported (${missing.join(", ")})`);
    if (expected.includes(suite.name)) {
      console.log(`  ${suite.name} is in expected.json, but not ported`);
      failed++;
    }

    continue;
  }

  const results: Record<string, Results> = {};
  for (const [compiler, instance] of Object.entries(await instances(suite.build))) {
    results[compiler] = new Results();
    suite.run(instance, results[compiler]);
    writeFileSync(join(out, `${suite.name}.${compiler}.txt`), results[compiler].lines.join("\n"));
  }

  const mismatches: string[] = [];
  for (const [a, b] of [
    ["as", "zig"],
    ["zig", "poison"],
  ] as const) {
    const [la, lb] = [results[a].lines, results[b].lines];
    const at = differs(la, lb);
    if (at >= 0) {
      const key = la[at]?.slice(0, la[at].indexOf(": "));
      mismatches.push(
        `${b} differs from ${a} at case ${at + 1} of ${la.length}:\n    ${a}: ${la[at]}\n    ${b}: ${lb[at]}` +
          (key ? await showBlobs(suite, key, a, b) : ""),
      );
    }
  }

  report[suite.name] = mismatches.length ? "differs" : `same, ${results.as.lines.length} cases`;
  console.log(
    `  ${suite.name}: ${mismatches.length ? mismatches.join("\n  ") : report[suite.name]}`,
  );
  if (mismatches.length && expected.includes(suite.name)) {
    failed++;
  } else if (!mismatches.length && !expected.includes(suite.name)) {
    // A ratchet: what is the same is held so.
    console.log(`  ${suite.name} is the same now: add it to tests/parity/expected.json`);
    failed++;
  }
}

writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failed > 0) {
  process.exitCode = 1;
}
