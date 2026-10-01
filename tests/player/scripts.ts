// The AS3 half of a player test: scripts/<name>.as compiled by ASC in the
// oracle's container against builtin and playerglobal, into `out`, where
// it stays until the source or the image changes. Nothing runs it there:
// avmshell has no natives for playerglobal. Each test package compiles
// into an out directory of its own: pnpm runs the packages at once, and
// two compiles of one file into one place race.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runOracle } from "../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** A script to compile: scripts/<name>.as, or a source a test wrote, kept under `out` by its name. */
export type Script = string | { name: string; source: string };

/** The ABCs of the scripts, compiled into `out`, by name; a script that does not compile throws with ASC's log. */
export function compileScripts(scripts: Script[], out = `${here}out`): Map<string, Uint8Array> {
  const named = scripts.map((script) => {
    if (typeof script === "string") {
      return { name: script, source: `${here}scripts/${script}.as` };
    }

    // Written where the compile reads it: ASC names its output after the file.
    mkdirSync(`${out}/sources`, { recursive: true });
    const source = `${out}/sources/${script.name}.as`;
    writeFileSync(source, script.source);
    return { name: script.name, source };
  });
  const results = runOracle(
    named.map(({ name, source }) => ({ source, name: `scripts/${name}` })),
    out,
    { imports: ["builtin", "playerglobal"], run: false },
  );
  const abcs = new Map<string, Uint8Array>();
  for (const [i, { name }] of named.entries()) {
    if (!results[i].compiled) {
      throw new Error(`${name}.as did not compile:\n${results[i].compileLog}`);
    }

    abcs.set(name, new Uint8Array(readFileSync(`${out}/scripts/${name}.abc`)));
  }

  return abcs;
}

/** A compiler for a case that builds its SWF in steps: compile(name) for scripts/<name>.as, compile(name, source) for a source of its own. */
export type Compile = (name: string, source?: string) => Uint8Array;

export function compiler(out = `${here}out`): Compile {
  return (name, source) =>
    compileScripts([source === undefined ? name : { name, source }], out).get(name) as Uint8Array;
}
