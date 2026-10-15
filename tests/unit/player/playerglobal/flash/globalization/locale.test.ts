import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESOLVED_MAX,
  resolvedCount,
  resolveLocale,
} from "../../../../../../packages/player/dist/playerglobal/flash/globalization/locale.js";
import type { Scripting } from "../../../../../../packages/player/dist/scripting.js";

// A SWF may name any locale it likes, and every player shares the resolutions: the cache must
// keep the last few, not every name it was ever asked.
test("resolved locale names are kept to a bounded few", () => {
  const s = { platform: { locale: "en-US" } } as unknown as Scripting;
  for (let i = 0; i < 20000; i++) {
    resolveLocale(s, `en-US-x${i.toString(36).padStart(4, "a")}`);
    resolveLocale(s, `${i}`);
  }

  assert.ok(resolvedCount() <= RESOLVED_MAX);
  assert.deepEqual(resolveLocale(s, "de"), {
    requested: "de",
    actual: "de-DE",
    status: "noError",
  });
  assert.deepEqual(resolveLocale(s, "xx"), {
    requested: "xx",
    actual: "en-US",
    status: "usingDefaultWarning",
  });
  // Resolved again, a name gives the same as it did: a copy, not the cached record.
  const first = resolveLocale(s, "fi-FI");
  first.actual = "changed";
  assert.equal(resolveLocale(s, "fi-FI").actual, "fi-FI");
  assert.ok(resolvedCount() <= RESOLVED_MAX);
});
