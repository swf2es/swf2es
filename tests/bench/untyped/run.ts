// Times untyped property access, Untyped.as, compiled by swf2es and run in
// node: names on values typed `*`, which the compiler cannot bind, so that
// each get, set and call goes through the runtime's multiname lookup. Its
// sections trace their times ("time: display 120"), and its other lines
// must match avmshell's, which the oracle prints.
//
//   node tests/bench/untyped/run.ts [runs, 5]                   the builds now
//   node tests/bench/untyped/run.ts <dir A> <dir B> [runs, 7]   two snapshots
//
// Snapshots are tests/programs/ab.ts's (--snapshot <dir>); their runs are
// interleaved as ab.ts interleaves them, A, B, B, A, ..., each in a process
// of its own. Medians and ranges per section, and B against A.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { containerEngine, libraries, runOracle } from "../../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const read = (p: string) => new Uint8Array(readFileSync(`${out}${p}`));

if (process.argv[2] === "--child") {
  const { runSwf2es } = await import("../../conformance/swf2es.ts");
  const lines = await runSwf2es(
    [read("lib/builtin.abc"), read("lib/shell_toplevel.abc")],
    read("Untyped.abc"),
  );
  console.log(lines.join("\n"));
  process.exit(0);
}

const args = process.argv.slice(2);
const builds = args.length >= 2 ? [args[0], args[1]] : [];
const runs = Number(args[builds.length] ?? (builds.length ? 7 : 5));

// avmshell's run, which also compiles the ABC, and the builtins it loads.
const engine = containerEngine();
const [oracle] = runOracle([`${here}Untyped.as`], out, { engine, timeoutSeconds: 120 });
if (!oracle.compiled || oracle.exitCode !== 0) {
  console.log(`Untyped.as: avmshell exit ${oracle.exitCode}\n${oracle.compileLog}${oracle.output}`);
  process.exit(1);
}

libraries(["builtin", "shell_toplevel"], `${out}lib`, { engine });

const timed = (lines: string[]) =>
  lines.flatMap((l) => {
    const m = /^time: (\w+) (\d+)$/.exec(l);
    return m ? [[m[1], Number(m[2])] as const] : [];
  });
const checked = (lines: string[]) => lines.filter((l) => l && !l.startsWith("time: ")).join("\n");
const expected = checked(oracle.output.split("\n"));
const sections = timed(oracle.output.split("\n")).map(([s]) => s);

const names = builds.length ? ["A", "B"] : ["now"];
const times: Record<string, Record<string, number[]>> = {};
for (const name of names) {
  times[name] = {};
}

for (let run = 0; run < runs; run++) {
  // A then B, then B then A: neither always runs after the other.
  const order = names.map((n, i) => [n, builds[i]] as const);
  for (const [name, dir] of run % 2 ? order.reverse() : order) {
    const env = dir
      ? {
          ...process.env,
          SWF2ES_RUNTIME: resolve(dir, "runtime"),
          SWF2ES_CODEGEN: resolve(dir, "codegen"),
        }
      : process.env;
    const lines = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
      env,
      encoding: "utf8",
    }).split("\n");
    if (checked(lines) !== expected) {
      console.log(`FAIL ${name}: output differs from avmshell's`);
      console.log(`avmshell:\n${expected}\nswf2es:\n${checked(lines)}`);
      process.exit(1);
    }

    for (const [section, ms] of timed(lines)) {
      times[name][section] = [...(times[name][section] ?? []), ms];
    }
  }
}

const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const range = (v: number[]) => `${Math.min(...v)}–${Math.max(...v)}`;
const avmshell = new Map(timed(oracle.output.split("\n")));
for (const section of sections) {
  const parts = names.map((n) => {
    const v = times[n][section];
    return `${n} ${median(v)} ms (${range(v)})`;
  });
  if (builds.length) {
    const [a, b] = names.map((n) => median(times[n][section]));
    parts.push(`B/A ${(((b - a) / a) * 100).toFixed(1)}%`);
  }

  console.log(`${section.padEnd(8)} ${parts.join("  ")}  avmshell ${avmshell.get(section)} ms`);
}
