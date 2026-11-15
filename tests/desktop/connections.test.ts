// The desktop app's socket connections (apps/desktop/src/main/connections.ts)
// in node, without Electron: what they carry, what they refuse, and that a
// peer that stops reading cannot make the main process buffer without end.
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import {
  type ConnectionOptions,
  Connections,
  MAX_BUFFERED,
} from "../../apps/desktop/src/main/connections.ts";
import { parseProxy } from "../../apps/desktop/src/main/proxy.ts";
import type { SocketEvent } from "../../apps/desktop/src/shared/api.ts";
import { testProxy } from "./proxy-server.ts";

async function listen(onConnection: (socket: Socket) => void): Promise<[Server, number]> {
  const server = createServer(onConnection);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return [server, (server.address() as { port: number }).port];
}

/** Connections whose events are kept, and a wait for one of a type. */
function recorded(options?: ConnectionOptions) {
  const events: SocketEvent[] = [];
  const waiting: [string, () => void][] = [];
  const connections = new Connections((_id, event) => {
    events.push(event);
    for (const [type, done] of waiting.splice(0)) {
      if (type === event.type) {
        done();
      } else {
        waiting.push([type, done]);
      }
    }
  }, options);
  const next = (type: SocketEvent["type"]) =>
    events.some((e) => e.type === type)
      ? Promise.resolve()
      : new Promise<void>((done) => waiting.push([type, done]));
  return { connections, events, next };
}

test("carries bytes both ways", async () => {
  const [server, port] = await listen((socket) => {
    socket.on("data", (bytes) => socket.write(bytes.toString() === "ping" ? "pong" : "?"));
  });
  const { connections, events, next } = recorded();
  connections.connect(1, "127.0.0.1", port);
  await next("open");
  connections.send(1, new TextEncoder().encode("ping"));
  await next("data");
  const data = events.find((e) => e.type === "data");
  assert.equal(data?.type === "data" && new TextDecoder().decode(data.bytes), "pong");
  connections.close(1);
  await next("close");
  assert.equal(connections.size, 0);
  server.close();
});

test("refuses a bad port or host as an error, then a close", () => {
  const { connections, events } = recorded();
  connections.connect(1, "127.0.0.1", 70000);
  connections.connect(2, "", 80);
  connections.connect(3, 42, 80);
  assert.deepEqual(
    events.map((e) => e.type),
    ["error", "close", "error", "close", "error", "close"],
  );
  assert.equal(connections.size, 0);
});

test("fails a connection whose peer stops reading, past what it may buffer", {
  timeout: 30_000,
}, async () => {
  const [server, port] = await listen((socket) => socket.pause());
  const { connections, events, next } = recorded();
  connections.connect(1, "127.0.0.1", port);
  await next("open");
  // Far more than the kernel's buffers take: past them, node would hold the rest.
  const chunk = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 256 && !events.some((e) => e.type === "error"); i++) {
    connections.send(1, chunk);
    await new Promise((done) => setImmediate(done));
  }

  assert.ok(
    events.some((e) => e.type === "error"),
    "the connection never failed",
  );
  await next("close");
  assert.equal(connections.size, 0);
  assert.ok(MAX_BUFFERED < 256 * chunk.length);
  server.close();
});

test("connects to the address its policy came from, not where the name resolves now", async () => {
  const [server, port] = await listen((socket) => socket.end("here"));
  const { connections, events, next } = recorded();
  connections.connect(1, "no-such-host.invalid", port, "127.0.0.1");
  await next("data");
  const opened = events.find((e) => e.type === "open");
  assert.equal(opened?.type === "open" && opened.remoteAddress, "127.0.0.1");
  await next("close");
  server.close();
});

