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
  played.player.tick();
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
