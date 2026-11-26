// Local SWFs for the parity harness and the compile-time benchmark:
// SWF2ES_LOCAL_SWFS, paths separated by the platform's path delimiter (":"
// on POSIX, ";" on Windows), so that a path may hold spaces. Each is read
// once, up front, and reported by its number alone, never by its path.
import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { readSwf, type Swf } from "../../packages/format/dist/index.js";

/** The local SWFs, read: throws, naming a SWF by its number, where one cannot be read. */
export function localSwfs(): Swf[] {
  return (process.env.SWF2ES_LOCAL_SWFS ?? "")
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
}
