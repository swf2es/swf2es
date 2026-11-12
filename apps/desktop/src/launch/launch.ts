#!/usr/bin/env node
// Starts the desktop app in Electron, with a SWF if one is named: the
// swf2es-desktop command of the package npm installs, and a checkout's
// `start`.
//
//   npx @swf2es/desktop [--trace] [--log-network] [file.swf | https://host/movie.swf]
//   npx @swf2es/desktop [--trace] app.xml [root-dir] [-- arguments...]
//   pnpm --filter @swf2es/desktop start ...        the same, in a checkout
//
// A relative path is the caller's: from the directory the command was run
// in, which pnpm and npm name in INIT_CWD where they change it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appRoot, electronBinary, electronPackage, missing } from "./electron.ts";

// Electron's binary comes by its package's install script, which a package manager may not
// have run: pnpm runs none it was not told to, and a checkout's install skips this one. Then
// it is fetched now, once, as that script fetches it.
if (!electronBinary()) {
  let install = "";
  try {
    install = join(electronPackage(), "install.js");
  } catch {
    // Not installed at all: `missing` says so.
  }

  if (install && existsSync(install)) {
    console.error("swf2es: downloading Electron, once...");
    spawnSync(process.execPath, [install], { stdio: "inherit" });
  }
}

const why = missing();
if (why) {
  console.error(why);
  process.exit(1);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
// Switches and URLs as they are; a path from where the command was run. What follows "--" is
// an AIR application's own arguments, as they are.
const given = process.argv.slice(2);
const end = given.indexOf("--");
const own = end < 0 ? given : given.slice(0, end);
const args = [
  ...own.map((a) => (a.startsWith("-") || /^https?:\/\//i.test(a) ? a : resolve(cwd, a))),
  ...(end < 0 ? [] : given.slice(end)),
];
// What the context menu's About item names: a checkout's commit, else the package's version.
let build = "";
try {
  build = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: appRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Not a checkout, or no git.
}

// An installed package may sit inside some other project's checkout: its commit is not the app's.
if (!build || appRoot.includes(`${join("node_modules", "@swf2es")}`)) {
  build = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version;
}

const env: NodeJS.ProcessEnv = { ...process.env, SWF2ES_DESKTOP_BUILD: build };
// Set by tools that are Electron apps themselves, an editor's terminals and tasks among them,
// for the node they run: here it would make Electron run the app's main module as plain node.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary() as string, [appRoot, ...args], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
