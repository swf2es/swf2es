// The desktop app's HTTP cache (apps/desktop/src/main/http-cache.ts), alone
// and under its network (network.ts), against a server of the test's own:
// RFC 9111's freshness and revalidation as http-cache-semantics reads them,
// Vary, invalidation, the budget, what a crash or a failing disk leaves,
// and Flash's rules still judging every request the cache could answer:
// a response kept for the address and the movie's origin it came for, so
// that DNS that changes its answer reaches nothing through the cache.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { type CacheRequest, HttpCache } from "../../apps/desktop/src/main/http-cache.ts";
import { Network } from "../../apps/desktop/src/main/network.ts";
import {
  type NetResponse,
  type NetworkOptions,
  Refused,
} from "../../apps/desktop/src/main/network-types.ts";
import { parseProxy } from "../../apps/desktop/src/main/proxy.ts";
import { testProxy } from "./proxy-server.ts";

const PUBLIC = "127.0.0.2";
/** Where rebind.test may also be: an address the test's network takes for a private one. */
const PRIVATE = "127.0.0.3";

interface Resource {
  headers?: Record<string, string>;
  body?: string;
  /** Answered with a 304 where the request's If-None-Match names it. */
  etag?: string;
  /** Answered with a 304 where the request's If-Modified-Since is it. */
  lastModified?: string;
  /** What a 304 adds beside the validators. */
  notModified?: Record<string, string>;
  /** What a POST answers, a 200 by default. */
  post?: { status: number; headers?: Record<string, string> };
}

/** What each /r/<name> answers, and the requests each got. */
const resources = new Map<string, Resource>();
const seen = new Map<string, IncomingHttpHeaders[]>();
let policy: string | null = null;
/** What the policy file comes with, and the requests for it. */
let policyHeaders: Record<string, string> = {};
const policyRequests: IncomingHttpHeaders[] = [];
/** What the private address's own policy says, and the paths it was asked for. */
let insidePolicy: string | null = null;
const insideSeen: string[] = [];
let port = 0;

const xml = (domain: string) =>
  `<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="${domain}"/></cross-domain-policy>`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  if (url.pathname === "/crossdomain.xml") {
    policyRequests.push(request.headers);
    const since = request.headers["if-modified-since"];
    if (policy === null) {
      response.writeHead(404).end();
    } else if (since && since === policyHeaders["last-modified"]) {
      response.writeHead(304, policyHeaders).end();
    } else {
      response
        .writeHead(200, { "content-type": "text/x-cross-domain-policy", ...policyHeaders })
        .end(policy);
    }

    return;
  }

  if (url.pathname === "/movie.swf") {
    response.writeHead(200, { "content-type": "application/x-shockwave-flash" }).end("FWS");
    return;
  }

  const name = url.pathname.slice("/r/".length);
  const resource = resources.get(name);
  if (!url.pathname.startsWith("/r/") || !resource) {
    response.writeHead(404).end();
    return;
  }

  seen.set(name, [...(seen.get(name) ?? []), request.headers]);
  if (request.method === "POST") {
    request.resume();
    response.writeHead(resource.post?.status ?? 200, resource.post?.headers).end("posted");
    return;
  }

  const validators: Record<string, string> = {
    ...(resource.etag ? { etag: resource.etag } : {}),
    ...(resource.lastModified ? { "last-modified": resource.lastModified } : {}),
  };
  const match = request.headers["if-none-match"];
  const since = request.headers["if-modified-since"];
  if (
    (resource.etag && match?.split(",").some((t) => t.trim() === resource.etag)) ||
    (!match && resource.lastModified && since === resource.lastModified)
  ) {
    response.writeHead(304, { ...validators, ...resource.notModified }).end();
    return;
  }

  response
    .writeHead(200, { "content-type": "text/plain", ...validators, ...resource.headers })
    .end(resource.body ?? name);
});

/** The private address's server, at the same port: what rebind.test reaches once it rebinds. */
const inside = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  insideSeen.push(url.pathname);
  if (url.pathname === "/crossdomain.xml" && insidePolicy !== null) {
    // Fresh for long, as a server may say: kept all the same for no other network's machine.
    response
      .writeHead(200, {
        "content-type": "text/x-cross-domain-policy",
        "cache-control": "max-age=600",
      })
      .end(insidePolicy);
  } else if (url.pathname.startsWith("/r/")) {
    response.writeHead(200, { "cache-control": "max-age=600" }).end("inside");
  } else {
    response.writeHead(404).end();
  }
});

before(async () => {
  // A port both addresses have free.
  for (;;) {
    await new Promise<void>((done) => server.listen(0, PUBLIC, done));
    port = (server.address() as { port: number }).port;
    const free = await new Promise<boolean>((done) => {
      inside.once("error", () => done(false));
      inside.listen(port, PRIVATE, () => done(true));
    });
    if (free) {
      return;
    }

    await new Promise((done) => server.close(done));
  }
});

after(() => {
  for (const each of [server, inside]) {
    each.close();
    each.closeAllConnections();
  }
});

const directories: string[] = [];
after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(): string {
  const made = mkdtempSync(join(tmpdir(), "swf2es-http-cache-"));
  directories.push(made);
  return made;
}

/** A clock the test moves: now, `offset` milliseconds on. */
let offset = 0;
const clock = () => Date.now() + offset;

