// The libraries' TypeScript declarations are what tools/as3-types.ts makes
// of the committed libraries: CI fails where a library changed and they
// were not written again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarations } from "../../../tools/as3-types.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("each library's declarations are its ABC's", () => {
  const files = declarations();
  assert.equal(files.length, 3);
  for (const [path, text] of files) {
    assert.equal(
      readFileSync(`${root}${path}`, "utf8"),
      text,
      `${path} is stale: run node tools/as3-types.ts --update`,
    );
  }
});
