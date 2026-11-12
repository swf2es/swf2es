// The desktop app's WebSocket connections
// (apps/desktop/src/main/websocket-connections.ts) in node, without
// Electron, against a server of the test's own: what they carry, what they
// refuse, how they close, and whose certificate goes unverified.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseProxy } from "../../apps/desktop/src/main/proxy.ts";
import {
  dispatchedOpener,
  MAX_BUFFERED,
  proxiedDispatcher,
  unverifiedDispatcher,
  validProtocols,
  validWebSocketUrl,
  WebSocketConnections,
  webSocketOpener,
} from "../../apps/desktop/src/main/websocket-connections.ts";
import type { WebSocketEvent } from "../../apps/desktop/src/shared/api.ts";
import { testProxy } from "./proxy-server.ts";
import { type Peer, webSocketServer } from "./websocket-server.ts";

/** Connections whose events are kept, and a wait for the next of a type. */
function recorded(open?: ConstructorParameters<typeof WebSocketConnections>[1]) {
  const events: WebSocketEvent[] = [];
  let read = 0;
  let wake = () => {};
  const connections = new WebSocketConnections((_id, event) => {
    events.push(event);
    wake();
  }, open);
  /** The next event not yet read, which must be of `type`. */
  const next = async <T extends WebSocketEvent["type"]>(
    type: T,
  ): Promise<Extract<WebSocketEvent, { type: T }>> => {
    while (read >= events.length) {
      await new Promise<void>((done) => {
        wake = done;
      });
    }

    const event = events[read++];
    assert.equal(event.type, type);
    return event as Extract<WebSocketEvent, { type: T }>;
  };
  return { connections, events, next };
}

const settle = () => new Promise((done) => setTimeout(done, 100));

test("carries text and binary messages both ways, and the subprotocol the server chose", async () => {
  let offered: string[] = [];
  const server = await webSocketServer({
    protocol: (protocols) => {
      offered = protocols;
      return protocols[1];
    },
    message: (peer, data) =>
      peer.send(typeof data === "string" ? `echo ${data}` : Uint8Array.from(data).reverse()),
  });
  const { connections, next } = recorded();
  connections.connect(1, `ws://127.0.0.1:${server.port}/path?q=1`, ["one", "two"]);
  assert.deepEqual(await next("open"), { type: "open", protocol: "two" });
  assert.deepEqual(offered, ["one", "two"]);

  connections.send(1, "héllo");
  assert.deepEqual(await next("message"), { type: "message", data: "echo héllo" });
  connections.send(1, new Uint8Array([0, 1, 2, 255]));
  const binary = await next("message");
  assert.ok(binary.data instanceof Uint8Array);
  assert.deepEqual([...binary.data], [255, 2, 1, 0]);

  connections.close(1, 1000);
  assert.deepEqual(await next("close"), { type: "close", code: 1000 });
  assert.equal(connections.size, 0);
  await server.close();
});

test("closes with the code given where the client sends it, and tells the server's", async () => {
  const peers: Peer[] = [];
  const codes: number[] = [];
  const server = await webSocketServer({
    open: (peer) => peers.push(peer),
    close: (_peer, code) => codes.push(code),
    message: (peer, data) => peer.close(Number(data)),
  });
  const url = `ws://127.0.0.1:${server.port}/`;
  const { connections, next } = recorded();

  // 3000 to 4999 and 1000 go as they are; any other, which the client refuses, as a frame with none.
  connections.connect(1, url, []);
  await next("open");
  connections.close(1, 3001);
  assert.equal((await next("close")).code, 3001);
  connections.connect(2, url, []);
  await next("open");
  connections.close(2, 1002);
  assert.equal((await next("close")).code, 1005);
  connections.connect(3, url, []);
  await next("open");
  connections.close(3);
  assert.equal((await next("close")).code, 1005);
  assert.deepEqual(codes, [3001, 1005, 1005]);

  // The server's close frame, its code; a connection dropped with none, 1006.
  connections.connect(4, url, []);
  await next("open");
  connections.send(4, "4000");
  assert.equal((await next("close")).code, 4000);
  connections.connect(5, url, []);
  await next("open");
  peers[4].destroy();
  let event = await next("close").catch(() => null);
  // An error may come first, as for any connection that failed.
  event ??= await next("close");
  assert.equal(event.code, 1006);
  assert.equal(connections.size, 0);
  await server.close();
});

