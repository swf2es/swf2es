// The parity harness (docs/zig-codegen.md, section 5): the compiler in
// AssemblyScript, the oracle until it is deleted, and the compiler in Zig
// fed the same calls, their results compared byte for byte; and Zig's test
// build that fills freed memory with 0xAA against Zig's compiler, which
// differ only where output reads memory nothing wrote. Each suite names the
// exports it calls: one that calls an export Zig's compiler does not have
// yet is reported as not ported, and skipped. Each compiler's results are
// written to out/, to compare by eye.
//
//   node tests/parity/run.ts [suite...]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

interface Suite {
  name: string;
  /** The exports it calls. */
  needs: (keyof typeof SIGNATURES)[];
  /** Its results, one a line, from one compiler. */
  run(compiler: CodegenExports): string[];
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

/** What a call handed out, by its length and digest: a module may be megabytes. */
function digest(c: CodegenExports, address: number): string {
  const bytes = new Uint8Array(c.memory.buffer, address, c.outputLength());
  return `${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The libraries added as the player adds them, each one's module, source map and entries. */
function libraries(c: CodegenExports, version: number, list: Uint8Array[]): string[] {
  const lines: string[] = [];
  c.domainReset(version);
  for (const abc of list) {
    lines.push(`add ${c.domainAdd(abc, true, 0)}`);
  }

  for (let index = 0; index < list.length; index++) {
    const parts = [digest(c, c.domainModuleBytes("", index, true, false))];
    while (!c.domainModuleDone()) {
      c.__collect();
      parts.push(digest(c, c.domainModuleMoreBytes()));
    }

    lines.push(`module ${index}: ${parts.join(", ")}`);
    lines.push(
      `source map ${index}: ${createHash("sha256").update(c.domainSourceMap()).digest("hex")}`,
    );
    lines.push(
      `entries ${index}: ${createHash("sha256").update(c.domainModuleEntries()).digest("hex")}`,
    );
    c.__collect();
  }

  return lines;
}

const SUITES: Suite[] = [
  {
    name: "version",
    needs: ["compilerVersion"],
    run: (c) => [c.compilerVersion()],
  },
  {
    name: "abcVersion",
    needs: ["abcVersion"],
    run: (c) => [...abcs(), ...odd()].map(([name, bytes]) => `${name}: ${c.abcVersion(bytes)}`),
  },
  {
    name: "libraries",
    needs: [
      "domainReset",
      "domainAdd",
      "domainModuleBytes",
      "domainModuleMoreBytes",
      "domainModuleDone",
      "domainSourceMap",
      "domainModuleEntries",
    ],
    run: (c) => [
      ...libraries(c, API_VERSION, [builtinLibrary, playerglobalLibrary]),
      ...libraries(c, AIR_API_VERSION, [builtinLibrary, playerglobalLibrary, airLibrary]),
    ],
  },
];

const compile = (path: string) => WebAssembly.compile(readFileSync(join(root, path)));
const asModule = await compile("packages/codegen/dist/codegen.wasm");
const zigModule = await compile("packages/codegen/dist/codegen-zig.wasm");
const poisonModule = await zigTestingModule(true);
const has = new Set(WebAssembly.Module.exports(zigModule).map((e) => e.name));

let failed = 0;
for (const [name, module] of [
  ["codegen-zig.wasm", zigModule],
  ["testing-zig-poison.wasm", poisonModule],
] as const) {
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  if (imports.join() !== "env.abort") {
    console.log(`${name} imports ${imports.join(", ")}, not env.abort alone`);
    failed++;
  }
}

const exports = Object.keys(SIGNATURES);
const ported = exports.filter((name) => has.has(name));
console.log(
  `parity: Zig's compiler has ${ported.length} of codegen.wasm's ${exports.length} exports`,
);

/** The first line two compilers' results differ at, or -1. */
function differs(a: string[], b: string[]): number {
  const at = a.findIndex((line, i) => line !== b[i]);
  return at >= 0 ? at : a.length === b.length ? -1 : Math.min(a.length, b.length);
}

const wanted = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const report: Record<string, string> = {};
for (const suite of SUITES.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
  const missing = suite.needs.filter((name) => !has.has(name));
  if (missing.length > 0) {
    report[suite.name] = `not ported: ${missing.join(", ")}`;
    console.log(`  ${suite.name}: not ported (${missing.join(", ")})`);
    continue;
  }

  // A fresh instance of each for each suite, as a host makes one.
  const results = {
    as: suite.run(await instantiateAs(asModule, { env: {} })),
    zig: suite.run(await instantiateZig(zigModule)),
    poison: suite.run(await bindTesting(poisonModule)),
  };
  for (const [compiler, lines] of Object.entries(results)) {
    writeFileSync(join(out, `${suite.name}.${compiler}.txt`), lines.join("\n"));
  }

  const mismatches: string[] = [];
  for (const [a, b] of [
    ["as", "zig"],
    ["zig", "poison"],
  ] as const) {
    const at = differs(results[a], results[b]);
    if (at >= 0) {
      mismatches.push(
        `${b} differs from ${a} at line ${at + 1} of ${results[a].length}:\n    ${a}: ${results[a][at]}\n    ${b}: ${results[b][at]}`,
      );
    }
  }

  report[suite.name] = mismatches.length ? "differs" : `same, ${results.as.length} results`;
  console.log(
    `  ${suite.name}: ${mismatches.length ? mismatches.join("\n  ") : report[suite.name]}`,
  );
  failed += mismatches.length;
}

writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failed > 0) {
  process.exitCode = 1;
}
