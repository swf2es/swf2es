// Real programs, compiled and run in avmshell through the oracle. Their
// deterministic output (lines not starting with "time: ") must match
// expected/<name>.txt, and swf2es must parse and decode their ABCs like
// abcdump, and link them and verify all their methods with types.
//
//   node tests/programs/run.ts [--update]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  abcdumpFacts,
  compareFacts,
  irProblem,
  loweringProblem,
  swf2esFacts,
  typedErrors,
} from "../../oracle/abc-facts.ts";
import { containerEngine, libraries, type OracleJob, runOracle } from "../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const update = process.argv.includes("--update");

/** as3pb's benchmark: its avmshell entry point, with the -in files in the order it lists. */
function as3pb(): OracleJob {
  const dir = `${here}as3pb/`;
  const sources = readFileSync(`${dir}runtime/test/bench/shell-sources.txt`, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));

  return {
    source: `${dir}runtime/test/bench/ShellMain.as`,
    name: "as3pb/ShellMain",
    ascArgs: [
      "-AS3",
      "-optimize",
      "-inline",
      "-strict",
      ...sources.flatMap((s) => ["-in", relative(root, `${dir}${s}`)]),
    ],
  };
}

if (!existsSync(`${here}as3pb/runtime`)) {
  console.log("programs: skipped (tests/programs/as3pb missing; run git submodule update --init)");
  process.exit(0);
}

let engine: string;
try {
  engine = containerEngine();
} catch (e) {
  console.log(`programs: skipped (${(e as Error).message})`);
  process.exit(0);
}

const programs = [{ name: "as3pb", job: as3pb() }];
const results = runOracle(
  programs.map((p) => p.job),
  `${here}out`,
  { engine, abcdump: true, timeoutSeconds: 120 },
);

// What avmshell loads before each program.
const builtins = libraries(["builtin", "shell_toplevel"], `${here}out/lib`, { engine }).map(
  (l) => l.abc,
);

let failed = 0;
for (const [i, r] of results.entries()) {
  const name = programs[i].name;
  if (!r.compiled) {
    failed++;
    console.log(`FAIL ${name} did not compile\n${r.compileLog}`);
    continue;
  }

  const lines = r.output.split("\n");
  const output = `${lines
    .filter((l) => !l.startsWith("time: "))
    .join("\n")
    .trimEnd()}\n`;
  const timings = lines.filter((l) => l.startsWith("time: ")).length;
  const expectedFile = `${here}expected/${name}.txt`;

  if (update) {
    writeFileSync(expectedFile, output);
    console.log(`wrote expected/${name}.txt`);
  } else if (!existsSync(expectedFile) || readFileSync(expectedFile, "utf8") !== output) {
    failed++;
    console.log(
      `FAIL ${name}: avmshell output differs from expected/${name}.txt (exit ${r.exitCode})`,
    );
    console.log(output);
  }

  const abc = new Uint8Array(readFileSync(`${here}out/${r.name}.abc`));
  const differences = compareFacts(abcdumpFacts(r.dump ?? ""), swf2esFacts(abc));
  const errors = typedErrors(builtins, abc);
  if (errors.length) {
    differences.push(`linking and typed verification: errors ${errors.join(" ")}`);
  }

  const ir = irProblem() ?? loweringProblem();
  if (ir) {
    differences.push(`IR: ${ir}`);
  }

  for (const d of differences.slice(0, 20)) {
    console.log(`FAIL ${name}: ${d}`);
  }
  failed += differences.length ? 1 : 0;

  console.log(
    `${failed ? "FAIL" : "ok  "} ${name}: exit ${r.exitCode}, ${output.split("\n").length - 1} expected lines, ${timings} timing lines`,
  );
}

if (failed) {
  process.exit(1);
}