test("through a proxy: by the pinned address or by name, refused as one no server took", async () => {
  const [server, port] = await listen((socket) => {
    socket.write("hello");
    socket.on("data", (bytes) => socket.write(bytes.toString() === "ping" ? "pong" : "?"));
  });
  for (const kind of ["socks5", "http"] as const) {
    const code = kind === "socks5" ? 1 : 403;
    const proxy = await testProxy(kind, { refuse: (_host, at) => (at === 1 ? code : null) });
    const warned: string[] = [];
    const { connections, events, next } = recorded({
      proxy: parseProxy(proxy.url()),
      warn: (message) => warned.push(message),
    });
    connections.connect(1, "no-such-host.invalid", port, "127.0.0.1");
    await next("open");
    // Its peer is the target, not the proxy.
    const opened = events.find((e) => e.type === "open");
    assert.equal(
      opened?.type === "open" && `${opened.remoteAddress}:${opened.remotePort}`,
      `127.0.0.1:${port}`,
    );
    await next("data");
    connections.send(1, new TextEncoder().encode("ping"));
    while (
      !events.some((e) => e.type === "data" && new TextDecoder().decode(e.bytes).includes("pong"))
    ) {
      await new Promise((done) => setTimeout(done, 10));
    }

    connections.close(1);
    await next("close");

    // By name, where nothing pinned an address: the proxy resolves it.
    const named = recorded({ proxy: parseProxy(proxy.url()) });
    named.connections.connect(2, "localhost", port);
    await named.next("open");
    named.connections.closeAll();
    assert.deepEqual(proxy.targets, [`127.0.0.1:${port}`, `localhost:${port}`]);

    // Refused by the proxy: an error, then a close, and why on stderr.
    const refused = recorded({ proxy: parseProxy(proxy.url()), warn: (m) => warned.push(m) });
    refused.connections.connect(3, "127.0.0.1", 1);
    await refused.next("close");
    assert.deepEqual(
      refused.events.map((e) => e.type),
      ["error", "close"],
    );
    assert.match(warned.join("\n"), /^no socket to 127\.0\.0\.1:1: the proxy \S+ refused: /);

    // Closed before the proxy has made it: closed, and nothing opens after.
    const early = recorded({ proxy: parseProxy(proxy.url()) });
    early.connections.connect(4, "127.0.0.1", port);
    assert.equal(early.connections.size, 1);
    early.connections.close(4);
    await early.next("close");
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(
      early.events.map((e) => e.type),
      ["close"],
    );
    assert.equal(early.connections.size, 0);
    await proxy.close();
  }

  server.close();
});

test("each read is copied out at its length, a store of its own", async () => {
  const total = 1024 * 1024;
  const pattern = Buffer.alloc(total);
  for (let i = 0; i < total; i++) {
    pattern[i] = (i * 31 + (i >> 11)) & 0xff;
  }

  const [server, port] = await listen((socket) => socket.end(pattern));
  const { connections, events, next } = recorded();
  connections.connect(1, "127.0.0.1", port);
  await next("close");
  const reads = events.flatMap((e) => (e.type === "data" ? [e.bytes] : []));
  assert.ok(Buffer.concat(reads).equals(pattern));
  // The socket's buffer is read into again, and IPC sends a typed array's whole store.
  for (const bytes of reads) {
    assert.equal(bytes.buffer.byteLength, bytes.length);
  }

  server.close();
});

test("through a proxy: what came with its reply first, then the tunnel's reads, once open", {
  timeout: 30_000,
}, async () => {
  // A SOCKS5 proxy that sends its reply and the server's first bytes in one write.
  const tail = Buffer.alloc(2 * 1024 * 1024, 7);
  const eager = createServer((socket) => {
    let step = 0;
    socket.on("data", (bytes) => {
      step++;
      if (step === 1) {
        socket.write(Buffer.from([5, 0]));
      } else if (step === 2) {
        socket.write(
          Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]), Buffer.from("hello")]),
        );
      } else if (bytes.toString() === "more") {
        socket.end(tail);
      }
    });
  });
  await new Promise<void>((done) => eager.listen(0, "127.0.0.1", done));
  const proxyPort = (eager.address() as { port: number }).port;
  const { connections, events, next } = recorded({
    proxy: parseProxy(`socks5://127.0.0.1:${proxyPort}`),
  });
  connections.connect(1, "127.0.0.1", 9);
  await next("data");
  assert.deepEqual(
    events.map((e) => e.type),
    ["open", "data"],
  );
  const reads = () => events.flatMap((e) => (e.type === "data" ? [e.bytes] : []));
  assert.equal(new TextDecoder().decode(reads()[0]), "hello");

  // It reads on once open, through its own buffer.
  connections.send(1, new TextEncoder().encode("more"));
  await next("close");
  assert.ok(Buffer.concat(reads()).equals(Buffer.concat([Buffer.from("hello"), tail])));
  assert.ok(reads().length > 2, "the tunnel's own reads");
  for (const bytes of reads()) {
    assert.equal(bytes.buffer.byteLength, bytes.length);
  }

  eager.close();
});
