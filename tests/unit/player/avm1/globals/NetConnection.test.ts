// NetConnection's AS2 face in node: the local connection, and Flash
// Remoting's calls, a frame's sent together as one AMF0 packet with the
// connection's headers, their answers going to their responders (the
// corpus's netconnection_* and amf_* tests).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchRequest } from "../../../../../packages/player/dist/hosts.js";
import { play, take } from "../network.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const utf = (s: string) => [0, s.length, ...ascii(s)];
const h = (s: string) => s.split(" ").map((x) => Number.parseInt(x, 16));

test("connect(null) is the local connection, connected at once; another closes it first", async () => {
  const played = await play(
    `var nc = new NetConnection();
nc.onStatus = function (e) { trace(e.code + " " + e.level); };
trace(nc.isConnected + " " + nc.uri);
nc.connect(null); trace(nc.isConnected + " " + nc.uri + " " + nc.protocol);
nc.connect("http://example.test/gateway"); trace(nc.isConnected + " " + nc.uri + " " + nc.protocol);
nc.close();`,
  );
  assert.deepEqual(take(played), [
    "false undefined",
    "NetConnection.Connect.Success status",
    "true null rtmp",
    "NetConnection.Connect.Closed status",
    "false http://example.test/gateway undefined",
    "NetConnection.Connect.Closed status",
    "undefined undefined",
  ]);
});

test("a frame's calls go as one packet with the headers, each answered at its index", async () => {
  const asked: FetchRequest[] = [];
  // An answer for the second call's onStatus and the first's onResult.
  const answer = Uint8Array.from([
    ...h("00 00 00 00 00 02"),
    ...utf("/2/onStatus"),
    ...utf("null"),
    ...h("00 00 00 00 02"),
    ...utf("bad"),
    ...utf("/1/onResult"),
    ...utf("null"),
    ...h("00 00 00 00 00 40 45 00 00 00 00 00 00"),
  ]);
  const played = await play(
    `var nc = new NetConnection();
nc.connect("http://example.test/gateway");
nc.addHeader("Credentials", false, "x"); nc.addHeader("credentials", true, null);
var r1 = {onResult: function (v) { trace("result " + v); }};
var r2 = {onStatus: function (v) { trace("status " + v); }};
nc.call("svc.first", r1, 1, [true, "a"]);
nc.call("svc.second", r2);
trace("called");`,
    {
      fetch: async (request) => {
        asked.push(request);
        return { bytes: answer, status: 200, headers: [] };
      },
    },
  );
  // The first frame's calls go at its end, before the next frame takes what the network answered.
  assert.deepEqual(take(played), ["called"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].method, "POST");
  assert.deepEqual(asked[0].headers, [["Content-Type", "application/x-amf"]]);
  assert.equal(
    hex(asked[0].body as Uint8Array),
    hex(
      Uint8Array.from([
        ...h("00 00 00 01"),
        ...utf("credentials"),
        ...h("01 00 00 00 01 05 00 02"),
        ...utf("svc.first"),
        ...utf("/1"),
        ...h("00 00 00 19 0a 00 00 00 02 00 3f f0 00 00 00 00 00 00 0a 00 00 00 02 01 01 02"),
        ...utf("a"),
        ...utf("svc.second"),
        ...utf("/2"),
        ...h("00 00 00 05 0a 00 00 00 00"),
      ]),
    ),
  );
  await played.deliver();
  assert.deepEqual(take(played), ["status bad", "result 42"]);
});

test("a call whose request fails tells the connection's onStatus nothing", async () => {
  const played = await play(
    `var nc = new NetConnection();
nc.onStatus = function () { trace("status " + arguments.length); };
nc.connect("https://example.test/gateway");
nc.call("svc.m", {});`,
    { fetch: async () => ({ bytes: null, status: 404, headers: [] }) },
  );
  played.player.tick();
  await played.deliver();
  assert.deepEqual(take(played), ["status 0"]);
});