test("refuses what is no ws: or wss: URL, or no list of subprotocols, as an error, then a close", async () => {
  assert.ok(validWebSocketUrl("ws://h/"));
  assert.ok(validWebSocketUrl("wss://h:8443/a?b"));
  assert.ok(!validWebSocketUrl("http://h/"));
  assert.ok(!validWebSocketUrl(`ws://h/${"a".repeat(9000)}`));
  assert.ok(!validWebSocketUrl(42));
  assert.ok(validProtocols([]));
  assert.ok(!validProtocols("chat"));
  assert.ok(!validProtocols([1]));
  assert.ok(!validProtocols(new Array(100).fill("p")));

  const { connections, events } = recorded();
  connections.connect(1, "http://127.0.0.1/", []);
  connections.connect(2, "ws://127.0.0.1/", "chat");
  // What the WebSocket constructor throws for: a subprotocol twice, or one that is no token.
  connections.connect(3, "ws://127.0.0.1/", ["a", "a"]);
  connections.connect(4, "ws://127.0.0.1/", ["not a token"]);
  assert.deepEqual(
    events,
    new Array(4).fill([{ type: "error" }, { type: "close", code: 1006 }]).flat(),
  );
  assert.equal(connections.size, 0);
  // Nothing is sent to, or closed of, a connection there is not.
  connections.send(1, "x");
  connections.close(1);
});

test("a server that is not there, or is no WebSocket server, is an error, then a close", async () => {
  const server = await webSocketServer({});
  const { port } = server;
  const { connections, next } = recorded();
  // A plain request is answered 426.
  connections.connect(1, `ws://127.0.0.1:${port}/`, []);
  await next("open");
  connections.close(1);
  await next("close");
  await server.close();

  connections.connect(2, `ws://127.0.0.1:${port}/`, []);
  await next("error");
  assert.equal((await next("close")).code, 1006);
  assert.equal(connections.size, 0);
});

test("a page's connections close without a word when it goes", async () => {
  const codes: number[] = [];
  let closed = () => {};
  const server = await webSocketServer({
    close: (_peer, code) => {
      codes.push(code);
      closed();
    },
  });
  const { connections, events, next } = recorded();
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  connections.connect(2, `ws://127.0.0.1:${server.port}/`, []);
  const generation = connections.generation;
  connections.closeAll();
  assert.equal(connections.size, 0);
  assert.equal(connections.generation, generation + 1);
  await new Promise<void>((done) => {
    closed = done;
  });
  await settle();
  // The one open sent its close frame; the page that held them hears nothing more.
  assert.deepEqual(codes, [1005]);
  assert.deepEqual(events, [{ type: "open", protocol: "" }]);

  // The next page numbers its own from 1.
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  connections.closeAll();
  await server.close();
});

test("fails a connection whose peer stops reading, past what it may buffer", {
  timeout: 60_000,
}, async () => {
  const server = await webSocketServer({ open: (peer) => peer.pause() });
  const { connections, events, next } = recorded();
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  // Far more than the kernel's buffers take: past them, node would hold the rest.
  const chunk = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 256 && events.length === 1; i++) {
    connections.send(1, chunk);
    await new Promise((done) => setImmediate(done));
  }

  await next("error");
  assert.equal((await next("close")).code, 1006);
  assert.equal(connections.size, 0);
  assert.ok(MAX_BUFFERED < 256 * chunk.length);
  await server.close();
});

test("a wss: server's certificate is verified, but for the hosts --ignore-certificate-errors names", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "swf2es-wss-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0) {
    t.skip(`no openssl to make a certificate: ${made.stderr ?? made.error}`);
    return;
  }

  const server = await webSocketServer(
    { protocol: (offered) => offered[0], message: (peer, data) => peer.send(data) },
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
  );
  const url = `wss://127.0.0.1:${server.port}/`;

  // Signed by itself: refused.
  const verified = recorded();
  verified.connections.connect(1, url, []);
  await verified.next("error");
  assert.equal((await verified.next("close")).code, 1006);

  // This Node must give the dispatcher: Electron's, the same undici, then does too.
  const dispatcher = unverifiedDispatcher();
  assert.ok(dispatcher, "no dispatcher that leaves certificates unverified");

  // Named: its certificate goes unchecked, with its subprotocols offered all the same.
  const asked: string[] = [];
  const named = recorded(
    webSocketOpener((host) => {
      asked.push(host);
      return host === "127.0.0.1";
    }, dispatcher),
  );
  named.connections.connect(1, url, ["chat"]);
  assert.equal((await named.next("open")).protocol, "chat");
  named.connections.send(1, "secret");
  assert.equal((await named.next("message")).data, "secret");
  named.connections.close(1);
  await named.next("close");
  assert.deepEqual(asked, ["127.0.0.1"]);

  // Another host named: this one is verified still.
  const other = recorded(webSocketOpener((host) => host === "other.test", dispatcher));
  other.connections.connect(1, url, []);
  await other.next("error");
  await other.next("close");

  // A ws: server has no certificate to ask about.
  const plain = await webSocketServer({});
  const unasked = recorded(
    webSocketOpener(() => {
      throw new Error("asked of a ws: URL");
    }, dispatcher),
  );
  unasked.connections.connect(1, `ws://127.0.0.1:${plain.port}/`, []);
  await unasked.next("open");
  unasked.connections.closeAll();
  await plain.close();
  await server.close();
});

