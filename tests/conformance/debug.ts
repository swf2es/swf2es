// Runs one conformance case in swf2es, as the runner compiled it, and
// prints its output, or the error it threw with its first frames. The
// runner must have run first, for the case's ABC and the builtins in out/.
//
//   node tests/conformance/debug.ts <case name, e.g. vectors> [--lines]
//
// With --lines, the case is compiled again with asc's -d, so that its ABC
// has debugfile and debugline and its module a source map: with node's
// --enable-source-maps, stacks name AS3 lines, and with --inspect-brk a
// debugger steps through the AS3 (SWF2ES_MODULES=<dir> writes the modules
// and their maps as files).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runOracle } from "../../oracle/oracle.ts";
import { runSwf2es } from "./swf2es.ts";

const out = new URL("out/", import.meta.url);
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, out)));
const name = process.argv[2];
let abc = `${name}.abc`;
if (process.argv.includes("--lines")) {
  const [result] = runOracle(
    [
      {
        source: fileURLToPath(new URL(`cases/${name}.as`, import.meta.url)),
        name: `lines/${name}`,
        ascArgs: ["-d"],
      },
    ],
    fileURLToPath(out),
    {},
  );
  if (!result.compiled) {
    console.log(result.compileLog);
    process.exit(1);
  }

  abc = `lines/${name}.abc`;
}

Error.stackTraceLimit = 20;
try {
  const lines = await runSwf2es(
    [read("lib/builtin.abc"), read("lib/shell_toplevel.abc")],
    read(abc),
  );
  console.log(lines.join("\n"));
} catch (e) {
  console.log(
    String((e as Error).stack ?? e).replace(
      /data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,
      "module",
    ),
  );
}
