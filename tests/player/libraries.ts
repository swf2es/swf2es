// The ABCs a SWF's code links against: builtin.abc and playerglobal.abc,
// copied out of the oracle's image into `out` the first time they are
// missing, and kept there uncommitted: playerglobal is Adobe's. Not the
// libraries test's copies: that test rewrites them while the packages
// pnpm runs at once would read them.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { libraries } from "../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const NAMES = ["builtin", "playerglobal"];

/** builtin.abc and playerglobal.abc, in that order, from `out`. */
export function libraryAbcs(out = `${here}out/libraries/`): Uint8Array[] {
  if (!NAMES.every((n) => existsSync(`${out}${n}.abc`))) {
    libraries(NAMES, out);
  }

  return NAMES.map((n) => new Uint8Array(readFileSync(`${out}${n}.abc`)));
}