test("through a proxy, by name, over TLS too, its certificate as the switch says", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "swf2es-wss-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { encoding: "utf8" },
  );
  const echo = {
    protocol: (offered: string[]) => offered[0],
    message: (peer: Peer, data: string | Uint8Array) => peer.send(data),
  };
  const plain = await webSocketServer(echo);
  const secure =
    made.status === 0
      ? await webSocketServer(echo, {
          key: readFileSync(join(dir, "key.pem")),
          cert: readFileSync(join(dir, "cert.pem")),
        })
      : null;
  for (const kind of ["socks5", "http"] as const) {
    const proxy = await testProxy(kind, {
      credentials: { username: "me", password: "pw" },
      // Not port 1, which the WebSocket client refuses itself, as the Fetch standard does.
      refuse: (_host, port) => (port === 4 ? (kind === "socks5" ? 5 : 403) : null),
    });
    const warned: string[] = [];
    const dispatcher = proxiedDispatcher(
      parseProxy(proxy.url("me:pw")),
      (host) => host === "127.0.0.1",
      (message) => warned.push(message),
    );
    assert.ok(dispatcher, "no dispatcher that goes through a proxy");
    const through = recorded(dispatchedOpener(dispatcher));
    through.connections.connect(1, `ws://localhost:${plain.port}/`, ["chat"]);
    assert.equal((await through.next("open")).protocol, "chat");
    through.connections.send(1, "hello");
    assert.equal((await through.next("message")).data, "hello");
    through.connections.close(1, 1000);
    await through.next("close");
    if (secure) {
      // Named by --ignore-certificate-errors: unverified; another name, refused.
      through.connections.connect(2, `wss://127.0.0.1:${secure.port}/`, ["chat"]);
      assert.equal((await through.next("open")).protocol, "chat");
      through.connections.send(2, "secret");
      assert.equal((await through.next("message")).data, "secret");
      through.connections.close(2, 1000);
      await through.next("close");
      through.connections.connect(3, `wss://localhost:${secure.port}/`, []);
      await through.next("error");
      await through.next("close");
    }

    // A name goes to the proxy as it is.
    assert.equal(proxy.targets[0], `localhost:${plain.port}`);
    if (secure) {
      assert.ok(proxy.targets.includes(`127.0.0.1:${secure.port}`), proxy.targets.join());
    }

    // Refused by the proxy: an error and a close with no frame, and why on stderr.
    through.connections.connect(4, "ws://127.0.0.1:4/", []);
    await through.next("error");
    assert.equal((await through.next("close")).code, 1006);
    assert.ok(
      warned.some((w) => /^no WebSocket to 127\.0\.0\.1:4: the proxy \S+ refused/.test(w)),
      warned.join("\n"),
    );
    // The wrong password: the proxy's failure, its password unsaid.
    const wrong = recorded(
      dispatchedOpener(
        proxiedDispatcher(
          parseProxy(proxy.url("me:hunter2")),
          () => false,
          (m) => warned.push(m),
        ),
      ),
    );
    wrong.connections.connect(1, `ws://127.0.0.1:${plain.port}/`, []);
    await wrong.next("error");
    await wrong.next("close");
    assert.ok(
      warned.some((w) => /refused the username and password/.test(w)),
      warned.join("\n"),
    );
    assert.ok(!warned.join("\n").includes("hunter2"));
    await proxy.close();
  }

  await plain.close();
  await secure?.close();
});
