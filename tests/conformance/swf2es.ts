// Runs an ABC compiled by swf2es in node: the builtins avmshell loads, then
// the ABC, each compiled to a module and loaded into one runtime, whose
// trace output is the result.
import { createHash } from "node:crypto";
import { testing } from "../unit/codegen/testing-module.ts";

const runtime = await import(
  new URL("../../packages/runtime/dist/avm2/index.js", import.meta.url).href
);

/** The module swf2es compiles the domain's last ABC to, loaded. */
async function load(js: string): Promise<(rt: unknown) => unknown> {
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  return module.default;
}

/**
 * Run `abc` after `builtins`, as avmshell does: the builtins' scripts on
 * first use, then the ABC's entry point. The lines it traces, or an error.
 */
export async function runSwf2es(builtins: Uint8Array[], abc: Uint8Array): Promise<string[]> {
  const lines: string[] = [];
  const rt = runtime.createRuntime({ print: (line: string) => lines.push(line) });
  // Each module names the ABCs before it, by the hashes the cache key uses.
  const hashes: string[] = [];
  const hash = (bytes: Uint8Array) => {
    hashes.push(createHash("sha256").update(bytes).digest("hex"));
    return hashes.join("\n");
  };

  testing.domainReset(50);
  for (const bytes of builtins) {
    const error = testing.domainAdd(bytes, true);
    if (error) {
      throw new Error(`a builtin failed to link: error ${error}`);
    }

    (await load(testing.domainModule(hash(bytes))))(rt);
  }

  const error = testing.domainAdd(abc, false);
  if (error) {
    return [`VerifyError: Error #${error}`];
  }

  const A = (await load(testing.domainModule(hash(abc))))(rt);
  try {
    rt.run(A);
  } catch (e) {
    // An AS3 exception nothing caught: avmshell prints it, as its string.
    if (e instanceof Error) {
      throw e;
    }

    lines.push(rt.toString(e));
  }

  return lines;
}