/** What the caches said of their failures. */
const warnings: string[] = [];

function cache(at = directory(), budget?: number, maxEntries?: number): HttpCache {
  return new HttpCache(at, {
    now: clock,
    warn: (message) => warnings.push(message),
    ...(budget === undefined ? {} : { budget }),
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
}

/** A request as network.ts asks the cache, from the address and for the partition it names. */
function ask(url: string, headers: [string, string][] = []): CacheRequest {
  return {
    method: "GET",
    url,
    headers,
    address: PUBLIC,
    partition: "http://swf.test",
    route: "direct",
  };
}

const swf = () => `http://swf.test:${port}`;
const other = () => `http://other.test:${port}`;
const rebind = () => `http://rebind.test:${port}`;
/** Where rebind.test is now. */
let rebindTo = PUBLIC;

/** A network playing a remote SWF from `from` (swf.test's), answered from `store`. */
async function playing(
  store: HttpCache | null,
  limits = {},
  from = swf(),
  more: Partial<NetworkOptions> = {},
): Promise<Network> {
  const net = new Network({
    resolve: async (host) => {
      switch (host) {
        case "swf.test":
        case "other.test":
          return [PUBLIC];
        case "rebind.test":
          return [rebindTo];
        case "secure.test":
          return [PUBLIC];
        default:
          throw new Error("no such host");
      }
    },
    classify: (address) => (address === PRIVATE ? "private" : "public"),
    limits,
    ...more,
  });
  net.cache = store;
  net.play({ kind: "remote", url: `${from}/movie.swf` });
  await get(net, `${from}/movie.swf`, "movie");
  return net;
}

const never = new AbortController().signal;

function get(
  net: Network,
  url: string,
  purpose: "movie" | "content" | "data" = "data",
  headers: [string, string][] = [],
): Promise<NetResponse> {
  return net.fetch({ url, method: "GET", headers, body: null, purpose }, never);
}

/** The body as text, how the cache answered and how many requests the resource has had. */
async function load(
  net: Network,
  store: HttpCache | null,
  name: string,
  headers: [string, string][] = [],
): Promise<[string | null, string, number]> {
  const response = await get(net, `${swf()}/r/${name}`, "data", headers);
  await store?.settled();
  const text = response.bytes ? new TextDecoder().decode(response.bytes) : null;
  return [text, response.cache ?? "network", seen.get(name)?.length ?? 0];
}

const header = (response: { headers: [string, string][] }, name: string) =>
  response.headers.find(([n]) => n.toLowerCase() === name)?.[1];

test("max-age: fresh, served without the network; stale, revalidated by its ETag", async () => {
  offset = 0;
  resources.set("max-age", { headers: { "cache-control": "max-age=60" }, etag: '"v1"' });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "max-age"), ["max-age", "network", 1]);
  assert.deepEqual(await load(net, store, "max-age"), ["max-age", "hit", 1]);

  offset = 61_000;
  assert.deepEqual(await load(net, store, "max-age"), ["max-age", "revalidated", 2]);
  assert.equal(seen.get("max-age")?.[1]["if-none-match"], '"v1"');
  // Fresh again after the 304.
  assert.deepEqual(await load(net, store, "max-age"), ["max-age", "hit", 2]);
  store.close();
});

test("Expires: fresh until then; stale without a validator, fetched again whole", async () => {
  offset = 0;
  resources.set("expires", {
    headers: { expires: new Date(Date.now() + 60_000).toUTCString() },
  });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "expires"), ["expires", "network", 1]);
  assert.deepEqual(await load(net, store, "expires"), ["expires", "hit", 1]);
  offset = 120_000;
  assert.deepEqual(await load(net, store, "expires"), ["expires", "network", 2]);
  assert.equal(seen.get("expires")?.[1]["if-none-match"], undefined);
  assert.equal(seen.get("expires")?.[1]["if-modified-since"], undefined);
  store.close();
});

test("no-cache is revalidated every time; no-store is never kept; private is kept", async () => {
  offset = 0;
  resources.set("no-cache", { headers: { "cache-control": "no-cache" }, etag: '"n"' });
  resources.set("no-store", { headers: { "cache-control": "no-store, max-age=60" } });
  resources.set("private", { headers: { "cache-control": "private, max-age=60" } });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "no-cache"), ["no-cache", "network", 1]);
  assert.deepEqual(await load(net, store, "no-cache"), ["no-cache", "revalidated", 2]);
  assert.deepEqual(await load(net, store, "no-cache"), ["no-cache", "revalidated", 3]);

  assert.deepEqual(await load(net, store, "no-store"), ["no-store", "network", 1]);
  assert.deepEqual(await load(net, store, "no-store"), ["no-store", "network", 2]);

  assert.deepEqual(await load(net, store, "private"), ["private", "network", 1]);
  assert.deepEqual(await load(net, store, "private"), ["private", "hit", 1]);
  // The movie came with nothing that lets it be kept: neither fresh nor revalidated.
  assert.equal(store.usage().entries, 2, "no-cache and private");
  store.close();
});

test("must-revalidate is revalidated, as http-cache-semantics has it, even while fresh", async () => {
  offset = 0;
  resources.set("must", {
    headers: { "cache-control": "max-age=60, must-revalidate" },
    etag: '"m"',
  });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "must"), ["must", "network", 1]);
  assert.deepEqual(await load(net, store, "must"), ["must", "revalidated", 2]);
  store.close();
});

