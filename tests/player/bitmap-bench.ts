// Full CPU applyFilter timing, including Wasm packing, owned copying and destination writes.
// Run under the machine lock: node tests/player/bitmap-bench.ts [fresh Chrome processes, 2].
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const runs = Number(process.argv[2] ?? 2);
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 20);
const results = [];
for (let run = 0; run < runs; run++) {
  const result = await withPage(
    "bitmapBench",
    async (evaluate, send) => {
      const call = async (phase: string, round = 0) => {
        const result = await evaluate(`bitmapBench(${JSON.stringify(phase)},${round})`);
        if (result.exception) {
          throw Error(result.exception);
        }

        return result.value;
      };
      const warm = await call("warm");
      await send("HeapProfiler.collectGarbage");
      const before = await send("Runtime.getHeapUsage");
      const rows = [];
      for (let round = 0; round < 9; round++) {
        rows.push(
          ...((await call("round", round)) as { workload: string; mode: string; ms: number }[]),
        );
      }

      const teardown = await call("dispose");
      await send("HeapProfiler.collectGarbage");
      const afterExit = await send("Runtime.getHeapUsage");
      return { warm, rows, before, teardown, afterExit };
    },
    false,
    { page: "page/bitmap-bench.html", timeout: 180000 },
  );
  results.push({ run, ...result });
}

console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
