// Formats the repository's ActionScript with Apache Royale's asformat, in its
// default style: the libraries under as3/ and the tests' scripts. CI has no
// asformat, so this stays a local step.
//
//   node tools/as3-format.ts        (pnpm as3:format; ASFORMAT names asformat's script)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const asformat = process.env.ASFORMAT ?? "asformat";

const LIBRARIES = ["as3/builtin/src", "as3/playerglobal/src", "as3/air/src"];

// What asformat 0.9.12 would break, left as written:
// - AVM1's scripts are ActionScript 1 and 2, which tests/avm1-script.ts compiles: asformat ends
//   `tellTarget (t) {` with a semicolon, making its block run outside the target.
// - asformat drops the space before `instanceof`, which then no longer parses after a name.
// - It cannot parse AIR's float literals (`1f`), and stops at the first file it cannot parse.
const LEFT_OUT_DIRECTORIES = ["tests/player/avm1/"];
const LEFT_OUT = ["tests/conformance/cases/air/AirFloat.as"];

// The tests' own scripts: tracked files alone, so neither the programs' submodules nor
// fetched corpora nor compiled output.
const listed = spawnSync("git", ["ls-files", "-z", "tests/*.as", "tests/*.as.template"], {
  cwd: root,
  encoding: "utf8",
});
if (listed.status !== 0) {
  throw new Error(`git ls-files failed: ${listed.stderr}`);
}

const tests = listed.stdout
  .split("\0")
  .filter(Boolean)
  .filter(
    (file) =>
      !LEFT_OUT.includes(file) &&
      !LEFT_OUT_DIRECTORIES.some((dir) => file.startsWith(dir)) &&
      !/\binstanceof\b/.test(readFileSync(`${root}${file}`, "utf8")),
  );

// asformat reports a file it cannot parse and goes on with status 0, so its output decides.
const run = spawnSync(asformat, ["-write-files", ...LIBRARIES, ...tests], {
  cwd: root,
  encoding: "utf8",
});
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
if (run.error || run.status !== 0 || /error/i.test(output)) {
  console.error(output || run.error?.message);
  process.exit(1);
}

console.log(`formatted ${LIBRARIES.join(", ")} and ${tests.length} test scripts`);
