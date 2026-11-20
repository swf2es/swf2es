// The browser build: @swf2es/web and what it loads, bundled by Rspack
// into ES modules that find one another by relative URL, so that the
// folder works wherever it is served from, a CDN among them, with no
// import map. dist/swf2es.js defines <swf2es-player>; the renderer,
// Stage3D and the workers' host are chunks it loads as a SWF needs them;
// dist/worker.js is what a Flash Worker runs; codegen.wasm lies beside
// them. dist/plugin.js, a classic script of its own, lists Flash's plug-in
// for a page's detection scripts. Run after `pnpm build`, which builds the
// packages it bundles:
//
//   node packages/swf2es/build.ts
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type MultiStats, type RuleSetRule, rspack } from "@rspack/core";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = `${here}dist`;
rmSync(dist, { recursive: true, force: true });

const typescript: RuleSetRule = {
  test: /\.ts$/,
  loader: "builtin:swc-loader",
  options: { jsc: { parser: { syntax: "typescript" }, target: "es2022" } },
  type: "javascript/auto",
};

const compiler = rspack([
  {
    mode: "production",
    context: here,
    entry: {
      // Its exports @swf2es/web's, for a page's module script to import.
      swf2es: { import: "./src/swf2es.ts", library: { type: "module" } },
      worker: "./src/worker.ts",
    },
    target: ["web", "es2022"],
    output: {
      path: dist,
      module: true,
      chunkFormat: "module",
      chunkLoading: "import",
      filename: "[name].js",
      chunkFilename: "chunks/[contenthash:16].js",
      assetModuleFilename: "[name][ext]",
      // Chunks and codegen.wasm by the URL of the module that asks for them, wherever it is
      // served; src/public-path.ts moves both under dist/ for a CDN's package URL.
      publicPath: "auto",
    },
    resolve: { extensions: [".ts", ".js"] },
    module: {
      rules: [
        // codegen.wasm copied beside the bundle, its import its URL.
        { test: /\.wasm$/, type: "asset/resource" },
        // Its import.meta.url the bundle's at run time, which Rspack would fix as the source file's.
        { test: /src[\\/]public-path\.ts$/, parser: { importMeta: false } },
        typescript,
      ],
    },
    // player-hosts' default worker script, its unbundled thread/ tree, which this build replaces
    // with worker.js (src/swf2es.ts): not copied.
    plugins: [new rspack.IgnorePlugin({ resourceRegExp: /thread\/player-hosts\/web-worker\.js$/ })],
    // @swf2es/web's default codegen.wasm URL comes from an import map (import.meta.resolve), which
    // a bundle has not; src/swf2es.ts gives it the URL, so that path is never taken.
    ignoreWarnings: [{ module: /web[\\/]dist[\\/]config\.js$/, message: /import\.meta/ }],
    devtool: "source-map",
    performance: { hints: false },
  },
  {
    // A classic script, which a page's <script src> runs as the page reads it, as no module
    // runs: one function, all in one file.
    mode: "production",
    context: here,
    entry: { plugin: "./src/plugin.ts" },
    target: ["web", "es2022"],
    output: { path: dist, filename: "[name].js", iife: true },
    resolve: { extensions: [".ts", ".js"] },
    module: { rules: [typescript] },
    devtool: "source-map",
  },
]);

const stats = await new Promise<MultiStats>((done, fail) =>
  compiler.run((error, result) => (error || !result ? fail(error) : done(result))),
);
await new Promise((done) => compiler.close(done));
if (stats.hasErrors()) {
  console.error(stats.toString({ colors: false, all: false, errors: true }));
  process.exit(1);
}

console.log(stats.toString({ colors: false, all: false, assets: true, warnings: true }));
