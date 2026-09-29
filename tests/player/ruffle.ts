// Ruffle's test corpus (https://github.com/ruffle-rs/ruffle, tests/tests/swfs,
// Apache-2.0 or MIT): SWFs with the output Flash Player traced for them,
// and for some the frames it drew, with Ruffle's tolerances for comparing
// them. Fetched at RUFFLE_COMMIT by fetch-ruffle.ts, not committed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The corpus's commit: its tests and expected outputs as of it. */
export const RUFFLE_COMMIT = "4b7edd6ade87b05115ceccfdeee57c70b7af64c2";

const here = fileURLToPath(new URL(".", import.meta.url));

/** Where the corpus is: SWF2ES_RUFFLE, else what fetch-ruffle.ts checks out. */
export const corpus = process.env.SWF2ES_RUFFLE ?? join(here, "ruffle/tests/tests/swfs");

/** A frame to compare, and how closely. */
export interface ImageCheck {
  name: string;
  /** The frame it is drawn at, 1 the first; the test's last by default. */
  frame: number;
  tolerance: number;
  maxOutliers: number;
  /** The PNG Ruffle expects, as Flash drew it or as Ruffle accepts it. */
  expected: string;
  knownFailure: boolean;
}

export interface RuffleTest {
  /** Its directory, relative to the corpus: "avm2/add", "timeline/..." */
  path: string;
  swf: string;
  /** How many frames it runs. */
  frames: number;
  /** What Flash traced, or null if the test compares none. */
  output: string | null;
  images: ImageCheck[];
  /** Ruffle's own known failure: the output is still Flash's. */
  knownFailure: boolean;
  /** Stage quality its renderer runs at: "low", "medium", "high" or "best". */
  quality: string;
  /** Tests Ruffle skips, or that need what this runner does not do yet (audio, video, fonts, input). */
  ignore: boolean;
}

/**
 * The subset of TOML test.toml uses: tables, arrays of tables, and keys
 * with numbers, strings, booleans and inline tables as values. An array of
 * tables' entries are numbered, as "checks.0".
 */
export function readToml(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const counts = new Map<string, number>();
  let table = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const array = /^\[\[(.+)\]\]$/.exec(line);
    if (array) {
      const name = unquote(array[1]);
      const n = counts.get(name) ?? 0;
      counts.set(name, n + 1);
      table = `${name}.${n}`;
      continue;
    }

    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      table = unquote(section[1]);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq > 0) {
      const key = unquote(line.slice(0, eq).trim());
      values.set(table ? `${table}.${key}` : key, line.slice(eq + 1).trim());
    }
  }

  return values;
}

/** A dotted key's parts without their quotes: image_comparisons."output" as image_comparisons.output. */
function unquote(key: string): string {
  return key
    .split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .join(".");
}

function number(v: string | undefined, fallback: number): number {
  return v === undefined ? fallback : Number(v);
}

function test(path: string): RuffleTest | null {
  const dir = join(corpus, path);
  const toml = join(dir, "test.toml");
  if (!existsSync(toml) || !existsSync(join(dir, "test.swf"))) {
    return null;
  }

  const values = readToml(readFileSync(toml, "utf8"));
  const frames = number(values.get("num_frames") ?? values.get("num_ticks"), 1);
  const outputPath = (values.get("output_path") ?? '"output.txt"').replace(/^"|"$/g, "");
  const output = existsSync(join(dir, outputPath))
    ? readFileSync(join(dir, outputPath), "utf8")
    : null;

  const names = new Set<string>();
  for (const key of values.keys()) {
    const m = /^image_comparisons\.([^.]+)\./.exec(key);
    if (m) {
      names.add(m[1]);
    }
  }

  const images: ImageCheck[] = [];
  for (const name of names) {
    const get = (k: string) => values.get(`image_comparisons.${name}.${k}`);
    // A frame the SWF asks for itself, by fscommand, is not captured yet.
    const trigger = get("trigger");
    if (trigger !== undefined && !/^\d+$/.test(trigger)) {
      continue;
    }

    // Without its expected image a comparison has nothing to compare.
    if (!existsSync(join(dir, `${name}.expected.png`))) {
      continue;
    }

    // With several checks, the loosest: a frame matches when any of them passes.
    let tolerance = number(get("tolerance"), 0);
    let maxOutliers = number(get("max_outliers"), 0);
    for (let i = 0; get(`checks.${i}.tolerance`) !== undefined; i++) {
      tolerance = Math.max(tolerance, number(get(`checks.${i}.tolerance`), 0));
      maxOutliers = Math.max(maxOutliers, number(get(`checks.${i}.max_outliers`), 0));
    }

    images.push({
      name,
      frame: number(get("trigger"), frames),
      tolerance,
      maxOutliers,
      expected: join(dir, `${name}.expected.png`),
      knownFailure: get("known_failure") === "true",
    });
  }

  const needs =
    ["with_audio", "with_video", "with_default_font"].some(
      (k) => values.get(`player_options.${k}`) === "true",
    ) || existsSync(join(dir, "input.json"));
  const quality = /quality\s*=\s*"(\w+)"/.exec(values.get("player_options.with_renderer") ?? "");
  return {
    path,
    swf: join(dir, "test.swf"),
    frames,
    output,
    images,
    knownFailure: values.get("known_failure") === "true",
    quality: quality?.[1] ?? "high",
    ignore: values.get("ignore") === "true" || needs,
  };
}

/** The corpus's tests under the given prefixes, or all of them, in path order. */
export function collectRuffle(prefixes: string[] = []): RuffleTest[] {
  const tests: RuffleTest[] = [];
  const walk = (path: string) => {
    const t = test(path);
    if (t) {
      tests.push(t);
      return;
    }

    for (const name of readdirSync(join(corpus, path)).sort()) {
      if (statSync(join(corpus, path, name)).isDirectory()) {
        walk(path ? `${path}/${name}` : name);
      }
    }
  };
  walk("");
  return prefixes.length ? tests.filter((t) => prefixes.some((p) => t.path.startsWith(p))) : tests;
}
