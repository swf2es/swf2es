// Bundle the experimental worker with this checkout's adapter. The URL prefix
// names the directory serving pixi/pixi.mjs beside the other built packages.
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function buildRenderWorker(output: string, prefix = "/"): Promise<void> {
  if (!prefix.startsWith("/") || !prefix.endsWith("/")) {
    throw new Error("worker asset prefix must start and end with /");
  }

  const esbuild = await import(
    new URL("../vendor/pixijs/node_modules/esbuild/lib/main.js", import.meta.url).href
  );
  await esbuild.build({
    stdin: {
      contents: `import { WebWorkerAdapter } from ${JSON.stringify(`${root}vendor/pixijs/lib/environment-webworker/WebWorkerAdapter.mjs`)};
      import { renderThread } from ${JSON.stringify(`${root}packages/player/dist/render/worker/thread.js`)};
      renderThread(self, WebWorkerAdapter);`,
      resolveDir: root,
      sourcefile: "render-worker.ts",
      loader: "ts",
    },
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: [`${prefix}pixi/*`],
    plugins: [
      {
        name: "worker-pixi",
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
            contents: `export * from ${JSON.stringify(`${prefix}pixi/pixi.mjs`)};`,
            loader: "js",
            resolveDir: root,
          }));
        },
      },
    ],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) {
    throw new Error("usage: node tools/render-worker.ts output.js [/asset-prefix/]");
  }

  await buildRenderWorker(process.argv[2], process.argv[3]);
}
