// Times code that lives at a script's top level, as Crossbridge (FlasCC)
// compiles C: thousands of package-level variables and functions, which are
// the slots and methods of one script object, its stack pointer and return
// registers among the first slots, every function a method of the script.
// Globals.as is written here, VARS variables and FUNCS functions; its
// sections trace their times ("time: calls 120") and its other lines must
// match avmshell's, which the oracle prints. In V8 an object of that many
// properties, and a prototype of that many methods, is a dictionary.
//
//   node tests/bench/globals/run.ts [runs, 5]                   the builds now
//   node tests/bench/globals/run.ts <dir A> <dir B> [runs, 7]   two snapshots
//
// Snapshots are tests/programs/ab.ts's (--snapshot <dir>); their runs are
// interleaved as ab.ts interleaves them, A, B, B, A, ..., each in a process
// of its own. Medians and ranges per section, and B against A.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    read("Globals.abc"),
  );
  console.log(lines.join("\n"));
  process.exit(0);
}

const args = process.argv.slice(2);
const builds = args.length >= 2 ? [args[0], args[1]] : [];
const runs = Number(args[builds.length] ?? (builds.length ? 7 : 5));

// avmshell's run, which also compiles the ABC, and the builtins it loads.
const engine = containerEngine();
mkdirSync(out, { recursive: true });
writeFileSync(`${out}Globals.as`, globalsSource());
const [oracle] = runOracle([`${out}Globals.as`], out, { engine, timeoutSeconds: 120 });
if (!oracle.compiled || oracle.exitCode !== 0) {
  console.log(`Globals.as: avmshell exit ${oracle.exitCode}\n${oracle.compileLog}${oracle.output}`);
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

  console.log(`${section.padEnd(14)} ${parts.join("  ")}  avmshell ${avmshell.get(section)} ms`);
}

/**
 * The program: registers first, then VARS more variables and FUNCS
 * functions, each a C function's shape: it takes stack, works in the
 * registers and gives it back.
 */
function globalsSource(): string {
  const VARS = Number(process.env.GLOBALS_VARS ?? 4800);
  const FUNCS = Number(process.env.GLOBALS_FUNCS ?? 2000);
  const lines = [
    "package {",
    "  public var esp:int = 65536;",
    "  public var eax:int = 0;",
    "  public var edx:int = 0;",
  ];
  for (let i = 0; i < VARS; i++) {
    lines.push(`  public var g${i}:int = ${i};`);
  }

  for (let i = 0; i < FUNCS; i++) {
    lines.push(
      `  public function f${i}(a:int):int { esp = esp - 16; eax = a + ${i}; edx = eax ^ ${i & 255}; esp = esp + 16; return eax - edx; }`,
    );
  }

  lines.push(
    "  public function runSlots(n:int):Number { var s:Number = 0; for (var i:int = 0; i < n; i++) { esp = esp - 4; eax = i; s += eax; esp = esp + 4; } return s + esp; }",
    "  public function runCalls(n:int):Number { var s:Number = 0; for (var i:int = 0; i < n; i++) { s += f7(i) + fLAST(i); } return s; }",
    "  public function runHigh(n:int):Number { for (var i:int = 0; i < n; i++) { gHIGH = gHIGH + i; gMID = gMID ^ i; } return gHIGH + gMID; }",
    "}",
    "function time(name:String, f:Function, n:int):void {",
    "  var start:int = getTimer();",
    "  var r:* = f(n);",
    '  trace("time: " + name + " " + (getTimer() - start));',
    '  trace(name + " " + r);',
    "}",
    'time("slots", runSlots, 20000000);',
    'time("calls", runCalls, 5000000);',
    'time("high", runHigh, 20000000);',
  );
  return `${lines.join("\n")}\n`
    .replaceAll("gHIGH", `g${VARS - 100}`)
    .replaceAll("gMID", `g${Math.floor(VARS * 0.6)}`)
    .replaceAll("fLAST", `f${FUNCS - 500 > 7 ? FUNCS - 500 : FUNCS - 1}`);
}