test("without Cache-Control, a tenth of the age Last-Modified gives, then If-Modified-Since", async () => {
  offset = 0;
  const lastModified = new Date(Date.now() - 10 * 86_400_000).toUTCString();
  resources.set("heuristic", { lastModified });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "heuristic"), ["heuristic", "network", 1]);
  offset = 3_600_000;
  assert.deepEqual(await load(net, store, "heuristic"), ["heuristic", "hit", 1]);
  offset = 2 * 86_400_000;
  assert.deepEqual(await load(net, store, "heuristic"), ["heuristic", "revalidated", 2]);
  assert.equal(seen.get("heuristic")?.[1]["if-modified-since"], lastModified);
  store.close();
});

test("Age counts against max-age", async () => {
  offset = 0;
  resources.set("age", { headers: { "cache-control": "max-age=60", age: "50" } });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "age"), ["age", "network", 1]);
  offset = 5_000;
  assert.deepEqual(await load(net, store, "age"), ["age", "hit", 1]);
  offset = 15_000;
  assert.deepEqual(await load(net, store, "age"), ["age", "network", 2]);
  store.close();
});

test("a 304 refreshes the stored headers; a 200 to a revalidation replaces the entry", async () => {
  offset = 0;
  resources.set("versions", {
    headers: { "cache-control": "max-age=10", "x-version": "1" },
    etag: '"a"',
    body: "first",
    notModified: { "cache-control": "max-age=100", "x-version": "2", "content-length": "99" },
  });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "versions"), ["first", "network", 1]);
  offset = 11_000;
  const revalidated = await get(net, `${swf()}/r/versions`);
  assert.equal(revalidated.cache, "revalidated");
  assert.equal(header(revalidated, "x-version"), "2");
  assert.equal(header(revalidated, "content-type"), "text/plain");
  assert.notEqual(header(revalidated, "content-length"), "99");
  // The 304's max-age now holds: still fresh 50 seconds on.
  offset = 61_000;
  const fresh = await get(net, `${swf()}/r/versions`);
  assert.equal(fresh.cache, "hit");
  assert.equal(header(fresh, "x-version"), "2");

  // Changed on the server: the revalidation's 200 is the entry from now on.
  resources.set("versions", {
    headers: { "cache-control": "max-age=10" },
    etag: '"b"',
    body: "second",
  });
  offset = 200_000;
  assert.deepEqual(await load(net, store, "versions"), ["second", "network", 3]);
  assert.equal(seen.get("versions")?.[2]["if-none-match"], '"a"');
  assert.deepEqual(await load(net, store, "versions"), ["second", "hit", 3]);
  assert.equal(store.usage().entries, 1);
  store.close();
});

test("Vary: each value of a header it names an entry of its own; Vary: * none", async () => {
  offset = 0;
  resources.set("vary", { headers: { "cache-control": "max-age=60", vary: "Accept, X-Mode" } });
  resources.set("vary-all", { headers: { "cache-control": "max-age=60", vary: "*" } });
  const store = cache();
  const net = await playing(store);
  const a: [string, string][] = [["Accept", "text/a"]];
  const b: [string, string][] = [["Accept", "text/b"]];
  assert.deepEqual(await load(net, store, "vary", a), ["vary", "network", 1]);
  assert.deepEqual(await load(net, store, "vary", b), ["vary", "network", 2]);
  assert.deepEqual(await load(net, store, "vary", a), ["vary", "hit", 2]);
  assert.deepEqual(await load(net, store, "vary", b), ["vary", "hit", 2]);
  assert.deepEqual(await load(net, store, "vary", [...a, ["X-Mode", "1"]]), ["vary", "network", 3]);

  assert.deepEqual(await load(net, store, "vary-all"), ["vary-all", "network", 1]);
  assert.deepEqual(await load(net, store, "vary-all"), ["vary-all", "network", 2]);
  store.close();

  // Accept-Encoding, which no SWF may send, apart: the cache's own key is the same for any header.
  const alone = cache();
  const url = "http://example.test/vary";
  const response = (bytes: string) => ({
    status: 200,
    headers: [
      ["Cache-Control", "max-age=60"],
      ["Vary", "Accept-Encoding"],
    ] as [string, string][],
    bytes: new TextEncoder().encode(bytes),
  });
  const request = (coding: string) => ask(url, [["Accept-Encoding", coding]]);
  await alone.store(request("gzip"), response("gzipped"));
  await alone.store(request("br"), response("brotli"));
  for (const [coding, text] of [
    ["gzip", "gzipped"],
    ["br", "brotli"],
  ]) {
    const entry = alone.lookup(request(coding));
    assert.ok(entry?.fresh, coding);
    assert.equal(new TextDecoder().decode((await alone.body(entry)) ?? undefined), text);
  }

  assert.equal(alone.lookup(request("deflate")), null);
  assert.equal(alone.usage().entries, 2);
  alone.close();
});

