// Runs the Tamarin acceptance tests in swf2es, as run.ts runs them in
// avmshell, and scores swf2es against avmshell: a test matches when it
// passes and fails the same checks, and nothing stopped it. Run after
// run.ts, which compiles the tests and records avmshell's results in
// baseline.json.
//
//   node tests/tamarin/swf2es.ts [--update-baseline | --relax] [path prefix...]
//
// swf2es-baseline.json holds swf2es' results, so that a change that breaks
// a test that matched fails, and one that fixes a test shows. A test whose
// entry is null is not compared: one whose result varies from run to run,
// as with the host's stack depth or a clock. --relax makes each test that
// differs so, as run.ts's --relax does. Each test runs
// in one of at most 10 worker processes, which is replaced when a test runs
// longer than TIMEOUT.
import { type ChildProcess, fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { collectTests } from "./collect.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const baselineFile = `${here}swf2es-baseline.json`;
const args = process.argv.slice(2);
const update = args.includes("--update-baseline");
const relax = args.includes("--relax");
const prefixes = args.filter((a) => !a.startsWith("--"));
const TIMEOUT = 30_000;

/** What swf2es did with one test. */
interface Outcome {
  passed: number;
  failed: number;
  /**
   * How it ended, as avmshell's exit code: 0, 1 for a VerifyError or an AS3
   * exception nothing caught, 124 for a timeout; null if the host stopped it.
   */
  exitCode: number | null;
  /** What of the host's stopped it, if anything: an error, or its worker dying. */
  error: string | null;
}

/** avmshell's result for a test, as run.ts records it. */
interface Avmshell {
  compiled: boolean;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
}

const avmshell: Record<string, Avmshell> = JSON.parse(readFileSync(`${here}baseline.json`, "utf8"));
const { tests } = collectTests(prefixes);
// A test avmshell compiled must have its ABC: a missing one would drop out
// of the comparison, and out of the baseline on an update.
const compiled = tests
  .map((t) => ({ path: t.path, abc: `${here}out/${t.path}.abc` }))
  .filter((t) => avmshell[t.path]?.compiled);
const missing = compiled.filter((t) => !existsSync(t.abc));
if (missing.length) {
  for (const t of missing.slice(0, 20)) {
    console.log(`FAIL ${t.path}: no ${t.abc}; pnpm tamarin compiles it`);
  }

  console.log(`tamarin in swf2es: ${missing.length} compiled tests have no ABC`);
  process.exit(1);
}

const queue = compiled;

const outcomes: Record<string, Outcome> = {};
const started = performance.now();

/** Run the queue on `count` workers; a worker past TIMEOUT on a test is killed and replaced. */
async function runAll(count: number): Promise<void> {
  let next = 0;
  const work = () =>
    new Promise<void>((resolve) => {
      let child: ChildProcess;
      let timer: NodeJS.Timeout | undefined;
      let current: string | null = null;
      const send = () => {
        if (next >= queue.length) {
          child.kill();
          resolve();
          return;
        }

        const test = queue[next++];
        current = test.path;
        timer = setTimeout(() => {
          outcomes[test.path] = { passed: 0, failed: 0, exitCode: 124, error: null };
          current = null;
          child.kill("SIGKILL");
          spawn();
        }, TIMEOUT);
        child.send(test);
      };

      const spawn = () => {
        const c = fork(`${here}swf2es-worker.ts`, [], {
          // A test's own output comes back over IPC; a worker that runs out
          // of memory would only print V8's stack.
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        child = c;
        c.on(
          "message",
          (m: {
            ready?: boolean;
            path?: string;
            lines?: string[];
            exitCode?: number;
            error?: string;
          }) => {
            // A worker killed at a timeout has been replaced: it no longer speaks for its test.
            if (child !== c) {
              return;
            }

            if (m.ready) {
              send();
              return;
            }

            clearTimeout(timer);
            const output = (m.lines ?? []).join("\n");
            outcomes[m.path as string] = {
              passed: (output.match(/PASSED!/g) ?? []).length,
              failed: (output.match(/FAILED!/g) ?? []).length,
              exitCode: m.error === undefined ? (m.exitCode ?? null) : null,
              error: m.error ?? null,
            };
            current = null;
            send();
          },
        );
        c.on("exit", (code) => {
          // A worker that died on its own, as out of memory, fails its test.
          if (child === c && current !== null) {
            clearTimeout(timer);
            outcomes[current] = {
              passed: 0,
              failed: 0,
              exitCode: null,
              error: `worker exited (${code})`,
            };
            current = null;
            spawn();
          }
        });
      };

      spawn();
    });

  await Promise.all(Array.from({ length: count }, work));
}

await runAll(Math.min(10, availableParallelism(), queue.length));

/** Whether swf2es passed and failed the checks avmshell did, and ended as it did, nothing of the host's stopping it. */
const matches = (path: string, o: Outcome) =>
  o.error === null &&
  o.exitCode === avmshell[path].exitCode &&
  o.passed === (avmshell[path].passed ?? 0) &&
  o.failed === (avmshell[path].failed ?? 0);

// By directory: tests that match, of those run, and checks passed, swf2es against avmshell.
const byDir = new Map<string, { tests: number; matched: number; ours: number; theirs: number }>();
const reasons = new Map<string, number>();
for (const [path, o] of Object.entries(outcomes)) {
  // as3, e4x and ecma3 by their second level; the rest, a test or a few per directory, by their first.
  const parts = path.split("/");
  const dir = parts.slice(0, ["as3", "e4x", "ecma3"].includes(parts[0]) ? 2 : 1).join("/");
  const d = byDir.get(dir) ?? { tests: 0, matched: 0, ours: 0, theirs: 0 };
  d.tests++;
  d.ours += o.passed;
  d.theirs += avmshell[path].passed ?? 0;
  if (matches(path, o)) {
    d.matched++;
  } else {
    // Why, with the specifics that vary (numbers, quoted names) kept: they say what is missing.
    const why =
      o.error ??
      (o.exitCode !== avmshell[path].exitCode
        ? `ended with ${o.exitCode === 124 ? "a timeout" : `exit code ${o.exitCode}`}, avmshell with ${avmshell[path].exitCode}`
        : o.passed < (avmshell[path].passed ?? 0)
          ? "fewer checks passed"
          : "other checks failed");
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }

  byDir.set(dir, d);
}

const all = Object.entries(outcomes);
const matched = all.filter(([p, o]) => matches(p, o)).length;
const checks = all.reduce((n, [, o]) => n + o.passed, 0);
const theirChecks = all.reduce((n, [p]) => n + (avmshell[p].passed ?? 0), 0);
const seconds = ((performance.now() - started) / 1000).toFixed(0);
console.log(`tamarin in swf2es: ${all.length} tests in ${seconds} s`);
console.log(`  as avmshell: ${matched} tests (${((100 * matched) / all.length).toFixed(1)}%)`);
console.log(
  `  checks passed: ${checks} of avmshell's ${theirChecks} (${((100 * checks) / theirChecks).toFixed(1)}%)`,
);
console.log("\n  directory                          tests   as avmshell   checks passed");
for (const [dir, d] of [...byDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
  console.log(
    `  ${dir.padEnd(34)} ${String(d.tests).padStart(5)}   ${`${d.matched} (${((100 * d.matched) / d.tests).toFixed(0)}%)`.padStart(11)}   ${`${d.ours}/${d.theirs}`.padStart(13)}`,
  );
}

console.log("\n  most common reasons a test does not match:");
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${String(n).padStart(5)}  ${why.slice(0, 140)}`);
}

// Against the baseline: a test that matched and no longer does is a regression.
const baseline: Record<string, Outcome | null> = existsSync(baselineFile)
  ? JSON.parse(readFileSync(baselineFile, "utf8"))
  : {};

function writeBaseline(entries: Record<string, Outcome | null>): void {
  const sorted = Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  writeFileSync(
    baselineFile,
    `{\n${sorted.map(([p, o]) => `  ${JSON.stringify(p)}: ${JSON.stringify(o)}`).join(",\n")}\n}\n`,
  );
  console.log(`\n  baseline: wrote ${sorted.length} tests`);
}

if (update) {
  // A test not compared stays so.
  const merged: Record<string, Outcome | null> = prefixes.length ? { ...baseline } : {};
  for (const [path, o] of all) {
    merged[path] = baseline[path] === null ? null : o;
  }

  writeBaseline(merged);
} else {
  const regressions: string[] = [];
  const fixed: string[] = [];
  for (const [path, o] of all) {
    const before = baseline[path];
    if (before === undefined) {
      regressions.push(`${path}: not in swf2es-baseline.json (run with --update-baseline)`);
      continue;
    }

    if (before === null) {
      continue;
    }

    const was = matches(path, before);
    const is = matches(path, o);
    if (was && !is) {
      regressions.push(`${path}: ${JSON.stringify(o)}, was ${JSON.stringify(before)}`);
    } else if (!was && is) {
      fixed.push(path);
    } else if (!is && o.passed < before.passed) {
      regressions.push(`${path}: ${o.passed} checks passed, was ${before.passed}`);
    }
  }

  if (fixed.length) {
    console.log(
      `\n  now as avmshell (${fixed.length}; --update-baseline to keep): ${fixed.slice(0, 20).join(", ")}`,
    );
  }

  if (relax) {
    for (const r of regressions) {
      baseline[r.split(":")[0]] = null;
    }

    writeBaseline(baseline);
    console.log(`  baseline: relaxed ${regressions.length} tests`);
    process.exit(0);
  }

  for (const r of regressions.slice(0, 50)) {
    console.log(`FAIL ${r}`);
  }

  if (regressions.length) {
    console.log(`tamarin in swf2es: ${regressions.length} regressions`);
    process.exit(1);
  }
}
