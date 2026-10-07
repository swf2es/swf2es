// The IndexedDB module cache (player-hosts) in Chrome: a SWF of a large
// document class played with it compiles its modules once and then reads
// them, and traces alike when its stored modules are cut short and
// compiled again; the store reads again once closed, deletes, evicts the
// least recently used and keeps nothing larger than itself. The cache's keys and fallbacks are tested in node
// (tests/unit/player/scripting/code.test.ts).
import assert from "node:assert/strict";
import { bare } from "./cases.ts";
import { checkModuleCache } from "./chrome.ts";
import { libraryAbcs } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";

libraryAbcs();
// An ABC larger than the smallest the cache is asked for (code.ts, MIN_CACHED_ABC).
const methods = Array.from(
  { length: 400 },
  (_, i) => `public function m${i}(x:Number):Number { return x * ${i}; }`,
);
const source = `package { import flash.display.Sprite; public class CacheLarge extends Sprite {
  public function CacheLarge() { trace("CacheLarge", m2(3)); }
  ${methods.join("\n  ")}
} }`;
const abc = compileScripts([{ name: "CacheLarge", source }]).get("CacheLarge") as Uint8Array;
const check = await checkModuleCache(bare(abc, 1, "CacheLarge"));

assert.deepEqual(
  check.loads.map((l) => l.error),
  [null, null, null],
);
// builtin, playerglobal and the SWF's; none; all three again.
assert.deepEqual(
  check.loads.map((l) => l.compiled),
  [3, 0, 3],
);
assert.deepEqual(check.loads[0].trace, ["CacheLarge 6"]);
assert.deepEqual(check.loads[1].trace, check.loads[0].trace);
assert.deepEqual(check.loads[2].trace, check.loads[0].trace);
assert.deepEqual(check.kept, ["a", "c"]);
assert.equal(check.oversized, false);
assert.equal(check.reopened, true);
assert.equal(check.deleted, true);
console.log("module cache: ok");
