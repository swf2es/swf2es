// Workers on a page that is not cross-origin isolated, in Chrome
// (docs/workers.md): those that only pass messages run as on an isolated
// one, worker-basics tracing as Flash does, and Worker.isSupported stays
// true; sharing a shareable ByteArray or a Mutex fails with the error
// that names cross-origin isolation, rather than a copy nobody writes or a
// lock nobody else takes. The isolated page runs worker-shared-bytes and
// worker-mutex in run.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.ts";
import { runPlayer } from "./chrome.ts";
import { libraryAbcs } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const chosen = ["worker-basics", "worker-shared-bytes", "worker-mutex"].map((name) => {
  const c = cases.find((c) => c.name === name);
  assert.ok(c && typeof c.swf === "function" && c.script);
  return c;
});
const scripts = compileScripts(chosen.map((c) => c.script as string));
libraryAbcs();

const [basics, shared, mutex] = await runPlayer(
  chosen.map((c) => ({
    ...c,
    swf: (c.swf as (abc: Uint8Array) => Uint8Array)(scripts.get(c.script as string) as Uint8Array),
  })),
  { isolated: false },
);

const expected = readFileSync(`${here}references/worker-basics/trace.txt`, "utf8")
  .replace(/\n$/, "")
  .split(/\r|\n/);
assert.equal(basics.error, null);
assert.deepEqual(basics.trace, expected);

assert.deepEqual(shared.trace, ["shareable false", "shareable true"]);
assert.match(
  shared.error ?? "",
  /sharing a shareable ByteArray with another worker needs shared memory, which a browser gives only a cross-origin isolated page/,
);
assert.deepEqual(mutex.trace, []);
assert.match(
  mutex.error ?? "",
  /sharing a Mutex with another worker needs shared memory, which a browser gives only a cross-origin isolated page/,
);
console.log("isolation: messages pass without isolation, and sharing memory says it needs it");
