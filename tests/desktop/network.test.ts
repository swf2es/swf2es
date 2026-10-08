// The desktop app's network (apps/desktop/src/main/network.ts) in node,
// against servers of the test's own: what a remote SWF and a local one
// with networking may load and read, by Flash's rules and policy files,
// and what no SWF reaches however it asks: a more private address
// without that address's own word, through a redirect or a host whose
// DNS changes its answer, other schemes and ports, Flash's forbidden
// headers, and responses that are too large or never come.
//
// Each site listens on 127.0.0.2, which the test's network takes for the
// internet, and on 127.0.0.1 at the same port, which stays this machine:
// a name the test resolves to either reaches one or the other.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { addressClass } from "../../apps/desktop/src/main/addresses.ts";
import {
  GZIP_HEADER_MAX,
  GzipHeader,
  type Limits,
  Network,
  type NetworkOptions,
  type Purpose,
  Refused,
  refererFor,
} from "../../apps/desktop/src/main/network.ts";

const PUBLIC = "127.0.0.2";
const LOOPBACK = "127.0.0.1";

type Handler = (request: IncomingMessage, response: ServerResponse, inside: boolean) => void;

const servers: (Server | TcpServer)[] = [];
after(() => {
  for (const server of servers) {
    server.close();
    (server as Server).closeAllConnections?.();
  }
});

function listen(server: Server | TcpServer, host: string, port = 0): Promise<number | null> {
  return new Promise((done) => {
    server.once("error", () => done(null));
    server.listen(port, host, () => {
      servers.push(server);
      done((server.address() as { port: number }).port);
    });
  });
}

/** A site on PUBLIC and LOOPBACK at one port, `handle` told which was asked. */
async function site(handle: Handler, make = () => createHttpServer()): Promise<number> {
  for (;;) {
    const outside = make();
    outside.on("request", (q, r) => handle(q, r, false));
    const port = (await listen(outside, PUBLIC)) as number;
    const inside = make();
    inside.on("request", (q, r) => handle(q, r, true));
    if ((await listen(inside, LOOPBACK, port)) !== null) {
      return port;
    }

    outside.close();
  }
}

/** What each site's /crossdomain.xml says, and where the named policy files are; null for a 404. */
const policies = new Map<string, string | null>();
const xml = (body: string) =>
  `<?xml version="1.0"?><cross-domain-policy>${body}</cross-domain-policy>`;

