// What the compatibility page shows, worked out from the repository as the
// site builds, so it is as current as the commit: no figure is kept by hand.
//
// - ActionScript 3: the Tamarin acceptance tests, swf2es' results
//   (tests/tamarin/swf2es-baseline.json) against avmshell's (baseline.json),
//   scored as tests/tamarin/swf2es.ts scores a run.
// - Ruffle's corpus: tests/player/corpus/baseline.json, how far the player
//   got through each test's trace.
// - The flash.* API: the player's playerglobal (playerglobal-library.ts),
//   which tools/playerglobal.ts --check holds to Flash Player's API, so its
//   surface is Flash Player's; a member counts as implemented unless it is a
//   native that unimplemented-natives.json lists, which natives-coverage.test.ts
//   keeps to exactly the natives no implementation registers.
//
// Reading and scoring them takes a few tens of milliseconds, so every build
// does it afresh.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSurface, type Trait } from "../../tools/abc-surface/read.ts";

/** Done of how many. */
export interface Share {
  done: number;
  of: number;
}

// ActionScript 3: Tamarin.

/** avmshell's result for a test, as tests/tamarin/run.ts records it. */
export interface Avmshell {
  compiled: boolean;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
}

/** swf2es' result for a test, as tests/tamarin/swf2es.ts records it; null when not compared. */
export type Recorded = {
  passed: number | null;
  failed: number | null;
  exitCode: number | null;
  error: string | null;
} | null;

export interface TamarinScore {
  /** Tests that match avmshell, of those scored. */
  all: Share;
  /** By suite, the first directory; the small ones together as "other". */
  suites: { name: string; tests: Share; dirs?: string[] }[];
  /** Why the rest do not match, most first. */
  reasons: { reason: string; tests: number }[];
  /** Tests avmshell compiled. */
  compiled: number;
  /** Left out: avmshell's counts follow the date or the machine, not compared. */
  uncounted: string[];
  /** Left out: swf2es' result varies from run to run (null in its baseline). */
  varying: string[];
}

/** The suites the page names; the rest are a test or a few each. */
export const SUITES = ["ecma3", "spidermonkey", "as3", "e4x", "regress"];

/** Score swf2es against avmshell as swf2es.ts does, from the two baselines. */
export function scoreTamarin(
  avmshell: Record<string, Avmshell>,
  ours: Record<string, Recorded | undefined>,
): TamarinScore {
  const suites = new Map<string, Share>();
  const others = new Set<string>();
  const reasons = new Map<string, number>();
  const uncounted: string[] = [];
  const varying: string[] = [];
  const all: Share = { done: 0, of: 0 };
  let compiled = 0;

  for (const [path, theirs] of Object.entries(avmshell).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!theirs.compiled) {
      continue;
    }

    compiled++;
    if (theirs.passed === null || theirs.failed === null) {
      uncounted.push(path);
      continue;
    }

    const o = ours[path];
    // A test swf2es.ts ran but recorded nothing for fails its run; here it is not scored.
    if (o === null || o === undefined) {
      varying.push(path);
      continue;
    }

    const first = path.split("/")[0];
    const suite = SUITES.includes(first) ? first : "other";
    if (suite === "other") {
      others.add(first);
    }

    const share = suites.get(suite) ?? { done: 0, of: 0 };
    suites.set(suite, share);
    share.of++;
    all.of++;
    // swf2es.ts's matches(): as avmshell ended, nothing of the host's stopping it, the same counts.
    const ended = theirs.exitCode === null || o.exitCode === theirs.exitCode;
    const counts = o.passed === theirs.passed && o.failed === theirs.failed;
    if (o.error === null && ended && counts) {
      share.done++;
      all.done++;
      continue;
    }

    const reason =
      o.error !== null
        ? "Stopped by the host: an error of JavaScript's or a limit"
        : !ended
          ? "Ended otherwise than in avmshell"
          : (o.passed ?? 0) < theirs.passed
            ? "Fewer checks passed than in avmshell"
            : "The same checks passed, but others failed";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  return {
    all,
    suites: [...SUITES, "other"]
      .filter((name) => suites.has(name))
      .map((name) => ({
        name,
        tests: suites.get(name) as Share,
        ...(name === "other" ? { dirs: [...others].sort() } : {}),
      })),
    reasons: [...reasons]
      .map(([reason, tests]) => ({ reason, tests }))
      .sort((a, b) => b.tests - a.tests),
    compiled,
    uncounted,
    varying,
  };
}

