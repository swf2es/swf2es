// Times two builds of swf2es against each other on as3pb, in node alone:
// the ABC tests/programs compiled, compiled again and run by each build in
// turn, A, B, B, A, A, B, ..., each run in a process of its own as the
// programs runner runs it. Interleaved, both builds see the same load on
// the machine, and neither always runs after the other. The totals of
// as3pb's two AS3PB paths, or the lines AB_PATHS names, median and range,
// per build.
//
//   node tests/programs/ab.ts --snapshot <dir>    the builds now, into <dir>
//   node tests/programs/ab.ts <dir A> <dir B> [runs, 7]
//
// A snapshot holds the runtime's dist and the compiler's release test
// build (packages/runtime/dist, packages/codegen/dist-test), with format's
// dist and its dependencies for the runtime to import, so that a change to
// any of them can be timed: snapshot, change, build, snapshot again.
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
  console.log(lines.filter((l) => l.startsWith("time: ")).join("\n"));
  process.exit(0);
}

if (process.argv[2] === "--snapshot") {
  const dir = resolve(process.argv[3]);
  rmSync(dir, { recursive: true, force: true });
  cpSync(`${root}packages/runtime/dist`, join(dir, "runtime"), { recursive: true });
  cpSync(`${root}packages/codegen/dist-test`, join(dir, "codegen"), { recursive: true });
  // The runtime imports format, and format pako and lzma1: a copy of each
  // where the runtime's imports find them, as node resolves a package.
  const format = join(dir, "node_modules/@swf2es/format");
  cpSync(`${root}packages/format/dist`, join(format, "dist"), { recursive: true });
  cpSync(`${root}packages/format/package.json`, join(format, "package.json"));
  for (const dependency of ["pako", "lzma1"]) {
    cpSync(
      `${root}packages/format/node_modules/${dependency}`,
      join(dir, "node_modules", dependency),
      {
        recursive: true,
        dereference: true,
      },
    );
  }

  console.log(`snapshot of the builds in ${dir}`);
  process.exit(0);
}

const [a, b, runsArg] = process.argv.slice(2);
if (!a || !b) {
  console.log("usage: node tests/programs/ab.ts --snapshot <dir> | <dir A> <dir B> [runs]");
  process.exit(1);
}

const runs = Number(runsArg ?? 7);
// Each path as the name of as3pb's timing line and which of its lines to
// take, 1 for serialize, 2 for deserialize, 3 for the total: by default the
// totals of AS3PB's two, else AB_PATHS, as "AMF3:2,JSON:1".
const paths = (process.env.AB_PATHS ?? "AS3PB bytes:3,AS3PB memory:3").split(",").map((p) => {
  const at = p.lastIndexOf(":");
  return { name: p.slice(0, at), line: Number(p.slice(at + 1)) };
});
const label = (p: (typeof paths)[number]) =>
  p.name.startsWith("AS3PB ") && p.line === 3
    ? p.name.slice(6)
    : `${p.name} ${["", "encode", "decode", "total"][p.line]}`;
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
      const all = [...out.matchAll(new RegExp(`time: ${path.name}: (\\d+)ms`, "g"))];
      const key = label(path);
      times[name][key] = [...(times[name][key] ?? []), Number(all[path.line - 1][1])];
    }
  }
}

const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
for (const key of paths.map(label)) {
  const [ma, mb] = [median(times.A[key]), median(times.B[key])];
  const range = (v: number[]) => `${Math.min(...v)}–${Math.max(...v)}`;
  const change = (((mb - ma) / ma) * 100).toFixed(1);
  console.log(
    `${key.padEnd(6)} A ${ma} ms (${range(times.A[key])})  B ${mb} ms (${range(times.B[key])})  B/A ${change}%`,
  );
}
