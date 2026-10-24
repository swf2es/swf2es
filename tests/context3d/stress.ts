// Repeated real-AS3 loads must release Context3D resources, wrappers and surfaces.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import { fixtureSource } from "./fixtures.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = fileURLToPath(new URL("out/", import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf("--loads");
const loads = at < 0 ? 48 : Number(args[at + 1]);
const warm = 8;
assert.ok(Number.isSafeInteger(loads) && loads > warm, "--loads must exceed 8");
mkdirSync(out, { recursive: true });
libraryAbcs();
const scripts = compileScripts([{ name: "Stress", source: fixtureSource("Stress") }], out);
const abc = scripts.get("Stress");
assert.ok(abc);
writeFileSync(`${out}Stress.swf`, bare(abc, 1, "Stress", 256, 256));

interface Status {
  loads: number;
  collectedObjects: number;
  made: number;
  removed: number;
  checks: number;
  listeners: number;
  handlesCreated: number;
  handlesDeleted: number;
  alive: Record<string, number>;
  codegen: { live: number; dead: number; memory: number };
}
interface Heap {
  usedSize: number;
  backingStorageSize: number;
}
interface Sample {
  status: Status;
  heap: Heap;
}

const samples: Sample[] = [];
await withPage(
  "runSwf",
  async (evaluate, send) => {
    const begin = await evaluate(
      'import("/repo/tests/context3d/stress-page.ts").then(m => m.begin())',
    );
    assert.equal(begin.exception, null, JSON.stringify(begin));
    for (let n = 1; n <= loads; n++) {
      const loaded = await evaluate(
        'import("/repo/tests/context3d/stress-page.ts").then(m => m.load())',
      );
      assert.equal(loaded.exception, null, `load ${n}: ${JSON.stringify(loaded)}`);
      if (n < warm || (n !== warm && n !== loads && n % 16 !== 0)) {
        continue;
      }

      const idle = await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      assert.equal(idle.exception, null, JSON.stringify(idle));
      await send("HeapProfiler.collectGarbage");
      const heap = await send<Heap>("Runtime.getHeapUsage");
      const result = await evaluate<Status>(
        'import("/repo/tests/context3d/stress-page.ts").then(m => m.collected())',
      );
      assert.equal(result.exception, null, JSON.stringify(result));
      const status = result.value;
      assert.ok(status);
      assert.equal(status.loads, n);
      assert.ok(status.collectedObjects >= n * 80, "stress omitted resource collection probes");
      assert.equal(status.made, status.removed);
      assert.equal(status.listeners, 0);
      assert.equal(status.handlesCreated, status.handlesDeleted);
      assert.deepEqual(
        status.alive,
        {},
        "retired AS/player/backend/surface objects remain reachable",
      );
      samples.push({ heap, status });
      writeFileSync(`${out}stress-results.json`, JSON.stringify(samples, null, 2));
      const baseline = samples[0];
      // A retained scene holds over a MiB of pixel/staging data. Allow small JIT/cache
      // growth, but fail well before even one such scene per repeated load could hide.
      const growth =
        heap.usedSize +
        heap.backingStorageSize -
        baseline.heap.usedSize -
        baseline.heap.backingStorageSize;
      assert.ok(
        growth <= 512 * 1024 + (n - warm) * 32 * 1024,
        `retained heap grew ${growth} bytes after ${n} loads`,
      );
      assert.ok(
        status.codegen.memory <= Math.max(baseline.status.codegen.memory, 32 * 1024 * 1024),
        "Context3D loads grew codegen's high-water mark",
      );
      console.log(
        `context3d stress: ${n} loads, ${status.made} surfaces released, ${status.checks} pixels checked, ${((heap.usedSize + heap.backingStorageSize) / 1048576).toFixed(2)} MiB JS/buffers, ${(status.codegen.memory / 1048576).toFixed(0)} MiB codegen`,
      );
    }
  },
  false,
  {
    mounts: [
      ["/repo/", root],
      ["/context3d/", out],
    ],
    timeout: 180000,
  },
);
