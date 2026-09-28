import assert from "node:assert/strict";
import { test } from "node:test";
import { testing } from "./testing-module.ts";
import { verifyCases } from "./verify-cases.ts";

/** The first error swf2es' decoder reports for any body, or undefined. */
function verify(abc: Uint8Array): number | undefined {
  const error = (testing.codeDump(abc) as string)
    .split("\n")
    .find((l) => l.trim().startsWith("error"));
  return error ? Number(error.trim().split(" ")[1]) : undefined;
}

for (const c of verifyCases) {
  test(c.name, () => {
    assert.equal(verify(c.abc), c.error);
  });
}
