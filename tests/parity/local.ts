// What a host has beyond the repository, for the parity harness and the
// compile-time benchmark: local SWFs, and the ABCs the oracle compiled.
//
// Local SWFs are SWF2ES_LOCAL_SWFS, paths separated by the platform's path
// delimiter (":" on POSIX, ";" on Windows), so that a path may hold spaces.
// Each is read once and reported by its number alone, never by its path.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isAs3, readActions, readSwf, type Swf } from "../../packages/format/dist/index.js";
import type { Avm1Swf } from "../conformance/determinism-avm1.ts";

let read: Swf[] | undefined;

/** The local SWFs, read: throws, naming a SWF by its number, where one cannot be read. */
export function localSwfs(): Swf[] {
  read ??= (process.env.SWF2ES_LOCAL_SWFS ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((file, i) => {
      try {
        return readSwf(new Uint8Array(readFileSync(file)));
      } catch (error) {
        throw new Error(
          `local SWF ${i} (SWF2ES_LOCAL_SWFS) cannot be read: ${(error as { code?: string }).code ?? (error as Error).name}`,
        );
      }
    });
  return read;
}

/** The local SWFs' AVM1 action blocks, each SWF named by its number. */
export function localAvm1(): Avm1Swf[] {
  return localSwfs().flatMap((swf, i) => {
    const { version, blocks } = readActions(swf);
    return isAs3(swf) || blocks.length === 0
      ? []
      : [
          {
            name: `local ${i}`,
            bytes: swf.bytes,
            version,
            offsets: Int32Array.from(blocks, (b) => b.offset),
            lengths: Int32Array.from(blocks, (b) => b.length),
          },
        ];
  });
}

/** Where this host keeps the ABCs ASC compiled for the oracle (Tamarin's tests, the conformance cases). */
export function oracleDir(): string {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return process.env.SWF2ES_ORACLE_CACHE ?? join(cache, "swf2es", "oracle");
}

/** Why the suites of the oracle's ABCs have nothing to run, if they have not. */
export function noOracle(): string | null {
  const dir = oracleDir();
  const any =
    existsSync(dir) &&
    readdirSync(dir).some((sub) => {
      try {
        return readdirSync(join(dir, sub)).some((f) => f.endsWith(".abc"));
      } catch {
        return false;
      }
    });
  return any
    ? null
    : "no ABCs in the oracle's cache (~/.cache/swf2es/oracle or SWF2ES_ORACLE_CACHE)";
}
