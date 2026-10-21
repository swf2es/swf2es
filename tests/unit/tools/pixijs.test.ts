import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BROWSER_EXPORTS, isolatedWorkerPlugins } from "../../../tools/pixijs.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const sourceFile = /\.[cm]?ts$/;

// What the browser may load with Pixi's bundle: every package's and app's
// sources, as a new file anywhere in them is one the player or the desktop
// app's renderer may import, and the test pages.
const browserSources = [
  ...["packages", "apps"].flatMap((dir) =>
    readdirSync(join(root, dir)).map((name) => join(dir, name, "src")),
  ),
  "tests/player/page.ts",
  "tests/web/page.ts",
];

function sources(path: string): string[] {
  if (sourceFile.test(path)) {
    return [path];
  }

  return readdirSync(join(root, path), { recursive: true, encoding: "utf8" })
    .filter((file) => sourceFile.test(file))
    .map((file) => join(path, file));
}

/**
 * The names a file imports or re-exports from "pixi.js" as values, `type`
 * ones left out.
 */
function valueImports(text: string): string[] {
  const names: string[] = [];
  for (const [, typeOnly, list] of text.matchAll(
    /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*"pixi\.js"/g,
  )) {
    if (typeOnly) {
      continue;
    }

    for (const member of list.split(",")) {
      const name = member.trim();
      if (name !== "" && !name.startsWith("type ")) {
        names.push(name.split(/\s+as\s+/)[0]);
      }
    }
  }

  return names;
}

test("the Pixi bundle exports just what the browser's sources import from pixi.js", () => {
  const imported = new Set<string>();
  for (const file of browserSources.flatMap(sources)) {
    const text = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(
      text,
      /(?:import|export)\s+\*(?:\s+as\s+\w+)?\s+from\s+"pixi\.js"|from\s+"pixi\.js\/|import\(\s*"pixi\.js/,
      `${file} imports pixi.js in a way the bundle's list cannot follow`,
    );
    for (const name of valueImports(text)) {
      imported.add(name);
    }
  }

  assert.deepEqual([...BROWSER_EXPORTS].sort(), [...imported].sort());
});

test("a worker build cannot reset its parent's in-flight CommonJS dependencies", async () => {
  const require = createRequire(join(root, "vendor/pixijs/package.json"));
  const { rollup } = await import(pathToFileURL(require.resolve("rollup")).href);
  const { default: commonjs } = await import(
    pathToFileURL(require.resolve("@rollup/plugin-commonjs")).href
  );
  const { default: webworker } = await import(
    pathToFileURL(require.resolve("@pixi/webworker-plugins/rollup-plugin")).href
  );
  const dir = mkdtempSync(join(tmpdir(), "swf2es-pixi-worker-"));
  const workerId = `\0@pixi/webworker-plugins/rollup-plugin:${join(dir, "probe.worker.js")}`;
  writeFileSync(
    join(dir, "main.js"),
    "import dep from './dep.cjs'; import Worker from 'worker:./probe.worker.js'; export const value = dep.value; export { Worker };",
  );
  writeFileSync(join(dir, "dep.cjs"), "module.exports = require('./leaf.cjs');");
  writeFileSync(join(dir, "leaf.cjs"), "module.exports = { value: 42 };");
  writeFileSync(join(dir, "probe.worker.js"), "postMessage('ready');");
  const plugins = isolatedWorkerPlugins([webworker(), commonjs()], async () => [
    webworker(),
    commonjs(),
  ]);
  const worker = plugins[0] as { load(id: string): unknown };

  try {
    const build = await rollup({
      input: join(dir, "main.js"),
      plugins: [
        {
          name: "overlap-worker",
          async load(id: string) {
            // Start a worker while the parent's CommonJS transform awaits its leaf.
            if (id === join(dir, "leaf.cjs")) {
              await worker.load.call(this, workerId);
            }
          },
        },
        ...plugins,
      ],
    });
    try {
      const { output } = await build.generate({ format: "es" });
      const module = await import(`data:text/javascript,${encodeURIComponent(output[0].code)}`);
      assert.equal(module.value, 42);
      assert.equal(typeof module.Worker, "function");
    } finally {
      await build.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
