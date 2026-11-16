// The desktop app's keep-alive connections (apps/desktop/src/main/http-pool.ts,
// through network.ts) against servers of the test's own that count the
// connections they take: a connection serves the next request of exactly
// its key and no other, so a name that rebinds, a host whose certificate
// goes unchecked and a tunnel to another target each get one of their own;
// idle ones close, a key keeps to its limit, and an abort, a server that
// closes a kept one and a page that goes leave nothing behind that breaks
// the next request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { ConnectionPool } from "../../apps/desktop/src/main/http-pool.ts";
import { Network } from "../../apps/desktop/src/main/network.ts";
import { type NetworkOptions, Refused } from "../../apps/desktop/src/main/network-types.ts";
import { parseProxy } from "../../apps/desktop/src/main/proxy.ts";
import { testProxy } from "./proxy-server.ts";

const A = "127.0.0.2";
const B = "127.0.0.3";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A server and the connections it has taken: how many, how many open, the most at once. */
interface Counted {
  port: number;
  server: Server;
  opened: number;
  open: Set<Socket>;
  most: number;
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
});

const ok: Handler = (request, response) => {
  response.setHeader("Content-Type", "text/plain");
  response.end(`at ${request.url}`);
};

async function counted(
  host: string,
  handle: Handler = ok,
  make: () => Server = () => createHttpServer(),
  port = 0,
): Promise<Counted> {
  const server = make();
  const count: Counted = { port: 0, server, opened: 0, open: new Set(), most: 0 };
  // An https server's are counted as the TCP connections beneath its TLS.
  server.on("connection", (socket: Socket) => {
    count.opened++;
    count.open.add(socket);
    count.most = Math.max(count.most, count.open.size);
    socket.on("close", () => count.open.delete(socket));
  });
  server.on("request", handle);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => done());
  });
  servers.push(server);
  count.port = (server.address() as { port: number }).port;
  return count;
}

/** One server on A, and one on B at the same port. */
async function pair(handle: Handler = ok): Promise<[Counted, Counted]> {
  for (;;) {
    const a = await counted(A, handle);
    try {
      return [a, await counted(B, handle, () => createHttpServer(), a.port)];
    } catch {
      a.server.close();
    }
  }
}

const names = new Map<string, string[]>();
function network(options: Partial<NetworkOptions> = {}): Network {
  const net = new Network({
    resolve: async (host) => {
      const answers = names.get(host);
      if (!answers?.length) {
        throw new Error("no such host");
      }

      // Each asking takes the next answer, the last kept: DNS that changes its mind.
      return [answers.length > 1 ? (answers.shift() as string) : answers[0]];
    },
    classify: () => "public",
    ...options,
  });
  // An application's requests need no policy: what is tested is how they connect.
  net.play({ kind: "application" });
  return net;
}

function get(net: Network, url: string, signal = new AbortController().signal, method = "GET") {
  return net.fetch(
    {
      url,
      method,
      headers: [],
      body: method === "POST" ? new Uint8Array([1]) : null,
      purpose: "data",
    },
    signal,
  );
}

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Refused, String(error));
    return error.message;
  }

  assert.fail("not refused");
}

test("two requests to one server go over one connection", async () => {
  const [server] = await pair();
  names.set("one.test", [A]);
  const net = network();
  const url = `http://one.test:${server.port}`;

  const first = await get(net, `${url}/a`);
  const second = await get(net, `${url}/b`);
  assert.equal(text(first.bytes), "at /a");
  assert.equal(text(second.bytes), "at /b");
  assert.equal(first.reused, undefined);
  assert.equal(second.reused, true);
  assert.equal(server.opened, 1);
  assert.equal(net.pool.opened, 1);
  assert.equal(net.pool.idle(), 1);
});

test("a redirect and a 304 leave their connection for the next request", async () => {
  const [server] = await pair((request, response) => {
    switch (request.url) {
      case "/moved":
        response.writeHead(302, { Location: "/here", "Content-Type": "text/html" });
        response.end("<a href=/here>here</a>");
        break;
      case "/same":
        response.writeHead(304, { ETag: '"1"' });
        response.end();
        break;
      default:
        ok(request, response);
    }
  });
  names.set("hop.test", [A]);
  const net = network();

  const moved = await get(net, `http://hop.test:${server.port}/moved`);
  assert.equal(text(moved.bytes), "at /here");
  assert.equal(moved.reused, true);
  const same = await get(net, `http://hop.test:${server.port}/same`);
  assert.equal(same.status, 304);
  const after = await get(net, `http://hop.test:${server.port}/after`);
  assert.equal(text(after.bytes), "at /after");
  assert.equal(server.opened, 1);
});

