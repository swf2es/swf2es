import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRenderWorker } from "../../tools/render-worker.ts";
import { withPage } from "./chrome.ts";
import { importMap } from "./serve.ts";
import { workerContentScene } from "./worker-scene.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(`${here}out/worker`, { recursive: true });
await buildRenderWorker(`${here}out/worker/host-entry.js`);
writeFileSync(
  `${here}out/worker/host.html`,
  `<!doctype html><body><script type="importmap">${JSON.stringify(importMap)}</script><script type="module" src="/page/worker-host-page.ts"></script>`,
);
await withPage(
  "runWorkerHostTest",
  async (evaluate) => {
    const result = await evaluate<string[]>(
      `runWorkerHostTest(${JSON.stringify(Buffer.from(workerContentScene()).toString("base64"))})`,
    );
    assert.equal(result.exception, null);
    assert.equal(result.value?.length, 8);
    for (const name of result.value ?? []) {
      console.log(`worker host: ok ${name}`);
    }
  },
  process.argv.includes("--gpu"),
  { page: "page/out/worker/host.html", isolated: true, timeout: 60_000 },
);
