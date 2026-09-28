// Runs the Tamarin acceptance tests in avmshell through the oracle, checks
// the results against baseline.json, and checks that swf2es parses and
// decodes every compiled ABC like avmplus' abcdump, and links it against
// the builtins avmshell loads and verifies it with types, expecting the
// VerifyErrors avmshell prints.
//
//   node tests/tamarin/run.ts [--update-baseline | --relax] [path prefix...]
//
// The oracle image is pinned, so avmshell's results can only change with the
// environment: time of day, machine, thread timing. --relax therefore sets
// every field that differs from baseline.json to null, which stops it being
// compared, and keeps the rest.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  abcdumpFacts,
  compareFacts,
  irProblem,
  loweringProblem,
  swf2esFacts,
  typedErrors,
  verifyErrors,
} from "../../oracle/abc-facts.ts";
import { libraries, runOracle } from "../../oracle/oracle.ts";
import { collectTests } from "./collect.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const baselineFile = `${here}baseline.json`;
const args = process.argv.slice(2);
const update = args.includes("--update-baseline");
const relax = args.includes("--relax");
const prefixes = args.filter((a) => !a.startsWith("--"));

/** What avmshell did with one test. */
interface Outcome {
  compiled: boolean;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  /**
   * The first 16 hex digits of the output's SHA-256; null if the output
   * changes between two runs. In baseline.json any field may be null: it is
   * then not compared (see --relax).
   */
  output: string | null;
}

const { tests, skipped } = collectTests(prefixes);
const started = performance.now();
const results = runOracle(
  tests.map((t) => ({ source: t.source, name: t.path, ascArgs: t.ascArgs })),
  `${here}out`,
  { repeat: true, abcdump: true },
);

// What avmshell loads before each test, as swf2es links it.
const builtins = libraries(["builtin", "shell_toplevel"], `${here}out/lib`).map((l) => l.abc);

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
    const facts = swf2esFacts(abc);
    for (const difference of compareFacts(abcdumpFacts(r.dump ?? ""), facts, count)) {
      problems.push(`${r.name}: ${difference}`);
    }

    // A linking error stops the ABC loading, before any method is verified;
    // otherwise every method the scripts can run is verified with types, and
    // any other body structurally.
    const typed = typedErrors(builtins, abc);
    const ir = irProblem() ?? loweringProblem();
    if (ir) {
      problems.push(`${r.name}: IR: ${ir}`);
    }
    const ours = [...new Set([...typed, ...verifyErrors(facts)])].sort((x, y) => x - y).join(" ");
    const theirs = [...new Set(r.output.match(/(?<=VerifyError: Error #)\d+/g) ?? [])]
      .sort()
      .join(" ");
    if (ours !== theirs) {
      problems.push(`${r.name}: VerifyErrors: avmshell [${theirs}], swf2es [${ours}]`);
    }
    unreachable += count.count;
  }
}

const seconds = ((performance.now() - started) / 1000).toFixed(0);
const all = Object.values(outcomes);
const count = (f: (o: Outcome) => boolean) => all.filter(f).length;
console.log(`tamarin: ${all.length} tests in ${seconds} s, ${skipped.length} skipped`);
console.log(
  `  compiled ${count((o) => o.compiled)}, every check passed in ${count((o) => (o.passed ?? 0) > 0 && !o.failed && o.exitCode === 0)}`,
);
console.log(`  checks: ${sum((o) => o.passed ?? 0)} passed, ${sum((o) => o.failed ?? 0)} failed`);
console.log(
  `  swf2es: parsed and decoded like abcdump in all but ${new Set(problems.map((p) => p.split(":")[0])).size}; ${unreachable} unreachable instructions skipped`,
);

// A null field in the baseline is not compared, and stays null when rewritten.
const baseline = readBaseline();
for (const [path, outcome] of Object.entries(outcomes)) {
  for (const key of Object.keys(outcome) as (keyof Outcome)[]) {
    if (baseline[path] && baseline[path][key] === null) {
      (outcome as Record<keyof Outcome, unknown>)[key] = null;
    }
  }
}

if (update) {
  // Merge when given prefixes, so updating a subset keeps the other tests' entries.
  writeBaseline(prefixes.length ? { ...baseline, ...outcomes } : outcomes);
} else {
  let relaxed = 0;
  for (const [path, outcome] of Object.entries(outcomes)) {
    const expected = baseline[path];
    if (!expected) {
      problems.push(`${path}: not in baseline.json (run with --update-baseline)`);
    } else if (JSON.stringify(expected) !== JSON.stringify(outcome)) {
      if (relax) {
        for (const key of Object.keys(outcome) as (keyof Outcome)[]) {
          if (expected[key] !== outcome[key]) {
            (expected as Record<keyof Outcome, unknown>)[key] = null;
          }
        }
        relaxed++;
        continue;
      }

      problems.push(
        `${path}: avmshell ${JSON.stringify(outcome)}, baseline ${JSON.stringify(expected)}` +
          " (unstable in this environment? pnpm tamarin --relax <path>)",
      );
    }
  }

  if (relax) {
    writeBaseline(baseline);
    console.log(`  baseline: relaxed ${relaxed} tests`);
  }
}

for (const problem of problems.slice(0, 50)) {
  console.log(`FAIL ${problem}`);
}

if (problems.length) {
  console.log(`tamarin: ${problems.length} problems`);
  process.exit(1);
}

/** One test per line, so a changed result is a one-line diff, in code point order (unlike localeCompare, the same on every machine). */
function writeBaseline(entries: Record<string, Outcome>): void {
  const sorted = Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = sorted.map(([path, o]) => `  ${JSON.stringify(path)}: ${JSON.stringify(o)}`);
  writeFileSync(baselineFile, `{\n${lines.join(",\n")}\n}\n`);
  console.log(`  baseline: wrote ${sorted.length} tests`);
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
