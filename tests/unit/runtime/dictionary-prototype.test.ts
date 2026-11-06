import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("standalone Dictionary prototype passes GC and recorded Adobe checks", () => {
  const root = new URL("../../bench/dictionary-prototype/", import.meta.url);
  for (const args of [["--expose-gc", "--test", "dictionary.test.js"], ["oracle-test.js"]]) {
    const result = spawnSync(process.execPath, args, {
      cwd: fileURLToPath(root),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }
});
