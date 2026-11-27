// Times the ABC parser, the bytecode decoder and the verifier in the
// compiler's test build. Numbers are for comparing changes on one machine.
//
//   node tests/bench/bench.ts [file.abc...]
// Without files it uses abcdump.abc from the last conformance run.
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTesting } from "../unit/codegen/testing-module.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const testing = await loadTesting("testing");

const files = process.argv.slice(2);
if (!files.length) {
  files.push(`${root}tests/conformance/out/abcdump.abc`);
}

for (const file of files) {
  if (!existsSync(file)) {
    console.error(`${file} is missing; pnpm test builds abcdump.abc`);
    process.exit(1);
  }
}

/** Median over five samples of the time per round, in ms, after a warm-up. */
function time(
  fn: (bytes: Uint8Array, rounds: number) => number,
  bytes: Uint8Array,
  target = 200,
): number {
  fn(bytes, 3);
  const once = performance.now();
  fn(bytes, 1);
  const rounds = Math.max(1, Math.round(target / Math.max(performance.now() - once, 0.01) / 5));

  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    fn(bytes, rounds);
    samples.push((performance.now() - start) / rounds);
  }

  return samples.sort((a, b) => a - b)[2];
}

// Typed verification runs in a domain after the builtins avmshell loads,
// as the compiler verifies: those of the last conformance run.
const lib = `${root}tests/conformance/out/lib/`;
const builtins = ["builtin.abc", "shell_toplevel.abc"].map((f) => {
  if (!existsSync(`${lib}${f}`)) {
    console.error(`${lib}${f} is missing; pnpm test builds it`);
    process.exit(1);
  }

  return new Uint8Array(readFileSync(`${lib}${f}`));
});

console.log(
  "file                       KB   methods  instructions   parse ms    MB/s   decode ms  ns/instr   verify ms   µs/body",
);
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const methods = testing.benchParse(bytes, 1);
  const instructions = testing.benchDecode(bytes, 1);
  const parse = time(testing.benchParse, bytes);
  const decode = time(testing.benchDecode, bytes);
  // Each sample verifies the ABC as it is compiled, once, in a domain made
  // for it, whose linking is not timed.
  const linked = () => {
    testing.domainReset(50);
    for (const b of builtins) {
      testing.domainAdd(b, true);
    }

    return testing.domainAdd(bytes, false) === 0;
  };
  const verifiedOnce = (): [number, number] => {
    linked();
    const start = performance.now();
    const summary: string = testing.domainVerifyAll();
    const ms = performance.now() - start;
    return [ms, Number(summary.match(/verified (\d+) of \d+ bodies$/)?.[1] ?? 0)];
  };
  const verified = linked() ? verifiedOnce()[1] : 0;
  const verify = verified
    ? [0, 1, 2, 3, 4].map(() => verifiedOnce()[0]).sort((a, b) => a - b)[2]
    : Number.NaN;
  const mb = bytes.length / 1024 / 1024;
  console.log(
    [
      basename(file).padEnd(22),
      (bytes.length / 1024).toFixed(0).padStart(6),
      String(methods).padStart(9),
      String(instructions).padStart(13),
      parse.toFixed(3).padStart(10),
      (mb / (parse / 1000)).toFixed(0).padStart(7),
      decode.toFixed(3).padStart(11),
      ((decode * 1e6) / instructions).toFixed(1).padStart(9),
      verify.toFixed(3).padStart(12),
      ((verify * 1e3) / verified).toFixed(1).padStart(9),
    ].join(""),
  );
}
