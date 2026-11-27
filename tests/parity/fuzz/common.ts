// What the differential fuzz suites (fuzz/*.ts) share: their random
// numbers, a compiler that a case may kill and that the next case gets
// fresh, the libraries, and the dumps a compiled ABC is compared by.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellToplevelLibrary } from "../../../packages/cli/dist/shell-toplevel-library.js";
import { builtinLibrary } from "../../../packages/player/dist/playerglobal/libraries.js";
import { floatLibrary } from "../../../packages/runtime/dist/avm2/float-library.js";
import type { Compiler, Results } from "../suite.ts";

/** How large the suites are: the standard run, or --deep's, the counts the review that wrote them ran. */
export interface FuzzOptions {
  deep: boolean;
  seed: number;
  /** Every suite's random cases, where --cases sets them. */
  cases?: number;
}

/** A suite's count: standard or deep, unless --cases says. */
export function count(o: FuzzOptions, standard: number, deep: number): number {
  return o.cases ?? (o.deep ? deep : standard);
}

/** The review's generator, seeded: the same numbers on every host. */
export function generator(seed: number): { random: () => number; below: (n: number) => number } {
  let s = seed >>> 0;
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { random, below: (n) => Math.floor(random() * n) };
}

/** A compiler that a case may kill: the case's result is what it threw, and the next case runs on a fresh one. */
export class Live {
  c: Compiler;
  readonly fresh: () => Promise<Compiler>;

  constructor(c: Compiler, fresh: () => Promise<Compiler>) {
    this.c = c;
    this.fresh = fresh;
  }

  /** Case `name`'s text, as a digest: what `run` returns on the compiler, or what it threw. */
  async case(r: Results, name: string, run: (c: Compiler) => string): Promise<void> {
    let text: string;
    try {
      text = run(this.c);
    } catch (error) {
      const e = error as Error;
      text = `threw ${e?.name}: ${e?.message}`;
      this.c = await this.fresh();
    }

    r.case(name, () => r.blob(name, Buffer.from(text, "utf8")));
  }
}

export const builtin = builtinLibrary;
export const shell = shellToplevelLibrary;
export const float = floatLibrary;

export const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A module's cache key's hashes: the libraries', then the ABC's. */
export const hashes = (libraries: Uint8Array[], abc: Uint8Array) =>
  [...libraries.map(sha), sha(abc)].join("\n");

/**
 * ABC `bytes` added after `libraries` at API version `api`: what adding it
 * answers and, where it links, its methods verified, its module, every
 * body's IR and the domain's summary (`summary` first, as some suites
 * compare it before verifying).
 */
export function compiled(
  c: Compiler,
  bytes: Uint8Array,
  libraries: Uint8Array[],
  api: number,
  summaryFirst: boolean,
): string {
  c.domainReset(api);
  for (const library of libraries) {
    c.domainAdd(library, true);
  }

  const added = c.domainAdd(bytes, false);
  let text = `add ${added}`;
  if (summaryFirst) {
    text += `\n${c.domainSummary()}`;
  }

  if (added === 0) {
    text += `\n${c.domainVerifyAll()}\n${c.domainModule(hashes(libraries, bytes))}\n${c.domainIrAll()}`;
    if (!summaryFirst) {
      text += `\n${c.domainSummary()}`;
    }
  }

  return text;
}

function oracleDir(): string {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return process.env.SWF2ES_ORACLE_CACHE ?? join(cache, "swf2es", "oracle");
}

/** Whether the oracle's cache has ABCs, which some suites take seeds from. */
export function oracleHasAbcs(): boolean {
  const dir = oracleDir();
  return (
    existsSync(dir) &&
    readdirSync(dir).some((sub) => {
      try {
        return readdirSync(join(dir, sub)).some((f) => f.endsWith(".abc"));
      } catch {
        return false;
      }
    })
  );
}

/**
 * The oracle cache's ABCs, a test's folder at a time in order: the first
 * `perTest` of each smaller than `maxBytes`, `total` at most.
 */
export function oracleSeeds(perTest: number, maxBytes: number, total: number): Uint8Array[] {
  const dir = oracleDir();
  const seeds: Uint8Array[] = [];
  if (!existsSync(dir)) {
    return seeds;
  }

  for (const sub of readdirSync(dir).sort()) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, sub))
        .filter((f) => f.endsWith(".abc"))
        .sort();
    } catch {
      continue;
    }

    for (const file of files.slice(0, perTest)) {
      const bytes = new Uint8Array(readFileSync(join(dir, sub, file)));
      if (bytes.length < maxBytes && seeds.length < total) {
        seeds.push(bytes);
      }
    }
  }

  return seeds;
}

/** Every ABC in the oracle's cache under `maxBytes`, `limit` at most, by name. */
export function oracleAll(maxBytes: number, limit: number): [string, Uint8Array][] {
  const dir = oracleDir();
  const all: [string, Uint8Array][] = [];
  for (const sub of readdirSync(dir).sort()) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, sub))
        .filter((f) => f.endsWith(".abc"))
        .sort();
    } catch {
      continue;
    }

    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(join(dir, sub, file)));
      if (bytes.length > maxBytes) {
        continue;
      }

      if (all.length >= limit) {
        return all;
      }

      all.push([file.slice(0, 16), bytes]);
    }
  }

  return all;
}
