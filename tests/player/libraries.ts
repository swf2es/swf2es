// The ABCs a SWF's code links against: builtin.abc and playerglobal.abc,
// copied out of the oracle's image into `out` the first time they are
// missing, and kept there uncommitted: playerglobal is Adobe's. Not the
// libraries test's copies: that test rewrites them while the packages
// pnpm runs at once would read them.
//
// With SWF2ES_PLAYERGLOBAL=ours, our playerglobal (tools/playerglobal.ts)
// takes the place of Flash Player's. The player's pages do the same
// (chrome.ts, page.ts).
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { libraries } from "../../oracle/oracle.ts";
import { build, sourcesChanged } from "../../tools/playerglobal.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const NAMES = ["builtin", "playerglobal"];

/** Our playerglobal in `out`, compiled again once its sources have changed. */
function ours(out: string): Uint8Array {
  const file = `${out}ours.abc`;
  if (!existsSync(file) || statSync(file).mtimeMs < sourcesChanged()) {
    // Test processes run at once: each compiles apart and swaps in its result whole.
    const dir = mkdtempSync(`${out}ours-`);
    try {
      build(dir);
      renameSync(`${dir}/playerglobal.abc`, file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return new Uint8Array(readFileSync(file));
}

/** builtin.abc and playerglobal.abc, in that order, from `out`: ours in place of Flash Player's under SWF2ES_PLAYERGLOBAL=ours. */
export function libraryAbcs(out = `${here}out/libraries/`): Uint8Array[] {
  if (!NAMES.every((n) => existsSync(`${out}${n}.abc`))) {
    libraries(NAMES, out);
  }

  const [builtin, playerglobal] = NAMES.map((n) => new Uint8Array(readFileSync(`${out}${n}.abc`)));
  return process.env.SWF2ES_PLAYERGLOBAL === "ours"
    ? [builtin, ours(out)]
    : [builtin, playerglobal];
}

/** The files of the libraries libraryAbcs gives, in its order, for a command that reads them. */
export function libraryFiles(out = `${here}out/libraries/`): string[] {
  libraryAbcs(out);
  return ["builtin", process.env.SWF2ES_PLAYERGLOBAL === "ours" ? "ours" : "playerglobal"].map(
    (n) => `${out}${n}.abc`,
  );
}
