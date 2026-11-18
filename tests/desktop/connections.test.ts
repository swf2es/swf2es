// The desktop app's socket connections (apps/desktop/src/main/connections.ts)
// in node, without Electron: what they carry, what they refuse, and that a
// peer that stops reading cannot make the main process buffer without end,
// and that each sends at once unless the SWF's tcpNoDelay said otherwise.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import { type TLSSocket, createServer as tlsServer } from "node:tls";
import {
  type ConnectionOptions,
  Connections,
  MAX_BUFFERED,
  secureOptions,
} from "../../apps/desktop/src/main/connections.ts";
import { parseProxy } from "../../apps/desktop/src/main/proxy.ts";
import type { SocketEvent } from "../../apps/desktop/src/shared/api.ts";
import { noDelayOf, socketsOpenedBy } from "../tcp-nodelay.ts";
import { tlsCertificates } from "../tls-certificates.ts";
import { testProxy } from "./proxy-server.ts";

const certificates = tlsCertificates();
after(certificates.dispose);

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

test("sends at once unless the SWF set tcpNoDelay to false, directly and through a proxy", async () => {
  const [server, port] = await listen((socket) => socket.resume());
  const cases = [
    [undefined, true],
    [true, true],
    [false, false],
  ] as const;
  for (const [asked, expected] of cases) {
    const { connections, next } = recorded();
    const opened = socketsOpenedBy(() =>
      connections.connect(1, "127.0.0.1", port, undefined, asked),
    );
    assert.equal(opened.length, 1);
    assert.equal(noDelayOf(opened[0]), expected);
    await next("open");
    assert.equal(noDelayOf(opened[0]), expected);
    connections.close(1);
    await next("close");
  }

  for (const kind of ["socks5", "http"] as const) {
    const proxy = await testProxy(kind);
    for (const [asked, expected] of cases) {
      const { connections, next } = recorded({ proxy: parseProxy(proxy.url()) });
      // The proxy's own connection to the target comes later, and is not the page's.
      const opened = socketsOpenedBy(() =>
        connections.connect(1, "127.0.0.1", port, undefined, asked),
      );
      assert.equal(opened.length, 1);
      // Node's default through the handshake; the SWF's choice once the tunnel is up.
      assert.equal(noDelayOf(opened[0]), false);
      await next("open");
      assert.equal(noDelayOf(opened[0]), expected, `${kind} ${asked}`);
      connections.close(1);
      await next("close");
    }

    await proxy.close();
  }

  server.close();
});

