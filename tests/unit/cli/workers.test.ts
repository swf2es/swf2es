// swf2es run's background workers where avmshell is no reference: the
// oracle's avmshell runs without interrupts, so it never stops a worker
// spinning in a loop, and waits for it at exit for ever. swf2es stops its
// thread at terminate, and the run ends.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { containerEngine, runOracle } from "../../../oracle/oracle.ts";

const out = fileURLToPath(new URL("../out/cli/workers/", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/cli/dist/main.js", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const SPINNER = readFileSync(new URL("./Spinner.as", import.meta.url), "utf8");

test("terminate stops a worker spinning in a loop, and the run ends", { skip }, () => {
  mkdirSync(out, { recursive: true });
  const source = `${out}Spinner.as`;
  writeFileSync(source, SPINNER);
  const [result] = runOracle([{ source, name: "Spinner" }], out, { run: false });
  assert.ok(result.compiled, result.compileLog);

  const run = spawnSync(process.execPath, [cli, "run", `${out}Spinner.abc`], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "spinning true",
    "listed 2 running",
    "terminate true terminated",
    "listed 1",
    "terminate again false",
  ]);
});
