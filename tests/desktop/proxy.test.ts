// The desktop app's proxy (apps/desktop/src/main/proxy.ts) in node, against
// a SOCKS5 proxy and an HTTP CONNECT proxy of the test's own
// (proxy-server.ts), all on this machine: --proxy's URL read, tunnels made
// by address and by name, IPv6 among them, with credentials and without,
// and each way one fails, saying why and never what the credentials are.
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import {
  connectThrough,
  describeProxy,
  type ProxyConfig,
  ProxyError,
  parseProxy,
  proxyArgument,
  sameProxy,
} from "../../apps/desktop/src/main/proxy.ts";
import { type TestProxy, type TestProxyOptions, testProxy } from "./proxy-server.ts";

const SECRET = "s3cr3t:p@ss";
const closing: { close(): unknown }[] = [];
after(async () => {
  for (const c of closing) {
    await c.close();
  }
});

/** A server on `host` that says "hello" first, then answers "ping" with "pong". */
async function echo(host = "127.0.0.1"): Promise<number | null> {
  const server: Server = createServer((socket) => {
    socket.on("error", () => {});
    socket.write("hello");
    socket.on("data", (bytes) => {
      if (bytes.toString() === "ping") {
        socket.write("pong");
      }
    });
  });
  const port = await new Promise<number | null>((done) => {
    server.once("error", () => done(null));
    server.listen(0, host, () => done((server.address() as { port: number }).port));
  });
  if (port !== null) {
    closing.push(server);
  }

  return port;
}

async function proxy(kind: "socks5" | "http", options: TestProxyOptions = {}): Promise<TestProxy> {
  const made = await testProxy(kind, options);
  closing.push(made);
  return made;
}

/** What `socket` says first, then its answer to "ping". */
async function talk(socket: Socket): Promise<string> {
  let heard = "";
  await new Promise<void>((done, fail) => {
    socket.on("data", (bytes) => {
      heard += bytes.toString();
      if (heard === "hello") {
        socket.write("ping");
      } else if (heard === "hellopong") {
        done();
      }
    });
    socket.on("error", fail);
  });
  socket.destroy();
  return heard;
}

async function refusal(promise: Promise<Socket>): Promise<ProxyError> {
  try {
    (await promise).destroy();
  } catch (error) {
    assert.ok(error instanceof ProxyError, String(error));
    assert.ok(!error.message.includes("s3cr3t"), error.message);
    assert.ok(!error.message.includes("p@ss"), error.message);
    return error;
  }

  assert.fail("connected");
}

test("--proxy's URL: SOCKS5, its socks5h alias and HTTP, credentials decoded", () => {
  assert.deepEqual(parseProxy("socks5://127.0.0.1:1080"), {
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: null,
    password: null,
  });
  assert.deepEqual(parseProxy("socks5h://Proxy.Test"), {
    kind: "socks5",
    host: "proxy.test",
    port: 1080,
    username: null,
    password: null,
  });
  assert.deepEqual(parseProxy(`http://me:${encodeURIComponent(SECRET)}@[::1]:3128/`), {
    kind: "http",
    host: "::1",
    port: 3128,
    username: "me",
    password: SECRET,
  });
  assert.equal(parseProxy("http://proxy.test").port, 80);
  assert.deepEqual(
    { ...parseProxy("socks5://only@host:1"), kind: undefined, host: undefined, port: undefined },
    { kind: undefined, host: undefined, port: undefined, username: "only", password: "" },
  );

  for (const [text, message] of [
    ["https://host:443", /no proxy this app speaks/],
    ["socks4://host:1080", /no proxy this app speaks/],
    ["host:1080", /no proxy this app speaks/],
    ["socks5://", /names no host/],
    ["http://host:3128/path", /more than a host and a port/],
    ["http://host:3128?q", /more than a host and a port/],
    ["not a url", /not a URL/],
    ["http://a%3Ab:pw@host:1", /no colon/],
    [`socks5://${"u".repeat(256)}:pw@host:1`, /255 bytes/],
  ] as const) {
    assert.throws(() => parseProxy(text), message, text);
  }

  // Its credentials never in a message, the URL's or a malformed one's.
  for (const text of [
    `socks5://me:${SECRET}@host:1080/path`,
    `http://me:${SECRET}@host:99999`,
    `bogus://me:${SECRET}@`,
    `socks5://me:%zz${SECRET}@host:1`,
  ]) {
    assert.throws(
      () => parseProxy(text),
      (error: Error) => !error.message.includes("s3cr3t") && !error.message.includes("p@ss"),
      text,
    );
  }

  assert.equal(describeProxy(parseProxy(`http://me:pw@[::1]:3128`)), "http://[::1]:3128");
  assert.equal(describeProxy(parseProxy(`socks5h://me:pw@host:1`)), "socks5://host:1");
});

