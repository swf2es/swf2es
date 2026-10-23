// Times the natives that walk an Array or a Vector (map, filter, forEach,
// every, some, sort, Vector conversion), Collections.as compiled by swf2es
// and run in node; its other lines must match avmshell's.
//
//   node tests/bench/native-collections/run.ts [runs, 5]                   the builds now
//   node tests/bench/native-collections/run.ts <dir A> <dir B> [runs, 5]   two snapshots
//
// Snapshots are tests/programs/ab.ts's (--snapshot <dir>), run interleaved
// as tests/bench/untyped/run.ts runs them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { libraries, runOracle } from "../../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const read = (name: string) => new Uint8Array(readFileSync(`${out}${name}`));

if (process.argv[2] === "--child") {
  const { runSwf2es } = await import("../../conformance/swf2es.ts");
  const lines = await runSwf2es(
    [read("lib/builtin.abc"), read("lib/shell_toplevel.abc")],
    read("Collections.abc"),
  );
  console.log(lines.join("\n"));
  process.exit(0);
}

const args = process.argv.slice(2);
const builds = args.length >= 2 ? [args[0], args[1]] : [];
const runs = Number(args[builds.length] ?? 5);
const [oracle] = runOracle([`${here}Collections.as`], out, { timeoutSeconds: 120 });
assert.equal(oracle.compiled, true, oracle.compileLog);
assert.equal(oracle.exitCode, 0, oracle.output);
libraries(["builtin", "shell_toplevel"], `${out}lib`);

const checked = (text: string) =>
  text
    .split("\n")
    .filter((line) => line && !line.startsWith("time:"))
    .join("\n");
const expected = checked(oracle.output);
const names = builds.length ? ["A", "B"] : ["now"];
const results = new Map<string, Map<string, number[]>>(names.map((name) => [name, new Map()]));

for (let round = 0; round < runs; round++) {
  const order = names.map((name, i) => [name, builds[i]] as const);
  for (const [name, directory] of round % 2 ? order.reverse() : order) {
    const text = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
      encoding: "utf8",
      env: directory
        ? {
            ...process.env,
            SWF2ES_RUNTIME: resolve(directory, "runtime"),
            SWF2ES_CODEGEN: resolve(directory, "codegen"),
          }
        : process.env,
    });
    assert.equal(checked(text), expected, `${name} must match avmshell`);
    const times = results.get(name) as Map<string, number[]>;
    for (const line of text.split("\n")) {
      const match = /^time: ([\w-]+) (\d+)$/.exec(line);
      if (match) {
        const values = times.get(match[1]) ?? [];
        values.push(Number(match[2]));
        times.set(match[1], values);
      }
    }
  }
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const half = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

for (const section of results.get(names[0])?.keys() ?? []) {
  const times = names.map((name) => results.get(name)?.get(section) as number[]);
  const summaries = times.map(
    (values, i) =>
      `${names[i]} ${median(values)} ms (${Math.min(...values)}–${Math.max(...values)})`,
  );
  if (builds.length) {
    summaries.push(`B/A ${((median(times[1]) / median(times[0]) - 1) * 100).toFixed(1)}%`);
  }

  console.log(`${section.padEnd(16)} ${summaries.join("  ")}`);
}
