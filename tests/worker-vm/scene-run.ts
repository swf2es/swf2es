// Opt-in complete-scene pixel parity; no private fixtures or production bundles.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withPage } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";

const here = fileURLToPath(new URL(".", import.meta.url)),
  out = `${here}out/scene/`;
mkdirSync(out, { recursive: true });
const esbuild = await import(
  new URL("../../vendor/pixijs/node_modules/esbuild/lib/main.js", import.meta.url).href
);
await esbuild.build({
  entryPoints: [`${here}scene-page.ts`, `${here}scene-thread.ts`],
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  plugins: [
    {
      name: "existing-pixi",
      setup(build: { onResolve(options: { filter: RegExp }, resolve: () => object): void }) {
        build.onResolve({ filter: /^pixi\.js$/ }, () => ({
          path: "/pixi/pixi.mjs",
          external: true,
        }));
      },
    },
  ],
});
writeFileSync(
  `${out}index.html`,
  '<!doctype html><meta charset="utf-8"><title>Complete scene transport comparison</title><script type="module" src="./scene-page.js"></script>',
);
await withPage(
  "runSceneTransport",
  async (evaluate) => {
    const answer = await evaluate<{
      pictures: { direct: string[]; local: string[]; worker: string[] };
      libraries: number;
    }>("runSceneTransport()");
    assert.equal(answer.exception, null, JSON.stringify(answer));
    assert.ok(answer.value);
    const { pictures, libraries } = answer.value;
    assert.equal(libraries, 2);
    assert.equal(pictures.direct.length, 12);
    assert.ok(new Set(pictures.direct).size >= 8, "fixture must visibly change");
    for (let frame = 0; frame < 12; frame++) {
      const expected = decodePng(Buffer.from(pictures.direct[frame].split(",")[1], "base64"));
      assert.equal(expected.width, 128);
      assert.equal(expected.height, 128);
      for (const mode of ["local", "worker"] as const) {
        const actual = decodePng(Buffer.from(pictures[mode][frame].split(",")[1], "base64"));
        assert.deepEqual(actual, expected, `${mode}, complete scene frame ${frame}`);
      }
    }
    const first = decodePng(Buffer.from(pictures.direct[0].split(",")[1], "base64"));
    const at = (12 * 128 + 12) * 4;
    assert.deepEqual([...first.data.slice(at, at + 4)], [0xcc, 0x33, 0, 255]);
    console.log(
      "Twelve complete scenes match direct, local mirror and worker mirror after payload reuse; two libraries with colliding IDs.",
    );
  },
  process.argv.includes("--gpu"),
  {
    page: "scene/index.html",
    mounts: [["/scene/", out]],
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    timeout: 90000,
  },
);
