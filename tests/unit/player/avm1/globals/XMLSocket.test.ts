// XMLSocket in node against a fake socket host: connecting, messages split
// across the host's chunks at their zero bytes, sends, the close of either
// side, and connections that fail, which call onConnect(false) and never
// throw.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SocketEvents } from "../../../../../packages/player/dist/hosts.js";
import { play, take } from "../network.ts";

interface Connection {
  host: string;
  port: number;
  events: SocketEvents;
  sent: string[];
  closed: boolean;
}

function fakeSockets(refuse: (port: number) => boolean = () => false) {
  const connections: Connection[] = [];
  return {
    connections,
    socket: {
      connect(host: string, port: number, events: SocketEvents) {
        const c: Connection = { host, port, events, sent: [], closed: false };
        connections.push(c);
        if (refuse(port)) {
          events.error("Error #2031: Socket Error.");
        }

        return {
          send: (bytes: Uint8Array) => {
            c.sent.push(new TextDecoder().decode(bytes));
          },
          close: () => {
            c.closed = true;
          },
        };
      },
    },
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);

test("messages come to onData at their zero bytes, however the host splits them", async () => {
  const { connections, socket } = fakeSockets((port) => port === 2000);
  const played = await play(
    `var s = new XMLSocket();
s.onConnect = function (ok) { trace("connect " + ok); if (ok) { s.send("hi"); } };
s.onData = function (d) { trace("data [" + d + "]"); };
s.onClose = function () { trace("close"); };
s.send("early"); s.close();
trace(s.connect("example.test", 1234));
var f = new XMLSocket();
f.onConnect = function (ok) { trace("refused " + ok); };
f.connect(null, 2000);`,
    { socket },
  );

  assert.deepEqual(take(played), ["true"]);
  assert.deepEqual(
    connections.map((c) => [c.host, c.port]),
    [
      ["example.test", 1234],
      ["localhost", 2000],
    ],
  );

  const [c] = connections;
  c.events.open();
  await played.deliver();
  assert.deepEqual(take(played), ["refused false", "connect true"]);
  assert.deepEqual(c.sent, ["hi\0"]);

  c.events.data(bytes("ab"));
  c.events.data(bytes("c\0d\0e"));
  await played.deliver();
  assert.deepEqual(take(played), ["data [abc]", "data [d]"]);

  c.events.data(bytes("\0\0"));
  c.events.close();
  await played.deliver();
  assert.deepEqual(take(played), ["data [e]", "data []", "close"]);
});

test("the default onData makes an XML of each message for onXML, and close in a handler ends it", async () => {
  const { connections, socket } = fakeSockets();
  const played = await play(
    `var s = new XMLSocket();
s.onXML = function (x) { trace(x.firstChild.nodeName + " " + x); s.close(); };
s.onClose = function () { trace("never"); };
s.connect("example.test", 1024);`,
    { socket },
  );
  const [c] = connections;
  c.events.open();
  c.events.data(bytes("<root><item></item></root>\0<second/>\0"));
  c.events.close();
  await played.deliver();

  assert.deepEqual(take(played), ["root <root><item /></root>"]);
  assert.ok(c.closed);
});

test("without a socket host, and on a connection that closes before it opens, onConnect is false", async () => {
  const played = await play(`var s = new XMLSocket();
s.onConnect = function (ok) { trace("connect " + ok); };
trace(s.connect("example.test", 1024));`);
  await played.deliver();
  assert.deepEqual(take(played), ["true", "connect false"]);

  const { connections, socket } = fakeSockets();
  const closing = await play(
    `var s = new XMLSocket(); s.onConnect = function (ok) { trace("connect " + ok); }; s.connect("a", 1);`,
    { socket },
  );
  connections[0].events.close();
  await closing.deliver();
  assert.deepEqual(take(closing), ["connect false"]);
});
