// Runs the Tamarin acceptance tests in avmshell through the oracle.
//
//   node tests/tamarin/run.ts [path prefix...]   e.g. ecma3/Array as3/Types
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runOracle } from "../../oracle/oracle.ts";
import { collectTests } from "./collect.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const { tests, skipped } = collectTests(process.argv.slice(2));

const started = performance.now();
const results = runOracle(
  tests.map((t) => ({ source: t.source, name: t.path, ascArgs: t.ascArgs })),
  `${here}out`,
  { repeat: true },
);
const seconds = ((performance.now() - started) / 1000).toFixed(0);

const summary = results.map((r) => ({
  path: r.name,
  compiled: r.compiled,
  exitCode: r.exitCode,
  passed: (r.output.match(/PASSED!/g) ?? []).length,
  failed: (r.output.match(/FAILED!/g) ?? []).length,
  nondeterministic: r.nondeterministic,
}));
writeFileSync(
  `${here}out/results.json`,
  `${JSON.stringify({ results: summary, skipped }, null, 1)}\n`,
);

const count = (f: (s: (typeof summary)[number]) => boolean) => summary.filter(f).length;
console.log(`tamarin: ${tests.length} tests in ${seconds} s, ${skipped.length} skipped`);
console.log(`  did not compile: ${count((s) => !s.compiled)}`);
console.log(
  `  exit 0: ${count((s) => s.exitCode === 0)}, other exits: ${count((s) => s.compiled && s.exitCode !== 0)}`,
);
console.log(`  timed out: ${count((s) => s.exitCode === 124)}`);
console.log(
  `  all checks passed: ${count((s) => s.compiled && s.exitCode === 0 && s.failed === 0 && s.passed > 0)}`,
);
console.log(`  some checks failed: ${count((s) => s.failed > 0)}`);
console.log(`  no checks printed: ${count((s) => s.compiled && s.passed + s.failed === 0)}`);
console.log(`  output differs between runs: ${count((s) => s.nondeterministic)}`);
