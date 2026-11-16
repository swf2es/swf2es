// The desktop app's WebSocket connections
// (apps/desktop/src/main/websocket-connections.ts) in node, without
// Electron, against a server of the test's own: what they carry, as AIR
// sends and keeps it, what they refuse, how they close, where they connect
// and whose certificate they accept. What adl does for each is in
// docs/architecture/services.md ("AIR's WebSocket").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseProxy } from "../../apps/desktop/src/main/proxy.ts";
import {
  MAX_BUFFERED,
  validOpcode,
  validProtocols,
  validWebSocketUrl,
  WebSocketConnections,
  type WebSocketOptions,
} from "../../apps/desktop/src/main/websocket-connections.ts";
import type { WebSocketEvent } from "../../apps/desktop/src/shared/api.ts";
import { testProxy } from "./proxy-server.ts";
import { type Handlers, type Peer, webSocketServer } from "./websocket-server.ts";

const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;
const PING = 9;
const PONG = 10;

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** Connections whose events are kept, and a wait for the next of a type. */
function recorded(options?: WebSocketOptions) {
  const events: WebSocketEvent[] = [];
  let read = 0;
  let wake = () => {};
  const connections = new WebSocketConnections((_id, event) => {
    events.push(event);
    wake();
  }, options);
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
    assert.equal(event.type, type, JSON.stringify(event));
    return event as Extract<WebSocketEvent, { type: T }>;
  };
  return { connections, events, next };
}

const settle = (ms = 100) => new Promise((done) => setTimeout(done, ms));

/** Wait until `ready` holds, for a server to have seen what was sent. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ready(); i++) {
    await settle(10);
  }

  assert.ok(ready());
}

/** The server's handlers, with the peers it took kept in order. */
function peers(handlers: Handlers = {}): { list: Peer[]; handlers: Handlers } {
  const list: Peer[] = [];
  return {
    list,
    handlers: {
      ...handlers,
      open: (peer) => {
        list.push(peer);
        handlers.open?.(peer);
      },
    },
  };
}

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Certificates openssl makes: one signed by itself for localhost and
 * 127.0.0.1, and a CA's with one it signed for `leafName`; null without
 * openssl.
 */
function certificates(leafName = "localhost") {
  const dir = mkdtempSync(join(tmpdir(), "swf2es-wss-"));
  dirs.push(dir);
  const at = (name: string) => join(dir, name);
  const run = (args: string[]) => spawnSync("openssl", args, { encoding: "utf8" }).status === 0;
  const key = ["-newkey", "rsa:2048", "-nodes"];
  writeFileSync(at("leaf.ext"), `subjectAltName=DNS:${leafName}\n`);
  const made =
    run([
      "req",
      "-x509",
      ...key,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      at("self.key"),
      "-out",
      at("self.pem"),
    ]) &&
    run([
      "req",
      "-x509",
      ...key,
      "-days",
      "1",
      "-subj",
      "/CN=swf2es test CA",
      "-keyout",
      at("ca.key"),
      "-out",
      at("ca.pem"),
    ]) &&
    run([
      "req",
      ...key,
      "-subj",
      `/CN=${leafName}`,
      "-keyout",
      at("leaf.key"),
      "-out",
      at("leaf.csr"),
    ]) &&
    run([
      "x509",
      "-req",
      "-in",
      at("leaf.csr"),
      "-CA",
      at("ca.pem"),
      "-CAkey",
      at("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      at("leaf.ext"),
      "-out",
      at("leaf.pem"),
    ]);
  if (!made) {
    return null;
  }

  return {
    self: { key: readFileSync(at("self.key")), cert: readFileSync(at("self.pem")) },
    leaf: { key: readFileSync(at("leaf.key")), cert: readFileSync(at("leaf.pem")) },
    ca: readFileSync(at("ca.pem"), "utf8"),
  };
}

const echo: Handlers = {
  protocol: (offered) => offered[0],
  message: (peer, data) => peer.send(data),
};

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

  connections.frame(1, TEXT, bytes("héllo"));
  const echoed = await next("message");
  assert.equal(echoed.text, true);
  assert.equal(text(echoed.data), "echo héllo");
  connections.frame(1, BINARY, new Uint8Array([0, 1, 2, 255]));
  const binary = await next("message");
  assert.equal(binary.text, false);
  assert.deepEqual([...binary.data], [255, 2, 1, 0]);

  connections.frame(1, CLOSE, new Uint8Array([0x03, 0xe8]));
  assert.deepEqual(await next("close"), { type: "close", code: 1000 });
  assert.equal(connections.size, 0);
  await server.close();

  // The request as adl's: the subprotocols joined by ", ", no extension, no Origin.
  let request: Peer["request"] | undefined;
  const watched = await webSocketServer({
    open: (peer) => {
      request = peer.request;
    },
  });
  connections.connect(2, `ws://127.0.0.1:${watched.port}/`, ["a", "b"]);
  await next("open");
  assert.equal(request?.headers["sec-websocket-protocol"], "a, b");
  assert.equal(request?.headers["sec-websocket-extensions"], undefined);
  assert.equal(request?.headers.origin, undefined);
  connections.closeAll();
  await watched.close();
});

