// AVM2 module emission in two compiler builds. Loading, linking and checking
// the generated text are outside the timer. The first four pairs warm up V8.
//
//   node tests/bench/codegen-strings.ts <before.wasm> <after.wasm> [pairs]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCodegen } from "../../packages/codegen/dist/index.js";
import {
  builtinLibrary,
  playerglobalLibrary,
} from "../../packages/player/dist/playerglobal/libraries.js";
import { abc, tables, u30 } from "../unit/codegen/abc-builder.ts";

const [before, after, count = "24"] = process.argv.slice(2);
const pairs = Number(count);
if (!before || !after || !Number.isSafeInteger(pairs) || pairs < 1) {
  throw new Error("usage: codegen-strings.ts <before.wasm> <after.wasm> [positive pair count]");
}

const modules = await Promise.all(
  [before, after].map((path) => WebAssembly.compile(readFileSync(path))),
);

interface Workload {
  name: string;
  libraries: Uint8Array[];
  program?: Uint8Array;
}

function literals(name: string, width: number, text: string): Workload {
  const content = text.repeat(Math.ceil(width / text.length)).slice(0, width);
  const strings = Array.from({ length: 256 }, (_, i) => String(i).padStart(3, "0") + content);
  // Push the strings, construct an array and return it so every literal is emitted.
  const code = strings.flatMap((_, i) => [0x2c, ...u30(i + 1)]);
  code.push(0x56, ...u30(strings.length), 0x48);
  const body = { method: 0, maxStack: strings.length, code };
  const program = abc(
    { strings },
    tables({ methods: [{}], scripts: [{ init: 0 }], bodies: [body] }),
  );

  return { name, libraries: [builtinLibrary], program };
}

async function run(wasm: WebAssembly.Module, workload: Workload) {
  const compiler = await createCodegen(wasm);
  compiler.reset();
  for (const library of workload.libraries) {
    assert.equal(compiler.add(library, true), 0);
  }

  let indices = workload.libraries.map((_, i) => i);
  if (workload.program) {
    assert.equal(compiler.add(workload.program), 0);
    indices = [workload.libraries.length];
  }

  const start = performance.now();
  const sources = indices.map((i) => compiler.compileModule([], i));
  const ms = performance.now() - start;
  if (workload.program) {
    assert.ok(sources[0].includes('"000') && sources[0].includes('"255'));
  }

  return { ms, sources };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
}

for (const workload of [
  { name: "builtin + playerglobal", libraries: [builtinLibrary, playerglobalLibrary] },
  literals("short ASCII", 16, "identifier_"),
  literals("long ASCII", 2048, "regular ASCII text "),
  literals("mixed", 2048, 'abc"\\\n\x7fé😀'),
  literals("escape-heavy", 256, '\n\t"\\'),
]) {
  const times: number[][] = [[], []];
  let reference: string[] | undefined;
  for (let pair = -4; pair < pairs; pair++) {
    for (const side of pair % 2 === 0 ? [0, 1] : [1, 0]) {
      const { ms, sources } = await run(modules[side], workload);
      reference ??= sources;
      assert.deepEqual(sources, reference);
      if (pair >= 0) {
        times[side].push(ms);
      }
    }
  }

  const [a, b] = times.map(median);
  console.log(
    `${workload.name}: ${a.toFixed(3)} ms -> ${b.toFixed(3)} ms (${(b / a).toFixed(3)}x)`,
  );
}
