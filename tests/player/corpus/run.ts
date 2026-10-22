// Plays Ruffle's corpus in the player and scores each test's standing
// against baseline.json: of the lines Flash traced, how many the player
// matched before the first difference, and what stopped it, if anything.
// A change may not lower a standing; one that raises it is recorded with
// --update-baseline. A test whose standing varies from run to run is set
// to null and not compared, as --relax does for each test that differs.
//
//   node tests/player/corpus/run.ts [--update-baseline | --relax] [--diff [--dump]] [path prefix...]
//
// --diff prints, for each test that does not pass, the lines where the
// player's trace and Flash's part, and what stopped the player; a
// regression shows them without it, below its standing before and after.
//
// The avm1/, avm2/ and timeline/ tests with an output.txt, less those the
// collector ignores (input, audio, video, fonts). Only traces compare: the
// frames are the Flash oracle's business (check-references.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type PlayerResult, runPlayer } from "../chrome.ts";
import { libraryAbcs } from "../libraries.ts";
import { collectRuffle, corpus, type RuffleTest } from "./ruffle.ts";

/** A pass: every line matched, no more traced, and no error. */
function passed(s: Standing): boolean {
  return s.matched === s.lines && s.traced === s.lines && !s.error;
}

/** How the player stood on one test: a pass is every line matched, no more traced, and no error. */
interface Standing {
  /** Lines matched before the first difference, of `lines` Flash traced. */
  matched: number;
  lines: number;
  /** Lines the player traced, more than `lines` when it went on past Flash's. */
  traced: number;
  /** What stopped the player: an exception's text, "timeout", or null. */
  error: string | null;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const baselineFile = `${here}baseline.json`;
const args = process.argv.slice(2);
const update = args.includes("--update-baseline");
const relax = args.includes("--relax");
const diff = args.includes("--diff");
const dump = args.includes("--dump");
const prefixes = args.filter((a) => !a.startsWith("--"));
/** A test's scripts may run this long; frames beyond it are a timeout. */
const TIMEOUT = 20_000;
/** A test asking for more frames than this runs this many: a tick a frame, nothing waits for time. */
const MAX_FRAMES = 300;

const tests = collectRuffle(prefixes.length ? prefixes : ["avm1/", "avm2/", "timeline/"]).filter(
  (t) => t.output !== null && !t.ignore,
);
if (tests.length === 0) {
  console.error("no tests; is the corpus fetched (node tests/player/corpus/fetch-ruffle.ts)?");
  process.exit(2);
}

// The libraries the page serves the tests' code with, fetched if missing.
libraryAbcs();
console.log(`${tests.length} tests`);
const started = performance.now();
let done = 0;
const results = await runPlayer(
  // Served from its directory, so that what a test loads by relative URL is there.
  tests.map((t) => ({
    swf: new Uint8Array(readFileSync(t.swf)),
    frames: Math.min(t.frames, MAX_FRAMES),
    capture: [],
    url: `/corpus/${t.path}/test.swf`,
    input: t.input ? JSON.parse(readFileSync(t.input, "utf8")) : undefined,
    viewport: t.viewport ?? undefined,
    logFetch: t.logFetch,
    socket: t.socket ? JSON.parse(readFileSync(t.socket, "utf8")) : undefined,
    lazyCompilation: args.includes("--lazy"),
  })),
  {
    timeout: TIMEOUT,
    mounts: [["/corpus/", `${corpus}/`]],
    onResult: () => {
      done++;
      if (done % 100 === 0) {
        console.log(
          `  ${done} of ${tests.length}, ${Math.round((performance.now() - started) / 1000)} s`,
        );
      }
    },
  },
);

const standings: Record<string, Standing> = {};
for (const [i, t] of tests.entries()) {
  standings[t.path] = standing(t, results[i]);
  if (diff && !passed(standings[t.path])) {
    showDiff(t, results[i], standings[t.path]);
  }
}

/**
 * Where the traces part, three lines of each side from there (every line
 * from the start with --dump), after a line naming the test and its error
 * unless the caller has.
 */
function showDiff(t: RuffleTest, r: PlayerResult, s: Standing, named = false): void {
  const expected = expectedLines(t);
  if (!named) {
    console.log(`\n${t.path}: ${s.matched} of ${s.lines} lines${s.error ? `, ${s.error}` : ""}`);
  }

  const last = Math.max(expected.length, r.trace.length);
  for (let i = dump ? 0 : s.matched; i < (dump ? last : Math.min(s.matched + 3, last)); i++) {
    if (i < expected.length) {
      console.log(`  flash  | ${expected[i]}`);
    }

    if (i < r.trace.length) {
      console.log(`  player | ${r.trace[i]}`);
    }
  }
}

function expectedLines(t: RuffleTest): string[] {
  const text = (t.output as string).replace(/\r\n/g, "\n").replace(/\n$/, "");
  return text === "" ? [] : text.split("\n");
}

function standing(t: RuffleTest, r: PlayerResult): Standing {
  const expected = expectedLines(t);
  const lines = expected.length;
  let matched = 0;
  while (matched < lines && matched < r.trace.length && r.trace[matched] === expected[matched]) {
    matched++;
  }

  return { matched, lines, traced: r.trace.length, error: r.error };
}

const passes = Object.values(standings).filter(passed).length;
console.log(
  `${passes} of ${tests.length} match Flash's trace, ${Math.round((performance.now() - started) / 1000)} s`,
);

// What stopped the player, by what the error names, most common first.
const stops = new Map<string, number>();
for (const s of Object.values(standings)) {
  if (s.error) {
    // Numbers vary (error ids, counts); the words are the kind.
    const key = s.error.replace(/\b\d+\b/g, "#").slice(0, 80);
    stops.set(key, (stops.get(key) ?? 0) + 1);
  }
}
for (const [key, n] of [...stops].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(4)}  ${key}`);
}

// Against the baseline: a lower standing is a regression, a higher one shows.
const baseline = readBaseline();
if (update) {
  for (const path of Object.keys(standings)) {
    if (baseline[path] === null) {
      standings[path] = null as unknown as Standing;
    }
  }

  writeBaseline(prefixes.length ? { ...baseline, ...standings } : standings);
} else {
  const regressions: { path: string; was: Standing | undefined }[] = [];
  const improved: string[] = [];
  for (const [path, s] of Object.entries(standings)) {
    if (!(path in baseline)) {
      regressions.push({ path, was: undefined });
      continue;
    }

    const before = baseline[path];
    if (before === null) {
      continue;
    }
    if (
      (passed(before) && !passed(s)) ||
      s.matched < before.matched ||
      (s.error && !before.error)
    ) {
      regressions.push({ path, was: before });
    } else if (s.matched > before.matched || (passed(s) && !passed(before))) {
      improved.push(`${path}: ${describe(s)}, was ${describe(before)}`);
    }
  }

  if (improved.length) {
    console.log(
      `  ${improved.length} tests stand higher than baseline.json (record with --update-baseline):`,
    );
    for (const line of improved.slice(0, 50)) {
      console.log(`    ${line}`);
    }
  }

  if (relax) {
    for (const r of regressions) {
      baseline[r.path] = null;
    }

    writeBaseline(baseline);
    console.log(`  baseline: relaxed ${regressions.length} tests`);
  } else if (regressions.length) {
    console.log(`\n${regressions.length} regressions:`);
    const index = new Map(tests.map((t, i) => [t.path, i]));
    for (const { path, was } of regressions.slice(0, 50)) {
      const line = was
        ? `${path}: ${describe(standings[path])}, was ${describe(was)}`
        : `${path}: ${describe(standings[path])}, not in baseline.json (run with --update-baseline)`;
      // As an annotation, CI shows it on the run's summary too.
      console.log(
        process.env.GITHUB_ACTIONS ? `::error title=corpus regression::${line}` : `\n${line}`,
      );

      // --diff has shown it already.
      const i = index.get(path) as number;
      if (!diff && !passed(standings[path])) {
        showDiff(tests[i], results[i], standings[path], true);
      }
    }

    process.exitCode = 1;
  }
}

/** A standing in words: "3 of 5 lines, 4 traced, timeout". */
function describe(s: Standing): string {
  const traced = s.traced === s.lines ? "" : `, ${s.traced} traced`;
  return `${s.matched} of ${s.lines} lines${traced}${s.error ? `, ${s.error}` : ""}`;
}

function readBaseline(): Record<string, Standing | null> {
  try {
    return JSON.parse(readFileSync(baselineFile, "utf8"));
  } catch {
    return {};
  }
}

function writeBaseline(b: Record<string, Standing | null>): void {
  const sorted = Object.keys(b).sort();
  const lines = sorted.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(b[k])}`);
  writeFileSync(baselineFile, `{\n${lines.join(",\n")}\n}\n`);
  console.log(`  baseline: wrote ${sorted.length} tests`);
}
