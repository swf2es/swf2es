// The test build of codegen (tests/unit/codegen/testing-module.ts) as the
// shell's compiler, so that what runs ABCs as avmshell does in the tests
// runs the build pnpm test:checked checks every array access of.
import type { ShellCompiler } from "../../packages/cli/dist/shell.js";

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export function testingCompiler(testing: any): ShellCompiler {
  return {
    reset: (apiVersion = 50) => testing.domainReset(apiVersion),
    add: (abc, builtin = false, appDomain = 0) => testing.domainAdd(abc, builtin, appDomain),
    childDomain: (parent) => testing.domainChild(parent),
    found: (d) => testing.domainFound(d.domain, d.nsKind, d.uri, d.name, d.abc, d.asType),
    // The last ABC's, the only one the shell compiles.
    compileModule: (hashes = []) => testing.domainModule(hashes.join("\n")),
  };
}