test("a name pinned to another address gets a connection of its own", async () => {
  const [first, second] = await pair();
  // The first answer A, every later one B, as DNS that rebinds the name.
  names.set("rebind.test", [A, B]);
  const net = network();
  const url = `http://rebind.test:${first.port}`;

  await get(net, `${url}/a`);
  const moved = await get(net, `${url}/b`);
  assert.equal(moved.reused, undefined);
  assert.deepEqual([first.opened, second.opened], [1, 1]);
  // B's own connection serves the name while it stays at B.
  assert.equal((await get(net, `${url}/c`)).reused, true);
  assert.deepEqual([first.opened, second.opened], [1, 1]);
});

test("a host whose certificate goes unchecked shares no connection with one checked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "swf2es-pool-"));
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
      "/CN=secure.test",
      "-addext",
      "subjectAltName=DNS:secure.test",
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

  const key = readFileSync(join(dir, "key.pem"));
  const cert = readFileSync(join(dir, "cert.pem")).toString();
  const server = await counted(A, ok, () => createHttpsServer({ key, cert }));
  // One server under three names: its own, checked against its authority; another its
  // certificate does not name, checked; and a third the user let go unchecked.
  for (const name of ["secure.test", "other.test", "lax.test"]) {
    names.set(name, [A]);
  }
  const net = network({ ca: cert, unverified: (host) => host === "lax.test" });
  const at = (name: string, path: string) => `https://${name}:${server.port}${path}`;

  assert.equal(text((await get(net, at("lax.test", "/a"))).bytes), "at /a");
  // Had it the unchecked connection, it would be read; checked, it is refused.
  assert.match(await refusal(get(net, at("other.test", "/b"))), /certificate|altnames/i);
  assert.equal(text((await get(net, at("secure.test", "/c"))).bytes), "at /c");
  assert.equal((await get(net, at("lax.test", "/d"))).reused, true);
  assert.equal((await get(net, at("secure.test", "/e"))).reused, true);
  // lax.test's, other.test's refused one and secure.test's.
  assert.equal(server.opened, 3);

  // The same host with and without the setting: two keys, never one connection.
  const pool = new ConnectionPool({ ca: cert });
  const target = { secure: true, host: "secure.test", address: A, port: server.port };
  assert.notEqual(
    pool.agent({ ...target, unverified: true }),
    pool.agent({ ...target, unverified: false }),
  );
  assert.equal(
    pool.agent({ ...target, unverified: false }),
    pool.agent({ ...target, unverified: false }),
  );
  pool.destroy();
});

test("through a proxy, a tunnel serves its own target again and no other", async () => {
  const [first, second] = await pair();
  names.set("a.test", [A]);
  names.set("b.test", [B]);
  const proxy = await testProxy("http");
  try {
    const net = network({ proxy: parseProxy(proxy.url()) });
    await get(net, `http://a.test:${first.port}/1`);
    assert.equal((await get(net, `http://a.test:${first.port}/2`)).reused, true);
    assert.deepEqual(proxy.targets, [`${A}:${first.port}`]);

    await get(net, `http://b.test:${second.port}/3`);
    assert.deepEqual(proxy.targets, [`${A}:${first.port}`, `${B}:${second.port}`]);
    assert.deepEqual([first.opened, second.opened], [1, 1]);
  } finally {
    await proxy.close();
  }
});

test("an idle connection closes after its time, and the next request opens another", async () => {
  const [server] = await pair();
  names.set("idle.test", [A]);
  const net = network({ pool: { idle: 150 } });
  const url = `http://idle.test:${server.port}`;

  await get(net, `${url}/a`);
  assert.equal(server.open.size, 1);
  await wait(500);
  assert.equal(server.open.size, 0);
  assert.equal(net.pool.idle(), 0);
  assert.equal((await get(net, `${url}/b`)).reused, undefined);
  assert.equal(server.opened, 2);
});

test("a response that pauses longer than the idle time is still read whole", async () => {
  const [server] = await pair((_request, response) => {
    response.writeHead(200, { "Content-Length": "4" });
    response.write("ab");
    setTimeout(() => response.end("cd"), 400);
  });
  names.set("pause.test", [A]);
  const net = network({ pool: { idle: 100 } });
  assert.equal(text((await get(net, `http://pause.test:${server.port}/`)).bytes), "abcd");
});

test("a key keeps to its connections at once, the rest waiting for one", async () => {
  const [server] = await pair((request, response) => {
    setTimeout(() => ok(request, response), 50);
  });
  names.set("busy.test", [A]);
  const net = network({ pool: { perKey: 2 } });
  const url = `http://busy.test:${server.port}`;

  const answers = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((i) => get(net, `${url}/${i}`)));
  assert.deepEqual(
    answers.map((a) => text(a.bytes)),
    [1, 2, 3, 4, 5, 6, 7].map((i) => `at /${i}`),
  );
  assert.equal(server.opened, 2);
  assert.equal(server.most, 2);
  assert.equal(answers.filter((a) => a.reused).length, 5);
});

