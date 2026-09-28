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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testing } from "../unit/codegen/testing-module.ts";

const runtime = await import(
  new URL("../../packages/runtime/dist/avm2/index.js", import.meta.url).href
);

// The oracle runs avmshell with TZ=UTC, so local time is UTC here too.
process.env.TZ = "UTC";

const here = fileURLToPath(new URL(".", import.meta.url));
const builtins = ["builtin", "shell_toplevel"].map(
  (name) => new Uint8Array(readFileSync(`${here}out/lib/${name}.abc`)),
);

type Module = (rt: unknown) => unknown;

async function load(js: string): Promise<Module> {
  const url = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
  return (await import(url)).default;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A new domain holding the builtins, linked; each module names the ABCs before it by their hashes. */
function linkBuiltins(): string[] {
  testing.domainReset(50);
  const hashes: string[] = [];
  for (const bytes of builtins) {
    const error = testing.domainAdd(bytes, true);
    if (error) {
      throw new Error(`a builtin failed to link: error ${error}`);
    }

    hashes.push(sha(bytes));
  }

  return hashes;
}

// The builtins' modules, compiled once: each test's runtime runs them.
const builtinModules: Module[] = [];
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
async function run(abc: Uint8Array, lines: string[]): Promise<number> {
  const rt = runtime.createRuntime({ print: (line: string) => lines.push(line) });
  for (const module of builtinModules) {
    module(rt);
  }

  const hashes = linkBuiltins();
  const error = testing.domainAdd(abc, false);
  if (error) {
    lines.push(`VerifyError: Error #${error}`);
    return 1;
  }

  hashes.push(sha(abc));
  const A = (await load(testing.domainModule(hashes.join("\n"))))(rt);
  try {
    rt.run(A);
  } catch (e) {
    // An AS3 exception nothing caught: avmshell prints it, as its string, and exits with 1.
    if (e instanceof Error) {
      throw e;
    }

    lines.push(rt.toString(e));
    return 1;
  }

  return 0;
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
