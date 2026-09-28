import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { testing } from "./testing-module.ts";
import { typedCases } from "./typed-cases.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";
const builtin = skip
  ? new Uint8Array()
  : new Uint8Array(readFileSync(new URL("builtin.abc", generated)));

/** The first VerifyError the typed verifier reports for the methods the ABC's scripts can run, or undefined. */
function verify(abc: Uint8Array): number | undefined {
  testing.domainReset(50);
  assert.equal(testing.domainAdd(builtin, true), 0);
  const link = testing.domainAdd(abc, false) as number;
  if (link) {
    return link;
  }

  const error = (testing.domainVerifyAll() as string).split("\n").find((l) => l.includes("error"));
  return error ? Number(error.split(" ")[5]) : undefined;
}

for (const c of typedCases) {
  test(c.name, { skip }, () => {
    assert.equal(verify(c.abc), c.error);
  });
}