test("--proxy among the app's arguments: its last, never one with its URL apart", () => {
  assert.equal(proxyArgument(["movie.swf", "--trace"]), null);
  assert.deepEqual(proxyArgument(["--proxy=socks5://h:1", "--proxy=http://h:2", "m.swf"]), {
    proxy: parseProxy("http://h:2"),
  });
  // An AIR application's own arguments are not the app's.
  assert.equal(proxyArgument(["app.xml", "--", "--proxy=socks5://h:1"]), null);
  // Not a run without the proxy the user meant.
  assert.match(
    (proxyArgument(["--proxy", "socks5://h:1"]) as { error: string }).error,
    /after an equals sign/,
  );
  assert.match((proxyArgument(["--proxy="]) as { error: string }).error, /not a URL/);
  const bad = proxyArgument([`--proxy=ftp://me:${SECRET}@h:1`]) as { error: string };
  assert.match(bad.error, /^--proxy: /);
  assert.ok(!bad.error.includes("s3cr3t"), bad.error);

  const a = parseProxy("socks5://u:p@h:1");
  assert.ok(sameProxy(a, parseProxy("socks5h://u:p@h:1")));
  assert.ok(!sameProxy(a, parseProxy("socks5://u:q@h:1")));
  assert.ok(!sameProxy(a, null));
  assert.ok(sameProxy(null, null));
});

for (const kind of ["socks5", "http"] as const) {
  test(`${kind}: tunnels by address and by name, carrying what the server says first`, async () => {
    const port = (await echo()) as number;
    const through = await proxy(kind);
    const config = parseProxy(through.url());
    assert.equal(await talk(await connectThrough(config, "127.0.0.1", port)), "hellopong");
    assert.equal(await talk(await connectThrough(config, "localhost", port)), "hellopong");
    // A name goes to the proxy as it is, for it to resolve.
    assert.deepEqual(through.targets, [`127.0.0.1:${port}`, `localhost:${port}`]);
    if (kind === "socks5") {
      assert.deepEqual(through.types, ["ipv4", "domain"]);
    }
  });

  test(`${kind}: an IPv6 target, in its brackets or its 16 bytes`, async (t) => {
    const port = await echo("::1");
    if (port === null) {
      t.skip("no IPv6 loopback here");
      return;
    }

    const through = await proxy(kind);
    const config = parseProxy(through.url());
    assert.equal(await talk(await connectThrough(config, "::1", port)), "hellopong");
    assert.equal(await talk(await connectThrough(config, "[::1]", port)), "hellopong");
    const shown = kind === "socks5" ? "[0:0:0:0:0:0:0:1]" : "[::1]";
    assert.deepEqual(through.targets, [`${shown}:${port}`, `${shown}:${port}`]);
  });

  test(`${kind}: a username and password, right and wrong`, async () => {
    const port = (await echo()) as number;
    const through = await proxy(kind, { credentials: { username: "me", password: SECRET } });
    const right = parseProxy(through.url(`me:${encodeURIComponent(SECRET)}`));
    assert.equal(await talk(await connectThrough(right, "127.0.0.1", port)), "hellopong");

    const wrong = await refusal(
      connectThrough(parseProxy(through.url("me:wrong")), "127.0.0.1", port),
    );
    assert.ok(wrong.fault);
    assert.match(wrong.message, /^the proxy \S+ refused the username and password/);
    const none = await refusal(connectThrough(parseProxy(through.url()), "127.0.0.1", port));
    assert.ok(none.fault);
    assert.match(none.message, /asks for a username and password/);
  });

  test(`${kind}: a target refused, or not reached, is no fault of the proxy's`, async () => {
    const port = (await echo()) as number;
    const through = await proxy(kind, {
      refuse: (_host, at) => (at === port ? (kind === "socks5" ? 2 : 403) : null),
    });
    const config = parseProxy(through.url());
    const refused = await refusal(connectThrough(config, "127.0.0.1", port));
    assert.equal(refused.fault, false);
    assert.match(
      refused.message,
      kind === "socks5"
        ? /^the proxy socks5:\/\/127\.0\.0\.1:\d+ refused: not allowed by its rules \(SOCKS reply 2\)$/
        : /^the proxy http:\/\/127\.0\.0\.1:\d+ refused: HTTP 403 Refused$/,
    );

    // A port nothing listens on: the proxy says so.
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const free = (closed.address() as { port: number }).port;
    await new Promise((done) => closed.close(done));
    const missing = await refusal(connectThrough(config, "127.0.0.1", free));
    assert.equal(missing.fault, false);
    assert.match(missing.message, kind === "socks5" ? /SOCKS reply 5/ : /HTTP 502/);
  });
}

