// The ABCs the oracle image ships: builtin and shell_toplevel (the classes
// avmshell runs with), and Flash Player's playerglobal and AIR's airglobal.
// swf2es must parse and decode each, as a builtin ABC, like abcdump, and
// link each of the others on top of builtin, as the player loads them.
//
//   node tests/libraries/run.ts
import { fileURLToPath } from "node:url";
import {
  abcdumpFacts,
  compareFacts,
  linkError,
  swf2esFacts,
  verifyErrors,
} from "../../oracle/abc-facts.ts";
import { containerEngine, libraries } from "../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

let engine: string;
try {
  engine = containerEngine();
} catch (e) {
  console.log(`libraries: skipped (${(e as Error).message})`);
  process.exit(0);
}

let failed = 0;
const all = libraries(["builtin", "shell_toplevel", "playerglobal", "airglobal"], `${here}out`, {
  engine,
});
for (const library of all) {
  const facts = swf2esFacts(library.abc, true);
  const unreachable = { count: 0 };
  const differences = compareFacts(abcdumpFacts(library.dump), facts, unreachable);
  const errors = verifyErrors(facts);
  if (errors.length) {
    differences.push(`VerifyErrors ${errors.join(" ")}`);
  }

  const link = library.name === "builtin" ? 0 : linkError([all[0].abc], library.abc, true);
  if (link) {
    differences.push(`linking on top of builtin: error ${link}`);
  }

  for (const d of differences.slice(0, 20)) {
    console.log(`FAIL ${library.name}: ${d}`);
  }

  failed += differences.length ? 1 : 0;
  console.log(
    `${differences.length ? "FAIL" : "ok  "} ${library.name}: ${library.abc.length} bytes, ${facts.counts.methods} methods, ${facts.counts.bodies} bodies, ${unreachable.count} unreachable instructions`,
  );
}

if (failed) {
  process.exit(1);
}
