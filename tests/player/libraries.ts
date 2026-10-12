// The ABCs a SWF's code links against: builtin.abc, copied out of the
// oracle's image into `out` the first time it is missing, and the
// playerglobal the player ships (playerglobalLibrary), written beside it as
// playerglobal-swf2es.abc for the pages and the command that read files.
// Not the libraries test's copies: that test rewrites them while the
// packages pnpm runs at once would read them.
//
// With SWF2ES_PLAYERGLOBAL=adobe, Flash Player's playerglobal from the
// oracle's image, playerglobal-adobe.abc, takes the place of swf2es's, kept
// uncommitted: it is Adobe's. The player's pages do the same (chrome.ts,
// page.ts).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { libraries } from "../../oracle/oracle.ts";
import { playerglobalLibrary } from "../../packages/player/dist/playerglobal/playerglobal-library.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const adobe = process.env.SWF2ES_PLAYERGLOBAL === "adobe";
const PLAYERGLOBAL = adobe ? "playerglobal-adobe" : "playerglobal-swf2es";

/** playerglobal-swf2es.abc in `out`, written again if it is not the player's. */
function writeSwf2es(out: string): void {
  const file = `${out}playerglobal-swf2es.abc`;
  if (existsSync(file) && Buffer.from(readFileSync(file)).equals(playerglobalLibrary)) {
    return;
  }

  // Test processes run at once: each writes apart and swaps in its file whole.
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, playerglobalLibrary);
  renameSync(temporary, file);
}

/** builtin.abc and the playerglobal the tests play on, in that order, from `out`. */
export function libraryAbcs(out = `${here}out/libraries/`): Uint8Array[] {
  if (!existsSync(`${out}builtin.abc`)) {
    libraries(["builtin"], out);
  }

  // The image names it playerglobal.abc.
  if (adobe && !existsSync(`${out}playerglobal-adobe.abc`)) {
    libraries(["playerglobal"], out);
    renameSync(`${out}playerglobal.abc`, `${out}playerglobal-adobe.abc`);
  }

  writeSwf2es(out);
  return ["builtin", PLAYERGLOBAL].map((n) => new Uint8Array(readFileSync(`${out}${n}.abc`)));
}

/** The files of the libraries libraryAbcs gives, in its order, for a command that reads them. */
export function libraryFiles(out = `${here}out/libraries/`): string[] {
  libraryAbcs(out);
  return ["builtin", PLAYERGLOBAL].map((n) => `${out}${n}.abc`);
}
