// Flash's generator (packages/runtime/src/random.ts) against JavaScript's
// Math.random in node: ten million calls of each, directly and through
// AS3's Math.random native, the runs interleaved; the medians in ms.
//
//   node tests/bench/random.ts [runs, 7] [calls, 10000000]
import { createRuntime } from "../../packages/runtime/dist/avm2/index.js";
import { FlashRandom } from "../../packages/runtime/dist/random.js";

const runs = Number(process.argv[2] ?? 7);
const calls = Number(process.argv[3] ?? 10_000_000);
const flash = new FlashRandom();
const rt = createRuntime();
const native = rt.natives["Math.random"](rt) as () => number;

function time(draw: () => number): number {
  const started = performance.now();
  let sum = 0;
  for (let i = 0; i < calls; i++) {
    sum += draw();
  }

  if (!(sum > 0 && sum < calls)) {
    throw new Error("out of range");
  }

  return performance.now() - started;
}

const kinds: [string, () => number][] = [
  ["JavaScript Math.random", Math.random],
  ["FlashRandom.random", () => flash.random()],
  ["AS3 Math.random native", native],
];
const times = new Map<string, number[]>(kinds.map(([name]) => [name, []]));
for (let run = 0; run < runs + 1; run++) {
  for (let k = 0; k < kinds.length; k++) {
    const [name, draw] = kinds[(k + run) % kinds.length];
    const ms = time(draw);
    // The first run warms each up.
    if (run > 0) {
      times.get(name)?.push(ms);
    }
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
for (const [name, ms] of times) {
  console.log(`${name.padEnd(24)} ${median(ms).toFixed(1).padStart(8)} ms / ${calls} calls`);
}
