// LoadVars in node: its variables encoded and decoded as Flash does them
// (adl), its loads and sends through the host's fetch, and loadVariables
// into a clip.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchRequest } from "../../../../../packages/player/dist/hosts.js";
import { play, take } from "../network.ts";

test("toString encodes the variables newest first, and decode unescapes as unescape does", async () => {
  const played = await play(`var lv = new LoadVars(); lv.a = "x y"; lv.b = "1&2";
trace(lv.toString());
lv.decode("c=%41+%42&&d&=e&f=%zz&g=%C3%A4");
trace(lv.c + "#" + lv.d + "#" + lv.f + "#" + lv.g);
var keys = []; for (var k in new LoadVars()) { keys.push(k); } trace(keys.length);`);

  assert.deepEqual(take(played), ["b=1%262&a=x%20y", "A B##z#ä", "0"]);
});

test("load and sendAndLoad call onHTTPStatus, then onData, whose default decodes and calls onLoad", async () => {
  const asked: FetchRequest[] = [];
  const played = await play(
    `var lv = new LoadVars();
lv.onHTTPStatus = function (s) { trace("status " + s); };
lv.onLoad = function (ok) { trace("load " + ok + " " + this.myVar + " " + this.loaded + " " + this.getBytesTotal()); };
trace(lv.load() + " " + lv.load("vars.txt") + " " + lv.getBytesLoaded() + " " + lv.loaded);
var out = new LoadVars(); out.q = "a b"; out.addRequestHeader("X-One", "1");
var back = new LoadVars();
back.onData = function (d) { trace("data " + d); };
trace(out.sendAndLoad("missing.txt", back, "POST") + " " + out.sendAndLoad("x", 5));
out.sendAndLoad("get.php", back, "get");`,
    {
      url: "http://example.test/t/test.swf",
      fetch: async (request) => {
        asked.push(request);
        return request.url.endsWith("vars.txt")
          ? { bytes: new TextEncoder().encode("myVar=Hurray&also=yes"), status: 200, headers: [] }
          : { bytes: null, status: 404, headers: [] };
      },
    },
  );

  assert.deepEqual(take(played), ["false true 0 false", "true false"]);
  await played.deliver();
  assert.deepEqual(take(played), [
    "status 200",
    "load true Hurray true 21",
    "data undefined",
    "data undefined",
  ]);
  assert.deepEqual(
    asked.map((r) => [r.method, r.url, r.headers, r.body && new TextDecoder().decode(r.body)]),
    [
      ["GET", "http://example.test/t/vars.txt", [], null],
      [
        "POST",
        "http://example.test/t/missing.txt",
        [
          ["X-One", "1"],
          ["Content-Type", "application/x-www-form-urlencoded"],
        ],
        "q=a+b",
      ],
      ["GET", "http://example.test/t/get.php?q=a+b", [], null],
    ],
  );
});

test("a load without the host's fetch fails as a missing file does", async () => {
  const played = await play(`var lv = new LoadVars();
lv.onHTTPStatus = function (s) { trace("status " + s); };
lv.onLoad = function (ok) { trace("load " + ok); };
lv.load("vars.txt");`);

  await played.deliver();
  assert.deepEqual(take(played), ["status 0", "load false"]);
});

test("loadVariables sets the variables on the clip, then its onData runs", async () => {
  const asked: string[] = [];
  const played = await play(
    `this.x = 1;
this.onData = function () { trace("data " + this.loaded + " " + this.also); };
this.loadVariables("vars.txt", "GET");`,
    {
      fetch: async (request) => {
        asked.push(request.url);
        return {
          bytes: new TextEncoder().encode("loaded=Hurray&also=The%20test"),
          status: 0,
          headers: [],
        };
      },
    },
  );

  await played.deliver();
  assert.deepEqual(take(played), ["data Hurray The test"]);
  assert.match(asked[0], /^file:\/\/\/t\/vars\.txt\?/);
});
