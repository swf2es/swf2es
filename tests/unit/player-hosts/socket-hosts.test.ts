import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { nodeSocketHost } from "@swf2es/player-hosts/node";
import { webSocketSocketHost } from "@swf2es/player-hosts/websocket";
import type { SocketEndpoints } from "../../../packages/player/dist/hosts.js";

test("the Node host exchanges bytes with a TCP socket and reports its close", async () => {
  const server = createServer((peer) => {
    const request: number[] = [];
    peer.on("data", (bytes) => {
      request.push(...bytes);
      if (request.length >= 3) {
        assert.deepEqual(request, [1, 2, 3]);
        peer.write(Uint8Array.from([4, 5]));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  let connected!: (endpoints?: SocketEndpoints) => void;
  let received!: () => void;
  let closed!: () => void;
  const opened = new Promise<SocketEndpoints | undefined>((resolve) => {
    connected = resolve;
  });
  const data = new Promise<void>((resolve) => {
    received = resolve;
  });
  const ended = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const messages: number[] = [];
  const errors: string[] = [];
  const transport = nodeSocketHost().connect("127.0.0.1", address.port, {
    open: (endpoints) => connected(endpoints),
    data: (bytes) => {
      messages.push(...bytes);
      if (messages.length >= 2) {
        received();
      }
    },
    close: () => closed(),
    error: (message) => errors.push(message),
  });

  try {
    const endpoints = await opened;
    assert.equal(endpoints?.localAddress, "127.0.0.1");
    assert.ok(endpoints && endpoints.localPort > 0);
    assert.equal(endpoints?.remoteAddress, "127.0.0.1");
    assert.equal(endpoints?.remotePort, address.port);
    transport.send(Uint8Array.from([1, 2, 3]));
    await data;
    assert.deepEqual(messages, [4, 5]);
    assert.deepEqual(errors, []);
    transport.close();
    await ended;
  } finally {
    transport.close();
    server.close();
  }
});

test("the WebSocket host uses binary frames and leaves the proxy URL to its caller", () => {
  const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  const emit = (type: string, event: { data?: unknown } = {}) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };
  const sent: number[][] = [];
  let closeCalls = 0;
  const socket = {
    binaryType: "blob",
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    send(bytes: Uint8Array) {
      sent.push([...bytes]);
    },
    close() {
      closeCalls++;
      emit("close");
    },
  };
  const urls: string[] = [];
  const events: string[] = [];
  const host = webSocketSocketHost(
    (name, port) => `wss://proxy.test/tcp/${name}/${port}`,
    (url) => {
      urls.push(url);
      return socket as never;
    },
  );
  const transport = host.connect("example.test", 8080, {
    open: () => events.push("open"),
    data: (bytes) => events.push(`data:${[...bytes]}`),
    close: () => events.push("close"),
    error: (message) => events.push(`error:${message}`),
  });

  assert.deepEqual(urls, ["wss://proxy.test/tcp/example.test/8080"]);
  assert.equal(socket.binaryType, "arraybuffer");
  emit("open");
  transport.send(Uint8Array.from([1, 2]));
  assert.deepEqual(sent, [[1, 2]]);
  emit("message", { data: Uint8Array.from([3]).buffer });
  emit("message", { data: Uint8Array.from([4, 5]).buffer });
  assert.deepEqual(events, ["open", "data:3", "data:4,5"]);

  emit("message", { data: "not binary" });
  assert.deepEqual(events, [
    "open",
    "data:3",
    "data:4,5",
    "error:Socket bridge sent a non-binary WebSocket message.",
    "close",
  ]);
  assert.equal(closeCalls, 1);
});