function serve(name: string): Handler {
  return (request, response, inside) => {
    const url = new URL(request.url ?? "/", "http://x");
    const key = `${name}${inside ? "-inside" : ""}${url.pathname}`;
    if (url.pathname === "/drip" || policies.get(key) === "drip") {
      // A byte every 50 ms, without end.
      response.writeHead(200, { "content-type": "text/x-cross-domain-policy" });
      const timer = setInterval(() => response.write("<"), 50);
      response.on("close", () => clearInterval(timer));
      return;
    }

    if (url.pathname.endsWith(".xml")) {
      const body = policies.get(key);
      if (body === undefined || body === null) {
        response.writeHead(404).end();
      } else {
        response.writeHead(200, { "content-type": "text/x-cross-domain-policy" }).end(body);
      }

      return;
    }

    switch (url.pathname) {
      case "/movie.swf":
        response.writeHead(200, { "content-type": "application/x-shockwave-flash" }).end("FWS");
        return;
      case "/echo": {
        const chunks: Buffer[] = [];
        request.on("data", (c: Buffer) => chunks.push(c));
        request.on("end", () =>
          response.writeHead(200, { "set-cookie": "a=b", "x-seen": "yes" }).end(
            JSON.stringify({
              method: request.method,
              headers: request.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          ),
        );
        return;
      }
      case "/big":
        response.writeHead(200).end("x".repeat(5000));
        return;
      case "/chunked-big":
        response.writeHead(200);
        for (let i = 0; i < 10; i++) {
          response.write("x".repeat(500));
        }

        response.end();
        return;
      case "/coded": {
        // Compressed though no one asked, as some servers do.
        const how = url.searchParams.get("how") ?? "gzip";
        const size = Number(url.searchParams.get("size") ?? "11");
        const plain = Buffer.from("x".repeat(size));
        let body =
          how === "br"
            ? brotliCompressSync(plain)
            : how === "deflate"
              ? deflateSync(plain)
              : how === "raw"
                ? deflateRawSync(plain)
                : how === "bad"
                  ? Buffer.from("not gzip at all")
                  : how === "twice"
                    ? gzipSync(gzipSync(plain))
                    : gzipSync(plain);
        if (how === "named") {
          // A gzip header with a file name and a comment, as zlib writes none.
          const plainGzip = gzipSync(plain);
          plainGzip[3] |= 8 | 16;
          body = Buffer.concat([
            plainGzip.subarray(0, 10),
            Buffer.from("name.txt\0a comment\0"),
            plainGzip.subarray(10),
          ]);
        }

        if (url.searchParams.has("trail")) {
          body = Buffer.concat([body, Buffer.from("garbage after the footer")]);
        }

        const encoding =
          how === "raw" ? "deflate" : how === "bad" || how === "named" ? "gzip" : how;
        response.writeHead(200, {
          "content-encoding": how === "twice" ? "gzip, gzip" : encoding,
          "content-length": body.length,
        });
        // A byte at a time, where asked: the first bytes alone tell the format.
        if (url.searchParams.has("split")) {
          let at = 0;
          const next = () => {
            if (at < body.length) {
              response.write(body.subarray(at, at + 1));
              at++;
              setTimeout(next, 1);
            } else {
              response.end();
            }
          };
          next();
        } else {
          response.end(body);
        }

        return;
      }
      case "/hold":
        // 4000 bytes now, the rest a moment later.
        response.writeHead(200);
        response.write("x".repeat(4000));
        setTimeout(() => response.end("x".repeat(1000)), 300);
        return;
      case "/slow":
        // Never answers.
        return;
      case "/redirect": {
        response.writeHead(302, { location: url.searchParams.get("to") ?? "/" }).end();
        return;
      }
      case "/post-redirect":
        response.writeHead(302, { location: "/echo" }).end();
        return;
      case "/slow-redirect": {
        // A redirect every 150 ms, n of them.
        const n = Number(url.searchParams.get("n"));
        setTimeout(() => {
          response
            .writeHead(n > 0 ? 302 : 200, n > 0 ? { location: `/slow-redirect?n=${n - 1}` } : {})
            .end("arrived");
        }, 150);
        return;
      }
      case "/loop":
        response.writeHead(302, { location: "/loop" }).end();
        return;
      case "/missing":
        response.writeHead(404).end("gone");
        return;
      default:
        response.writeHead(200, { "content-type": "text/plain" }).end(`${key}`);
    }
  };
}

let swfPort = 0;
let otherPort = 0;
let insidePort = 0;
/** The names the test resolves, and how often "rebind.test" was asked. */
let rebinds = 0;
const resolve = async (host: string): Promise<string[]> => {
  switch (host) {
    case "swf.test":
    case "other.test":
    case "secure.test":
      return [PUBLIC];
    case "inside.test":
    case "localhost":
      return [LOOPBACK];
    case "hang.test":
      // A resolver that never answers.
      return new Promise<string[]>(() => {});
    case "rebind.test":
      // The first answer public, every later one this machine.
      return [rebinds++ === 0 ? PUBLIC : LOOPBACK];
    default:
      throw new Error("no such host");
  }
};
const classify = (address: string) => (address === PUBLIC ? "public" : addressClass(address));

before(async () => {
  swfPort = await site(serve("swf"));
  otherPort = await site(serve("other"));
  insidePort = await site(serve("inside"));
});

const swf = () => `http://swf.test:${swfPort}`;
const other = () => `http://other.test:${otherPort}`;
const inside = () => `http://inside.test:${insidePort}`;

function network(options: Partial<NetworkOptions> & { limits?: Partial<Limits> } = {}): Network {
  return new Network({ resolve, classify, ...options });
}

const never = new AbortController().signal;

function ask(
  net: Network,
  url: string,
  purpose: Purpose = "data",
  more: { method?: string; headers?: [string, string][]; body?: Uint8Array | null } = {},
  signal = never,
) {
  return net.fetch(
    {
      url,
      method: more.method ?? "GET",
      headers: more.headers ?? [],
      body: more.body ?? null,
      purpose,
    },
    signal,
  );
}

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

/** Its text, or the reason it was refused, "refused: ...". */
async function outcome(promise: Promise<{ bytes: Uint8Array | null; status: number }>) {
  try {
    const { bytes, status } = await promise;
    return text(bytes) ?? `status ${status}`;
  } catch (error) {
    assert.ok(error instanceof Refused, String(error));
    return `refused: ${error.message}`;
  }
}

/** A network playing the remote SWF at `url`, which it has fetched. */
async function playing(url = `${swf()}/movie.swf`, options = {}): Promise<Network> {
  const net = network(options);
  net.play({ kind: "remote", url });
  const movie = await ask(net, url, "movie");
  assert.equal(text(movie.bytes), "FWS");
  return net;
}

test("a remote SWF loads itself, then reads its own origin", async () => {
  const net = network();
  net.play({ kind: "remote", url: `${swf()}/movie.swf` });
  // Nothing before the SWF has come, and no other URL as the movie.
  assert.match(await outcome(ask(net, `${swf()}/data.txt`)), /refused: the SWF has not loaded/);
  assert.match(
    await outcome(ask(net, `${swf()}/other.swf`, "movie")),
    /refused: not the SWF that was opened/,
  );
  assert.equal(text((await ask(net, `${swf()}/movie.swf`, "movie")).bytes), "FWS");
  assert.equal(net.origin, `${swf()}/movie.swf`);

  assert.equal(await outcome(ask(net, `${swf()}/data.txt`)), "swf/data.txt");
  const echo = JSON.parse((await outcome(ask(net, `${swf()}/echo`))) as string);
  assert.equal(echo.headers.referer, `${swf()}/movie.swf`);
  // Elsewhere, its origin alone.
  const away = JSON.parse((await outcome(ask(net, `${other()}/echo`, "content"))) as string);
  assert.equal(away.headers.referer, `${swf()}/`);
  assert.equal(echo.headers["x-flash-version"], "32,0,0,465");
  assert.equal(echo.headers.cookie, undefined);
  // No cookie for a jar there is none of; the other headers as they came.
  const response = await ask(net, `${swf()}/echo`);
  assert.ok(response.headers.some(([n, v]) => n.toLowerCase() === "x-seen" && v === "yes"));
  assert.ok(!response.headers.some(([n]) => n.toLowerCase() === "set-cookie"));
  // A failed load is its status and no bytes.
  assert.deepEqual(
    { ...(await ask(net, `${swf()}/missing`)), headers: [] },
    { bytes: null, status: 404, headers: [] },
  );
});

test("another origin's data as its policy grants; content and sends need none", async () => {
  policies.clear();
  let net = await playing();
  assert.match(
    await outcome(ask(net, `${other()}/data.txt`)),
    /refused: no policy file on http:\/\/other\.test:\d+ grants swf\.test/,
  );
  assert.equal(await outcome(ask(net, `${other()}/image.png`, "content")), "other/image.png");
  // A send goes, and its answer is no one's to read.
  assert.equal(await outcome(ask(net, `${other()}/ping`, "send")), "status 200");

  policies.set("other/crossdomain.xml", xml('<allow-access-from domain="someone.else"/>'));
  net = await playing();
  assert.match(await outcome(ask(net, `${other()}/data.txt`)), /refused: no policy file/);

  policies.set("other/crossdomain.xml", xml('<allow-access-from domain="*.swf.test"/>'));
  net = await playing();
  assert.equal(await outcome(ask(net, `${other()}/data.txt`)), "other/data.txt");

  // A request aborted while its policy came leaves the policy to the next.
  net = await playing();
  const abort = new AbortController();
  const first = outcome(ask(net, `${other()}/data.txt`, "data", {}, abort.signal));
  abort.abort();
  assert.match(await first, /aborted/);
  assert.equal(await outcome(ask(net, `${other()}/data.txt`)), "other/data.txt");

  // Asked for once a movie: changed on the server, the movie keeps what it read.
  policies.set("other/crossdomain.xml", null);
  assert.equal(await outcome(ask(net, `${other()}/data.txt`)), "other/data.txt");
  net = await playing();
  assert.match(await outcome(ask(net, `${other()}/data.txt`)), /refused/);
});

test("a policy loadPolicyFile named counts as the master allows, in its directory", async () => {
  policies.clear();
  policies.set("other/api/policy.xml", xml('<allow-access-from domain="swf.test"/>'));
  let net = await playing();
  net.addPolicyFile(`${other()}/api/policy.xml`);
  // No master: Flash Player 10's default, master-only.
  assert.match(await outcome(ask(net, `${other()}/api/data`)), /refused/);

  policies.set(
    "other/crossdomain.xml",
    xml('<site-control permitted-cross-domain-policies="all"/>'),
  );
  net = await playing();
  net.addPolicyFile(`${other()}/api/policy.xml`);
  assert.equal(await outcome(ask(net, `${other()}/api/data`)), "other/api/data");
  assert.match(await outcome(ask(net, `${other()}/data`)), /refused/);

  policies.set(
    "other/crossdomain.xml",
    xml('<site-control permitted-cross-domain-policies="none"/><allow-access-from domain="*"/>'),
  );
  net = await playing();
  net.addPolicyFile(`${other()}/api/policy.xml`);
  assert.match(await outcome(ask(net, `${other()}/api/data`)), /refused/);
  assert.match(await outcome(ask(net, `${other()}/data`)), /refused/);
});

test("each redirect is judged as a request of its own", async () => {
  policies.clear();
  let net = await playing();
  const toOther = `${swf()}/redirect?to=${encodeURIComponent(`${other()}/data.txt`)}`;
  assert.match(await outcome(ask(net, toOther)), /refused: no policy file on http:\/\/other/);
  // Content may follow it, and is told where it went.
  const content = await ask(net, toOther, "content");
  assert.equal(content.url, `${other()}/data.txt`);

  policies.set("other/crossdomain.xml", xml('<allow-access-from domain="swf.test"/>'));
  net = await playing();
  assert.equal(await outcome(ask(net, toOther)), "other/data.txt");

  // A redirect to another scheme, and one without end.
  assert.match(
    await outcome(ask(net, `${swf()}/redirect?to=${encodeURIComponent("file:///etc/passwd")}`)),
    /refused: a redirect to file:/,
  );
  assert.match(await outcome(ask(net, `${swf()}/loop`)), /refused: too many redirects/);

  // A POST redirected by a 302 goes on as a GET, without its body.
  const echo = JSON.parse(
    (await outcome(
      ask(net, `${swf()}/post-redirect`, "data", {
        method: "POST",
        body: new TextEncoder().encode("a=1"),
        headers: [["Content-Type", "application/x-www-form-urlencoded"]],
      }),
    )) as string,
  );
  assert.equal(echo.method, "GET");
  assert.equal(echo.body, "");
});

test("a SWF from the internet reaches this machine only as its own policy grants", async () => {
  policies.clear();
  // An attacker's own policy grants everything, which says nothing for this machine.
  policies.set("other/crossdomain.xml", xml('<allow-access-from domain="*"/>'));
  let net = await playing();
  for (const purpose of ["data", "content", "send"] as const) {
    assert.match(
      await outcome(ask(net, `${inside()}/secret`, purpose)),
      new RegExp(
        "refused: inside\\.test:\\d+ is at 127\\.0\\.0\\.1, more private than the SWF, " +
          "and no policy file there grants swf\\.test",
      ),
    );
  }

  // Nor by address, a name for it, or a redirect.
  for (const url of [
    `http://127.0.0.1:${insidePort}/secret`,
    `http://localhost:${insidePort}/secret`,
    `http://[::1]:${insidePort}/secret`,
    `${swf()}/redirect?to=${encodeURIComponent(`${inside()}/secret`)}`,
    `${other()}/redirect?to=${encodeURIComponent(`http://127.0.0.1:${insidePort}/secret`)}`,
  ]) {
    assert.match(await outcome(ask(net, url, "content")), /refused: .*more private/, url);
  }

  // Addresses no request reaches at all, and a cloud's metadata service, which is private.
  for (const url of [
    `http://0.0.0.0:${insidePort}/`,
    `http://[::]:${insidePort}/`,
    "http://224.0.0.1/",
  ]) {
    assert.match(await outcome(ask(net, url, "content")), /which no request reaches/, url);
  }

  net = await playing(`${swf()}/movie.swf`, { limits: { policyTimeout: 300 } });
  assert.match(
    await outcome(ask(net, "http://169.254.169.254/latest/meta-data/", "content")),
    /refused: 169\.254\.169\.254 is at 169\.254\.169\.254, more private than the SWF/,
  );

  // Its own policy, served from this machine, grants it.
  policies.set("inside-inside/crossdomain.xml", xml('<allow-access-from domain="swf.test"/>'));
  net = await playing();
  assert.equal(await outcome(ask(net, `${inside()}/secret`)), "inside-inside/secret");
});

test("a host whose DNS turns to this machine is judged by where each request goes", async () => {
  policies.clear();
  rebinds = 0;
  const host = `http://rebind.test:${swfPort}`;
  let net = await playing(`${host}/movie.swf`);
  // Same origin, by name; but now at 127.0.0.1, more private than where the SWF came from.
  assert.match(
    await outcome(ask(net, `${host}/data.txt`)),
    /refused: rebind\.test:\d+ is at 127\.0\.0\.1, more private than the SWF/,
  );

  // Only the policy at that address grants it, not the one where the SWF came from.
  policies.set("swf/crossdomain.xml", xml('<allow-access-from domain="*"/>'));
  rebinds = 0;
  net = await playing(`${host}/movie.swf`);
  assert.match(await outcome(ask(net, `${host}/data.txt`)), /refused/);
  policies.set("swf-inside/crossdomain.xml", xml('<allow-access-from domain="rebind.test"/>'));
  rebinds = 0;
  net = await playing(`${host}/movie.swf`);
  assert.equal(await outcome(ask(net, `${host}/data.txt`)), "swf-inside/data.txt");

  // A SWF opened at this machine reads it, as the user asked.
  policies.clear();
  net = await playing(`${inside()}/movie.swf`);
  assert.equal(await outcome(ask(net, `${inside()}/data.txt`)), "inside-inside/data.txt");
  // But no redirect takes the movie itself somewhere more private.
  net = network();
  const sneaky = `${swf()}/redirect?to=${encodeURIComponent(`${inside()}/movie.swf`)}`;
  net.play({ kind: "remote", url: sneaky });
  assert.match(await outcome(ask(net, sneaky, "movie")), /refused: a redirect to .* more private/);
});

test("a local SWF with networking reads data only where a policy grants every domain", async () => {
  policies.clear();
  const net = network();
  const play = () => net.play({ kind: "local" });
  play();
  assert.match(
    await outcome(ask(net, `${other()}/data.txt`)),
    /refused: no policy file .* a local SWF/,
  );
  assert.equal(await outcome(ask(net, `${other()}/image.png`, "content")), "other/image.png");
  // This machine is more private than a local SWF stands for.
  assert.match(await outcome(ask(net, `${inside()}/image.png`, "content")), /more private/);
  assert.match(
    await outcome(ask(net, `${swf()}/movie.swf`, "movie")),
    /not the SWF that was opened/,
  );

  policies.set("other/crossdomain.xml", xml('<allow-access-from domain="swf.test"/>'));
  play();
  assert.match(await outcome(ask(net, `${other()}/data.txt`)), /refused/);
  policies.set("other/crossdomain.xml", xml('<allow-access-from domain="*"/>'));
  play();
  assert.equal(await outcome(ask(net, `${other()}/data.txt`)), "other/data.txt");
});

test("requests are what Flash let a SWF send, and no more", async () => {
  policies.clear();
  const net = await playing();
  const url = `${swf()}/echo`;
  for (const [what, request, reason] of [
    ["PUT", { method: "PUT" }, /no PUT request/],
    ["Cookie", { method: "POST", headers: [["Cookie", "a=b"]] }, /may not send the header Cookie/],
    ["Host", { method: "POST", headers: [["host", "evil"]] }, /may not send the header host/],
    ["Referer_", { method: "POST", headers: [["Referer", "x"]] }, /may not send/],
    ["CRLF", { method: "POST", headers: [["X-A", "1\r\nX-B: 2"]] }, /no header may hold/],
    ["NUL", { method: "POST", headers: [["X-A", "a\0b"]] }, /no header may hold/],
    ["DEL", { method: "POST", headers: [["X-A", "a\x7fb"]] }, /no header may hold/],
    ["escape", { method: "POST", headers: [["X-A", "a\x1bb"]] }, /no header may hold/],
    ["wide", { method: "POST", headers: [["X-A", "\u2028"]] }, /no header may hold/],
    ["name", { method: "POST", headers: [["X A", "1"]] }, /not a header/],
    ["count", { method: "POST", headers: Array(40).fill(["X-A", "1"]) }, /too many headers/],
  ] as const) {
    assert.match(await outcome(ask(net, url, "data", request as { method: string })), reason, what);
  }

  for (const target of [
    "file:///etc/passwd",
    "swf2es://app/index.html",
    "swf2es://file/x/y",
    "ftp://other.test/x",
    "data:,x",
    "http://user:pass@swf.test/x",
    "not a url",
    `http://swf.test:25/`,
    `http://swf.test:6667/`,
  ]) {
    assert.match(await outcome(ask(net, target)), /refused/, target);
  }

  assert.match(
    await outcome(net.fetch({ url: url, method: "GET", headers: [], body: null }, never)),
    /refused: no purpose/,
  );

  // A POST's own headers reach its own origin.
  const echo = JSON.parse(
    (await outcome(
      ask(net, url, "data", {
        method: "POST",
        headers: [
          ["X-Custom", "yes"],
          ["Content-Type", "text/plain"],
        ],
        body: new TextEncoder().encode("hi"),
      }),
    )) as string,
  );
  assert.deepEqual([echo.method, echo.headers["x-custom"], echo.body], ["POST", "yes", "hi"]);

  // Another's only as its policy lists them.
  policies.set("other/crossdomain.xml", xml('<allow-access-from domain="*"/>'));
  let cross = await playing();
  const post = {
    method: "POST",
    headers: [["X-Custom", "yes"]] as [string, string][],
    body: new TextEncoder().encode("hi"),
  };
  assert.match(
    await outcome(ask(cross, `${other()}/echo`, "data", post)),
    /refused: no policy file on http:\/\/other\.test:\d+ lets it send X-Custom/,
  );
  assert.match(await outcome(ask(cross, `${other()}/echo`, "send", post)), /lets it send/);
  policies.set(
    "other/crossdomain.xml",
    xml(
      '<allow-access-from domain="*"/>' +
        '<allow-http-request-headers-from domain="swf.test" headers="X-*"/>',
    ),
  );
  cross = await playing();
  assert.match(await outcome(ask(cross, `${other()}/echo`, "data", post)), /"x-custom":"yes"/);
});

test("responses are bounded in size and in time, and requests in number", async () => {
  policies.clear();
  let net = await playing(`${swf()}/movie.swf`, {
    limits: { response: 1000, timeout: 300, concurrent: 1, queue: 1 },
  });
  assert.match(await outcome(ask(net, `${swf()}/big`)), /larger than 1000 bytes/);
  assert.match(await outcome(ask(net, `${swf()}/chunked-big`)), /larger than 1000 bytes/);
  assert.match(await outcome(ask(net, `${swf()}/slow`)), /timed out/);

  // A server that trickles forever holds a request no longer than its deadline.
  const dripping = await playing(`${swf()}/movie.swf`, {
    limits: { timeout: 1000, deadline: 400, policyTimeout: 300 },
  });
  let started = performance.now();
  assert.match(await outcome(ask(dripping, `${swf()}/drip`)), /took too long/);
  assert.ok(performance.now() - started < 1000);
  // Nor its policy file, which counts as none.
  policies.set("other/crossdomain.xml", "drip");
  started = performance.now();
  assert.match(await outcome(ask(dripping, `${other()}/data.txt`)), /no policy file/);
  assert.ok(performance.now() - started < 1000);
  policies.clear();

  // The deadline is the whole request's: its redirects, each quick, and the
  // policy file it waits on, which may take longer, all count.
  const quick = await playing(`${swf()}/movie.swf`, {
    limits: { timeout: 1000, deadline: 400, policyTimeout: 5000 },
  });
  assert.equal(await outcome(ask(quick, `${swf()}/slow-redirect?n=1`)), "arrived");
  started = performance.now();
  assert.match(await outcome(ask(quick, `${swf()}/slow-redirect?n=5`)), /took too long/);
  assert.ok(performance.now() - started < 700);
  policies.set("other/crossdomain.xml", "drip");
  started = performance.now();
  assert.match(await outcome(ask(quick, `${other()}/data.txt`)), /took too long/);
  assert.ok(performance.now() - started < 700);
  policies.clear();

  // One at a time, one waiting, and a third refused.
  const first = outcome(ask(net, `${swf()}/slow`));
  const second = outcome(ask(net, `${swf()}/data.txt`));
  assert.match(await outcome(ask(net, `${swf()}/data.txt`)), /too many requests at once/);
  assert.match(await first, /timed out/);
  assert.equal(await second, "swf/data.txt");

  // Aborted by its signal, and by the next movie.
  net = await playing(`${swf()}/movie.swf`);
  const abort = new AbortController();
  const aborted = outcome(ask(net, `${swf()}/slow`, "data", {}, abort.signal));
  abort.abort();
  assert.match(await aborted, /aborted/);
  const left = outcome(ask(net, `${swf()}/slow`));
  net.play({ kind: "local" });
  assert.match(await left, /aborted/);
  net.play(null);
  assert.match(await outcome(ask(net, `${swf()}/data.txt`)), /no SWF plays/);
});

test("a movie's responses hold no more than their budget, given back as each is done", async () => {
  policies.clear();
  // The held one's array doubles from 4000 to 8000 bytes as its rest comes.
  const net = await playing(`${swf()}/movie.swf`, { limits: { buffered: 8500 } });
  const held = ask(net, `${swf()}/hold`);
  // Its first 4000 bytes in, a 5000-byte one does not fit beside them.
  await new Promise((done) => setTimeout(done, 100));
  assert.match(await outcome(ask(net, `${swf()}/big`)), /hold too much at once/);
  assert.equal(text((await held).bytes)?.length, 5000);
  // Counted until its caller has copied it away.
  const seen: number[] = [];
  await net.fetch(
    { url: `${swf()}/big`, method: "GET", headers: [], body: null, purpose: "data" },
    never,
    () => seen.push((net as unknown as { session: { buffered: number } }).session.buffered),
  );
  assert.deepEqual(seen, [5000]);
  assert.equal(text((await ask(net, `${swf()}/big`)).bytes)?.length, 5000);
  // A response is bytes of its own, not a view of a larger buffer.
  const { bytes } = await ask(net, `${swf()}/data.txt`);
  assert.equal(bytes?.byteLength, bytes?.buffer.byteLength);
});

test("a body sent a byte at a time takes memory for its bytes, not its chunks", async (t) => {
  // The server in a process of its own, whose 1M writes would take this one's memory.
  const server = spawn(
    process.execPath,
    [
      "-e",
      `require("node:http").createServer((q, r) => {
        const n = Number(new URL(q.url, "http://x").searchParams.get("n"));
        r.writeHead(200);
        let sent = 0;
        const pump = () => {
          while (sent < n) { sent++; if (!r.write("x")) { r.once("drain", pump); return; } }
          r.end();
        };
        pump();
      }).listen(0, "${PUBLIC}", function () { console.log(this.address().port); });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => server.kill());
  const port = await new Promise<number>((done) =>
    server.stdout.once("data", (line: Buffer) => done(Number(line.toString()))),
  );
  const tiny = `http://swf.test:${port}/tiny`;
  const net = await playing();
  const n = 1024 * 1024;
  // A run first, so that what Node itself takes is taken.
  await ask(net, `${tiny}?n=1000`, "content");
  // What is live, sampled after a collection while the bytes come: kept
  // chunks would be some 500 MB of it, an array of their bytes 1 to 2 MB.
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const live = () => {
    gc();
    const { heapUsed, arrayBuffers } = process.memoryUsage();
    return heapUsed + arrayBuffers;
  };
  const before = live();
  let peak = before;
  const sample = setInterval(() => {
    peak = Math.max(peak, live());
  }, 50);
  const { bytes } = await ask(net, `${tiny}?n=${n}`, "content");
  clearInterval(sample);
  assert.equal(bytes?.length, n);
  const grown = (peak - before) / (1024 * 1024);
  assert.ok(grown < 32, `${grown.toFixed(0)} MB`);
});

test("the Referer: the URL at home, the origin elsewhere, nothing from https to http", () => {
  const swfAt = new URL("https://swf.test/games/movie.swf?token=1");
  assert.equal(refererFor(swfAt, new URL("https://swf.test/data")), swfAt.href);
  assert.equal(refererFor(swfAt, new URL("https://other.test/data")), "https://swf.test/");
  assert.equal(refererFor(swfAt, new URL("http://swf.test/data")), null);
  assert.equal(refererFor(swfAt, new URL("http://other.test/data")), null);
  const plain = new URL("http://swf.test/movie.swf");
  assert.equal(refererFor(plain, new URL("https://other.test/")), "http://swf.test/");
  assert.equal(refererFor(null, new URL("https://other.test/")), null);
  // This machine is potentially trustworthy over http too.
  for (const local of [
    "http://127.0.0.1:8080/x",
    "http://[::1]/x",
    "http://localhost/x",
    "http://a.localhost/x",
  ]) {
    assert.equal(refererFor(swfAt, new URL(local)), "https://swf.test/", local);
  }

  assert.equal(refererFor(swfAt, new URL("http://127.example.test/")), null);
  // Past 4096 characters, the origin alone.
  const long = new URL(`https://swf.test/movie.swf?${"a".repeat(5000)}`);
  assert.equal(refererFor(long, new URL("https://swf.test/data")), "https://swf.test/");
});

test("a body compressed unasked is decompressed, within the limits", async () => {
  policies.clear();
  const net = await playing(`${swf()}/movie.swf`, { limits: { response: 100_000 } });
  for (const how of ["gzip", "deflate", "raw", "br"]) {
    const response = await ask(net, `${swf()}/coded?how=${how}`);
    assert.equal(text(response.bytes), "x".repeat(11), how);
    assert.ok(
      !response.headers.some(([n]) => /^content-(encoding|length)$/i.test(n)),
      `${how} keeps its encoding's headers`,
    );
  }

  // A bomb: 50 MB of x's in a few kilobytes, stopped at the limit.
  for (const how of ["gzip", "br"]) {
    assert.match(
      await outcome(ask(net, `${swf()}/coded?how=${how}&size=50000000`)),
      /larger than 100000 bytes/,
      how,
    );
  }

  assert.match(await outcome(ask(net, `${swf()}/coded?how=bad`)), /does not decompress/);
  // Its first bytes one by one, its header's name and comment, and what a
  // server put after its footer, which Chromium ignores too.
  for (const query of [
    "how=deflate&split",
    "how=raw&split",
    "how=gzip&split",
    "how=br&split",
    "how=named",
    "how=named&split",
    "how=gzip&trail",
    "how=deflate&trail",
  ]) {
    assert.equal(text((await ask(net, `${swf()}/coded?${query}`)).bytes), "x".repeat(11), query);
  }

  // Two codings, which no server needs, refused rather than half undone.
  assert.match(await outcome(ask(net, `${swf()}/coded?how=twice`)), /encoded 2 times/);
  // No Accept-Encoding goes out.
  const echo = JSON.parse((await outcome(ask(net, `${swf()}/echo`))) as string);
  assert.equal(echo.headers["accept-encoding"], undefined);
});

test("HTTPS: verified, and its policies' secure flag kept", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "swf2es-network-"));
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
  const cert = readFileSync(join(dir, "cert.pem"));
  const securePort = await site(serve("secure"), () => createHttpsServer({ key, cert }));
  const secure = `https://secure.test:${securePort}`;
  policies.clear();
  policies.set("secure/crossdomain.xml", xml('<allow-access-from domain="swf.test"/>'));

  // Not trusted without its authority.
  let net = await playing();
  assert.match(await outcome(ask(net, `${secure}/data.txt`, "content")), /refused: .*certificate/);

  // An HTTP SWF may not read it: secure is true by default.
  net = await playing(`${swf()}/movie.swf`, { ca: cert.toString() });
  assert.equal(await outcome(ask(net, `${secure}/image.png`, "content")), "secure/image.png");
  assert.match(await outcome(ask(net, `${secure}/data.txt`)), /refused: no policy file/);
  policies.set(
    "secure/crossdomain.xml",
    xml('<allow-access-from domain="swf.test" secure="false"/>'),
  );
  net = await playing(`${swf()}/movie.swf`, { ca: cert.toString() });
  assert.equal(await outcome(ask(net, `${secure}/data.txt`)), "secure/data.txt");

  // An HTTPS SWF reads its own, and another HTTPS site's under the default.
  net = await playing(`${secure}/movie.swf`, { ca: cert.toString() });
  assert.equal(await outcome(ask(net, `${secure}/data.txt`)), "secure/data.txt");
});

/** A socket server on PUBLIC that answers a policy request with `policy`, if any, then closes. */
async function socketServer(policy: () => string | null): Promise<number> {
  const server = createTcpServer((connection) => {
    connection.on("error", () => {});
    connection.once("data", (bytes) => {
      const answer = policy();
      if (bytes.toString() === "<policy-file-request/>\0" && answer) {
        connection.end(`${answer}\0`);
      } else {
        connection.end();
      }
    });
  });
  return (await listen(server, PUBLIC)) as number;
}

test("a remote SWF's socket needs a policy: port 843's, the port's own, or one named", async () => {
  let masterPolicy: string | null = null;
  let targetPolicy: string | null = null;
  let namedPolicy: string | null = null;
  const masterPort = await socketServer(() => masterPolicy);
  const targetPort = await socketServer(() => targetPolicy);
  const namedPort = await socketServer(() => namedPolicy);
  const net = async () => {
    const n = await playing(`${swf()}/movie.swf`, { socketPolicyPort: masterPort });
    n.addPolicyFile(`xmlsocket://SWF.test:${namedPort}`);
    return n;
  };
  const connect = async (n: Network, port = targetPort) => {
    try {
      return await n.socketAddress("swf.test", port);
    } catch (error) {
      assert.ok(error instanceof Refused);
      return `refused: ${error.message}`;
    }
  };

  // Its own server's too, as Flash Player 9.0.124 and later asked.
  assert.match(
    await connect(await net()),
    /refused: no socket policy on swf\.test grants swf\.test/,
  );

  targetPolicy = xml(`<allow-access-from domain="swf.test" to-ports="${targetPort}"/>`);
  assert.equal(await connect(await net()), PUBLIC);
  // The port's policy grants that port, not another.
  assert.match(await connect(await net(), namedPort), /refused/);

  // One the SWF named grants it too.
  targetPolicy = null;
  namedPolicy = xml('<allow-access-from domain="*" to-ports="*"/>');
  assert.equal(await connect(await net()), PUBLIC);

  // The master's meta-policy shuts out the others; its own rules count.
  masterPolicy = xml('<site-control permitted-cross-domain-policies="master-only"/>');
  assert.match(await connect(await net()), /refused/);
  masterPolicy = xml(
    '<site-control permitted-cross-domain-policies="master-only"/>' +
      `<allow-access-from domain="swf.test" to-ports="${targetPort}"/>`,
  );
  assert.equal(await connect(await net()), PUBLIC);

  // The deadline bounds the whole search: a server that takes the policy
  // request and never answers, and a name whose DNS never answers.
  masterPolicy = null;
  const silent = createTcpServer((connection) => connection.on("error", () => {}));
  const silentPort = (await listen(silent, PUBLIC)) as number;
  const hurried = await playing(`${swf()}/movie.swf`, {
    socketPolicyPort: masterPort,
    limits: { deadline: 300, policyTimeout: 5000 },
  });
  for (const [where, at] of [
    ["swf.test", silentPort],
    ["hang.test", targetPort],
  ] as const) {
    const started = performance.now();
    await assert.rejects(hurried.socketAddress(where, at), /took too long/, where);
    assert.ok(performance.now() - started < 1000, where);
  }

  // Nothing before the SWF has come, and nowhere no request reaches.
  const fresh = network();
  fresh.play({ kind: "remote", url: `${swf()}/movie.swf` });
  await assert.rejects(fresh.socketAddress("swf.test", targetPort), /has not loaded/);
  await assert.rejects((await net()).socketAddress("0.0.0.0", targetPort), /no request reaches/);
});

/** A gzip header with what `flags` asks for: FHCRC 2, FEXTRA 4, FNAME 8, FCOMMENT 16. */
function gzipHead(flags: number, name = "name.txt", extra = 3): Uint8Array {
  const parts = [Buffer.from([0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3])];
  if (flags & 4) {
    parts.push(Buffer.from([extra & 0xff, extra >> 8]), Buffer.alloc(extra, 7));
  }

  if (flags & 8) {
    parts.push(Buffer.from(`${name}\0`));
  }

  if (flags & 16) {
    parts.push(Buffer.from("a comment\0"));
  }

  if (flags & 2) {
    parts.push(Buffer.from([1, 2]));
  }

  return Buffer.concat(parts);
}

/** What GzipHeader says of `bytes` given whole, and given a byte at a time. */
function headerEnds(bytes: Uint8Array): [whole: number, bytewise: number] {
  const whole = new GzipHeader().add(bytes);
  const header = new GzipHeader();
  let bytewise = 0;
  for (let i = 0; i < bytes.length && bytewise === 0; i++) {
    bytewise = header.add(bytes.subarray(i, i + 1));
  }

  return [whole, bytewise];
}

test("a gzip header is read the same whole or a byte at a time, in time linear in it", () => {
  for (const flags of [0, 2, 4, 8, 16, 2 | 4 | 8 | 16]) {
    const head = gzipHead(flags);
    // What follows the header is not part of it.
    const withData = Buffer.concat([head, Buffer.from([1, 2, 3])]);
    assert.deepEqual(headerEnds(withData), [head.length, head.length], String(flags));
  }

  assert.deepEqual(headerEnds(Buffer.from("not gzip at all")), [-1, -1]);
  assert.deepEqual(headerEnds(Buffer.from([0x1f, 0x8b, 9])), [-1, -1]);

  // Its limit, the same however it comes: a header ending at it is read, one past it is not.
  const at = gzipHead(8, "n".repeat(GZIP_HEADER_MAX - 11));
  assert.equal(at.length, GZIP_HEADER_MAX);
  assert.deepEqual(headerEnds(at), [GZIP_HEADER_MAX, GZIP_HEADER_MAX]);
  const past = gzipHead(8, "n".repeat(GZIP_HEADER_MAX - 10));
  assert.deepEqual(headerEnds(past), [-1, -1]);
  // An extra field running past it, its length alone told.
  assert.deepEqual(headerEnds(gzipHead(4, "", GZIP_HEADER_MAX - 10)), [-1, -1]);

  // A name that never ends, a byte at a time: refused once past the limit, and soon.
  const endless = Buffer.concat([
    gzipHead(8, "").subarray(0, 10),
    Buffer.alloc(GZIP_HEADER_MAX * 2, 0x6e),
  ]);
  const started = performance.now();
  assert.deepEqual(headerEnds(endless), [-1, -1]);
  assert.ok(performance.now() - started < 100, `${performance.now() - started} ms`);
});
