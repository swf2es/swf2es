// Real programs, compiled and run in avmshell through the oracle. Their
// deterministic output (lines not starting with "time: ") must match
// expected/<name>.txt, and swf2es must parse and decode their ABCs like
// abcdump, and link them and verify all their methods with types. Each
// program also runs compiled by swf2es in node, whose deterministic output
// must match too, and whose timings are reported.
//
// One line is not compared: as3pb's wire checksum multiplies past 2^53,
// which the oracle's 32-bit avmshell computes in the x87's extended
// precision and swf2es in IEEE doubles (docs/architecture.md, "Testing
// against oracles").
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
import { runSwf2es } from "../conformance/swf2es.ts";

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

  // The same program compiled by swf2es, in node.
  const started = performance.now();
  let lines2: string[];
  try {
    lines2 = await runSwf2es(builtins, abc);
  } catch (e) {
    lines2 = [`threw ${e instanceof Error ? e.stack : String(e)}`];
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const compared = (all: string[]) => {
    const kept = all.filter((l) => !l.startsWith("time: "));
    const at = kept.indexOf("--- Wire checksum ---");
    return at < 0 ? kept : [...kept.slice(0, at + 1), ...kept.slice(at + 2)];
  };

  const theirs = compared(output.trimEnd().split("\n"));
  const ours = compared(lines2);
  for (let i = 0; i < Math.max(theirs.length, ours.length); i++) {
    if (theirs[i] !== ours[i]) {
      differences.push(
        `swf2es output, line ${i + 1}: avmshell ${theirs[i] ?? "(end)"}, swf2es ${ours[i] ?? "(end)"}`,
      );
      break;
    }
  }

  for (const d of differences.slice(0, 20)) {
    console.log(`FAIL ${name}: ${d}`);
  }
  failed += differences.length ? 1 : 0;
  console.log(`     ${name} in swf2es, ${seconds} s:`);
  for (const l of lines2.filter((l) => l.startsWith("time: "))) {
    console.log(`       ${l.slice(6)}`);
  }

  console.log(
    `${failed ? "FAIL" : "ok  "} ${name}: exit ${r.exitCode}, ${output.split("\n").length - 1} expected lines, ${timings} timing lines`,
  );
}

if (failed) {
  process.exit(1);
}
