// Runs the Tamarin acceptance tests in swf2es, as run.ts runs them in
// avmshell, and scores swf2es against avmshell: a test matches when it
// passes and fails the same checks, and nothing stopped it. avmshell's
// results are those run.ts recorded in baseline.json; the tests are
// compiled as run.ts compiles them, mostly from the oracle's store.
//
//   node tests/tamarin/swf2es.ts [--update-baseline | --relax] [path prefix...]
//
// swf2es-baseline.json holds swf2es' results, so that a change that breaks
// a test that matched fails, and one that fixes a test shows. A test whose
// entry is null is not compared, nor are an entry's null passed and failed:
// one whose result varies from run to run, as with the host's stack depth.
// --relax makes each test that differs so, as run.ts's --relax does: its
// counts, or the whole entry if it ended otherwise. A test whose counts
// baseline.json does not compare, avmshell's following the date or the
// machine, is left out of the score against avmshell, and only compared with
// swf2es-baseline.json. Each test runs in one of at most 10 worker
// processes, which is replaced when a test runs longer than TIMEOUT.
import { type ChildProcess, fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { runOracle } from "../../oracle/oracle.ts";
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

/** A test in swf2es-baseline.json: its outcome, passed and failed null when not compared. */
type Recorded = Omit<Outcome, "passed" | "failed"> & {
  passed: number | null;
  failed: number | null;
};

/** avmshell's result for a test, as run.ts records it. */
interface Avmshell {
  compiled: boolean;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
}

const avmshell: Record<string, Avmshell> = JSON.parse(readFileSync(`${here}baseline.json`, "utf8"));
const { tests } = collectTests(prefixes);
const compileStarted = performance.now();
// Compiled as run.ts compiles them, into the same directory, but not run:
// mostly taken from the oracle's store.
const toCompile = tests.filter((t) => avmshell[t.path]?.compiled);
runOracle(
  toCompile.map((t) => ({ source: t.source, name: t.path, ascArgs: t.ascArgs })),
  `${here}out`,
  { run: false },
);
console.log(
  `tamarin in swf2es: compiled ${toCompile.length} tests in ${((performance.now() - compileStarted) / 1000).toFixed(0)} s`,
);

// A test avmshell compiled must have its ABC: a missing one would drop out
// of the comparison, and out of the baseline on an update.
const compiled = toCompile.map((t) => ({ path: t.path, abc: `${here}out/${t.path}.abc` }));
const missing = compiled.filter((t) => !existsSync(t.abc));
if (missing.length) {
  for (const t of missing.slice(0, 20)) {
    console.log(`FAIL ${t.path}: no ${t.abc}; ASC did not compile it`);
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

/** Whether baseline.json compares avmshell's counts for the test: not where they follow the date or the machine. */
const counted = (path: string) => avmshell[path].passed !== null && avmshell[path].failed !== null;

/**
 * Whether swf2es ended as avmshell did, nothing of the host's stopping it,
 * and, with `counts`, passed and failed the checks avmshell did.
 */
const matches = (path: string, o: Recorded, counts = counted(path)) =>
  o.error === null &&
  (avmshell[path].exitCode === null || o.exitCode === avmshell[path].exitCode) &&
  (!counts || (o.passed === avmshell[path].passed && o.failed === avmshell[path].failed));

// By directory: tests that match, of those run, and checks passed, swf2es against avmshell.
const byDir = new Map<string, { tests: number; matched: number; ours: number; theirs: number }>();
const reasons = new Map<string, number>();
const all = Object.entries(outcomes);
const scored = all.filter(([path]) => counted(path));
for (const [path, o] of scored) {
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
        : o.passed < (avmshell[path].passed as number)
          ? "fewer checks passed"
          : "other checks failed");
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }

  byDir.set(dir, d);
}

const matched = scored.filter(([p, o]) => matches(p, o)).length;
const checks = scored.reduce((n, [, o]) => n + o.passed, 0);
const theirChecks = scored.reduce((n, [p]) => n + (avmshell[p].passed as number), 0);
const seconds = ((performance.now() - started) / 1000).toFixed(0);
console.log(`tamarin in swf2es: ${all.length} tests in ${seconds} s`);
console.log(
  `  as avmshell: ${matched} of ${scored.length} tests (${((100 * matched) / scored.length).toFixed(1)}%); ${all.length - scored.length} not scored, avmshell's counts not compared`,
);
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
const baseline: Record<string, Recorded | null> = existsSync(baselineFile)
  ? JSON.parse(readFileSync(baselineFile, "utf8"))
  : {};

function writeBaseline(entries: Record<string, Recorded | null>): void {
  const sorted = Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  writeFileSync(
    baselineFile,
    `{\n${sorted.map(([p, o]) => `  ${JSON.stringify(p)}: ${JSON.stringify(o)}`).join(",\n")}\n}\n`,
  );
  console.log(`\n  baseline: wrote ${sorted.length} tests`);
}

if (update) {
  // A test or a count not compared stays so.
  const merged: Record<string, Recorded | null> = prefixes.length ? { ...baseline } : {};
  for (const [path, o] of all) {
    const before = baseline[path];
    merged[path] =
      before === null
        ? null
        : {
            ...o,
            passed: before?.passed === null ? null : o.passed,
            failed: before?.failed === null ? null : o.failed,
          };
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

    // Counts not compared with avmshell's are still compared with swf2es' own, unless relaxed too.
    const ours = before.passed !== null && before.failed !== null;
    const counts = counted(path) && ours;
    const was = matches(path, before, counts);
    const is = matches(path, o, counts);
    if (was && !is) {
      regressions.push(`${path}: ${JSON.stringify(o)}, was ${JSON.stringify(before)}`);
    } else if (!was && is) {
      fixed.push(path);
    } else if ((!is || !counted(path)) && ours && o.passed < (before.passed as number)) {
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
      const path = r.split(":")[0];
      const before = baseline[path];
      const o = outcomes[path];
      // Only the counts if it ended as before, else the whole entry.
      baseline[path] =
        before && o.exitCode === before.exitCode && o.error === before.error
          ? { ...before, passed: null, failed: null }
          : null;
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
