import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { findZig } from "../../tools/zig.ts";
import { here } from "./paths.ts";

const zig = findZig();
execFileSync(zig, ["test", "fringe.zig"], { cwd: here, stdio: "inherit" });
execFileSync(
  zig,
  [
    "build-exe",
    "fringe.zig",
    "-target",
    "wasm32-freestanding",
    "-O",
    "ReleaseFast",
    "-fno-entry",
    "-rdynamic",
    "--stack",
    "65536",
    "--initial-memory=262144",
    "--max-memory=262144",
    `-femit-bin=${join(here, "fringe.wasm")}`,
  ],
  { cwd: here, stdio: "inherit" },
);