test("a proxy not there, one that speaks no proxy, one silent, and one aborted", async () => {
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const free = (closed.address() as { port: number }).port;
  await new Promise((done) => closed.close(done));
  const at = (kind: string, port: number): ProxyConfig =>
    parseProxy(`${kind}://me:${encodeURIComponent(SECRET)}@127.0.0.1:${port}`);

  const absent = await refusal(connectThrough(at("socks5", free), "127.0.0.1", 80));
  assert.ok(absent.fault);
  assert.match(absent.message, /^the proxy socks5:\/\/127\.0\.0\.1:\d+ is not reached: /);

  // A server that is no proxy: it says hello and closes, or says nothing.
  const talker = createServer((socket) => socket.end("hello, this is not a proxy\r\n\r\n"));
  const silent = createServer((socket) => socket.on("error", () => {}));
  for (const server of [talker, silent]) {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    closing.push(server);
  }

  const talkerPort = (talker.address() as { port: number }).port;
  const silentPort = (silent.address() as { port: number }).port;
  const socks = await refusal(connectThrough(at("socks5", talkerPort), "127.0.0.1", 80));
  assert.ok(socks.fault);
  assert.match(socks.message, /gave no SOCKS5 answer/);
  const http = await refusal(connectThrough(at("http", talkerPort), "127.0.0.1", 80));
  assert.ok(http.fault);
  assert.match(http.message, /gave no HTTP answer/);

  const started = performance.now();
  const slow = await refusal(
    connectThrough(at("http", silentPort), "127.0.0.1", 80, { timeout: 200 }),
  );
  assert.ok(slow.fault);
  assert.match(slow.message, /did not answer in time/);
  assert.ok(performance.now() - started < 2000);

  const stop = new AbortController();
  const aborted = connectThrough(at("socks5", silentPort), "127.0.0.1", 80, {
    signal: stop.signal,
  });
  stop.abort();
  assert.match((await refusal(aborted)).message, /aborted/);
});

test("bytes that come with the proxy's reply are the connection's first", async () => {
  // A SOCKS5 proxy that sends its reply and the server's first bytes in one write.
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
      } else if (bytes.toString() === "ping") {
        socket.write("pong");
      }
    });
  });
  await new Promise<void>((done) => eager.listen(0, "127.0.0.1", done));
  closing.push(eager);
  const config = parseProxy(`socks5://127.0.0.1:${(eager.address() as { port: number }).port}`);
  assert.equal(await talk(await connectThrough(config, "127.0.0.1", 9)), "hellopong");
});

test("a target that is no host name is never asked for", async () => {
  const through = await proxy("http");
  const config = parseProxy(through.url());
  for (const host of ["evil\r\nX-Injected: 1", "a b", "", "a".repeat(300)]) {
    const refused = await refusal(connectThrough(config, host, 80));
    assert.equal(refused.fault, false);
  }

  await refusal(connectThrough(config, "127.0.0.1", 0));
  await refusal(connectThrough(config, "127.0.0.1", 65536));
  assert.deepEqual(through.targets, []);
});
