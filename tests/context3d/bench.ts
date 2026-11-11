// Backend draw submission and shader constants, with interleaved A/B timings and pixel hashes.
// node tests/context3d/bench.ts [checkout A checkout B] [--draws 2000] [--frames 90]
//   [--runs 3] [--samples 0] [--gpu] [--only static,transform,material,programs,targets]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withPage } from "../player/chrome.ts";
import type { Options, Result } from "./bench-results.ts";

const args = process.argv.slice(2);
const paths: string[] = [];
while (args[0] && !args[0].startsWith("--")) {
  paths.push(args.shift() as string);
}

assert.ok(paths.length === 0 || paths.length === 2, "provide two built checkouts, or neither");
const roots = paths.length
  ? paths.map((path) => resolve(path))
  : [fileURLToPath(new URL("../../", import.meta.url))];
function option(name: string, fallback: number): number {
  const at = args.indexOf(`--${name}`);
  const value = at < 0 ? fallback : Number(args[at + 1]);
  assert.ok(Number.isSafeInteger(value) && value >= 0, `invalid --${name}`);
  return value;
}

const options: Options = {
  draws: option("draws", 2000),
  frames: option("frames", 90),
  samples: option("samples", 0),
};
assert.ok(options.draws > 0 && options.draws <= 21845, "--draws must fit 16-bit indices");
assert.ok(options.frames >= 2, "--frames must be at least 2");
const runs = option("runs", 3);
assert.ok(runs > 0, "--runs must be positive");
const names = [
  "static",
  "transform",
  "material",
  "all-changing",
  "programs",
  "bindings",
  "attributes",
  "indices-changing",
  "indices-uploading",
  "indices-uploading-bytes",
  "states",
  "states-enabled",
  "states-changing",
  "textures",
  "textures-changing",
  "textures-cube",
  "textures-cube-changing",
  "textures-uploading",
  "textures-uploading-zero",
  "targets",
  "indirect",
  "indirect-changing",
];
const only = args.indexOf("--only");
const selected = only < 0 ? names : (args[only + 1] ?? "").split(",");
assert.ok(selected.length && selected.every((name) => names.includes(name)), "invalid --only");
const results: { run: number; root: string; commit: string; dirty: boolean; result: Result }[] = [];
const references = new Map<string, Pick<Result, "renderer" | "pixels">>();
for (let run = 0; run < runs; run++) {
  for (const name of selected) {
    for (const root of run % 2 === 0 ? roots : [...roots].reverse()) {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const dirty =
        execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
          cwd: root,
          encoding: "utf8",
        }).trim().length > 0;
      const { value, exception } = await withPage(
        "runSwf",
        (evaluate) =>
          evaluate<Result>(
            `import("/context3d-bench/bench-page.ts").then(m => m.bench(${JSON.stringify(name)}, ${JSON.stringify(options)}))`,
          ),
        args.includes("--gpu"),
        {
          mounts: [
            ["/packages/context3d/dist/", resolve(root, "packages/context3d/dist")],
            ["/context3d-bench/", fileURLToPath(new URL(".", import.meta.url))],
          ],
          timeout: 180_000,
        },
      );
      assert.equal(exception, null, `${name}: ${exception}`);
      assert.ok(value);
      const reference = references.get(name);
      if (reference) {
        assert.equal(value.renderer, reference.renderer, `${name}: renderer changed`);
        assert.deepEqual(value.pixels, reference.pixels, `${name}: pixels changed`);
      } else {
        references.set(name, { renderer: value.renderer, pixels: value.pixels });
      }

      results.push({ run, root, commit, dirty, result: value });
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
      console.error(
        `${run + 1} ${commit.slice(0, 8)}${dirty ? "*" : ""} ${name}: CPU ${median(value.cpu).toFixed(3)} ms, completed ${median(value.completed).toFixed(3)} ms, calls ${JSON.stringify(value.calls)}`,
      );
    }
  }
}

console.log(JSON.stringify({ options, results }, null, 2));
