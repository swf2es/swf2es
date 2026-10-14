// Runs an ABC compiled by swf2es in node: the builtins avmshell loads, then
// the ABC, each compiled to a module and loaded into one runtime, whose
// trace output is the result.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runShell, type ShellModule } from "../../packages/cli/dist/shell.js";
import { testing } from "../unit/codegen/testing-module.ts";
import { testingCompiler } from "./abc-compiler.ts";

// SWF2ES_RUNTIME=<dir> loads another build of the runtime's dist, to compare two (tests/programs/ab.ts).
const runtime = await import(
  process.env.SWF2ES_RUNTIME
    ? pathToFileURL(join(process.env.SWF2ES_RUNTIME, "avm2/index.js")).href
    : new URL("../../packages/runtime/dist/avm2/index.js", import.meta.url).href
);

const root = fileURLToPath(new URL("../../", import.meta.url));

// The oracle runs avmshell with TZ=UTC, so local time is UTC here too.
process.env.TZ = "UTC";

// With SWF2ES_MODULES=<dir>, each module is written there, 0.mjs, 1.mjs, ...
// in load order, and loaded from its file, so that stacks name it.
const moduleDir = process.env.SWF2ES_MODULES;
let loaded = 0;

/**
 * The module swf2es compiles the domain's last ABC to, loaded, with its
 * source map: next to it, or in it, so that a debugger steps through the AS3.
 */
async function load(js: string): Promise<ShellModule> {
  // asc runs in the oracle's container, where the repository is /work.
  const parsed = JSON.parse(testing.domainSourceMap());
  parsed.sources = parsed.sources.map((s: string) => s.replace(/^\/work\//, root));
  const map = JSON.stringify(parsed);
  if (moduleDir) {
    mkdirSync(moduleDir, { recursive: true });
    const name = `${loaded++}.mjs`;
    const file = join(moduleDir, name);
    writeFileSync(`${file}.map`, map);
    writeFileSync(file, `${js}//# sourceMappingURL=${name}.map\n`);
    return (await import(`${pathToFileURL(file).href}?${Date.now()}`)).default;
  }

  const base64 = (s: string) => Buffer.from(s).toString("base64");
  const source = `${js}//# sourceMappingURL=data:application/json;base64,${base64(map)}\n`;
  const module = await import(`data:text/javascript;base64,${base64(source)}`);
  return module.default;
}

/**
 * Run `abc` after `builtins`, as avmshell does (swf2es run): the builtins'
 * scripts on first use, then the ABC's entry point. The lines it traces,
 * or an error.
 */
export async function runSwf2es(builtins: Uint8Array[], abc: Uint8Array): Promise<string[]> {
  const lines: string[] = [];
  await runShell(
    builtins.map((bytes, i) => ({ name: `builtin-${i}`, abc: bytes })),
    [{ name: "main", abc }],
    {
      compiler: testingCompiler(testing),
      createRuntime: runtime.createRuntime,
      print: (line) => lines.push(line),
      load,
    },
  );
  return lines;
}
