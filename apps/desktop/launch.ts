// Starts the desktop app in Electron, with a SWF if one is named:
//
//   pnpm --filter @swf2es/desktop start [--trace] [file.swf]
//
// pnpm runs this in apps/desktop; a relative path is the caller's, from
// the directory pnpm was run in.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary, missing } from "./electron.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const why = missing();
if (why) {
  console.error(why);
  process.exit(1);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2).map((a) => (a.startsWith("-") ? a : resolve(cwd, a)));
const child = spawn(electronBinary() as string, [here, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
