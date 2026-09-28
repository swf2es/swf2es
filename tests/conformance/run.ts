// Conformance runner. For every case, avmshell's trace output is the expected
// result, and the case compiled by swf2es and run in node, after the
// builtins avmshell loads, also compiled by swf2es, must print the same
// lines. Each case will also be compiled in JIT mode and AOT mode, which must
// give identical output (see docs/architecture.md). swf2es must also parse
// each case's ABC to the same facts as avmplus' abcdump.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { abcdumpFacts, compareFacts, swf2esFacts } from "../../oracle/abc-facts.ts";
import { containerEngine, libraries, type OracleResult, runOracle } from "../../oracle/oracle.ts";
import { runSwf2es } from "./swf2es.ts";

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

// With -md, ASC keeps metadata, such as the [Transient] that AMF and JSON
// leave a member out for, as Tamarin's JSON tests are compiled.
const results = runOracle(
  [...cases.map((source) => ({ source, ascArgs: ["-md"] })), ...parseOnly],
  `${here}out`,
  { engine, abcdump: true },
);
const builtins = libraries(["builtin", "shell_toplevel"], `${here}out/lib`, { engine }).map(
  (l) => l.abc,
);
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

const abcOf = (r: OracleResult) => new Uint8Array(readFileSync(`${here}out/${r.name}.abc`));

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

    const expected = r.output.replace(/\n$/, "").split("\n");
    let actual: string[];
    try {
      actual = await runSwf2es(builtins, abcOf(r));
    } catch (e) {
      // The first frames, with each module's data URL shortened.
      const stack = (e instanceof Error ? (e.stack ?? e.message) : String(e))
        .replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "module")
        .split("\n")
        .slice(0, 5)
        .join("\n");
      actual = [`threw ${stack}`];
    }

    report(
      actual.join("\n") === expected.join("\n"),
      `${r.file} runs in swf2es as in avmshell`,
      firstDifference(expected, actual),
    );
  }

  const unreachable = { count: 0 };
  const differences = compareFacts(abcdumpFacts(r.dump ?? ""), swf2esFacts(abcOf(r)), unreachable);
  const skipped = unreachable.count ? ` (${unreachable.count} unreachable instructions)` : "";
  report(!differences.length, `${r.file} parses and decodes like abcdump${skipped}`, differences);
}

/** Where two outputs part, for the report. */
function firstDifference(expected: string[], actual: string[]): string[] {
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] !== actual[i]) {
      return [
        `line ${i + 1}:`,
        `  avmshell: ${expected[i] ?? "(end)"}`,
        `  swf2es:   ${actual[i] ?? "(end)"}`,
      ];
    }
  }

  return [];
}

console.log(`conformance: ${results.length} ABCs, ${failed ? `${failed} failed` : "all passed"}`);
if (failed) {
  process.exit(1);
}