test("a text message's bytes go and come as they are, a BOM and what is no UTF-8 among them", async () => {
  const { list, handlers } = peers({
    message: (peer, data) => {
      if (data === "send") {
        peer.sendFrame(TEXT, new Uint8Array([0xef, 0xbb, 0xbf, 0x62, 0x6f, 0x6d]));
        peer.sendFrame(TEXT, new Uint8Array([0x66, 0xff, 0x67]));
      }
    },
  });
  const server = await webSocketServer(handlers);
  const { connections, next } = recorded();
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  connections.frame(1, TEXT, new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
  connections.frame(1, TEXT, new Uint8Array([0xff]));
  connections.frame(1, TEXT, bytes("send"));
  // As adl dispatches them: format 1 with every byte, the BOM's three too.
  assert.deepEqual(await next("message"), {
    type: "message",
    data: new Uint8Array([0xef, 0xbb, 0xbf, 0x62, 0x6f, 0x6d]),
    text: true,
  });
  assert.deepEqual(await next("message"), {
    type: "message",
    data: new Uint8Array([0x66, 0xff, 0x67]),
    text: true,
  });
  assert.deepEqual(list[0].frames.slice(0, 2), [
    [TEXT, new Uint8Array([0xef, 0xbb, 0xbf, 0x61])],
    [TEXT, new Uint8Array([0xff])],
  ]);
  connections.closeAll();
  await server.close();
});

test("pings and pongs go as the application sends them; the server's ping is answered, unheard", async () => {
  const { list, handlers } = peers({
    message: (peer, data) => {
      if (data === "ping me") {
        peer.sendFrame(PING, bytes("sping"));
        peer.sendFrame(PONG, bytes("spong"));
        peer.sendFrame(PING, new Uint8Array(0));
        peer.send("after");
      }
    },
  });
  const server = await webSocketServer(handlers);
  const { connections, events, next } = recorded();
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  connections.frame(1, PING, bytes("cping"));
  connections.frame(1, PONG, bytes("cpong"));
  // Past a control frame's 125 bytes: not sent, and the connection goes on.
  connections.frame(1, PING, new Uint8Array(126));
  connections.frame(1, TEXT, bytes("ping me"));
  assert.equal(text((await next("message")).data), "after");
  await until(() => list[0].frames.length >= 5);
  // adl answers each ping with its payload and dispatches nothing for a ping or a pong.
  assert.deepEqual(list[0].frames, [
    [PING, bytes("cping")],
    [PONG, bytes("cpong")],
    [TEXT, bytes("ping me")],
    [PONG, bytes("sping")],
    [PONG, new Uint8Array(0)],
  ]);
  assert.equal(events.length, 2);
  connections.closeAll();
  await server.close();
});

test("closes with any code a frame may carry and the application's reason, and tells the server's", async () => {
  const { list, handlers } = peers({ message: (peer, data) => peer.close(Number(data)) });
  const server = await webSocketServer(handlers);
  const url = `ws://127.0.0.1:${server.port}/`;
  const { connections, next } = recorded();
  const closing = async (id: number, payload: number[]) => {
    connections.connect(id, url, []);
    await next("open");
    connections.frame(id, CLOSE, new Uint8Array(payload));
    return (await next("close")).code;
  };

  // fmtCLOSE's payload as it is: its code and its reason, as adl sends them.
  assert.equal(await closing(1, [0x0f, 0xa1, ...bytes("bye")]), 4001);
  assert.deepEqual(list[0].frames.at(-1), [CLOSE, new Uint8Array([0x0f, 0xa1, ...bytes("bye")])]);
  // 1001 and 1011, which a browser refuses, go too.
  assert.equal(await closing(2, [0x03, 0xe9]), 1001);
  assert.equal(await closing(3, [0x03, 0xf3]), 1011);
  // A code no frame may carry, or none, closes with none; a reason past 123 bytes is left out.
  assert.equal(await closing(4, [0x03, 0xe7]), 1005);
  assert.equal(await closing(5, []), 1005);
  assert.equal(await closing(6, [0x0f, 0xa2, ...new Uint8Array(124).fill(0x61)]), 4002);
  assert.deepEqual(list[5].frames.at(-1), [CLOSE, new Uint8Array([0x0f, 0xa2])]);

  // The server's close frame, its code; a connection dropped with none, 1006.
  connections.connect(7, url, []);
  await next("open");
  connections.frame(7, TEXT, bytes("4000"));
  assert.equal((await next("close")).code, 4000);
  connections.connect(8, url, []);
  await next("open");
  list[7].destroy();
  let event = await next("close").catch(() => null);
  // An error may come first, as for any connection that failed.
  event ??= await next("close");
  assert.equal(event.code, 1006);
  assert.equal(connections.size, 0);
  await server.close();
});

test("refuses what is no ws: or wss: URL, or no list of subprotocols, as an error, then a close", () => {
  assert.ok(validWebSocketUrl("ws://h/"));
  assert.ok(validWebSocketUrl("wss://h:8443/a?b"));
  assert.ok(!validWebSocketUrl("http://h/"));
  assert.ok(!validWebSocketUrl(`ws://h/${"a".repeat(9000)}`));
  assert.ok(!validWebSocketUrl(42));
  assert.ok(validProtocols([]));
  assert.ok(!validProtocols("chat"));
  assert.ok(!validProtocols([1]));
  assert.ok(!validProtocols(new Array(100).fill("p")));
  assert.deepEqual([1, 2, 8, 9, 10].map(validOpcode), [true, true, true, true, true]);
  assert.deepEqual([0, 3, 11, "1", 1.5].map(validOpcode), [false, false, false, false, false]);

  const { connections, events } = recorded();
  connections.connect(1, "http://127.0.0.1/", []);
  connections.connect(2, "ws://127.0.0.1/", "chat");
  // What the client throws for: a fragment, which the natives take off, and a subprotocol
  // that no header may carry.
  connections.connect(3, "ws://127.0.0.1/#f", []);
  connections.connect(4, "ws://127.0.0.1/", ["a\nb"]);
  assert.deepEqual(
    events,
    new Array(4).fill([{ type: "error" }, { type: "close", code: 1006 }]).flat(),
  );
  assert.equal(connections.size, 0);
  // Nothing is sent to a connection there is not.
  connections.frame(1, TEXT, bytes("x"));
  connections.certificate(1, true);
});

test("a server not there fails the connection; one that refuses the handshake, the handshake", async () => {
  const server = await webSocketServer({
    refuse: (request) => (request.url === "/forbidden" ? 403 : undefined),
    protocol: (offered) =>
      offered.length === 0 ? "z" : offered.includes("x") ? undefined : offered[0],
  });
  const { port } = server;
  const { connections, next } = recorded();

  // As adl: refused, the URL and a close.
  connections.connect(1, `ws://127.0.0.1:${port}/forbidden`, []);
  assert.deepEqual(await next("error"), { type: "error", failure: "handshake" });
  assert.equal((await next("close")).code, 1006);
  connections.connect(2, `ws://127.0.0.1:${port}/`, ["one", "two"]);
  assert.equal((await next("open")).protocol, "one");
  connections.closeAll();
  // None of those offered chosen, as adl takes it: open, with no subprotocol.
  connections.connect(3, `ws://127.0.0.1:${port}/`, ["x", "y"]);
  assert.equal((await next("open")).protocol, "");
  connections.closeAll();
  // One chosen when none was offered: adl takes it.
  connections.connect(4, `ws://127.0.0.1:${port}/`, []);
  assert.equal((await next("open")).protocol, "z");
  connections.closeAll();
  // One chosen that was not offered: adl's handshake fails, the URL alone.
  const other = await webSocketServer({ protocol: () => "z" });
  connections.connect(5, `ws://127.0.0.1:${other.port}/`, ["x"]);
  assert.deepEqual(await next("error"), { type: "error", failure: "subprotocol" });
  assert.equal((await next("close")).code, 1006);
  await other.close();
  await server.close();

  // Nothing there: the connection's own failure.
  connections.connect(6, `ws://127.0.0.1:${port}/`, []);
  assert.deepEqual(await next("error"), { type: "error" });
  assert.equal((await next("close")).code, 1006);
  assert.equal(connections.size, 0);
});

test("a page's connections drop without a word when it goes, and a frame while connecting ends one", async () => {
  const { list, handlers } = peers();
  let ended = 0;
  const server = await webSocketServer({
    ...handlers,
    open: (peer) => {
      handlers.open?.(peer);
      // The client ends its side; the server, half open, keeps its own.
      peer.request.socket.on("end", () => ended++);
    },
  });
  const { connections, events, next } = recorded();
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  connections.connect(2, `ws://127.0.0.1:${server.port}/`, []);
  connections.closeAll();
  assert.equal(connections.size, 0);
  await until(() => ended === list.length && ended > 0);
  await settle();
  // Dropped with no close frame, as AIR's at its exit; the page that held them hears nothing more.
  assert.equal(list[0].closeCode, null);
  assert.deepEqual(events, [{ type: "open", protocol: "" }]);

  // The next page numbers its own from 1.
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  connections.closeAll();

  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  connections.frame(1, TEXT, bytes("too soon"));
  await next("error");
  assert.equal((await next("close")).code, 1006);
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
    connections.frame(1, BINARY, chunk);
    await new Promise((done) => setImmediate(done));
  }

  await next("error");
  assert.equal((await next("close")).code, 1006);
  assert.equal(connections.size, 0);
  assert.ok(MAX_BUFFERED < 256 * chunk.length);
  await server.close();
});