test("an aborted request's connection is closed, and the next goes as before", async () => {
  const [server] = await pair((request, response) => {
    if (request.url === "/hang") {
      response.writeHead(200, { "Content-Length": "100" });
      response.write("partial");
      return;
    }

    ok(request, response);
  });
  names.set("abort.test", [A]);
  const net = network({ pool: { perKey: 1 } });
  const url = `http://abort.test:${server.port}`;

  await get(net, `${url}/a`);
  const controller = new AbortController();
  const hanging = get(net, `${url}/hang`, controller.signal);
  // One waits behind it for the key's one connection, and is aborted there.
  const queued = new AbortController();
  const waiting = get(net, `${url}/never`, queued.signal);
  await wait(100);
  queued.abort();
  controller.abort();
  assert.equal(await refusal(hanging), "aborted");
  assert.equal(await refusal(waiting), "aborted");

  const next = await get(net, `${url}/b`);
  assert.equal(text(next.bytes), "at /b");
  assert.equal(next.reused, undefined);
  assert.equal(server.opened, 2);
  assert.equal((await get(net, `${url}/c`)).reused, true);
});

test("a kept connection the server closed is not reused; a GET broken on one goes again", async () => {
  // A server that ends each connection quietly after its first answer, as one whose
  // keep-alive ran out the moment it was reused.
  const answered = new WeakSet<Socket>();
  const [server] = await pair((request, response) => {
    const socket = request.socket;
    if (answered.has(socket)) {
      socket.destroy();
      return;
    }

    answered.add(socket);
    ok(request, response);
  });
  names.set("reset.test", [A]);
  const net = network();
  const url = `http://reset.test:${server.port}`;

  await get(net, `${url}/a`);
  const again = await get(net, `${url}/b`);
  assert.equal(text(again.bytes), "at /b");
  assert.equal(server.opened, 2);
  // A POST is not sent twice: its failure is the SWF's.
  assert.match(await refusal(get(net, `${url}/c`, undefined, "POST")), /socket hang up|ECONNRESET/);

  // A server that closes an idle connection itself takes it from the pool.
  const [closing] = await pair((request, response) => {
    response.on("finish", () => setTimeout(() => request.socket.end(), 20));
    ok(request, response);
  });
  names.set("closing.test", [A]);
  await get(net, `http://closing.test:${closing.port}/a`);
  await wait(200);
  assert.equal(closing.open.size, 0);
  assert.equal((await get(net, `http://closing.test:${closing.port}/b`)).reused, undefined);
});

test("a page that goes closes its connections, and so does the app as it quits", async () => {
  const [server] = await pair();
  names.set("page.test", [A]);
  const net = network();
  await get(net, `http://page.test:${server.port}/a`);
  assert.equal(server.open.size, 1);

  net.play({ kind: "application" });
  await wait(100);
  assert.equal(server.open.size, 0);
  assert.equal(net.pool.idle(), 0);

  await get(net, `http://page.test:${server.port}/b`);
  net.close();
  await wait(100);
  assert.equal(server.open.size, 0);
  await assert.rejects(get(net, `http://page.test:${server.port}/c`), /no SWF plays/);
});

test("through a proxy, a key keeps to its connections at once, tunnels being made counted", async () => {
  const [server] = await pair((request, response) => {
    setTimeout(() => ok(request, response), 50);
  });
  names.set("busy-proxied.test", [A]);
  const proxy = await testProxy("http");
  try {
    const net = network({ proxy: parseProxy(proxy.url()), pool: { perKey: 2 } });
    const url = `http://busy-proxied.test:${server.port}`;
    const all = [1, 2, 3, 4, 5, 6, 7];

    const answers = await Promise.all(all.map((i) => get(net, `${url}/${i}`)));
    assert.deepEqual(
      answers.map((a) => text(a.bytes)),
      all.map((i) => `at /${i}`),
    );
    assert.equal(proxy.targets.length, 2);
    assert.equal(server.opened, 2);
    assert.equal(server.most, 2);
    assert.equal(net.pool.idle(), 2);
  } finally {
    await proxy.close();
  }
});