test("what answered an Authorization only where public; Set-Cookie never kept", async () => {
  offset = 0;
  const store = cache();
  const url = "http://example.test/private";
  const authorized = ask(url, [["Authorization", "Basic eDp5"]]);
  const answer = (control: string) => ({
    status: 200,
    headers: [
      ["Cache-Control", control],
      ["Set-Cookie", "a=b"],
    ] as [string, string][],
    bytes: new Uint8Array(3),
  });
  await store.store(authorized, answer("max-age=60"));
  assert.equal(store.usage().entries, 0);
  await store.store(authorized, answer("public, max-age=60"));
  const entry = store.lookup(authorized);
  assert.ok(entry?.fresh);
  assert.deepEqual(entry.headers, [["Cache-Control", "public, max-age=60"]]);

  // A request conditional of its own is the SWF's to make: neither answered nor kept.
  const conditional = ask(url, [["If-None-Match", '"x"']]);
  assert.equal(store.lookup(conditional), null);
  await store.store({ ...conditional, url: `${url}2` }, answer("max-age=60"));
  assert.equal(store.usage().entries, 1);
  store.close();
});

test("past its cap on entries the least recently served go first", async () => {
  offset = 0;
  // Eight entries at most; 80,000 bytes, so 10,000 at most an entry, its body and its row.
  const at = directory();
  const store = cache(at, 80_000, 8);
  const request = (n: number) => ask(`http://example.test/${n}`);
  const response = {
    status: 200,
    headers: [["Cache-Control", "max-age=600"]] as [string, string][],
    bytes: new Uint8Array(240),
  };
  for (let n = 0; n < 8; n++) {
    offset = n;
    await store.store(request(n), response);
  }

  // Too large for the budget: never kept.
  await store.store(request(99), { ...response, bytes: new Uint8Array(10_000) });
  assert.equal(store.lookup(request(99)), null);

  // 0 served again: 1 and 2 are now the least recently served.
  offset = 100;
  const first = store.lookup(request(0));
  assert.ok(first && (await store.body(first)));
  for (const n of [8, 9]) {
    offset = 100 + n;
    await store.store(request(n), response);
  }

  const kept = [...Array(10).keys()].filter((n) => store.lookup(request(n)));
  assert.deepEqual(kept, [0, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([store.usage().entries, store.usage().bytes], [8, 8 * 240]);
  // Their files went with them.
  assert.equal(readdirSync(join(at, "bodies")).length, 8);
  store.close();
});

test("a start sweeps away files with no row, temporary files and rows whose file is gone", async () => {
  offset = 0;
  const at = directory();
  let store = cache(at);
  const request = (n: number) => ask(`http://example.test/${n}`);
  const response = {
    status: 200,
    headers: [["Cache-Control", "max-age=600"]] as [string, string][],
    bytes: new Uint8Array(10),
  };
  for (let n = 0; n < 3; n++) {
    await store.store(request(n), response);
  }

  const one = store.lookup(request(1));
  assert.ok(one);
  store.close();

  const bodies = join(at, "bodies");
  // What a crash leaves: a body half written, never renamed nor given a row; a file whose
  // row was lost with the index's last moments; a row whose file never reached the disk.
  writeFileSync(join(bodies, `${"0".repeat(64)}.1234.tmp`), "half");
  writeFileSync(join(bodies, "f".repeat(64)), "orphan");
  unlinkSync(join(bodies, one.key));
  store = cache(at);
  await store.settled();
  assert.deepEqual(
    readdirSync(bodies).sort(),
    [store.lookup(request(0))?.key, store.lookup(request(2))?.key].sort(),
  );
  assert.equal(store.lookup(request(1)), null);
  assert.equal(store.usage().entries, 2);
  store.close();

  // A body of another size than its row says is no body of that row's.
  const db = new DatabaseSync(join(at, "index.sqlite"));
  db.prepare("UPDATE entries SET size = 11").run();
  db.close();
  store = cache(at);
  await store.settled();
  assert.equal(store.usage().entries, 0);
  assert.deepEqual(readdirSync(bodies), []);
  store.close();
});

test("a body file gone under a row is a miss, and the row dropped", async () => {
  offset = 0;
  resources.set("vanish", { headers: { "cache-control": "max-age=60" } });
  const at = directory();
  const store = cache(at);
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "vanish"), ["vanish", "network", 1]);
  const entry = store.lookup({
    ...ask(`${swf()}/r/vanish`, requestHeaders()),
    partition: swf(),
  });
  assert.ok(entry, "kept under the headers network.ts sends");
  unlinkSync(join(at, "bodies", entry.key));
  assert.deepEqual(await load(net, store, "vanish"), ["vanish", "network", 2]);
  // Kept again from what the network gave.
  assert.deepEqual(await load(net, store, "vanish"), ["vanish", "hit", 2]);
  store.close();
});

/** The headers network.ts sends a remote SWF's data load to its own origin. */
function requestHeaders(): [string, string][] {
  return [
    ["User-Agent", "Mozilla/5.0 (compatible; swf2es) Shockwave Flash"],
    ["Accept", "*/*"],
    ["x-flash-version", "32,0,0,465"],
    ["Referer", `${swf()}/movie.swf`],
  ];
}

