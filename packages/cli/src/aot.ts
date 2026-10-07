// Ahead-of-time compilation: a SWF's ABCs compiled as the player compiles
// them for a SWF it loads as its main movie, so that each module is byte
// for byte what the browser would compile (the JIT/AOT invariant in
// docs/architecture.md). The steps are Code's in packages/player, in the
// same order: the libraries added to the root domain, each compiled as it
// is added, then the SWF's DoABCs all added to a child of the root before
// any of them compiles.
import { createHash } from "node:crypto";
import type { Codegen } from "@swf2es/codegen";
import { readDoAbc, readSwf, tags } from "@swf2es/format";

/** The API version the player resets the compiler with: Flash Player's. */
export const API_VERSION = 50;

export interface AbcInput {
  /** DoABC2's name, "" for a DoABC or a bare ABC. */
  name: string;
  /** DoABC2's lazy flag: its scripts run on first use, not when it loads. */
  lazy: boolean;
  abc: Uint8Array;
}

export interface Input {
  kind: "swf" | "abc";
  /** The SWF's version, 0 for a bare ABC. */
  version: number;
  abcs: AbcInput[];
}

export interface Module {
  name: string;
  /** SHA-256 of the ABC, as the player and the cache key name it. */
  hash: string;
  lazy: boolean;
  /** The ES module's source. */
  module: string;
}

const SIGNATURES = new Set(["FWS", "CWS", "ZWS"]);

/** The ABCs of a SWF, in tag order as the player links them, or a bare ABC as one. */
export function readInput(bytes: Uint8Array): Input {
  const signature = String.fromCharCode(...bytes.subarray(0, 3));
  if (!SIGNATURES.has(signature)) {
    return { kind: "abc", version: 0, abcs: [{ name: "", lazy: false, abc: bytes }] };
  }

  const swf = readSwf(bytes);
  const abcs: AbcInput[] = [];
  for (const t of swf.tags) {
    if (t.code === tags.DoABC || t.code === tags.DoABC2) {
      abcs.push(readDoAbc(swf.bytes, t));
    }
  }

  return { kind: "swf", version: swf.header.version, abcs };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class RejectedError extends Error {
  constructor(
    readonly what: string,
    readonly verifyError: number,
  ) {
    super(`${what} was rejected: VerifyError #${verifyError}`);
  }
}

/**
 * The libraries' modules, those asked for by `keepLibraries`, and the
 * ABCs' modules, in order. The libraries compile whether kept or not: the
 * player compiles each, and what a compile resolves of an ABC is what
 * later ABCs compile against.
 */
export function compileAhead(
  codegen: Codegen,
  libraries: { name: string; abc: Uint8Array }[],
  abcs: AbcInput[],
  keepLibraries = false,
): { libraries: Module[]; abcs: Module[] } {
  codegen.reset(API_VERSION);
  const hashes: string[] = [];
  const add = (what: string, abc: Uint8Array, builtin: boolean, domain: number) => {
    const error = codegen.add(abc, builtin, domain);
    if (error) {
      throw new RejectedError(what, error);
    }

    hashes.push(sha256(abc));
    return hashes.length - 1;
  };

  const libraryModules: Module[] = [];
  for (const { name, abc } of libraries) {
    const index = add(`library ${name}`, abc, true, 0);
    const module = codegen.compileModule(hashes, index);
    if (keepLibraries) {
      libraryModules.push({ name, hash: hashes[index], lazy: false, module });
    }
  }

  // The main movie's application domain, a child of the root's, as the player's mainDomain.
  const domain = codegen.childDomain(0);
  const indices = abcs.map(({ name, abc }, i) =>
    add(`ABC ${i}${name ? ` (${name})` : ""}`, abc, false, domain),
  );
  const modules = abcs.map(({ name, lazy }, i) => ({
    name,
    hash: hashes[indices[i]],
    lazy,
    module: codegen.compileModule(hashes, indices[i]),
  }));

  return { libraries: libraryModules, abcs: modules };
}
