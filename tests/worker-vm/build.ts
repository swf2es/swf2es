// Build only the opt-in experiments and their redistributable fixtures.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flashAssembler, script } from "../avm1-script.ts";
import { bare } from "../player/cases.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";

export async function buildExperiment() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const out = `${here}out/`;
  mkdirSync(out, { recursive: true });
  libraryAbcs();
  const abcs = compileScripts(
    [
      { name: "WorkerExternal", source: readFileSync(`${here}scripts/WorkerExternal.as`, "utf8") },
      { name: "WorkerBitmap", source: readFileSync(`${here}scripts/WorkerBitmap.as`, "utf8") },
    ],
    out,
  );
  const abc = abcs.get("WorkerExternal");
  if (!abc) {
    throw new Error("missing WorkerExternal ABC");
  }
  writeFileSync(`${out}avm2.swf`, bare(abc, 1, "WorkerExternal", 20, 20));
  const bitmapAbc = abcs.get("WorkerBitmap");
  if (!bitmapAbc) {
    throw new Error("missing WorkerBitmap ABC");
  }
  writeFileSync(`${out}avm2-bitmap.swf`, bare(bitmapAbc, 1, "WorkerBitmap", 40, 32));
  const bitmap = `
var EI = flash.external.ExternalInterface;
function hex(value) { return (value >>> 0).toString(16); }
function bitmap(seed, repeats) {
  var reads = [];
  var d;
  for (var repeat = 0; repeat < repeats; repeat++) {
    var s = _root.createEmptyMovieClip("source", 100);
    var back = s.attachMovie("blue", "back", 1);
    var front = s.attachMovie("red", "front", 2);
    front._x = 4; front._y = 6;
    s._x = 100; s._y = 50;
    d = new flash.display.BitmapData(40, 32, true, 0);
    d.draw(s);
    reads.push(hex(d.getPixel32(2, 2))); reads.push(hex(d.getPixel32(10, 10)));
    var symbol = "green";
    if (seed % 2 != 0) { symbol = "purple"; }
    front.removeMovieClip();
    front = s.attachMovie(symbol, "front", 2); front._x = 4; front._y = 6;
    d.draw(s); reads.push(hex(d.getPixel32(10, 10)));
    front.swapDepths(back);
    d.draw(s); reads.push(hex(d.getPixel32(10, 10)));
    back.removeMovieClip(); d.fillRect(d.rectangle, 0);
    d.draw(s); reads.push(hex(d.getPixel32(2, 2))); reads.push(hex(d.getPixel32(10, 10)));
    front.swapDepths(2); back = s.attachMovie("blue", "back", 1);
    d.fillRect(d.rectangle, 0);
    d.draw(s, new flash.geom.Matrix(-1, 0, 0, 1, 32, 0)); reads.push(hex(d.getPixel32(21, 10)));
    d.draw(s, new flash.geom.Matrix(1, 0, 0, 1, 4, 4), new flash.geom.ColorTransform(1, 0.5, 1, 0.5),
      "normal", new flash.geom.Rectangle(4, 4, 32, 24)); reads.push(hex(d.getPixel32(14, 14)));
    d.draw(s, new flash.geom.Matrix(1, 0, 0, 1, 4, 4), null, "multiply"); reads.push(hex(d.getPixel32(14, 14)));
  }
  var pixels = [];
  for (var y = 0; y < 32; y++) {
    for (var x = 0; x < 40; x++) { pixels.push(hex(d.getPixel32(x, y))); }
  }
  return reads.join(",") + "|" + pixels.join(",");
}
EI.addCallback("bitmap", null, bitmap);
EI.call("bitmapReport", bitmap(0, 1));
stop();`;
  const symbols: Uint8Array[] = [];
  const colors = [0x336699, 0xff3300, 0x33cc66, 0xcc66ff];
  for (let i = 0; i < colors.length; i++) {
    const width = (i === 0 ? 32 : 16) * 20;
    const height = (i === 0 ? 24 : 12) * 20;
    symbols.push(
      w.shape({
        id: i + 1,
        bounds: [0, width, 0, height],
        fills: [colors[i]],
        paths: [
          {
            fill1: 1,
            commands: [
              { move: [0, 0] },
              { line: [width, 0] },
              { line: [width, height] },
              { line: [0, height] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.sprite(i + 11, 1, [w.place({ depth: 1, character: i + 1 }), w.showFrame(), w.end()]),
    );
  }
  writeFileSync(
    `${out}avm1-bitmap.swf`,
    w.swf({
      version: 8,
      width: 40,
      height: 32,
      frameCount: 1,
      tags: [
        ...symbols,
        w.exportAssets([
          [11, "blue"],
          [12, "red"],
          [13, "green"],
          [14, "purple"],
        ]),
        w.doAction([...script(bitmap, 8)(flashAssembler()).end().bytes()]),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  const avm1 = `
var EI = flash.external.ExternalInterface;
EI.addCallback("nest", null, function(depth, failure) {
  trace("vm:" + depth);
  if (failure == "vm:" + depth) {
    trace("throw:" + depth);
    __op("Throw", "vm failure " + depth);
  }
  if (depth == 0) { return "leaf"; }
  return "vm(" + EI.call("probePage", depth - 1, failure) + ")";
});
EI.addCallback("outbound", null, function(depth, failure) {
  return EI.call("probePage", depth, failure);
});
EI.call("probePage", 0, "");
stop();`;
  writeFileSync(
    `${out}avm1.swf`,
    w.swf({
      version: 8,
      width: 20,
      height: 20,
      frameCount: 1,
      tags: [
        w.doAction([...script(avm1, 8)(flashAssembler()).end().bytes()]),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  writeFileSync(`${out}bitmap.html`, readFileSync(`${here}bitmap.html`));

  // Reuse the fork's existing build tool; no dependency or production bundle changes.
  const esbuild = await import(
    new URL("../../vendor/pixijs/node_modules/esbuild/lib/main.js", import.meta.url).href
  );
  await esbuild.build({
    entryPoints: [`${here}page.ts`, `${here}thread.ts`, `${here}bitmap-page.ts`],
    outdir: out,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    plugins: [
      {
        name: "existing-pixi-bundle",
        setup(build: { onResolve(options: { filter: RegExp }, resolve: () => object): void }) {
          build.onResolve({ filter: /^pixi\.js$/ }, () => ({
            path: "/pixi/pixi.mjs",
            external: true,
          }));
        },
      },
    ],
  });
  // The renderer comparison needs DOMAdapter, outside the production bundle's
  // intentionally small export list. Bundle the fork locally for this worker.
  await esbuild.build({
    entryPoints: [`${here}bitmap-thread.ts`],
    outfile: `${out}bitmap-thread.js`,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    plugins: [
      {
        name: "comparison-pixi",
        setup(build: { onResolve(options: { filter: RegExp }, resolve: () => object): void }) {
          build.onResolve({ filter: /^pixi\.js$/ }, () => ({
            path: fileURLToPath(new URL("../../vendor/pixijs/lib/index.mjs", import.meta.url)),
          }));
        },
      },
    ],
  });
  writeFileSync(
    `${out}index.html`,
    '<!doctype html><script type="module" src="/experiment/page.js"></script>',
  );

  return { here, out };
}