test("a crash mid-write leaves no row pointing at a partial file", async () => {
  offset = 0;
  const at = directory();
  let store = cache(at);
  const request = ask("http://example.test/partial");
  const response = {
    status: 200,
    headers: [["Cache-Control", "max-age=600"]] as [string, string][],
    bytes: new Uint8Array(100),
  };
  await store.store(request, response);
  const entry = store.lookup(request);
  assert.ok(entry);
  store.close();

  // A crash after the body went to its temporary file: the row and the file are the last ones.
  const bodies = join(at, "bodies");
  writeFileSync(join(bodies, `${entry.key}.5678.tmp`), new Uint8Array(40));
  store = cache(at);
  await store.settled();
  assert.deepEqual(readdirSync(bodies), [entry.key]);
  const again = store.lookup(request);
  assert.equal((again && (await store.body(again)))?.length, 100);

  // A crash before the first row: no row at all, and the file swept away.
  const fresh = { ...request, url: "http://example.test/never" };
  store.close();
  writeFileSync(join(bodies, "a".repeat(64)), new Uint8Array(40));
  store = cache(at);
  await store.settled();
  assert.equal(store.lookup(fresh), null);
  assert.deepEqual(readdirSync(bodies), [entry.key]);
  store.close();
});

test("a write begun as the cache starts is not swept away as a crash's", async () => {
  offset = 0;
  const at = directory();
  const request = ask("http://example.test/early");
  const response = {
    status: 200,
    headers: [["Cache-Control", "max-age=600"]] as [string, string][],
    bytes: new Uint8Array(100),
  };
  // A busy machine's start: the sweep lists the bodies late, once a write's temporary file
  // is there if the write began without waiting for the listing.
  const { readdir, open } = fsPromises;
  let list = () => {};
  const listed = new Promise<void>((done) => {
    list = done;
  });
  let store: HttpCache | null = null;
  let early = false;
  fsPromises.readdir = (async (...args: Parameters<typeof readdir>) => {
    await listed;
    return readdir(...args);
  }) as typeof readdir;
  fsPromises.open = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".tmp") && !early) {
      early = true;
      list();
      await (store as unknown as { sweeping: Promise<void> }).sweeping;
    }

    return handle;
  }) as typeof open;
  syncBuiltinESMExports();
  try {
    store = cache(at);
    fsPromises.readdir = readdir;
    syncBuiltinESMExports();
    const warned = warnings.length;
    const stored = store.store(request, response);
    // A write that waits for the listing has not opened its file by now.
    await new Promise((go) => setImmediate(go));
    list();
    await stored;
    await store.settled();
    assert.equal(store.usage().entries, 1);
    const entry = store.lookup(request);
    assert.equal((entry && (await store.body(entry)))?.length, 100);
    assert.deepEqual(readdirSync(join(at, "bodies")), [entry?.key]);
    assert.equal(warnings.length, warned);
  } finally {
    fsPromises.readdir = readdir;
    fsPromises.open = open;
    syncBuiltinESMExports();
    store?.close();
  }
});

test("Flash's policy still judges a request the cache could answer", async () => {
  offset = 0;
  policy = null;
  resources.set("elsewhere", { headers: { "cache-control": "max-age=600" } });
  const store = cache();
  const net = await playing(store);
  // As content, which needs no policy, it is fetched and kept.
  const content = await get(net, `${other()}/r/elsewhere`, "content");
  await store.settled();
  assert.equal(content.cache, undefined);
  assert.equal(seen.get("elsewhere")?.length, 1);
  // As data, another origin's needs its policy, which there is none of: refused, kept or not.
  await assert.rejects(get(net, `${other()}/r/elsewhere`, "data"), (error) => {
    assert.ok(error instanceof Refused);
    assert.match(error.message, /no policy file on http:\/\/other\.test:\d+ grants swf\.test/);
    return true;
  });
  // Granted, the stored response serves it.
  policy = xml("swf.test");
  const granted = await playing(store);
  const data = await get(granted, `${other()}/r/elsewhere`, "data");
  assert.equal(data.cache, "hit");
  assert.equal(seen.get("elsewhere")?.length, 1);
  policy = null;
  store.close();
});

test("a response kept under --ignore-policy-files serves no network without it", async () => {
  offset = 0;
  policy = null;
  resources.set("unguarded", { headers: { "cache-control": "max-age=600" } });
  const store = cache();
  const ignoring = { ignorePolicy: { all: true, hosts: [] } };
  const policiesBefore = policyRequests.length;
  const net = await playing(store, {}, swf(), ignoring);
  const first = await get(net, `${other()}/r/unguarded`, "data");
  await store.settled();
  assert.deepEqual([first.cache, first.policyIgnored], [undefined, true]);
  assert.equal(seen.get("unguarded")?.length, 1);
  // No policy file was asked for, so none is kept either.
  assert.equal(policyRequests.length, policiesBefore);

  // Without the switch, sharing the cache: refused before the cache is asked.
  const plain = await playing(store);
  await assert.rejects(get(plain, `${other()}/r/unguarded`, "data"), (error) => {
    assert.ok(error instanceof Refused);
    assert.match(error.message, /no policy file on http:\/\/other\.test:\d+ grants swf\.test/);
    return true;
  });
  // With it again, kept as any response is.
  const again = await playing(store, {}, swf(), ignoring);
  const hit = await get(again, `${other()}/r/unguarded`, "data");
  assert.deepEqual([hit.cache, hit.policyIgnored], ["hit", true]);
  assert.equal(seen.get("unguarded")?.length, 1);
  store.close();
});

test("a stored body counts as a fetched one, against the largest response and the budget", async () => {
  offset = 0;
  resources.set("large", { headers: { "cache-control": "max-age=600" }, body: "x".repeat(3000) });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual((await load(net, store, "large")).slice(1), ["network", 1]);
  const small = await playing(store, { response: 2000 });
  await assert.rejects(get(small, `${swf()}/r/large`), /its response is larger than 2000 bytes/);
  const tight = await playing(store, { buffered: 2000 });
  await assert.rejects(get(tight, `${swf()}/r/large`), /hold too much at once/);
  assert.equal(seen.get("large")?.length, 1);
  store.close();
});

