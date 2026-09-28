// Times two builds of swf2es against each other on as3pb, in node alone:
// the ABC tests/programs compiled, compiled again and run by each build in
// turn, A, B, B, A, A, B, ..., each run in a process of its own as the
// programs runner runs it. Interleaved, both builds see the same load on
// the machine, and neither always runs after the other. The totals of
// as3pb's two AS3PB paths, median and range, per build.
//
//   node tests/programs/ab.ts --snapshot <dir>    the builds now, into <dir>
//   node tests/programs/ab.ts <dir A> <dir B> [runs, 7]
//
// A snapshot holds the runtime's dist and the compiler's release test
// build (packages/runtime/dist, packages/codegen/dist-test), so that a
// change to either can be timed: snapshot, change, build, snapshot again.
// AB_NODE_ARGS="--flag ..." runs both with those node options, such as V8
// flags to measure a change against.
// Run tests/programs first, for out/as3pb/ShellMain.abc and the builtins.
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

if (process.argv[2] === "--child") {
  const { runSwf2es } = await import("../conformance/swf2es.ts");
  const read = (p: string) => new Uint8Array(readFileSync(`${here}out/${p}`));
  const lines = await runSwf2es(
    [read("lib/builtin.abc"), read("lib/shell_toplevel.abc")],
    read("as3pb/ShellMain.abc"),
  );
  console.log(lines.filter((l) => l.startsWith("time: AS3PB")).join("\n"));
  process.exit(0);
}

if (process.argv[2] === "--snapshot") {
  const dir = resolve(process.argv[3]);
  rmSync(dir, { recursive: true, force: true });
  cpSync(`${root}packages/runtime/dist`, join(dir, "runtime"), { recursive: true });
  cpSync(`${root}packages/codegen/dist-test`, join(dir, "codegen"), { recursive: true });
  console.log(`snapshot of the builds in ${dir}`);
  process.exit(0);
}

const [a, b, runsArg] = process.argv.slice(2);
if (!a || !b) {
  console.log("usage: node tests/programs/ab.ts --snapshot <dir> | <dir A> <dir B> [runs]");
  process.exit(1);
}

const runs = Number(runsArg ?? 7);
const paths = ["bytes", "memory"];
const times: Record<string, Record<string, number[]>> = { A: {}, B: {} };
for (let run = 0; run < runs; run++) {
  // A then B, then B then A: neither always runs after the other.
  const pair = [
    ["A", a],
    ["B", b],
  ];
  for (const [name, dir] of run % 2 ? pair.reverse() : pair) {
    const flags = (process.env.AB_NODE_ARGS ?? "").split(" ").filter((f) => f);
    const out = execFileSync(
      process.execPath,
      [...flags, fileURLToPath(import.meta.url), "--child"],
      {
        env: {
          ...process.env,
          SWF2ES_RUNTIME: resolve(dir, "runtime"),
          SWF2ES_CODEGEN: resolve(dir, "codegen"),
        },
        encoding: "utf8",
      },
    );
    for (const path of paths) {
      // Serialize, deserialize, then the total: the last line for the path.
      const all = [...out.matchAll(new RegExp(`AS3PB ${path}: (\\d+)ms`, "g"))];
      times[name][path] = [...(times[name][path] ?? []), Number(all[all.length - 1][1])];
    }
  }
}

const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
for (const path of paths) {
  const [ma, mb] = [median(times.A[path]), median(times.B[path])];
  const range = (v: number[]) => `${Math.min(...v)}–${Math.max(...v)}`;
  const change = (((mb - ma) / ma) * 100).toFixed(1);
  console.log(
    `${path.padEnd(6)} A ${ma} ms (${range(times.A[path])})  B ${mb} ms (${range(times.B[path])})  B/A ${change}%`,
  );
}
