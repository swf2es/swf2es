// The programs' builds, which the programs runner runs: as3pb by ASC,
// whose ABC tests/golden keeps and digests the module of, and LZ4 by
// Crossbridge's gcc, which builds it differently each time.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrossbridgeJob, OracleJob } from "../../oracle/oracle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

/** as3pb's benchmark: its avmshell entry point, with the -in files in the order it lists. */
export function as3pb(): OracleJob {
  const dir = `${here}as3pb/`;
  const sources = readFileSync(`${dir}runtime/test/bench/shell-sources.txt`, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));

  return {
    source: `${dir}runtime/test/bench/ShellMain.as`,
    name: "as3pb/ShellMain",
    ascArgs: [
      "-AS3",
      "-optimize",
      "-inline",
      "-strict",
      ...sources.flatMap((s) => ["-in", relative(root, `${dir}${s}`)]),
    ],
  };
}

/** LZ4's benchmark: the driver and com-lz4-as3's vendored sources, as -O4 as the library builds. */
export function lz4(): CrossbridgeJob {
  const vendor = "tests/programs/com-lz4-as3/native/vendor";
  return {
    name: "lz4",
    gccArgs: [
      "-O4",
      "-DNDEBUG",
      "-flto-api=tests/programs/com-lz4-as3/native/exports.txt",
      "-fllvm-opt-opt=-strip",
      "-disable-telemetry",
      `-I${vendor}`,
      "tests/programs/lz4/main.c",
      ...["lz4", "lz4hc", "lz4frame", "xxhash"].map((f) => `${vendor}/${f}.c`),
    ],
  };
}
