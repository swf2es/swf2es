// Alternating A/B runs of the same browser fixtures against two built checkouts.
// Timings are diagnostic, never CI thresholds. Use --gpu for hardware measurements.
// node tests/player/render-bench.ts <checkout A> <checkout B> [--gpu] [--runs 3]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withPage } from "./chrome.ts";
import type { Options, Result } from "./render-bench/results.ts";

const args = process.argv.slice(2);
const here = fileURLToPath(new URL("../../", import.meta.url));
const paths: string[] = [];
while (args[0] && !args[0].startsWith("--")) {
  paths.push(args.shift() as string);
}
assert.ok(paths.length === 0 || paths.length === 2, "provide two built checkouts, or neither");
const roots = paths.length ? paths.map(resolvePath) : [here];
function resolvePath(path: string): string {
  return resolve(path);
}
function option(name: string, fallback: number): number {
  const at = args.indexOf(`--${name}`);
  const value = at < 0 ? fallback : Number(args[at + 1]);
  assert.ok(Number.isSafeInteger(value) && value > 0, `invalid --${name}`);
  return value;
}
const options: Options = {
  frames: option("frames", 120),
  branches: option("branches", 64),
  samples: option("samples", 4),
};
assert.ok(options.frames >= 3, "--frames must be at least 3");
const runs = option("runs", 3);
const gpu = args.includes("--gpu");
const names = args.includes("--targets")
  ? ["targets"]
  : args.includes("--rebuild")
    ? ["rebuilding"]
    : ["visible", "moving", "hidden", "filtered"];
const modules = [
  "native",
  "format",
  "codegen",
  "runtime",
  "player",
  "render",
  "context3d",
  "player-hosts",
];
const results: { run: number; root: string; commit: string; dirty: boolean; result: Result }[] = [];
const references = new Map<string, Pick<Result, "samples" | "renderer" | "pixels">>();
for (let run = 0; run < runs; run++) {
  const order = run % 2 === 0 ? roots : [...roots].reverse();
  for (const root of order) {
    const mounts: [string, string][] = [];
    for (const name of modules) {
      const dir = resolve(root, "packages", name, "dist");
      mounts.push([`/packages/${name}/dist/`, dir]);
      mounts.push([name === "context3d" ? "/context3d-backend/" : `/${name}/`, dir]);
    }

    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: root,
        encoding: "utf8",
      }).trim().length > 0;
    for (const name of names) {
      const fn =
        name === "targets"
          ? `m.targets(${JSON.stringify(options)})`
          : `m.scene(${JSON.stringify(name)}, ${JSON.stringify(options)})`;
      const { value, exception } = await withPage(
        "runSwf",
        (evaluate) => evaluate<Result>(`import("/page/render-bench/page.ts").then(m => ${fn})`),
        gpu,
        { mounts, timeout: 180_000 },
      );
      assert.equal(exception, null, `${name}: ${exception}`);
      assert.ok(value);
      const reference = references.get(name);
      if (reference) {
        assert.equal(value.renderer, reference.renderer, `${name}: GPU changed`);
        assert.equal(value.samples, reference.samples, `${name}: sample count changed`);
        assert.deepEqual(value.pixels, reference.pixels, `${name}: output changed`);
      } else {
        references.set(name, {
          samples: value.samples,
          renderer: value.renderer,
          pixels: value.pixels,
        });
      }

      results.push({ run, root, commit, dirty, result: value });
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
      console.error(
        `${run + 1} ${commit.slice(0, 8)} ${name}: CPU ${median(value.cpu).toFixed(3)} ms, ` +
          `walk ${value.walk.length ? median(value.walk).toFixed(3) : "-"}, ` +
          `completed ${median(value.completed).toFixed(3)}, allocations ${value.allocations}`,
      );
    }
  }
}

console.log(JSON.stringify({ options, gpu, results }, null, 2));
