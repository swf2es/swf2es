// The player page's script, src/main.ts as tsc wrote it in dist/js/, bundled by Rspack into
// app/: one module, main.js, and Stage3D's backend as a chunk of its own, app/stage3d.js,
// which loads only once Stage3D is ticked. @swf2es/web is not in it: the page imports it from
// the browser build (packages/swf2es/dist/), which build.ts copies to player/, so the site
// plays what a CDN serves, in a few files rather than every module of every package.
import { rspack, type Stats } from "@rspack/core";

/** Bundle dist/js/main.js into `out`; `player` is the browser build's swf2es.js, by its URL path. */
export async function bundleApp(here: string, out: string, player: string): Promise<void> {
  const compiler = rspack({
    mode: "production",
    context: here,
    entry: { main: { import: "./dist/js/main.js", library: { type: "module" } } },
    target: ["web", "es2022"],
    output: {
      path: out,
      module: true,
      chunkFormat: "module",
      chunkLoading: "import",
      filename: "[name].js",
      chunkFilename: "[name].js",
      publicPath: "auto",
    },
    externalsType: "module",
    externals: { "@swf2es/web": player },
    module: {
      // import.meta.url the module's at run time, from which new URL finds the site's root.
      parser: { javascript: { importMeta: false, url: false } },
    },
    optimization: {
      // A chunk by the name its import gives it (webpackChunkName), as tests/site look for it.
      chunkIds: "named",
    },
    devtool: false,
    performance: { hints: false },
  });

  const stats = await new Promise<Stats>((done, fail) =>
    compiler.run((error, result) => (error || !result ? fail(error) : done(result))),
  );
  await new Promise((done) => compiler.close(done));
  if (stats.hasErrors()) {
    throw new Error(stats.toString({ colors: false, all: false, errors: true }));
  }
}
