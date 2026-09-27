// Finds the Tamarin acceptance tests and each one's ASC 2.0 arguments,
// following avmplus' test/util/runtestBase.py where it applies to ASC 2.0.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const ACCEPTANCE = "oracle/avmplus/test/acceptance";
const acceptance = join(root, ACCEPTANCE);

/** runtestBase.py's config string for this avmshell: 32-bit x86 Linux, ASC 2.0, release. */
const CONFIG = "x86-lnx-asc2-release";

/** The root helpers every test uses (com.adobe.test.Assert and friends). */
const HELPERS = ["Assert.as", "Utils.as", "DateUtils.as"];

/** Whole directories that do not apply to swf2es. */
const SKIPPED_DIRS: Record<string, string> = {
  abcasm: "abcasm tests are assembled, not compiled",
  // float and float4 (ABC 47.16) exist only in HARMAN's AIR runtime: not in Flash
  // Player, not in Ruffle, and not in the oracle's avmshell (built without them).
  "as3/Types/Float": "float (ABC 47.16) is AIR-only",
  "as3/Types/Float4": "float (ABC 47.16) is AIR-only",
};

export interface TamarinTest {
  /** Path under the acceptance directory, without .as, such as ecma3/Array/e15_4_1_1. */
  path: string;
  /** The .as file, relative to the repository root. */
  source: string;
  ascArgs: string[];
}

export interface SkippedTest {
  path: string;
  reason: string;
}

/** Tests whose path starts with one of `prefixes` (all when empty). */
export function collectTests(prefixes: string[] = []): {
  tests: TamarinTest[];
  skipped: SkippedTest[];
} {
  const configSkips = testConfigSkips();
  const tests: TamarinTest[] = [];
  const skipped: SkippedTest[] = [];

  for (const file of walk(acceptance)) {
    const path = relative(acceptance, file).replace(/\.as$/, "");
    if (prefixes.length && !prefixes.some((p) => path.startsWith(p))) {
      continue;
    }

    if (isSupportFile(file)) {
      continue;
    }

    const reason = skipReason(path, file, configSkips);
    if (reason) {
      skipped.push({ path, reason });
      continue;
    }

    tests.push({ path, source: relative(root, file), ascArgs: ascArgs(file) });
  }

  return { tests, skipped };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".as")) {
      yield full;
    }
  }
}

/** Helpers compiled into tests rather than run: root helpers, *Util.as, support directories. */
function isSupportFile(file: string): boolean {
  if (dirname(file) === acceptance && HELPERS.includes(basename(file))) {
    return true;
  }

  if (basename(file).endsWith("Util.as")) {
    return true;
  }

  // Anything below a directory named like a test (test.as next to test/), or a *_support one.
  for (let dir = dirname(file); dir.length > acceptance.length; dir = dirname(dir)) {
    if (existsSync(`${dir}.as`) || dir.endsWith("_support")) {
      return true;
    }
  }

  return false;
}

function skipReason(path: string, file: string, configSkips: RegExp[]): string | null {
  for (const [dir, reason] of Object.entries(SKIPPED_DIRS)) {
    if (path === dir || path.startsWith(`${dir}/`)) {
      return reason;
    }
  }

  const base = file.replace(/\.as$/, "");
  if (existsSync(`${base}.avm_args`)) {
    return "needs avmshell arguments (.avm_args)";
  }

  if (existsSync(`${base}_support`)) {
    return "needs prebuilt support ABCs (_support)";
  }

  if (configSkips.some((re) => re.test(path))) {
    return "skipped in testconfig.txt";
  }

  return null;
}

/** Test regexes testconfig.txt skips entirely for CONFIG. */
function testConfigSkips(): RegExp[] {
  const skips: RegExp[] = [];
  const text = readFileSync(join(acceptance, "testconfig.txt"), "utf8").replace(/\\\n/g, "");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const fields = line.split(",").map((f) => f.trim());
    if (fields.length < 4) {
      continue;
    }

    const [test, include, exclude, directive] = fields;
    const included = include ? new RegExp(include).test(CONFIG) : false;
    const excluded = exclude ? new RegExp(exclude).test(CONFIG) : false;
    if (directive.toLowerCase() === "skip" && included && !excluded && !test.includes(":")) {
      skips.push(new RegExp(test));
    }
  }

  return skips;
}

/**
 * The root dir.asc_args, then the test's own .asc_args or else the nearest
 * dir.asc_args above it, and the helpers and support files as -in.
 */
function ascArgs(file: string): string[] {
  let args = applyArgsFile([], join(acceptance, "dir.asc_args"), acceptance);

  const own = `${file.replace(/\.as$/, "")}.asc_args`;
  if (existsSync(own)) {
    args = applyArgsFile(args, own, dirname(file));
  } else {
    for (let dir = dirname(file); dir.length > acceptance.length; dir = dirname(dir)) {
      const dirArgs = join(dir, "dir.asc_args");
      if (existsSync(dirArgs)) {
        args = applyArgsFile(args, dirArgs, dir);
        break;
      }
    }
  }

  const includes = [
    ...HELPERS.map((h) => join(acceptance, h)),
    ...readdirSync(dirname(file))
      .filter((f) => f.endsWith("Util.as"))
      .sort()
      .map((f) => join(dirname(file), f)),
    ...supportFiles(file.replace(/\.as$/, "")),
  ];

  // A test must not include itself, as a *Util test would.
  return [
    ...args,
    ...includes.filter((f) => f !== file).flatMap((f) => ["-in", relative(root, f)]),
  ];
}

function supportFiles(dir: string): string[] {
  return existsSync(dir) && statSync(dir).isDirectory() ? [...walk(dir)] : [];
}

/**
 * As runtestBase.py's parseAscArgs: "merge|" or "override|" and arguments, with
 * $DIR and $SHELLABC replaced. "-noX" removes X, so "-no-optimize" removes
 * -optimize while "-nooptimize" removes nothing.
 */
function applyArgsFile(current: string[], file: string, dir: string): string[] {
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => !l.startsWith("#"));
  if (!line) {
    return current;
  }

  const bar = line.indexOf("|");
  const mode = bar >= 0 ? line.slice(0, bar).trim() : "merge";
  const text = (bar >= 0 ? line.slice(bar + 1) : line)
    .replace(/\$DIR/g, relative(root, dir))
    // The oracle always imports shell_toplevel.abc.
    .replace(/-import\s+\$SHELLABC/g, "");
  const tokens = text.split(/\s+/).filter(Boolean);

  const remove = tokens.filter((t) => t.toLowerCase().startsWith("-no")).map((t) => t.slice(3));
  const add = tokens.filter((t) => !t.toLowerCase().startsWith("-no"));
  const merged = mode === "override" ? add : [...new Set([...current, ...add])];
  return merged.filter((a) => !remove.includes(a));
}
