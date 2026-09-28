// Checks the hand-built ABCs the unit tests use against avmshell: each must
// fail with the error the tests expect of swf2es, or load and run cleanly,
// unless the case records how avmshell knowingly differs.
//
//   node oracle/cases.ts
import { fileURLToPath } from "node:url";
import { linkCases, resolveCases } from "../tests/unit/codegen/link-cases.ts";
import { typedCases } from "../tests/unit/codegen/typed-cases.ts";
import { verifyCases } from "../tests/unit/codegen/verify-cases.ts";
import { runAbcs } from "./oracle.ts";

const cases = [...verifyCases, ...linkCases, ...resolveCases, ...typedCases];
const runs = runAbcs(
  cases.map((c) => c.abc),
  fileURLToPath(new URL("out/cases/", import.meta.url)),
);

let failed = 0;
for (const [i, c] of cases.entries()) {
  const run = runs[i];
  const expected = c.avmshell === undefined ? c.error : (c.avmshell ?? undefined);
  // A VerifyError, or the load-time error a case expects (such as the
  // ReferenceError of an ambiguous base class). Errors thrown by running
  // code that verified do not count.
  const verifyError = run.output.match(/VerifyError: Error #(\d+)/)?.[1];
  const anyError = run.output.match(/Error: Error #(\d+)/)?.[1];
  const error = verifyError ?? (expected !== undefined ? anyError : undefined);
  const actual = error ? Number(error) : undefined;
  if (actual !== expected) {
    failed++;
    console.log(
      `FAIL ${c.name}: expected ${expected ?? "no error"}, avmshell ${actual ?? "no error"}`,
    );
    console.log(run.output.trimEnd().replace(/^/gm, "  "));
  }
}

console.log(`oracle cases: ${cases.length - failed} of ${cases.length} agree with avmshell`);
if (failed) {
  process.exit(1);
}