test("with no cache, as --no-http-cache or the File menu leaves it, nothing is read or kept", async () => {
  offset = 0;
  resources.set("off", { headers: { "cache-control": "max-age=600" } });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "off"), ["off", "network", 1]);
  const kept = store.usage();
  net.cache = null;
  assert.deepEqual(await load(net, null, "off"), ["off", "network", 2]);
  resources.set("off-2", { headers: { "cache-control": "max-age=600" } });
  assert.deepEqual(await load(net, null, "off-2"), ["off-2", "network", 1]);
  await store.settled();
  assert.deepEqual(store.usage(), kept);
  store.close();
});

test("a clear forgets every response, and drops one being written", async () => {
  offset = 0;
  const at = directory();
  const store = cache(at);
  const request = (n: number) => ask(`http://example.test/${n}`);
  const response = {
    status: 200,
    headers: [["Cache-Control", "max-age=600"]] as [string, string][],
    bytes: new Uint8Array(10),
  };
  await store.store(request(0), response);
  const writing = store.store(request(1), response);
  await store.clear();
  await writing;
  assert.equal(store.usage().entries, 0);
  assert.deepEqual(readdirSync(join(at, "bodies")), []);
  assert.ok(existsSync(join(at, "index.sqlite")));
  await store.store(request(2), response);
  assert.equal(store.usage().entries, 1);
  store.close();
});

test("an index that cannot be read starts again empty", async () => {
  const at = directory();
  writeFileSync(
    join(at, "index.sqlite"),
    "not a database, though long enough to be read as one".repeat(100),
  );
  const store = cache(at);
  await store.settled();
  assert.deepEqual(store.usage(), { entries: 0, bytes: 0, charges: 0 });
  await store.store(ask("http://example.test/"), {
    status: 200,
    headers: [["Cache-Control", "max-age=60"]],
    bytes: new Uint8Array(1),
  });
  assert.equal(store.usage().entries, 1);
  store.close();
});

test("DNS that rebinds reaches nothing through the cache: each address is asked itself", async () => {
  offset = 0;
  policy = xml("swf.test");
  policyHeaders = { "cache-control": "max-age=600" };
  insidePolicy = null;
  insideSeen.length = 0;
  resources.set("rebound", { headers: { "cache-control": "max-age=600" }, body: "outside" });
  const store = cache();
  try {
    // While rebind.test is public, its policy grants the SWF, and both it and the data are kept.
    rebindTo = PUBLIC;
    const first = await playing(store);
    const outside = await get(first, `${rebind()}/r/rebound`);
    await store.settled();
    assert.equal(new TextDecoder().decode(outside.bytes ?? undefined), "outside");
    assert.equal(store.usage().entries, 2, "the policy file and the data");

    // Rebound to a private address, the next movie needs that address's own word: the public
    // address's policy file, however fresh, is not it, nor its data the private one's.
    rebindTo = PRIVATE;
    const second = await playing(store);
    await assert.rejects(get(second, `${rebind()}/r/rebound`), (error) => {
      assert.ok(error instanceof Refused);
      assert.match(error.message, /more private than the SWF, and no policy file there grants/);
      return true;
    });
    assert.deepEqual(insideSeen, ["/crossdomain.xml"]);

    // Granted there, the private address answers for itself, not the public one's response.
    insidePolicy = xml("swf.test");
    const third = await playing(store);
    const granted = await get(third, `${rebind()}/r/rebound`);
    await store.settled();
    assert.equal(new TextDecoder().decode(granted.bytes ?? undefined), "inside");
    assert.equal(granted.cache, undefined);
    assert.deepEqual(insideSeen, ["/crossdomain.xml", "/crossdomain.xml", "/r/rebound"]);
    assert.equal(seen.get("rebound")?.length, 1);

    // The private address's policy file, though it says it is fresh for ten minutes, is not
    // kept: on another network the same address is another machine. Its data is.
    const fourth = await playing(store);
    const again = await get(fourth, `${rebind()}/r/rebound`);
    assert.equal(again.cache, "hit");
    assert.deepEqual(insideSeen, [
      "/crossdomain.xml",
      "/crossdomain.xml",
      "/r/rebound",
      "/crossdomain.xml",
    ]);
  } finally {
    rebindTo = PUBLIC;
    policy = null;
    policyHeaders = {};
    insidePolicy = null;
    store.close();
  }
});

test("each movie's origin has a cache of its own: one never reads another's", async () => {
  offset = 0;
  resources.set("shared", { headers: { "cache-control": "max-age=600" } });
  const store = cache();
  const content = async (net: Network) => {
    const response = await get(net, `${swf()}/r/shared`, "content");
    await store.settled();
    return [response.cache ?? "network", seen.get("shared")?.length];
  };
  const mine = await playing(store);
  assert.deepEqual(await content(mine), ["network", 1]);
  assert.deepEqual(await content(mine), ["hit", 1]);
  const theirs = await playing(store, {}, other());
  assert.deepEqual(await content(theirs), ["network", 2]);
  assert.deepEqual(await content(theirs), ["hit", 2]);
  store.close();
});