test("a reply with a truncated boolean or date is ignored", async () => {
  for (const value of [h("01"), h("0b 00 00 00 00 00 00 00 00")]) {
    const answer = Uint8Array.from([
      ...h("00 00 00 00 00 01"),
      ...utf("/1/onResult"),
      ...utf("null"),
      0,
      0,
      0,
      value.length,
      ...value,
    ]);
    const played = await play(
      `var nc = new NetConnection(); nc.connect("https://example.test/gateway");
nc.call("svc.m", {onResult: function () { trace("unexpected result"); }});`,
      { fetch: async () => ({ bytes: answer, status: 200, headers: [] }) },
    );
    played.player.tick();
    await played.deliver();
    assert.deepEqual(take(played), []);
  }
});

/** What `source` POSTs at its first frame's end, as hex. */
async function posted(source: string): Promise<string[]> {
  const asked: FetchRequest[] = [];
  const played = await play(source, {
    fetch: async (request) => {
      asked.push(request);
      return { bytes: null, status: 404, headers: [] };
    },
  });
  played.player.tick();
  take(played);
  return asked.map((r) => hex(r.body as Uint8Array));
}

test("a call's arguments share one table of references, the arguments the first; a header's its own", async () => {
  // adl, the bodies Flash POSTed to a server: an array and an object holding themselves, an
  // array met twice in another, a header's object holding itself, an array with a key that is no
  // index, an object met twice among the arguments.
  assert.deepEqual(
    await posted(`var nc = new NetConnection(); nc.connect("http://example.test/a"); var r = {};
var a = [1]; a.push(a); var o = {x: 1}; o.self = o; var b = [2]; var c = [b, b];
nc.call("cyc", r, a); nc.call("obj", r, o); nc.call("shared", r, c);`),
    [
      "00 00 00 00 00 03 00 03 63 79 63 00 02 2f 31 00 00 00 16 0a 00 00 00 01 0a 00 00 00 02 00 3f f0 00 00 00 00 00 00 07 00 01 00 03 6f 62 6a 00 02 2f 32 00 00 00 1e 0a 00 00 00 01 03 00 01 78 00 3f f0 00 00 00 00 00 00 00 04 73 65 6c 66 07 00 01 00 00 09 00 06 73 68 61 72 65 64 00 02 2f 33 00 00 00 1b 0a 00 00 00 01 0a 00 00 00 02 0a 00 00 00 01 00 40 00 00 00 00 00 00 00 07 00 02",
    ],
  );
  assert.deepEqual(
    await posted(`var nc = new NetConnection(); nc.connect("http://example.test/b"); var r = {};
var o = {x: 1}; o.self = o; nc.addHeader("h", false, o);
var m = [3]; m.k = m; var n = {}; nc.call("mixed", r, m, n, n);
var big = []; big[70000] = 1; nc.call("long", r, big.length);`),
    [
      "00 00 00 01 00 01 68 00 00 00 00 19 03 00 01 78 00 3f f0 00 00 00 00 00 00 00 04 73 65 6c 66 07 00 00 00 00 09 00 02 00 05 6d 69 78 65 64 00 02 2f 31 00 00 00 26 0a 00 00 00 03 08 00 00 00 01 00 01 30 00 40 08 00 00 00 00 00 00 00 01 6b 07 00 01 00 00 09 03 00 00 09 07 00 02 00 04 6c 6f 6e 67 00 02 2f 32 00 00 00 0e 0a 00 00 00 01 00 40 f1 17 10 00 00 00 00",
    ],
  );
});

test("a length or a nesting a script makes huge is written bounded", async () => {
  // Flash would write 2^31 - 1 elements, or recurse as deep as the objects go.
  const [body] = await posted(`var nc = new NetConnection(); nc.connect("http://example.test/c");
var a = []; a.length = 2147483647; var d = []; d["99999999999"] = 1;
var deep = {}; var at = deep; for (var i = 0; i < 5000; i++) { at.next = {}; at = at.next; }
nc.call("m", {}, a, d, deep);`);
  // A million values at most, a byte each where they are undefined.
  assert.ok(body.length / 3 < 1.1 * 2 ** 20, `${body.length / 3} bytes`);
});
