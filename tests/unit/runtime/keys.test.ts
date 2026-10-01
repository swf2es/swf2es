// The names the builtins' natives register under, every one: a move of
// natives between the record and the class style must leave this set as it
// was. natives-keys.json was recorded from the natives as records; a new
// native adds its key there, by hand or with UPDATE_NATIVE_KEYS=1.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { avm2 } from "@swf2es/runtime";

const file = fileURLToPath(new URL("natives-keys.json", import.meta.url));

test("the builtins' natives register under the recorded names, no more and no fewer", () => {
  const keys = Object.keys(avm2.builtinNatives(new avm2.Runtime({}, {}))).sort();
  if (process.env.UPDATE_NATIVE_KEYS) {
    writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`);
  }

  const recorded: string[] = JSON.parse(readFileSync(file, "utf8"));
  const missing = recorded.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !recorded.includes(k));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});
