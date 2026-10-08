// Ahead-of-time compilation: a SWF's ABCs compiled as the player compiles
// them for a SWF it loads as its main movie, so that each module is byte
// for byte what the browser would compile (the JIT/AOT invariant in
// docs/architecture.md). The steps are Code's in packages/player, in the
// same order: the libraries added to the root domain, each compiled as it
// is added, then the SWF's DoABCs all added to a child of the root before
// any of them compiles.
import { createHash } from "node:crypto";
import {
  API_VERSION,
  type Codegen,
  type LibraryDigest,
  libraryLog,
  moduleKey,
} from "@swf2es/codegen";
import { isAs3, readDoAbc, readSwf, tags } from "@swf2es/format";

export { API_VERSION };

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
  /**
   * What compiling it fixed in the compiler's domain, which the player
   * replays in its place (Codegen.compileModuleLogged); null where it
   * cannot be.
   */
  log: string | null;
  /**
   * The SHA-256 of its key, as the player's module cache looks it up when
   * it loads the SWF as its main movie (codegen's moduleKey); null for a
   * compiler without an identity, or a module without a log.
   */
  key: string | null;
}

const SIGNATURES = new Set(["FWS", "CWS", "ZWS"]);

/** Input the command cannot compile, with why. */
export class InputError extends Error {}

/**
 * The ABCs of a SWF, in tag order as the player links them, or a bare ABC
 * as one. Only an AS3 SWF's: the player runs an AVM1 SWF's code as AVM1,
 * and never compiles its DoABCs.
 */
export function readInput(bytes: Uint8Array): Input {
  const signature = String.fromCharCode(...bytes.subarray(0, 3));
  if (!SIGNATURES.has(signature)) {
    // An ABC starts with its minor and major version, and avmplus reads only major 46.
    if (bytes.length < 4 || bytes[2] !== 46 || bytes[3] !== 0) {
      throw new InputError("neither a SWF nor an ABC");
    }

    return { kind: "abc", version: 0, abcs: [{ name: "", lazy: false, abc: bytes }] };
  }

  let swf: ReturnType<typeof readSwf>;
  try {
    swf = readSwf(bytes);
  } catch (e) {
    throw new InputError(`a truncated or corrupt SWF (${(e as Error).message})`);
  }

  // A DoABC cut short would reach codegen as a malformed ABC and read as
  // the code's error; a SWF cut elsewhere the player plays, as far as it goes.
  const last = swf.tags.at(-1);
  if (swf.truncated && (last?.code === tags.DoABC || last?.code === tags.DoABC2)) {
    throw new InputError("a truncated SWF: the file ends inside a DoABC tag");
  }

  if (!isAs3(swf)) {
    throw new InputError(
      "an AVM1 SWF (its FileAttributes has no ActionScript 3 flag): the player runs its code as AVM1",
    );
  }

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
    /** A library's, not the input's. */
    readonly library: boolean,
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
  const builtins: boolean[] = [];
  const add = (what: string, abc: Uint8Array, builtin: boolean, domain: number) => {
    const error = codegen.add(abc, builtin, domain);
    if (error) {
      throw new RejectedError(what, error, builtin);
    }

    hashes.push(sha256(abc));
    builtins.push(builtin);
    return hashes.length - 1;
  };
  // Keyed before it compiles, as the player keys it before it asks its cache.
  const compile = (index: number, libraryDigest: LibraryDigest | null) => {
    const keyText =
      codegen.identity === null
        ? null
        : moduleKey(codegen, index, { hashes, builtins }, libraryDigest);
    const { module, log } = codegen.compileModuleLogged(hashes, index);
    const key = keyText === null || log === null ? null : sha256Text(keyText);
    return { hash: hashes[index], module, log, key };
  };

  const libraryModules: Module[] = [];
  for (const { name, abc } of libraries) {
    const index = add(`library ${name}`, abc, true, 0);
    const compiled = compile(index, null);
    if (keepLibraries) {
      libraryModules.push({ name, lazy: false, ...compiled });
    }
  }

  // The main movie's application domain, a child of the root's, as the player's mainDomain.
  const domain = codegen.childDomain(0);
  const indices = abcs.map(({ name, abc }, i) =>
    add(`ABC ${i}${name ? ` (${name})` : ""}`, abc, false, domain),
  );
  // The libraries' part of the log, by its digest, as the player's keys name it once a SWF is added.
  const count = libraries.length;
  const digest: LibraryDigest | null =
    indices.length > 0
      ? { count, digest: sha256Text(libraryLog(codegen, indices[0], count)) }
      : null;
  const modules = abcs.map(({ name, lazy }, i) => ({ name, lazy, ...compile(indices[i], digest) }));

  return { libraries: libraryModules, abcs: modules };
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
