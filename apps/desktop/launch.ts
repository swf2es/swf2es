// Starts the desktop app in Electron, with a SWF if one is named:
//
//   pnpm --filter @swf2es/desktop start [--trace] [file.swf | https://host/movie.swf]
//
// pnpm runs this in apps/desktop; a relative path is the caller's, from
// the directory pnpm was run in.
import { execFileSync, spawn } from "node:child_process";
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
// Switches and URLs as they are; a path from where pnpm was run.
const args = process.argv
  .slice(2)
  .map((a) => (a.startsWith("-") || /^https?:\/\//i.test(a) ? a : resolve(cwd, a)));
// The checkout's commit, which the context menu's About item names.
let build = "";
try {
  build = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: here,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Not a checkout: the menu names no build.
}

const env = { ...process.env, SWF2ES_DESKTOP_BUILD: build };
const child = spawn(electronBinary() as string, [here, ...args], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
