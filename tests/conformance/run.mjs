// Conformance runner. For every test .abc:
//   expected = avmshell <test.abc>            (trace output)
//   actual   = node <swf2es-compiled test>    (trace output)
// and diff the two. It also compiles each test in JIT mode and in AOT mode and
// requires identical output hashes (see docs/architecture.md).
//
// Compilation is not implemented yet, so this only checks that the oracle is
// available and reports how many tests it would run.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const avmshell = root + "oracle/avmshell/bin/avmshell";
const cases = root + "tests/conformance/cases/";

if (!existsSync(avmshell)) {
  console.log("conformance: skipped (no avmshell at oracle/avmshell/bin/avmshell; run pnpm oracle:avmshell)");
  process.exit(0);
}
const tests = existsSync(cases) ? readdirSync(cases).filter(f => f.endsWith(".abc")) : [];
console.log("conformance: avmshell found, " + tests.length + " test(s); codegen not implemented yet");