test("secure sockets keep the original hostname through pinned direct and proxy routes", {
  timeout: 15000,
}, async () => {
  const peers = new Set<TLSSocket>();
  const server = tlsServer({ key: certificates.key, cert: certificates.leaf }, (peer) => {
    peers.add(peer);
    peer.on("error", () => {});
    peer.on("close", () => peers.delete(peer));
    peer.on("data", (bytes) => peer.write(bytes));
  });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  // AIR accepts a uint timeout; Node timers cannot take the upper half of that range.
  const options = {
    certificates: [{ encoded: certificates.ca, trusted: true }],
    timeout: 0xffffffff,
  };
  try {
    for (const kind of [null, "socks5", "http"] as const) {
      const proxy = kind ? await testProxy(kind) : null;
      const { connections, events, next } = recorded({
        proxy: proxy ? parseProxy(proxy.url()) : null,
      });
      try {
        connections.connect(1, "localhost", port, "127.0.0.1", true, options);
        await next("open");
        assert.equal(events[0].type, "certificate");
        assert.equal(events[0].type === "certificate" && events[0].status, "trusted");
        connections.send(1, Uint8Array.of(0, 255, 42));
        await next("data");
        const data = events.find((event) => event.type === "data");
        assert.ok(data?.type === "data");
        assert.deepEqual(new Uint8Array(data.bytes), Uint8Array.of(0, 255, 42));
        if (proxy) {
          assert.deepEqual(proxy.targets, [`127.0.0.1:${port}`]);
        }
        connections.send(1, new Uint8Array(MAX_BUFFERED + 1));
        await next("error");
        await next("close");
        assert.equal(connections.size, 0);
      } finally {
        connections.closeAll();
        await proxy?.close();
      }
    }

    const wrong = recorded();
    wrong.connections.connect(1, "wrong.invalid", port, "127.0.0.1", true, options);
    await wrong.next("close");
    assert.equal(
      wrong.events.some((event) => event.type === "open"),
      false,
    );
    assert.equal(
      wrong.events.some(
        (event) => event.type === "certificate" && event.status === "principalMismatch",
      ),
      true,
    );
    wrong.connections.closeAll();
  } finally {
    for (const peer of peers) {
      peer.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("closing a TLS certificate question or ending the page prevents late acceptance", {
  timeout: 10000,
}, async () => {
  const peers = new Set<TLSSocket>();
  const server = tlsServer({ key: certificates.selfKey, cert: certificates.self }, (peer) => {
    peers.add(peer);
    peer.on("error", () => {});
    peer.on("close", () => peers.delete(peer));
  });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    for (const pageEnd of [false, true]) {
      const { connections, events, next } = recorded({ application: () => true });
      connections.connect(1, "localhost", port, "127.0.0.1", true, {
        certificates: [],
        timeout: 500,
      });
      await next("certificateError");
      if (pageEnd) {
        connections.closeAll();
      } else {
        connections.close(1);
        await next("close");
      }
      const before = events.length;
      connections.certificate(1, true);
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.equal(events.length, before);
      assert.equal(connections.size, 0);
    }
  } finally {
    for (const peer of peers) {
      peer.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a self-signed server is refused in the main process unless an AIR application plays", {
  timeout: 10000,
}, async () => {
  const server = tlsServer({ key: certificates.selfKey, cert: certificates.self }, (peer) => {
    peer.on("error", () => {});
  });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    for (const application of [false, true]) {
      // The page asks either way: its word is not taken for whether AIR plays.
      const { connections, events, next } = recorded({ application: () => application });
      connections.connect(1, "localhost", port, "127.0.0.1", true, {
        certificates: [],
        timeout: 2000,
      });
      if (application) {
        await next("certificateError");
        connections.certificate(1, true);
        await next("open");
      } else {
        await next("close");
      }

      assert.deepEqual(
        events.filter((event) => event.type !== "data").map((event) => event.type),
        application
          ? ["certificateError", "certificate", "open"]
          : ["certificate", "error", "close"],
      );
      const certificate = events.find((event) => event.type === "certificate");
      assert.equal(
        certificate?.type === "certificate" && certificate.status,
        application ? "trusted" : "untrustedSigners",
      );
      connections.closeAll();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fails a TLS connection whose peer stops reading, past what it may buffer", {
  timeout: 30_000,
}, async () => {
  const peers = new Set<TLSSocket>();
  const server = tlsServer({ key: certificates.key, cert: certificates.leaf }, (peer) => {
    peers.add(peer);
    peer.on("error", () => {});
    peer.pause();
  });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const { connections, events, next } = recorded();
  try {
    connections.connect(1, "localhost", port, "127.0.0.1", true, {
      certificates: [{ encoded: certificates.ca, trusted: true }],
      timeout: 2000,
    });
    await next("open");
    // Each write under the limit: only what TLS holds unsent can add up past it.
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    for (; sent < 256 && !events.some((e) => e.type === "error"); sent++) {
      connections.send(1, chunk);
      await new Promise((done) => setImmediate(done));
    }

    assert.ok(
      events.some((e) => e.type === "error"),
      "the connection never failed",
    );
    assert.ok(sent * chunk.length > MAX_BUFFERED, `failed after ${sent} MB`);
    await next("close");
    assert.equal(connections.size, 0);
  } finally {
    connections.closeAll();
    for (const peer of peers) {
      peer.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a TLS connection through a proxy has what the tunnel left of its timeout", {
  timeout: 10000,
}, async () => {
  // Answers CONNECT after a while, then says nothing: TLS's handshake never ends.
  const delay = 400;
  const held = new Set<Socket>();
  const [proxy, port] = await listen((socket) => {
    held.add(socket);
    socket.on("error", () => {});
    socket.once("data", () =>
      setTimeout(() => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"), delay),
    );
  });
  const { connections, events, next } = recorded({
    proxy: parseProxy(`http://127.0.0.1:${port}`),
  });
  try {
    const started = performance.now();
    connections.connect(1, "localhost", 443, "127.0.0.1", true, {
      certificates: [],
      timeout: 700,
    });
    await next("error");
    const elapsed = performance.now() - started;
    // The whole timeout from the tunnel on would fail at 1100 ms.
    assert.ok(elapsed >= 650 && elapsed < 1000, `failed after ${elapsed.toFixed(0)} ms`);
    assert.equal(
      events.some((event) => event.type === "open"),
      false,
    );
  } finally {
    connections.closeAll();
    for (const socket of held) {
      socket.destroy();
    }
    proxy.close();
  }
});

test("permission reservations are cancelled by close and page end", () => {
  const { connections } = recorded();
  const closed = connections.reserve(1);
  assert.ok(closed);
  assert.equal(connections.size, 1);
  connections.close(1);
  assert.equal(closed(), false);
  const gone = connections.reserve(1);
  assert.ok(gone);
  connections.closeAll();
  assert.equal(gone(), false);
  const allowed = connections.reserve(1);
  assert.ok(allowed);
  assert.equal(allowed(), true);
  assert.equal(allowed(), false);
  assert.equal(connections.size, 0);
});

test("TLS IPC options reject malformed certificates and bounded-input violations", () => {
  assert.ok(
    secureOptions({ certificates: [{ encoded: certificates.ca, trusted: true }], timeout: 2000 }),
  );
  for (const value of [
    null,
    {},
    { certificates: [], timeout: NaN },
    { certificates: [], timeout: -1 },
    { certificates: [], timeout: 2 ** 32 },
    { certificates: [{ encoded: [48], trusted: true }], timeout: 2000 },
    { certificates: [{ encoded: new Uint8Array(), trusted: true }], timeout: 2000 },
    { certificates: [{ encoded: certificates.ca, trusted: "true" }], timeout: 2000 },
    {
      certificates: new Array(65).fill({ encoded: certificates.ca, trusted: true }),
      timeout: 2000,
    },
  ]) {
    assert.equal(secureOptions(value), null);
  }
});
