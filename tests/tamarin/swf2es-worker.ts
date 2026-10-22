// A worker of tests/tamarin/swf2es.ts: runs the Tamarin tests it is sent in
// swf2es, one at a time, each in a runtime of its own after the builtins
// avmshell loads. The builtins are compiled to modules once; each test
// links them again in a new domain, then its ABC, and runs it.
//
// Messages in: { path, abc } for an ABC file. Out: { path, lines, exitCode }
// with the lines it traced and how it ended, as avmshell's exit code: 0, or
// 1 for a VerifyError or an AS3 exception nothing caught; or { path, lines,
// error } with what of the host's stopped it, and the lines before.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runShell, type ShellModule } from "../../packages/cli/dist/shell.js";
import { testingCompiler } from "../conformance/abc-compiler.ts";
import { testing } from "../unit/codegen/testing-module.ts";

const runtime = await import(
  new URL("../../packages/runtime/dist/avm2/index.js", import.meta.url).href
);

// The oracle runs avmshell with TZ=UTC, so local time is UTC here too.
process.env.TZ = "UTC";

// avmshell's working directory as the oracle runs it, the repository, which some tests read files from.
const workDir = fileURLToPath(new URL("../../", import.meta.url));
// The builtins avmshell loads, as the oracle's libraries() copies them out.
const builtins = ["builtin", "shell_toplevel"].map(
  (name) => new Uint8Array(readFileSync(`${workDir}oracle/avmplus/generated/${name}.abc`)),
);

async function load(js: string): Promise<ShellModule> {
  const url = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
  return (await import(url)).default;
}

/** The working directory's files, and those a test writes, kept in memory, not written there. */
function testFiles() {
  const written = new Map<string, Uint8Array>();
  return {
    read(name: string): Uint8Array | null {
      const file = `${workDir}${name}`;
      const bytes = written.get(name);
      if (bytes) {
        return bytes;
      }

      return existsSync(file) && statSync(file).isFile()
        ? new Uint8Array(readFileSync(file))
        : null;
    },
    write(name: string, bytes: Uint8Array): boolean {
      written.set(name, bytes.slice());
      return true;
    },
  };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// The builtins' modules, compiled once: each test's runtime runs them.
const builtinModules: ShellModule[] = [];
{
  testing.domainReset(50);
  const hashes: string[] = [];
  for (const bytes of builtins) {
    testing.domainAdd(bytes, true);
    hashes.push(sha(bytes));
    builtinModules.push(await load(testing.domainModule(hashes.join("\n"))));
  }
}

/** Run `abc`, tracing into `lines`: avmshell's exit code for how it ended. */
function run(abc: Uint8Array, lines: string[]): Promise<number> {
  // Linked again in a domain of the test's own, but not compiled again.
  const libraries = builtins.map((bytes, i) => ({
    name: `builtin-${i}`,
    abc: bytes,
    module: builtinModules[i],
  }));
  return runShell(libraries, [{ name: "test", abc }], {
    compiler: testingCompiler(testing),
    createRuntime: runtime.createRuntime,
    print: (line) => lines.push(line),
    files: testFiles(),
    load,
  });
}

process.on("message", async (message: { path: string; abc: string }) => {
  const lines: string[] = [];
  try {
    const exitCode = await run(new Uint8Array(readFileSync(message.abc)), lines);
    process.send?.({ path: message.path, lines, exitCode });
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // Its first line, and not all of it: some quote a whole regular expression.
    process.send?.({ path: message.path, lines, error: error.split("\n")[0].slice(0, 200) });
  }
});

process.send?.({ ready: true });
