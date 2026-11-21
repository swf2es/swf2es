// Checks bench.ts --census in Chrome (page.ts, installCensus): on masked lists, with and without
// WEBGL_multi_draw, and on blends drawn direct, what it counted of the runs it read from the
// renderer must add up to the sub-draws GL was asked for, a walk of what changed must visit no
// more than the walk did, and a still scene's walk must take spans. A renaming in the renderer
// that the census reads throws here.
//
//   node tests/player/census-check.ts
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bench = fileURLToPath(new URL("bench.ts", import.meta.url));

/** The census summary of a bench.ts run with `options`. */
function census(...options: string[]): Record<string, number> {
  const out = execFileSync(
    process.execPath,
    [bench, ...options, "--frames", "30", "--census", "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return JSON.parse(out).census as Record<string, number>;
}

const failures: string[] = [];
/** That `actual` is `expected`, means of whole numbers that add up frame by frame. */
const same = (what: string, actual: number, expected: number) => {
  if (Math.abs(actual - expected) > 1e-6) {
    failures.push(`${what}: ${actual}, expected ${expected}`);
  }
};

for (const multi of [true, false]) {
  const name = `--masks 20${multi ? "" : " --no-multi-draw"}`;
  const c = census("--masks", "20", ...(multi ? [] : ["--no-multi-draw"]));
  const v = (key: string) => c[key] ?? 0;
  const unmerged =
    v("runs.draws") - v("runs.merged.draws") + v("masks.draws") - v("masks.merged.draws");
  if (v("masks.draws") === 0 || v("runs.draws") === 0) {
    failures.push(`${name}: no masks or runs counted`);
  }

  same(`${name}: merged sub-draws`, v("path.merged"), v("runs.merged") + v("masks.merged"));
  same(
    `${name}: ${multi ? "multi-draw" : "single"} sub-draws`,
    v(multi ? "path.multi" : "path.single"),
    unmerged,
  );
  if (v("walk.needed") > v("walk.visited")) {
    failures.push(`${name}: a walk of what changed visits more than the walk`);
  }
}

const blends = census("--blends", "20");
if (!blends["blend.direct"]) {
  failures.push("--blends 20: no blend drawn direct");
}

same(
  "--blends 20: blend program sub-draws",
  blends["path.blended"] ?? 0,
  blends["blend.direct"] ?? 0,
);

// A scene that mostly stands still takes most of its objects' spans whole (docs/renderer.md, "Spans").
const crowd = census("--still-crowd", "64");
if (!crowd["walk.copied"] || crowd["walk.copied"] < crowd["walk.visited"] / 4) {
  failures.push(
    `--still-crowd 64: took ${crowd["walk.copied"] ?? 0} spans, walking ${crowd["walk.visited"]} objects`,
  );
}

if (failures.length > 0) {
  console.error(`census-check: ${failures.join("; ")}`);
  process.exit(1);
}

console.log("census-check: ok");
