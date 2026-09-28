// Runs one conformance case in swf2es, as the runner compiled it, and
// prints its output, or the error it threw with its first frames. The
// runner must have run first, for the case's ABC and the builtins in out/.
//
//   node tests/conformance/debug.ts <case name, e.g. vectors>
import { readFileSync } from "node:fs";
import { runSwf2es } from "./swf2es.ts";

const out = new URL("out/", import.meta.url);
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, out)));
Error.stackTraceLimit = 20;
try {
  const lines = await runSwf2es(
    [read("lib/builtin.abc"), read("lib/shell_toplevel.abc")],
    read(`${process.argv[2]}.abc`),
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
