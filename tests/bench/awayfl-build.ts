// Bundle the local checkout and its installed peers; no third-party source is committed.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, dependencies] = process.argv.slice(2);
if (!checkout || !dependencies) {
  throw new Error("usage: node tests/bench/awayfl-build.ts /path/to/avm2 /path/to/node_modules");
}
const require = createRequire(pathToFileURL(resolve(dependencies, "../package.json")));
const { rollup } = require("rollup");
const { nodeResolve } = require("@rollup/plugin-node-resolve");
const commonjs = require("@rollup/plugin-commonjs");
const entry = "swf2es-awayfl-entry";
const base = resolve(checkout, "dist");
const bundle = await rollup({
  input: entry,
  plugins: [
    {
      name: "benchmark-entry",
      resolveId(id: string) {
        if (id === entry) {
          return entry;
        }
        if (!id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0")) {
          const direct = resolve(dependencies, `${id}.js`);
          if (existsSync(direct)) {
            return direct;
          }
          const manifestPath = resolve(dependencies, id, "package.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          return resolve(dependencies, id, manifest.module || manifest.main);
        }

        return null;
      },
      load(id: string) {
        if (id !== entry) {
          return null;
        }

        return [
          `export { ABCFile } from ${JSON.stringify(`${base}/lib/abc/lazy/ABCFile.js`)};`,
          `export { analyze } from ${JSON.stringify(`${base}/lib/gen/analyze.js`)};`,
          `export { initlazy } from ${JSON.stringify(`${base}/lib/abc/lazy.js`)};`,
          `export { Settings } from ${JSON.stringify(`${base}/lib/Settings.js`)};`,
        ].join("\n");
      },
    },
    nodeResolve({ modulePaths: [resolve(dependencies)], mainFields: ["module", "main"] }),
    commonjs(),
  ],
  // Importing a player entry point would initialize unrelated renderer/browser state.
  treeshake: { moduleSideEffects: false },
});
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
await bundle.write({ file: new URL("./out/awayfl.js", import.meta.url).pathname, format: "es" });
await bundle.close();
