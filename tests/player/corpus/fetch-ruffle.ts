// Checks out Ruffle's test corpus at RUFFLE_COMMIT into tests/player/corpus/ruffle:
// only tests/tests/swfs, shallow and sparse, about 230 MB.
//
//   node tests/player/corpus/fetch-ruffle.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RUFFLE_COMMIT } from "./ruffle.ts";

const dir = fileURLToPath(new URL("ruffle/", import.meta.url));
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "inherit" });

if (!existsSync(`${dir}.git`)) {
  mkdirSync(dir, { recursive: true });
  git("init", "--quiet");
  git("remote", "add", "origin", "https://github.com/ruffle-rs/ruffle.git");
  git("sparse-checkout", "set", "--no-cone", "/tests/tests/swfs/");
}

git("fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", RUFFLE_COMMIT);
git("checkout", "--quiet", "--detach", RUFFLE_COMMIT);