test("fails a connection whose peer pings and stops reading the pongs", {
  timeout: 60_000,
}, async () => {
  const ping = Buffer.from([0x89, 125, ...new Uint8Array(125)]);
  const flood = Buffer.concat(new Array(20_000).fill(ping));
  let stop = false;
  const server = await webSocketServer({
    open: async (peer) => {
      peer.pause();
      const socket = peer.request.socket;
      for (let i = 0; i < 100 && !stop && !socket.destroyed; i++) {
        socket.write(flood);
        await new Promise((done) => setImmediate(done));
      }
    },
  });
  const { connections, next } = recorded();
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  await next("error");
  assert.equal((await next("close")).code, 1006);
  stop = true;
  assert.ok(MAX_BUFFERED < 100 * flood.length);
  await server.close();
});

test("connects to the address the name resolves to now, if a connection may reach it", async () => {
  const A = "127.0.0.2";
  const B = "127.0.0.3";
  const first = peers();
  const second = peers();
  const a = await webSocketServer(first.handlers, undefined, { host: A });
  const b = await webSocketServer(second.handlers, undefined, { host: B, port: a.port });
  // The first answer A, every later one B, as DNS that rebinds the name.
  const answers = new Map([
    ["rebind.test", [A, B]],
    ["nowhere.test", ["0.0.0.0"]],
  ]);
  const resolved: string[] = [];
  const classified: string[] = [];
  const warned: string[] = [];
  const { connections, next } = recorded({
    resolve: async (host) => {
      resolved.push(host);
      const list = answers.get(host);
      if (!list) {
        throw new Error("no such host");
      }

      return [list.length > 1 ? (list.shift() as string) : list[0]];
    },
    classify: (address) => {
      classified.push(address);
      return address === "0.0.0.0" ? null : "loopback";
    },
    warn: (message) => warned.push(message),
  });
  const url = `ws://rebind.test:${a.port}/`;
  connections.connect(1, url, []);
  await next("open");
  connections.connect(2, url, []);
  await next("open");
  // Each connection its own lookup and its own address, checked: A's server took one, B's one.
  assert.deepEqual([first.list.length, second.list.length], [1, 1]);
  assert.equal(first.list[0].request.headers.host, `rebind.test:${a.port}`);
  assert.deepEqual(resolved, ["rebind.test", "rebind.test"]);
  assert.deepEqual(classified, [A, B]);
  connections.closeAll();

  // An address no connection reaches, or none: refused, and why said.
  connections.connect(3, `ws://nowhere.test:${a.port}/`, []);
  assert.deepEqual(await next("error"), { type: "error" });
  await next("close");
  connections.connect(4, `ws://missing.test:${a.port}/`, []);
  await next("error");
  await next("close");
  assert.deepEqual(warned, [
    `no WebSocket to nowhere.test:${a.port}: nowhere.test is at 0.0.0.0, which no connection reaches`,
    `no WebSocket to missing.test:${a.port}: missing.test has no address`,
  ]);
  // An address is no name to resolve, but is checked all the same.
  connections.connect(5, `ws://${B}:${a.port}/`, []);
  await next("open");
  assert.deepEqual(resolved.slice(2), ["nowhere.test", "missing.test"]);
  assert.equal(classified.at(-1), B);
  connections.closeAll();
  await a.close();
  await b.close();
});

