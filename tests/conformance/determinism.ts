// Checks that the compiler is deterministic: that an ABC compiles to the
// same module and source map, byte for byte, however the compiler got
// there. Each chain (the builtins avmshell loads, then one ABC) is compiled
//
//   - in an instance of its own (the reference);
//   - in one instance, after all the chains before it;
//   - in one instance, in the reverse order, each chain twice in a row;
//   - in the build that checks every array access.
//
// This is less than the JIT/AOT invariant of docs/architecture.md, which
// needs a method compiled alone to come out as in its module; that waits
// for type references that do not depend on which method is compiled
// first. What it does check is that nothing the compiler keeps between
// calls, such as its reused buffers, leaks into what it writes.
//
// The ABCs are the conformance cases, as the runner compiles them and again
// with asc's -d, so that their source maps have lines, and as3pb when the
// programs runner has compiled it. Run after the runners:
//
//   node tests/conformance/determinism.ts
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containerEngine, runOracle } from "../../oracle/oracle.ts";
import { type Build, loadTesting } from "../unit/codegen/testing-module.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const programs = fileURLToPath(new URL("../programs/out/", import.meta.url));

try {
  containerEngine();
} catch (e) {
  console.log(`determinism: skipped (${(e as Error).message})`);
  process.exit(0);
}

const read = (path: string) => new Uint8Array(readFileSync(path));
const builtins = [read(`${out}lib/builtin.abc`), read(`${out}lib/shell_toplevel.abc`)];

// The cases, as the conformance runner compiled them and again with -d.
const names = readdirSync(`${here}cases`)
  .filter((f) => f.endsWith(".as"))
  .map((f) => f.slice(0, -3));
const lines = runOracle(
  names.map((name) => ({
    source: `${here}cases/${name}.as`,
    name: `lines/${name}`,
    ascArgs: ["-d"],
  })),
  out,
  {},
);
// Every case compiles, with -d too: one that does not would leave its
// source map unchecked.
const chains: { name: string; abc: Uint8Array }[] = [];
names.forEach((name, i) => {
  if (!lines[i].compiled) {
    console.log(`determinism: ${name} did not compile with -d\n${lines[i].compileLog}`);
    process.exit(1);
  }

  chains.push({ name, abc: read(`${out}${name}.abc`) });
  chains.push({ name: `${name} -d`, abc: read(`${out}lines/${name}.abc`) });
});

if (existsSync(`${programs}as3pb/ShellMain.abc`)) {
  chains.push({ name: "as3pb", abc: read(`${programs}as3pb/ShellMain.abc`) });
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Each module of a chain and its source map, as `testing` compiles them. */
// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
function compile(testing: any, abc: Uint8Array): string[] {
  const results: string[] = [];
  const hashes: string[] = [];
  testing.domainReset(50);
  for (const [i, bytes] of [...builtins, abc].entries()) {
    // The corpus is valid: an ABC that does not link is a failure, not output to compare.
    const error = testing.domainAdd(bytes, i < builtins.length);
    if (error) {
      throw new Error(`an ABC of the chain failed to link: error ${error}`);
    }

    hashes.push(sha(bytes));
    results.push(testing.domainModule(hashes.join("\n")), testing.domainSourceMap());
  }

  return results;
}

const what = (k: number) => `${k % 2 ? "source map" : "module"} ${Math.floor(k / 2)}`;
let differences = 0;

/** Compare a chain's output with the reference's, reporting where it first differs. */
function compare(way: string, name: string, got: string[], want: string[]): void {
  for (let k = 0; k < Math.max(got.length, want.length); k++) {
    if (got[k] === want[k]) {
      continue;
    }

    differences++;
    const a = (got[k] ?? "").split("\n");
    const b = (want[k] ?? "").split("\n");
    let line = 0;
    while (line < a.length && a[line] === b[line]) {
      line++;
    }

    console.log(`DIFF ${name}, ${way}: ${what(k)} differs at line ${line + 1}`);
    console.log(`  got:  ${(a[line] ?? "(end)").slice(0, 160)}`);
    console.log(`  want: ${(b[line] ?? "(end)").slice(0, 160)}`);
    return;
  }
}

const started = Date.now();
const reference = new Map<string, string[]>();
for (const chain of chains) {
  reference.set(chain.name, compile(await loadTesting("dist-test"), chain.abc));
}

/** The chains compiled one after another in one instance of `build`. */
async function oneInstance(way: string, build: Build, order: typeof chains, times: number) {
  const testing = await loadTesting(build);
  for (const chain of order) {
    for (let n = 0; n < times; n++) {
      compare(way, chain.name, compile(testing, chain.abc), reference.get(chain.name) ?? []);
    }
  }
}

await oneInstance("after the chains before it", "dist-test", chains, 1);
await oneInstance("in reverse, twice in a row", "dist-test", [...chains].reverse(), 2);
await oneInstance("in the checked build", "dist-test-checked", chains, 1);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (differences) {
  console.log(`determinism: ${chains.length} chains, ${differences} differ (${seconds} s)`);
  process.exit(1);
}

console.log(`determinism: ${chains.length} chains, each the same 4 ways (${seconds} s)`);
