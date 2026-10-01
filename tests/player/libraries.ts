// The ABCs a SWF's code links against: builtin.abc and playerglobal.abc,
// copied out of the oracle's image into tests/libraries/out (where the
// libraries test keeps them, uncommitted: playerglobal is Adobe's) the
// first time they are missing.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { libraries } from "../../oracle/oracle.ts";

const out = fileURLToPath(new URL("../libraries/out/", import.meta.url));
const NAMES = ["builtin", "playerglobal"];

/** builtin.abc and playerglobal.abc, in that order. */
export function libraryAbcs(): Uint8Array[] {
  if (!NAMES.every((n) => existsSync(`${out}${n}.abc`))) {
    libraries(NAMES, out);
  }

  return NAMES.map((n) => new Uint8Array(readFileSync(`${out}${n}.abc`)));
}