test("a wss: certificate is checked against the URL's name; a self-signed one is the application's to accept", async (t) => {
  const made = certificates("good.test");
  if (!made) {
    t.skip("no openssl to make certificates");
    return;
  }

  const self = await webSocketServer(echo, made.self);
  const leaf = await webSocketServer(echo, made.leaf);
  const options: WebSocketOptions = {
    resolve: async (host) => (host.endsWith(".test") || host === "localhost" ? ["127.0.0.1"] : []),
    ca: made.ca,
  };

  // Signed by a CA trusted, for the name asked: verified against the name, not the address.
  const { connections, next, events } = recorded(options);
  connections.connect(1, `wss://good.test:${leaf.port}/`, ["chat"]);
  assert.equal((await next("open")).protocol, "chat");
  connections.frame(1, TEXT, bytes("secret"));
  assert.equal(text((await next("message")).data), "secret");
  connections.closeAll();
  // Another name for the same address: refused, and not asked about.
  connections.connect(2, `wss://bad.test:${leaf.port}/`, []);
  assert.deepEqual(await next("error"), { type: "error" });
  await next("close");
  // Signed by a CA not trusted: refused, as adl refuses it, with no certificateError.
  const untrusted = recorded({ ...options, ca: undefined });
  untrusted.connections.connect(1, `wss://good.test:${leaf.port}/`, []);
  await untrusted.next("error");
  await untrusted.next("close");

  // Signed by itself: the application is asked, as adl's certificateError asks it.
  connections.connect(3, `wss://localhost:${self.port}/`, []);
  await next("certificate");
  connections.certificate(3, false);
  assert.deepEqual(await next("error"), { type: "error" });
  await next("close");
  connections.connect(4, `wss://localhost:${self.port}/`, []);
  await next("certificate");
  connections.certificate(4, true);
  await next("open");
  connections.frame(4, TEXT, bytes("accepted"));
  assert.equal(text((await next("message")).data), "accepted");
  connections.closeAll();
  // A page that goes while it is asked takes the question with it.
  connections.connect(5, `wss://localhost:${self.port}/`, []);
  await next("certificate");
  const before = events.length;
  connections.closeAll();
  await settle();
  assert.equal(events.length, before);

  // A host --ignore-certificate-errors names goes unchecked and unasked; another is asked still.
  const asked: string[] = [];
  const named = recorded({
    ...options,
    unverified: (host) => {
      asked.push(host);
      return host === "127.0.0.1";
    },
  });
  named.connections.connect(1, `wss://127.0.0.1:${self.port}/`, ["chat"]);
  assert.equal((await named.next("open")).protocol, "chat");
  named.connections.connect(2, `wss://localhost:${self.port}/`, []);
  await named.next("certificate");
  named.connections.closeAll();
  assert.deepEqual(asked, ["127.0.0.1", "localhost"]);

  // A ws: server has no certificate to ask about.
  const plain = await webSocketServer({});
  const unasked = recorded({
    unverified: () => {
      throw new Error("asked of a ws: URL");
    },
  });
  unasked.connections.connect(1, `ws://127.0.0.1:${plain.port}/`, []);
  await unasked.next("open");
  unasked.connections.closeAll();
  await plain.close();
  await self.close();
  await leaf.close();
});