test("a POST answered with success forgets its URL's responses, and its Location's", async () => {
  offset = 0;
  resources.set("posted", { headers: { "cache-control": "max-age=600" } });
  resources.set("created", { headers: { "cache-control": "max-age=600" } });
  resources.set("poster", {
    headers: { "cache-control": "max-age=600" },
    post: {
      status: 201,
      headers: { location: "/r/created", "content-location": "http://elsewhere.test/r/x" },
    },
  });
  resources.set("refusing", {
    headers: { "cache-control": "max-age=600" },
    post: { status: 500 },
  });
  const store = cache();
  const net = await playing(store);
  const post = (name: string) =>
    net.fetch(
      {
        url: `${swf()}/r/${name}`,
        method: "POST",
        headers: [],
        body: new TextEncoder().encode("a=1"),
        purpose: "data",
      },
      never,
    );
  for (const name of ["posted", "created", "refusing"]) {
    assert.deepEqual(await load(net, store, name), [name, "network", 1]);
    assert.deepEqual(await load(net, store, name), [name, "hit", 1]);
  }

  await post("posted");
  assert.deepEqual(await load(net, store, "posted"), ["posted", "network", 3]);
  await post("poster");
  assert.deepEqual(await load(net, store, "created"), ["created", "network", 2]);
  // A failure changed nothing it had.
  await post("refusing");
  assert.deepEqual(await load(net, store, "refusing"), ["refusing", "hit", 2]);
  store.close();
});

test("a policy file is never fresh by a guess, and no guess lasts past a day", async () => {
  offset = 0;
  policy = xml("swf.test");
  // Only Last-Modified: a tenth of a year's age would be a guess of over a month.
  policyHeaders = { "last-modified": new Date(Date.now() - 400 * 86_400_000).toUTCString() };
  policyRequests.length = 0;
  resources.set("guarded", { headers: { "cache-control": "max-age=600" } });
  const store = cache();
  try {
    const first = await playing(store);
    await get(first, `${other()}/r/guarded`);
    await store.settled();
    // The next movie revalidates the policy file it has, rather than trusting it.
    const second = await playing(store);
    await get(second, `${other()}/r/guarded`);
    assert.equal(policyRequests.length, 2);
    assert.equal(policyRequests[1]["if-modified-since"], policyHeaders["last-modified"]);
  } finally {
    policy = null;
    policyHeaders = {};
    store.close();
  }

  const lastModified = new Date(Date.now() - 1000 * 86_400_000).toUTCString();
  resources.set("old", { lastModified });
  const guessed = cache();
  const net = await playing(guessed);
  assert.deepEqual(await load(net, guessed, "old"), ["old", "network", 1]);
  offset = 23 * 3_600_000;
  assert.deepEqual(await load(net, guessed, "old"), ["old", "hit", 1]);
  offset = 25 * 3_600_000;
  assert.deepEqual(await load(net, guessed, "old"), ["old", "revalidated", 2]);
  guessed.close();
});

test("a response from the cache says its age", async () => {
  offset = 0;
  resources.set("aged", { headers: { "cache-control": "max-age=600", age: "5" } });
  const store = cache();
  const net = await playing(store);
  await load(net, store, "aged");
  offset = 30_000;
  const hit = await get(net, `${swf()}/r/aged`);
  assert.equal(hit.cache, "hit");
  assert.deepEqual(
    hit.headers.filter(([n]) => n.toLowerCase() === "age"),
    [["Age", "35"]],
  );
  store.close();
});

test("a URL that comes to vary leaves no response of before that would answer any request", async () => {
  offset = 0;
  resources.set("varies", { headers: { "cache-control": "max-age=600" }, body: "plain" });
  const store = cache();
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "varies"), ["plain", "network", 1]);
  resources.set("varies", {
    headers: { "cache-control": "max-age=600", vary: "Accept" },
    body: "varied",
  });
  // A request the stored one does not answer: Cache-Control of its own asks the server.
  assert.deepEqual(await load(net, store, "varies", [["Cache-Control", "no-cache"]]), [
    "varied",
    "network",
    2,
  ]);
  assert.equal(store.usage().entries, 1);
  assert.deepEqual(await load(net, store, "varies"), ["varied", "hit", 2]);
  store.close();
});

