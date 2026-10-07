// The IndexedDB module cache (player-hosts) in Chrome: a scripted SWF
// played with it compiles its modules once and then reads them, traces
// alike when its stored modules are cut short and compiled again, and the
// store evicts the least recently used and keeps nothing larger than
// itself. The cache's keys and fallbacks are tested in node
// (tests/unit/player/scripting/code.test.ts).
import assert from "node:assert/strict";
import { scripted } from "./cases.ts";
import { checkModuleCache } from "./chrome.ts";
import { libraryAbcs } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";

libraryAbcs();
const swf = scripted(compileScripts(["Main"]).get("Main") as Uint8Array);
const { loads, kept, oversized } = await checkModuleCache(swf);

assert.deepEqual(
  loads.map((l) => l.error),
  [null, null, null],
);
// builtin, playerglobal and the SWF's; none; all three again.
assert.deepEqual(
  loads.map((l) => l.compiled),
  [3, 0, 3],
);
assert.ok(loads[0].trace.length > 0);
assert.deepEqual(loads[1].trace, loads[0].trace);
assert.deepEqual(loads[2].trace, loads[0].trace);
assert.deepEqual(kept, ["a", "c"]);
assert.equal(oversized, false);
console.log("module cache: ok");
