// Times the ABC parser and the bytecode decoder in the release build of the
// test module. Numbers are for comparing changes on one machine.
//
//   node tests/bench/bench.ts [file.abc...]
// Without files it uses abcdump.abc from the last conformance run.
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = `${root}packages/codegen/dist-test/`;
const { instantiate } = await import(`${dir}testing.js`);
const testing = await instantiate(await WebAssembly.compile(readFileSync(`${dir}testing.wasm`)), {
  env: {},
});

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

/** Median over `samples` of the time per round, in ms, after a warm-up. */
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

console.log(
  "file                       KB   methods  instructions   parse ms    MB/s   decode ms  ns/instr",
);
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const methods = testing.benchParse(bytes, 1);
  const instructions = testing.benchDecode(bytes, 1);
  const parse = time(testing.benchParse, bytes);
  const decode = time(testing.benchDecode, bytes);
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
    ].join(""),
  );
}