test("through a proxy, by name, over TLS too, its certificate as the switch says", async () => {
  const made = certificates();
  const plain = await webSocketServer(echo);
  const secure = made ? await webSocketServer(echo, made.self) : null;
  for (const kind of ["socks5", "http"] as const) {
    const proxy = await testProxy(kind, {
      credentials: { username: "me", password: "pw" },
      refuse: (_host, port) => (port === 4 ? (kind === "socks5" ? 5 : 403) : null),
    });
    const warned: string[] = [];
    const through = recorded({
      proxy: parseProxy(proxy.url("me:pw")),
      unverified: (host) => host === "127.0.0.1",
      resolve: () => {
        throw new Error("resolved here, not by the proxy");
      },
      warn: (message) => warned.push(message),
    });
    through.connections.connect(1, `ws://localhost:${plain.port}/`, ["chat"]);
    assert.equal((await through.next("open")).protocol, "chat");
    through.connections.frame(1, TEXT, bytes("hello"));
    assert.equal(text((await through.next("message")).data), "hello");
    through.connections.frame(1, CLOSE, new Uint8Array([0x03, 0xe8]));
    await through.next("close");
    if (secure) {
      // Named by --ignore-certificate-errors: unverified; another name, asked about.
      through.connections.connect(2, `wss://127.0.0.1:${secure.port}/`, ["chat"]);
      assert.equal((await through.next("open")).protocol, "chat");
      through.connections.frame(2, TEXT, bytes("secret"));
      assert.equal(text((await through.next("message")).data), "secret");
      through.connections.closeAll();
      through.connections.connect(3, `wss://localhost:${secure.port}/`, []);
      await through.next("certificate");
      through.connections.certificate(3, false);
      await through.next("error");
      await through.next("close");
    }

    // A name goes to the proxy as it is.
    assert.equal(proxy.targets[0], `localhost:${plain.port}`);
    if (secure) {
      assert.ok(proxy.targets.includes(`127.0.0.1:${secure.port}`), proxy.targets.join());
      assert.ok(proxy.targets.includes(`localhost:${secure.port}`), proxy.targets.join());
    }

    // Refused by the proxy: an error and a close with no frame, and why on stderr.
    through.connections.connect(4, "ws://127.0.0.1:4/", []);
    assert.deepEqual(await through.next("error"), { type: "error" });
    assert.equal((await through.next("close")).code, 1006);
    assert.ok(
      warned.some((w) => /^no WebSocket to 127\.0\.0\.1:4: the proxy \S+ refused/.test(w)),
      warned.join("\n"),
    );
    // The wrong password: the proxy's failure, its password unsaid.
    const wrong = recorded({
      proxy: parseProxy(proxy.url("me:hunter2")),
      warn: (m) => warned.push(m),
    });
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

test("a URL with credentials is refused, nothing sent, as adl connects nowhere with one", async () => {
  let reached = 0;
  const server = await webSocketServer({ open: () => reached++ });
  const warned: string[] = [];
  const { connections, next } = recorded({ warn: (message) => warned.push(message) });
  connections.connect(1, `ws://me:secret@127.0.0.1:${server.port}/`, []);
  assert.deepEqual(await next("error"), { type: "error" });
  assert.equal((await next("close")).code, 1006);
  await settle();
  assert.equal(reached, 0);
  assert.deepEqual(warned, [
    `no WebSocket to 127.0.0.1:${server.port}: its URL carries credentials`,
  ]);
  assert.ok(!warned.join().includes("secret"));
  await server.close();
});

test("a message past the largest one taken fails the connection", async () => {
  const { list, handlers } = peers({
    message: (peer, data) => peer.send(new Uint8Array(Number(data))),
  });
  const server = await webSocketServer(handlers);
  const { connections, next } = recorded({ maxPayload: 1024 });
  connections.connect(1, `ws://127.0.0.1:${server.port}/`, []);
  await next("open");
  connections.frame(1, TEXT, bytes("1024"));
  assert.equal((await next("message")).data.length, 1024);
  connections.frame(1, TEXT, bytes("1025"));
  await next("error");
  // ws sends 1009, Message Too Big, and reads no more, so its own close has no frame.
  assert.equal((await next("close")).code, 1006);
  await until(() => list[0].closeCode !== null);
  assert.equal(list[0].closeCode, 1009);
  await server.close();
});

test("a connection that takes too long to be made, or a certificate unanswered, fails", async (t) => {
  const warned: string[] = [];
  const timeout = 200;

  // A lookup that never answers.
  const lookup = recorded({
    timeout,
    resolve: () => new Promise(() => {}),
    warn: (message) => warned.push(message),
  });
  lookup.connections.connect(1, "ws://slow.test:1234/", []);
  assert.deepEqual(await lookup.next("error"), { type: "error" });
  assert.equal((await lookup.next("close")).code, 1006);
  assert.deepEqual(warned, ["no WebSocket to slow.test:1234: it took too long"]);

  // A server that takes the connection and never begins TLS.
  const sockets: Socket[] = [];
  const silent = createServer((socket) => sockets.push(socket));
  await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
  const port = (silent.address() as { port: number }).port;
  const tls = recorded({ timeout, warn: (message) => warned.push(message) });
  tls.connections.connect(1, `wss://127.0.0.1:${port}/`, []);
  await tls.next("error");
  await tls.next("close");
  assert.equal(warned.at(-1), `no WebSocket to 127.0.0.1:${port}: it took too long`);
  for (const socket of sockets) {
    socket.destroy();
  }

  silent.close();

  // A self-signed certificate the page never answers about: refused, a late answer unheard.
  const made = certificates();
  if (!made) {
    t.diagnostic("no openssl to make a certificate: the unanswered question is not tested");
    return;
  }

  const self = await webSocketServer(echo, made.self);
  const asked = recorded({ timeout, resolve: async () => ["127.0.0.1"] });
  asked.connections.connect(1, `wss://localhost:${self.port}/`, []);
  await asked.next("certificate");
  assert.deepEqual(await asked.next("error"), { type: "error" });
  assert.equal((await asked.next("close")).code, 1006);
  asked.connections.certificate(1, true);
  await settle();
  assert.equal(asked.events.length, 3);
  await self.close();
});

test("a connection closed while its host is resolved says nothing on stderr", async () => {
  const warned: string[] = [];
  let asked = 0;
  const { connections, events, next } = recorded({
    resolve: () => {
      asked++;
      return new Promise(() => {});
    },
    warn: (message) => warned.push(message),
  });

  // The page gone: nothing told, nothing said.
  connections.connect(1, "ws://slow.test:1234/", []);
  await until(() => asked === 1);
  connections.closeAll();
  await settle();
  assert.deepEqual(events, []);

  // Closed by the page as it connects: an error and a close for it, but nothing said.
  connections.connect(1, "ws://slow.test:1234/", []);
  await until(() => asked === 2);
  connections.frame(1, CLOSE, new Uint8Array([0x03, 0xe8]));
  await next("error");
  assert.equal((await next("close")).code, 1006);
  await settle();
  assert.deepEqual(warned, []);
  assert.equal(connections.size, 0);
});

test("an expired self-signed certificate is refused without a question", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "swf2es-wss-"));
  dirs.push(dir);
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-not_before",
      "20200101000000Z",
      "-not_after",
      "20200201000000Z",
      "-keyout",
      join(dir, "old.key"),
      "-out",
      join(dir, "old.pem"),
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0) {
    t.skip("no openssl that makes an expired certificate");
    return;
  }

  const old = await webSocketServer(echo, {
    key: readFileSync(join(dir, "old.key")),
    cert: readFileSync(join(dir, "old.pem")),
  });
  const { connections, next } = recorded({ resolve: async () => ["127.0.0.1"] });
  connections.connect(1, `wss://localhost:${old.port}/`, []);
  // adl asks about it, as self-signed; OpenSSL names its expiry first, and it fails closed.
  assert.deepEqual(await next("error"), { type: "error" });
  await next("close");
  await old.close();
});
