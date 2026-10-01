// The AS3 half of a player test: scripts/<name>.as compiled by ASC in the
// oracle's container against builtin and playerglobal, into `out`, where
// it stays until the source or the image changes. Nothing runs it there:
// avmshell has no natives for playerglobal. Each test package compiles
// into an out directory of its own: pnpm runs the packages at once, and
// two compiles of one file into one place race.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runOracle } from "../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The ABCs of the named scripts, compiled into `out`; a script that does not compile throws with ASC's log. */
export function compileScripts(names: string[], out = `${here}out`): Map<string, Uint8Array> {
  const results = runOracle(
    names.map((name) => ({ source: `${here}scripts/${name}.as`, name: `scripts/${name}` })),
    out,
    { imports: ["builtin", "playerglobal"], run: false },
  );
  const abcs = new Map<string, Uint8Array>();
  for (const [i, name] of names.entries()) {
    if (!results[i].compiled) {
      throw new Error(`${name}.as did not compile:\n${results[i].compileLog}`);
    }

    abcs.set(name, new Uint8Array(readFileSync(`${out}/scripts/${name}.abc`)));
  }

  return abcs;
}
