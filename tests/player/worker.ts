import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withPage } from "./chrome.ts";
import { importMap } from "./serve.ts";
import { workerScene } from "./worker-scene.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
// Use the existing fork build dependency; workers do not inherit a page's import map.
const esbuild = await import(
  new URL("../../vendor/pixijs/node_modules/esbuild/lib/main.js", import.meta.url).href
);
await esbuild.build({
  entryPoints: [`${here}worker-entry.ts`],
  outfile: `${here}out/worker/entry.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["/pixi/*"],
  plugins: [
    {
      name: "worker-adapter",
      setup(build: {
        onResolve(
          options: { filter: RegExp },
          resolve: () => { path: string; namespace: string },
        ): void;
        onLoad(
          options: { filter: RegExp; namespace: string },
          load: () => { contents: string; loader: "js"; resolveDir: string },
        ): void;
      }) {
        build.onResolve({ filter: /^pixi\.js$/ }, () => ({ path: "pixi", namespace: "worker" }));
        build.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
          // Keep Pixi's DOM adapter singleton shared with the existing player
          // bundle, while its worker-only XML parser stays out of that bundle.
          contents: `export * from "/pixi/pixi.mjs";
          export { WebWorkerAdapter } from ${JSON.stringify(`${root}vendor/pixijs/lib/environment-webworker/WebWorkerAdapter.mjs`)};`,
          loader: "js",
          resolveDir: root,
        }));
      },
    },
  ],
});
mkdirSync(`${here}out/worker`, { recursive: true });
writeFileSync(
  `${here}out/worker/index.html`,
  `<!doctype html><body>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script type="module" src="/page/worker-page.ts"></script>`,
);
await withPage(
  "runWorkerTest",
  async (evaluate) => {
    const result = await evaluate<string[]>(
      `runWorkerTest(${JSON.stringify(Buffer.from(workerScene()).toString("base64"))})`,
    );
    assert.equal(result.exception, null);
    assert.equal(result.value?.length, 4);
    for (const name of result.value ?? []) {
      console.log(`worker: ok ${name}`);
    }
  },
  process.argv.includes("--gpu"),
  { page: "page/out/worker/index.html", isolated: true, timeout: 30_000 },
);
