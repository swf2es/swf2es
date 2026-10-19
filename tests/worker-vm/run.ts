// Opt-in feasibility probes: node tests/worker-vm/run.ts (after pnpm build).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { withPage } from "../player/chrome.ts";
import { serve } from "../player/serve.ts";
import { buildExperiment } from "./build.ts";
import { checkPlayback } from "./playback-check.ts";

const { out } = await buildExperiment();

interface Result {
  kind: string;
  mode: string;
  outcomes: { value?: unknown; error?: string }[];
  events: string[];
  reports: string[];
  calls: number;
  spins: number;
  transport: string[];
  blocking: null | {
    elapsed: number;
    microtaskRan: boolean;
    timerRan: boolean;
    rafRan: boolean;
    asyncTasks: number;
  };
}

async function checkExternal(): Promise<void> {
  const results: Result[] = [];
  await withPage(
    "runWorkerVm",
    async (evaluate) => {
      const isolation = await evaluate<boolean>("crossOriginIsolated");
      assert.equal(isolation.value, true, "experiment needs SharedArrayBuffer isolation");
      for (const kind of ["avm1", "avm2"]) {
        const run = async (mode: string) => {
          const answer = await evaluate<Result>(
            `runWorkerVm(${JSON.stringify(kind)}, ${JSON.stringify(mode)})`,
          );
          assert.equal(answer.exception, null, JSON.stringify(answer));
          assert.ok(answer.value);
          results.push(answer.value);
          return answer.value;
        };
        const direct = await run("direct");
        const diagnostic = await run("diagnostic-spin");
        assert.equal(direct.outcomes.length, 126);
        assert.equal(direct.outcomes[0].value, "leaf");
        assert.notEqual(
          direct.outcomes[2].value,
          "leaf",
          `${kind}: the VM throw must interrupt its callback`,
        );
        for (let depth = 0; depth <= 6; depth++) {
          assert.ok(direct.events.includes(`throw:${depth}`), `${kind}: throw at depth ${depth}`);
        }
        assert.equal(direct.outcomes[96].value, "vm(page(vm(page(vm(page(leaf))))))");
        assert.deepEqual(diagnostic.outcomes, direct.outcomes, `${kind}: nested results/errors`);
        assert.deepEqual(diagnostic.events, direct.events, `${kind}: nested call order`);
        assert.deepEqual(diagnostic.reports, direct.reports, `${kind}: error reports`);
        assert.ok(diagnostic.calls > 0 && diagnostic.spins > 0);
        assert.deepEqual(diagnostic.transport, [
          "payload exceeds",
          "response exceeds",
          "nesting exceeds",
          "timeout; endpoint closed",
          "bridge closed",
          "worker wait cancelled",
        ]);
        const blocked = diagnostic.blocking;
        assert.ok(blocked);
        assert.ok(blocked.elapsed >= 90, JSON.stringify(blocked));
        assert.equal(blocked.microtaskRan, false);
        assert.equal(blocked.timerRan, false);
        assert.equal(blocked.rafRan, false);
        assert.ok(blocked.asyncTasks > 0, JSON.stringify(blocked));
        const rejected = await run("reject");
        assert.ok(rejected.outcomes.every((value) => value.error));
        assert.ok(rejected.reports.some((error) => error.includes("requires blocking main")));
        assert.equal(rejected.calls, 0);
        assert.equal(rejected.spins, 0);
        console.log(
          `${kind}: ${direct.outcomes.length} synchronous result/error comparisons and call order match main; ` +
            `diagnostic spin blocks main for ${blocked.elapsed.toFixed(1)} ms; ` +
            `async worker work allows ${blocked.asyncTasks} main tasks; nonblocking callbacks rejected`,
        );
      }
    },
    false,
    {
      mounts: [["/experiment/", out]],
      page: "experiment/index.html",
      timeout: 45_000,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  );
  writeFileSync(`${out}results.json`, `${JSON.stringify(results, null, 2)}\n`);
}

interface BitmapResult {
  kind: string;
  mode: string;
  reads: string[];
  pixels: number[];
  startup: string;
  elapsed: number;
  stats: Record<string, number>;
  mainSpins: number;
  mainRenderers: number;
  image: string;
}

async function checkBitmaps(): Promise<void> {
  const bitmapResults: BitmapResult[] = [];
  await withPage(
    "runBitmapVm",
    async (evaluate, _send, fresh) => {
      for (const kind of ["avm1", "avm2"]) {
        for (const seed of [0, 1]) {
          const repeats = seed === 0 ? 1 : 3;
          let baseline: BitmapResult | undefined;
          for (const mode of ["direct", "main-renderer", "worker-renderer"]) {
            const answer = await evaluate<BitmapResult>(
              `runBitmapVm(${JSON.stringify(kind)}, ${JSON.stringify(mode)}, ${seed}, ${repeats})`,
            );
            assert.equal(answer.exception, null, JSON.stringify(answer));
            const value = answer.value;
            assert.ok(value);
            writeFileSync(
              `${out}bitmap-${kind}-${mode}-${seed}.json`,
              `${JSON.stringify(value, null, 2)}\n`,
            );
            baseline ??= value;
            assert.deepEqual(value.reads, baseline.reads, `${kind}/${mode}: immediate reads`);
            assert.deepEqual(value.pixels, baseline.pixels, `${kind}/${mode}: full bitmap`);
            assert.equal(value.startup, baseline.startup, `${kind}/${mode}: constructor drawing`);
            const initial = value.startup
              .split("|")[0]
              .split(",")
              .map((hex) => (Number.parseInt(hex, 16) >>> 0).toString(16));
            assert.deepEqual(initial.slice(0, 7), [
              "ff336699",
              "ffff3300",
              "ff33cc66",
              "ff336699",
              "0",
              "ff33cc66",
              "ff33cc66",
            ]);
            assert.deepEqual(value.reads.slice(0, 7), [
              "ff336699",
              "ffff3300",
              seed === 0 ? "ff33cc66" : "ffcc66ff",
              "ff336699",
              "0",
              seed === 0 ? "ff33cc66" : "ffcc66ff",
              seed === 0 ? "ff33cc66" : "ffcc66ff",
            ]);
            assert.equal(value.mainSpins, 0);
            assert.equal(value.mainRenderers, 1);
            assert.equal(value.stats.workerRenderers, mode === "worker-renderer" ? 1 : 0);
            if (mode === "main-renderer") {
              assert.equal(value.stats.unsupportedRejected, 1);
              assert.equal(value.stats.requests, 7 * (repeats + 1));
              assert.equal(value.stats.mainReadbacks, value.stats.requests);
              assert.ok(value.stats.pixelBytes > 0 && value.stats.sceneBytes > 0);
            }
            bitmapResults.push(value);
            console.log(
              `${kind}/${mode}: ${repeats * 9} immediate reads and 1280 pixels match; ${value.elapsed.toFixed(1)} ms; main spins ${value.mainSpins}`,
            );
          }
          await fresh();
        }
      }
    },
    false,
    {
      mounts: [["/experiment/", out]],
      page: "experiment/bitmap.html",
      timeout: 60_000,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  );
  writeFileSync(`${out}bitmap-results.json`, `${JSON.stringify(bitmapResults, null, 2)}\n`);
}

if (process.argv.includes("--serve")) {
  const { server, url } = await serve([["/experiment/", out]], undefined, {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  console.log(`Bitmap preview: ${url}experiment/bitmap.html`);
  console.log(`Playback preview: ${url}experiment/playback.html`);
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
} else if (process.argv.includes("--playback")) {
  await checkPlayback(out, process.argv.includes("--gpu"));
} else {
  if (!process.argv.includes("--bitmap")) {
    await checkExternal();
  }
  await checkBitmaps();
  if (!process.argv.includes("--bitmap")) {
    await checkPlayback(out, process.argv.includes("--gpu"));
  }
}