test("through a proxy, a tunnel made as the last one closed is kept and reused", async () => {
  const [server] = await pair((request, response) => {
    if (request.url === "/close") {
      response.setHeader("Connection", "close");
    }

    ok(request, response);
  });
  names.set("close-proxied.test", [A]);
  const proxy = await testProxy("http");
  try {
    const net = network({ proxy: parseProxy(proxy.url()) });
    const url = `http://close-proxied.test:${server.port}`;
    const rounds = 5;
    let reused = 0;
    for (let i = 0; i < rounds; i++) {
      // The server closes the connection this answer came over; the next request makes a
      // tunnel while the agent has nothing else, which must not forget it.
      reused += (await get(net, `${url}/close`)).reused ? 1 : 0;
      await get(net, `${url}/after`);
    }

    assert.equal(reused, rounds - 1);
    assert.equal(proxy.targets.length, rounds + 1);
    assert.equal(net.pool.idle(), 1);

    net.play({ kind: "application" });
    await wait(100);
    assert.equal(server.open.size, 0);
  } finally {
    await proxy.close();
  }
});

test("through a proxy, a page that goes closes its tunnels, those being made too", async () => {
  const [server] = await pair((request, response) => {
    if (request.url !== "/hang") {
      ok(request, response);
    }
  });
  names.set("page-proxied.test", [A]);
  // Called as the proxy is asked for a tunnel: while it is still being made.
  let asked = () => {};
  const proxy = await testProxy("http", {
    refuse: () => {
      asked();
      return null;
    },
  });
  try {
    const net = network({ proxy: parseProxy(proxy.url()) });
    const url = `http://page-proxied.test:${server.port}`;
    await get(net, `${url}/a`);
    // Over the tunnel the first one left, kept.
    const hanging = get(net, `${url}/hang`);
    await wait(50);
    assert.equal(server.open.size, 1);

    net.play({ kind: "application" });
    assert.equal(await refusal(hanging), "aborted");
    await wait(100);
    assert.equal(server.open.size, 0);
    assert.equal(net.pool.idle(), 0);

    // A page that goes while a tunnel is being made leaves nothing open.
    asked = () => {
      asked = () => {};
      net.play({ kind: "application" });
    };
    assert.equal(await refusal(get(net, `${url}/b`)), "aborted");
    await wait(200);
    assert.equal(server.open.size, 0);
    assert.equal(net.pool.idle(), 0);
    assert.equal(proxy.targets.length, 2);
  } finally {
    await proxy.close();
  }
});

test("no more connections are kept idle than the pool's bound, all keys told", async () => {
  const [server] = await pair();
  for (const name of ["i1.test", "i2.test", "i3.test"]) {
    names.set(name, [A]);
  }
  const net = network({ pool: { idleTotal: 2 } });

  for (const name of ["i1.test", "i2.test", "i3.test"]) {
    await get(net, `http://${name}:${server.port}/`);
  }
  await wait(50);
  assert.equal(server.opened, 3);
  assert.equal(net.pool.idle(), 2);
  assert.equal(server.open.size, 2);
});

test("an unread body is drained only within its bounds; an abort while it drains refuses", async () => {
  const [server] = await pair((request, response) => {
    switch (request.url) {
      case "/chunked":
        // No length: drained until past the bound, then closed.
        response.writeHead(404);
        response.write(Buffer.alloc(512, 0x61));
        setTimeout(() => response.end(Buffer.alloc(2048, 0x61)), 50);
        break;
      case "/long":
        // Said to be past the bound: closed at once.
        response.writeHead(404, { "Content-Length": "4096" });
        response.write(Buffer.alloc(512, 0x61));
        setTimeout(() => response.end(Buffer.alloc(3584, 0x61)), 50);
        break;
      case "/slow":
        response.writeHead(404, { "Content-Length": "20" });
        response.write("0123456789");
        break;
      case "/short":
        response.writeHead(404, { "Content-Length": "10" });
        response.end("0123456789");
        break;
      default:
        ok(request, response);
    }
  });
  names.set("drain.test", [A]);
  const net = network({ limits: { drainBytes: 1024, drainTime: 200 } });
  const url = `http://drain.test:${server.port}`;
  const reusedAfter = async (path: string) => {
    assert.equal((await get(net, `${url}${path}`)).status, 404);
    return (await get(net, `${url}/next`)).reused === true;
  };

  assert.equal(await reusedAfter("/short"), true);
  assert.equal(await reusedAfter("/chunked"), false);
  assert.equal(await reusedAfter("/long"), false);
  const started = performance.now();
  assert.equal(await reusedAfter("/slow"), false);
  const took = performance.now() - started;
  assert.ok(took >= 180 && took < 1500, `${took} ms`);

  // The request's abort holds while it drains.
  const patient = network();
  const controller = new AbortController();
  const draining = get(patient, `${url}/slow`, controller.signal);
  setTimeout(() => controller.abort(), 100);
  assert.equal(await refusal(draining), "aborted");
});
