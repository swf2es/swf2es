// Conformance runner. For every case, avmshell's trace output is the expected
// result; the swf2es-compiled case run in node will be the actual result, and
// the two must match exactly. Each case will also be compiled in JIT mode and
// AOT mode, which must give identical output (see docs/architecture.md).
//
// Codegen is not implemented yet, so this runs the oracle on every case and
// fails if a case does not compile or avmshell does not exit cleanly.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containerEngine, runOracle } from "../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const cases = readdirSync(`${here}cases`)
  .filter((f) => f.endsWith(".as"))
  .map((f) => `${here}cases/${f}`);

let engine: string;
try {
  engine = containerEngine();
} catch (e) {
  console.log(`conformance: skipped (${(e as Error).message})`);
  process.exit(0);
}

const results = runOracle(cases, `${here}out`, { engine });
let failed = 0;
for (const r of results) {
  const ok = r.compiled && r.exitCode === 0;
  if (!ok) {
    failed++;
  }
  console.log(`${ok ? "ok  " : "FAIL"} ${r.file}`);
  if (!ok) {
    console.log(r.compiled ? r.output : r.compileLog);
  }
}
console.log(`conformance: ${results.length - failed}/${results.length} cases run in avmshell`);
if (failed) {
  process.exit(1);
}