test("a cache that fails is left out where it fails, said once, and no request fails", async () => {
  offset = 0;
  resources.set("sturdy", { headers: { "cache-control": "max-age=600" } });
  resources.set("sturdy-2", { headers: { "cache-control": "max-age=600" } });
  const at = directory();
  const store = cache(at);
  const net = await playing(store);
  assert.deepEqual(await load(net, store, "sturdy"), ["sturdy", "network", 1]);
  warnings.length = 0;

  // A row whose headers do not parse: asked of the network instead, and kept again from it.
  const db = new DatabaseSync(join(at, "index.sqlite"));
  db.prepare("UPDATE entries SET headers = '{'").run();
  db.close();
  assert.deepEqual(await load(net, store, "sturdy"), ["sturdy", "network", 2]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /the HTTP cache failed/);

  // An index that can no longer be written, and bodies that cannot be: read as they are.
  (store as unknown as { db: DatabaseSync }).db.exec("PRAGMA query_only = ON");
  chmodSync(join(at, "bodies"), 0o555);
  try {
    assert.deepEqual(await load(net, store, "sturdy"), ["sturdy", "hit", 2]);
    assert.deepEqual(await load(net, store, "sturdy-2"), ["sturdy-2", "network", 1]);
    assert.deepEqual(await load(net, store, "sturdy-2"), ["sturdy-2", "network", 2]);
  } finally {
    chmodSync(join(at, "bodies"), 0o755);
    (store as unknown as { db: DatabaseSync }).db.exec("PRAGMA query_only = OFF");
  }

  // Its directory gone from under it.
  rmSync(at, { recursive: true, force: true });
  assert.deepEqual(await load(net, store, "sturdy"), ["sturdy", "network", 3]);
  assert.deepEqual(await load(net, store, "sturdy"), ["sturdy", "network", 4]);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  store.close();

  // A directory that cannot be written opens no cache: the app goes without one.
  const locked = directory();
  chmodSync(locked, 0o555);
  try {
    assert.throws(() => cache(locked));
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("nothing fetched with its certificate unchecked is read from the cache or kept", async (t) => {
  const dir = directory();
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

  let served = 0;
  const secure = createHttpsServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (_request, response) => {
      served++;
      response.writeHead(200, { "cache-control": "max-age=600" }).end("secure");
    },
  );
  await new Promise<void>((done) => secure.listen(0, PUBLIC, done));
  t.after(() => {
    secure.close();
    secure.closeAllConnections();
  });
  const url = `https://secure.test:${(secure.address() as { port: number }).port}/asset`;
  offset = 0;
  const store = cache();
  // --ignore-certificate-errors=secure.test: whoever is on the way could have written it.
  const net = await playing(store, {}, swf(), { unverified: (host) => host === "secure.test" });
  for (let n = 0; n < 2; n++) {
    const response = await get(net, url, "content");
    await store.settled();
    assert.equal(response.cache, undefined);
  }

  assert.equal(served, 2);
  assert.equal(store.usage().entries, 0);
  store.close();
});

test("an address through a proxy is another than the same one reached directly", async () => {
  offset = 0;
  resources.set("routed", { headers: { "cache-control": "max-age=600" } });
  const tunnel = await testProxy("http");
  const store = cache();
  try {
    const content = async (net: Network) => {
      const response = await get(net, `${swf()}/r/routed`, "content");
      await store.settled();
      return [response.cache ?? "network", seen.get("routed")?.length];
    };
    const direct = await playing(store);
    assert.deepEqual(await content(direct), ["network", 1]);
    assert.deepEqual(await content(direct), ["hit", 1]);
    const proxied = await playing(store, {}, swf(), { proxy: parseProxy(tunnel.url()) });
    assert.deepEqual(await content(proxied), ["network", 2]);
    assert.deepEqual(await content(proxied), ["hit", 2]);
    assert.ok(tunnel.targets.length > 0);
  } finally {
    store.close();
    await tunnel.close();
  }
});

test("each entry charges the budget its row and a disk block, not its body alone", async () => {
  offset = 0;
  // 100,000 bytes: a one-byte body with 2 KB of headers takes some 8 KB of it, row and block.
  const store = cache(directory(), 100_000);
  const big = "x".repeat(2048);
  for (let n = 0; n < 100; n++) {
    offset = n;
    await store.store(ask(`http://example.test/busted?${n}`), {
      status: 200,
      headers: [
        ["Cache-Control", "max-age=600"],
        ["X-Padding", big],
      ],
      bytes: new Uint8Array(1),
    });
  }

  const { entries, bytes, charges } = store.usage();
  assert.ok(entries > 0 && entries <= 100_000 / (4096 + 2048), `${entries} entries`);
  assert.equal(bytes, entries);
  assert.ok(charges <= 100_000 && charges > entries * (4096 + 2048), String(charges));
  // The most recent stay.
  assert.ok(store.lookup(ask("http://example.test/busted?99")));
  assert.equal(store.lookup(ask("http://example.test/busted?0")), null);
  store.close();
});

test("a policy file's fetch and a SWF's own GET of its URL are entries apart", async () => {
  offset = 0;
  const store = cache();
  const url = "http://example.test/crossdomain.xml";
  await store.store(ask(url), {
    status: 200,
    headers: [["Cache-Control", "max-age=600"]],
    bytes: new TextEncoder().encode("<cross-domain-policy/>"),
  });
  assert.ok(store.lookup(ask(url)));
  assert.equal(store.lookup({ ...ask(url), policyFile: true }), null);
  store.close();
});

test("a 304 to a response a write has since replaced revalidates nothing", async () => {
  offset = 0;
  const store = cache();
  const request = ask("http://example.test/raced");
  const response = {
    status: 200,
    headers: [
      ["Cache-Control", "no-cache"],
      ["ETag", '"one"'],
    ] as [string, string][],
    bytes: new Uint8Array(3),
  };
  await store.store(request, response);
  const found = store.lookup(request);
  assert.ok(found && !found.fresh);
  offset = 1000;
  await store.store(request, {
    ...response,
    headers: [...response.headers.slice(0, 1), ["ETag", '"two"']],
  });
  assert.equal(
    store.revalidated(found, request, { status: 304, headers: [["ETag", '"one"']], bytes: null }),
    null,
  );
  assert.equal(store.lookup(request)?.headers.find(([n]) => n === "ETag")?.[1], '"two"');
  store.close();
});
