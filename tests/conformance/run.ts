// Conformance runner. For every case, avmshell's trace output is the expected
// result; the swf2es-compiled case run in node will be the actual result, and
// the two must match exactly. Each case will also be compiled in JIT mode and
// AOT mode, which must give identical output (see docs/architecture.md).
//
// Codegen is not implemented yet, so for now this checks that every case runs
// cleanly in avmshell, and that swf2es parses each case's ABC to the same
// facts as avmplus' abcdump.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containerEngine, type OracleResult, runOracle } from "../../oracle/oracle.ts";
import { abcdumpFacts, compareFacts, swf2esFacts } from "./abc-facts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const cases = readdirSync(`${here}cases`)
  .filter((f) => f.endsWith(".as"))
  .map((f) => `${here}cases/${f}`);

// Larger ABCs to parse, whose run output does not matter.
const parseOnly = [`${root}oracle/avmplus/utils/abcdump.as`];

let engine: string;
try {
  engine = containerEngine();
} catch (e) {
  console.log(`conformance: skipped (${(e as Error).message})`);
  process.exit(0);
}

const results = runOracle([...cases, ...parseOnly], `${here}out`, { engine, abcdump: true });
let failed = 0;

const report = (ok: boolean, what: string, details: string[] = []) => {
  if (!ok) {
    failed++;
  }

  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  for (const line of details) {
    console.log(`     ${line}`);
  }
};

const abcOf = (r: OracleResult) =>
  new Uint8Array(readFileSync(`${here}out/${r.file.split("/").pop()?.replace(/\.as$/, ".abc")}`));

for (const r of results) {
  const isCase = !parseOnly.some((p) => p.endsWith(r.file));
  if (!r.compiled) {
    report(false, r.file, r.compileLog.split("\n"));
    continue;
  }

  if (isCase) {
    report(
      r.exitCode === 0,
      `${r.file} runs in avmshell`,
      r.exitCode === 0 ? [] : r.output.split("\n"),
    );
  }

  const differences = compareFacts(abcdumpFacts(r.dump ?? ""), swf2esFacts(abcOf(r)));
  report(!differences.length, `${r.file} parses like abcdump`, differences);
}

console.log(`conformance: ${results.length} ABCs, ${failed ? `${failed} failed` : "all passed"}`);
if (failed) {
  process.exit(1);
}