// Ruffle's corpus.

/** A test of the corpus, as tests/player/corpus/run.ts records it. */
export interface CorpusEntry {
  matched: number;
  lines: number;
  traced: number;
  error: string | null;
}

/** The natives' groups in unimplemented-natives.json: each native's group, and each group's why. */
export interface Unimplemented {
  group: Map<string, string>;
  why: Map<string, string>;
}

export interface CorpusScore {
  all: { tests: Share; lines: Share };
  areas: { name: string; tests: Share; lines: Share }[];
  /** Tests a native not supported yet stopped, by the natives' group, most first. */
  stoppers: { group: string; why: string; tests: number; classes: [string, number][] }[];
  /** Tests stopped by something else not supported yet, such as Flash Remoting. */
  otherUnsupported: number;
}

/** A test passes when every line Flash traced matched, no more were traced, and nothing stopped it. */
export const passes = (e: CorpusEntry) =>
  e.error === null && e.matched === e.lines && e.traced === e.lines;

const NATIVE = /native (\S+) is not supported yet/;

/** Score the corpus's baseline, by area (its first directory), and what stops its tests. */
export function scoreCorpus(
  baseline: Record<string, CorpusEntry>,
  unimplemented: Unimplemented,
): CorpusScore {
  const areas = new Map<string, { tests: Share; lines: Share }>();
  const all = { tests: { done: 0, of: 0 }, lines: { done: 0, of: 0 } };
  const groups = new Map<string, { tests: number; classes: Map<string, number> }>();
  let otherUnsupported = 0;

  for (const [path, e] of Object.entries(baseline)) {
    const name = path.split("/")[0];
    const area = areas.get(name) ?? { tests: { done: 0, of: 0 }, lines: { done: 0, of: 0 } };
    areas.set(name, area);
    for (const s of [area, all]) {
      s.tests.of++;
      s.tests.done += passes(e) ? 1 : 0;
      s.lines.of += e.lines;
      s.lines.done += e.matched;
    }

    const native = e.error === null ? null : NATIVE.exec(e.error);
    if (native) {
      const group = unimplemented.group.get(native[1]) ?? "unlisted";
      const g = groups.get(group) ?? { tests: 0, classes: new Map<string, number>() };
      groups.set(group, g);
      g.tests++;
      // The class: up to the # or . after its package's ::, whatever namespace the member has.
      const at = native[1].indexOf("::") + 2;
      const owner = native[1].slice(0, at + Math.max(native[1].slice(at).search(/[#.]/), 0));
      g.classes.set(owner, (g.classes.get(owner) ?? 0) + 1);
    } else if (e.error?.includes("is not supported yet")) {
      otherUnsupported++;
    }
  }

  return {
    all,
    areas: [...areas].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, s]) => ({ name, ...s })),
    stoppers: [...groups]
      .map(([group, g]) => ({
        group,
        why: unimplemented.why.get(group) ?? "",
        tests: g.tests,
        classes: [...g.classes].sort((a, b) => b[1] - a[1]),
      }))
      .sort((a, b) => b.tests - a.tests),
    otherUnsupported,
  };
}

// The flash.* API.

/** The player's playerglobal ABC, from the TypeScript module the player ships it in. */
export function playerglobalAbc(source: string): Uint8Array {
  const base64 = /atob\(\s*"([A-Za-z0-9+/=]+)"/.exec(source);
  if (!base64) {
    throw new Error("playerglobal-library.ts holds no ABC");
  }

  return new Uint8Array(Buffer.from(base64[1], "base64"));
}

/**
 * Classes AIR alone has that Flash Player's playerglobal declares with no
 * API version of AIR's, so that their names do not say so: they are left
 * out with what the version marks leave out. NativeMenu and NativeMenuItem
 * stay, ContextMenu's bases in Flash Player.
 */
export const AIR_CLASSES = [
  "flash.desktop::InvokeEventReason",
  "flash.desktop::NativeApplication",
  "flash.desktop::NativeDragActions",
  "flash.desktop::NativeDragOptions",
  "flash.desktop::Updater",
  "flash.display::NativeWindow",
  "flash.events::NativeDragEvent",
  "flash.filesystem::StorageVolumeInfo",
  "flash.html::HTMLHost",
  "flash.html::HTMLLoader",
  "flash.html::HTMLPDFCapability",
  "flash.net::URLRequestDefaults",
  "flash.security::IURIDereferencer",
  "flash.security::RevocationCheckSettings",
  "flash.security::SignatureStatus",
  "flash.security::SignerTrustSettings",
  "flash.security::XMLSignatureValidator",
];

/** A trait's name, `{kind:uri@vN,...}::local`, as its namespaces, versions and local name. */
function parseName(name: string): { uri: string; versions: number[]; local: string } {
  const m = /^\{(.*)\}::(.*)$/.exec(name);
  if (!m) {
    return { uri: "", versions: [], local: name };
  }

  const namespaces = m[1].split(",").map((ns) => {
    const [, uri = "", version] = /^[^:]*:(.*?)(?:@v(\d+))?$/.exec(ns) ?? [];
    return { uri, version: version === undefined ? null : Number(version) };
  });
  return {
    uri: namespaces[0].uri,
    versions: namespaces.flatMap((ns) => (ns.version === null ? [] : [ns.version])),
    local: m[2],
  };
}

/**
 * Whether an API version is AIR's: from 10 up, the odd ones; below, all but
 * Flash Player's 9 (0), 10.0 (2), 10.0.32 (5) and 10.1 (7), as avmplus'
 * api-versions.h interleaves them (codegen's domain.ts, isAir).
 */
export function isAirVersion(v: number): boolean {
  if (v === 0) {
    return false;
  }

  return v >= 10 ? (v & 1) === 1 : v !== 2 && v !== 5 && v !== 7;
}

/** Whether a name is AIR's alone: every version it has is AIR's. */
const airOnly = (versions: number[]) => versions.length > 0 && versions.every(isAirVersion);

/** Names a SWF sees: public, protected and interface names, not a class's private or internal ones. */
const visible = (name: string) =>
  !name.startsWith("{") || /^\{(package|protected|staticprotected|namespace)/.test(name);

export interface ClassScore {
  name: string;
  members: Share;
  /** The members not implemented, statics as "static name". */
  missing: string[];
}

export interface PackageScore {
  name: string;
  /** Classes with every member implemented. */
  classes: Share;
  members: Share;
  rows: ClassScore[];
}

export interface ApiScore {
  classes: Share;
  members: Share;
  packages: PackageScore[];
  /** Members left out as AIR's alone. */
  air: number;
  /** Natives `unimplemented` lists that the ABC does not declare: none, unless the names drift. */
  unmatched: string[];
}

/** The row of a package's functions, constants and variables, outside any class. */
export const PACKAGE_LEVEL = "(package level)";

/**
 * Score a playerglobal's API: each class's members, a name on its static or
 * instance side (a getter and a setter of one property are one member).
 * A member is implemented unless one of its methods is a native that
 * `unimplemented` lists; constants, variables and AS3 bodies are. AIR's
 * own API is left out: names whose versions are all AIR's, AIR_CLASSES,
 * and natives listed in the group `airGroup`.
 */
export function scoreApi(
  abc: Uint8Array,
  unimplemented: Unimplemented,
  airGroup = "air",
): ApiScore {
  const packages = new Map<string, Map<string, ClassScore>>();
  let air = 0;
  const airClasses = new Set(AIR_CLASSES);
  const declared = new Set<string>();

  const qualified = (n: { uri: string; local: string }) =>
    n.uri ? `${n.uri}::${n.local}` : n.local;
  /** Count `states` into the row `name` of package `pkg`. */
  const count = (pkg: string, name: string, states: Map<string, boolean | "air">) => {
    const rows = packages.get(pkg) ?? new Map<string, ClassScore>();
    packages.set(pkg, rows);
    const row = rows.get(name) ?? {
      name: name.replace(/^.*::/, ""),
      members: { done: 0, of: 0 },
      missing: [],
    };
    rows.set(name, row);
    for (const [key, state] of states) {
      if (state === "air") {
        air++;
        continue;
      }

      row.members.of++;
      if (state) {
        row.members.done++;
      } else {
        row.missing.push(key.replace(/^(instance|package) /, ""));
      }
    }
  };

  /** Each member's state over `traits`: "air" if AIR's alone, else whether it is implemented. */
  const members = (owner: string, traits: Trait[], side: string, classAir: boolean) => {
    const states = new Map<string, boolean | "air">();
    for (const t of traits) {
      if (!visible(t.name) || t.kind === "class") {
        continue;
      }

      const n = parseName(t.name);
      const key = `${side} ${n.local}`;
      let state: boolean | "air" = true;
      if (
        t.kind === "method" ||
        t.kind === "getter" ||
        t.kind === "setter" ||
        t.kind === "function"
      ) {
        if (t.method.flags.includes("native")) {
          const prefix = t.kind === "getter" ? "get:" : t.kind === "setter" ? "set:" : "";
          const native = `${owner}${prefix}${qualified(n)}`;
          declared.add(native);
          const group = unimplemented.group.get(native);
          state = group === airGroup ? "air" : group === undefined;
        }
      }

      if (classAir || airOnly(n.versions)) {
        state = "air";
      }

      const before = states.get(key);
      // A property is AIR's if an accessor is, else implemented if both accessors are.
      states.set(
        key,
        before === undefined
          ? state
          : before === "air" || state === "air"
            ? "air"
            : before && state,
      );
    }

    return states;
  };

  for (const script of readSurface(abc).scripts) {
    for (const t of script.traits) {
      const n = parseName(t.name);
      if (t.kind !== "class") {
        if (!visible(t.name)) {
          continue;
        }

        count(n.uri, PACKAGE_LEVEL, members("", [t], "package", false));
        continue;
      }

      const name = qualified(n);
      const classAir = airOnly(n.versions) || airClasses.has(name);
      const states = new Map([
        ...members(`${name}.`, t.class.static, "static", classAir),
        ...members(`${name}#`, t.class.instance, "instance", classAir),
      ]);
      if (classAir) {
        air += states.size;
      } else {
        count(n.uri, name, states);
      }
    }
  }

  const all: ApiScore = {
    classes: { done: 0, of: 0 },
    members: { done: 0, of: 0 },
    packages: [],
    air,
    unmatched: [...unimplemented.group.keys()].filter((native) => !declared.has(native)),
  };
  for (const [name, rows] of [...packages].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const pkg: PackageScore = {
      name: name || "(top level)",
      classes: { done: 0, of: 0 },
      members: { done: 0, of: 0 },
      rows: [...rows.values()].sort((a, b) =>
        a.name === PACKAGE_LEVEL ? -1 : b.name === PACKAGE_LEVEL ? 1 : a.name < b.name ? -1 : 1,
      ),
    };
    for (const r of pkg.rows) {
      if (r.name !== PACKAGE_LEVEL) {
        pkg.classes.of++;
        pkg.classes.done += r.members.done === r.members.of ? 1 : 0;
      }

      pkg.members.of += r.members.of;
      pkg.members.done += r.members.done;
    }

    all.classes.of += pkg.classes.of;
    all.classes.done += pkg.classes.done;
    all.members.of += pkg.members.of;
    all.members.done += pkg.members.done;
    all.packages.push(pkg);
  }

  return all;
}

/** unimplemented-natives.json as each native's group and each group's why. */
export function readUnimplemented(
  json: Record<string, string | { why: string; natives: string[] }>,
): Unimplemented {
  const out: Unimplemented = { group: new Map(), why: new Map() };
  for (const [group, entry] of Object.entries(json)) {
    if (typeof entry === "string") {
      continue;
    }

    out.why.set(group, entry.why);
    for (const native of entry.natives) {
      out.group.set(native, group);
    }
  }

  return out;
}

export interface Compatibility {
  tamarin: TamarinScore;
  corpus: CorpusScore;
  api: ApiScore;
  /** Each group of unimplemented-natives.json: its why, and how many natives it lists. */
  groups: Record<string, { why: string; natives: number }>;
}

/** Everything the page shows, from the repository at `root`. */
export function compatibility(root: string): Compatibility {
  const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const unimplemented = readUnimplemented(
    json("tests/unit/player/playerglobal/unimplemented-natives.json"),
  );
  const groups: Compatibility["groups"] = {};
  for (const [group, why] of unimplemented.why) {
    groups[group] = { why, natives: 0 };
  }

  for (const group of unimplemented.group.values()) {
    groups[group].natives++;
  }

  return {
    tamarin: scoreTamarin(
      json("tests/tamarin/baseline.json"),
      json("tests/tamarin/swf2es-baseline.json"),
    ),
    corpus: scoreCorpus(json("tests/player/corpus/baseline.json"), unimplemented),
    api: scoreApi(
      playerglobalAbc(
        readFileSync(
          join(root, "packages/player/src/playerglobal/playerglobal-library.ts"),
          "utf8",
        ),
      ),
      unimplemented,
    ),
    groups,
  };
}
