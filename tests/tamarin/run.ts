// Runs the Tamarin acceptance tests in avmshell through the oracle, checks
// the results against baseline.json, and checks that swf2es parses and
// decodes every compiled ABC like avmplus' abcdump.
//
//   node tests/tamarin/run.ts [--update-baseline] [path prefix...]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { abcdumpFacts, compareFacts, swf2esFacts } from "../../oracle/abc-facts.ts";
import { runOracle } from "../../oracle/oracle.ts";
import { collectTests } from "./collect.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const baselineFile = `${here}baseline.json`;
const args = process.argv.slice(2);
const update = args.includes("--update-baseline");
const prefixes = args.filter((a) => !a.startsWith("--"));

/** What avmshell did with one test. */
interface Outcome {
  compiled: boolean;
  exitCode: number | null;
  passed: number;
  failed: number;
  /** The first 16 hex digits of the output's SHA-256; null if the output changes from run to run. */
  output: string | null;
}

const { tests, skipped } = collectTests(prefixes);
const started = performance.now();
const results = runOracle(
  tests.map((t) => ({ source: t.source, name: t.path, ascArgs: t.ascArgs })),
  `${here}out`,
  { repeat: true, abcdump: true },
);

const outcomes: Record<string, Outcome> = {};
const problems: string[] = [];
let unreachable = 0;

for (const r of results) {
  outcomes[r.name] = {
    compiled: r.compiled,
    exitCode: r.exitCode,
    passed: (r.output.match(/PASSED!/g) ?? []).length,
    failed: (r.output.match(/FAILED!/g) ?? []).length,
    output: r.compiled && !r.nondeterministic ? hash(r.output) : null,
  };

  if (r.compiled) {
    const abc = new Uint8Array(readFileSync(`${here}out/${r.name}.abc`));
    const count = { count: 0 };
    for (const difference of compareFacts(abcdumpFacts(r.dump ?? ""), swf2esFacts(abc), count)) {
      problems.push(`${r.name}: ${difference}`);
    }
    unreachable += count.count;
  }
}

const seconds = ((performance.now() - started) / 1000).toFixed(0);
const all = Object.values(outcomes);
const count = (f: (o: Outcome) => boolean) => all.filter(f).length;
console.log(`tamarin: ${all.length} tests in ${seconds} s, ${skipped.length} skipped`);
console.log(
  `  compiled ${count((o) => o.compiled)}, every check passed in ${count((o) => o.passed > 0 && !o.failed && o.exitCode === 0)}`,
);
console.log(`  checks: ${sum((o) => o.passed)} passed, ${sum((o) => o.failed)} failed`);
console.log(
  `  swf2es: parsed and decoded like abcdump in all but ${new Set(problems.map((p) => p.split(":")[0])).size}; ${unreachable} unreachable instructions skipped`,
);

if (update) {
  // Merge, so updating a subset keeps the other tests' entries.
  const previous = prefixes.length ? readBaseline() : {};
  const merged = Object.fromEntries(
    Object.entries({ ...previous, ...outcomes }).sort(([a], [b]) => a.localeCompare(b)),
  );
  // One test per line, so a changed result is a one-line diff.
  const lines = Object.entries(merged).map(
    ([path, o]) => `${JSON.stringify(path)}: ${JSON.stringify(o)}`,
  );
  writeFileSync(baselineFile, `{\n${lines.join(",\n")}\n}\n`);
  console.log(`  baseline: wrote ${Object.keys(merged).length} tests`);
} else {
  const baseline = readBaseline();
  for (const [path, outcome] of Object.entries(outcomes)) {
    const expected = baseline[path];
    if (!expected) {
      problems.push(`${path}: not in baseline.json (run with --update-baseline)`);
    } else if (JSON.stringify(expected) !== JSON.stringify(outcome)) {
      problems.push(
        `${path}: avmshell ${JSON.stringify(outcome)}, baseline ${JSON.stringify(expected)}`,
      );
    }
  }
}

for (const problem of problems.slice(0, 50)) {
  console.log(`FAIL ${problem}`);
}

if (problems.length) {
  console.log(`tamarin: ${problems.length} problems`);
  process.exit(1);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function sum(f: (o: Outcome) => number): number {
  return all.reduce((n, o) => n + f(o), 0);
}

function readBaseline(): Record<string, Outcome> {
  try {
    return JSON.parse(readFileSync(baselineFile, "utf8"));
  } catch {
    return {};
  }
}
