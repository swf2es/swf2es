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

test("a port out of range is refused at once, and a connection not open by the timeout fails", async () => {
  const { connections, socket } = fakeSockets();
  const played = await play(
    `var s = new XMLSocket();
s.onConnect = function (ok) { trace("connect " + ok); };
trace(s.connect("a", 65536) + " " + s.connect("a", -1));
s.timeout = 50;
trace(s.timeout + " " + s.connect("a", 65535));`,
    { socket },
  );
  assert.deepEqual(take(played), ["false false", "50 true"]);
  assert.deepEqual(
    connections.map((c) => c.port),
    [65535],
  );

  await new Promise((resolve) => setTimeout(resolve, 120));
  await played.deliver();
  assert.deepEqual(take(played), ["connect false"]);
  assert.ok(connections[0].closed);

  // Opening after the timeout is too late.
  connections[0].events.open();
  await played.deliver();
  assert.deepEqual(take(played), []);
});

test("a message past the limit without its zero byte closes the connection", async () => {
  const { connections, socket } = fakeSockets();
  const played = await play(
    `var s = new XMLSocket();
s.onData = function (d) { trace("data " + d.length); };
s.onClose = function () { trace("close"); };
s.connect("a", 1024);`,
    { socket },
  );
  const [c] = connections;
  c.events.open();
  c.events.data(new Uint8Array(1024).fill(0x41));
  c.events.data(Uint8Array.of(0x41, 0));
  c.events.data(new Uint8Array(16 * 1024 * 1024 + 1).fill(0x41));
  c.events.data(Uint8Array.of(0));
  await played.deliver();

  assert.deepEqual(take(played), ["data 1025", "close"]);
  assert.ok(c.closed);
});

test("a SWF stopped for good closes its connections and holds nothing more", async () => {
  const { connections, socket } = fakeSockets();
  const played = await play(
    `var s = new XMLSocket();
s.onData = function (d) { trace("data " + d); };
s.connect("a", 1024);`,
    { socket },
  );
  const [c] = connections;
  c.events.open();
  // As an action Flash cannot read stops it.
  played.avm1.halted = true;
  played.player.tick();
  played.avm1.network();
  assert.ok(c.closed);

  c.events.data(Uint8Array.of(0x41, 0));
  await played.deliver();
  assert.deepEqual(take(played), []);
});
