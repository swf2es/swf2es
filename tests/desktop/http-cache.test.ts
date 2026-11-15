// The desktop app's HTTP cache (apps/desktop/src/main/http-cache.ts), alone
// and under its network (network.ts), against a server of the test's own:
// RFC 9111's freshness and revalidation as http-cache-semantics reads them,
// Vary, the budget, what a crash leaves, and Flash's rules still judging
// every request the cache could answer.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { HttpCache } from "../../apps/desktop/src/main/http-cache.ts";
import { Network } from "../../apps/desktop/src/main/network.ts";
import { type NetResponse, Refused } from "../../apps/desktop/src/main/network-types.ts";

const PUBLIC = "127.0.0.2";

interface Resource {
  headers?: Record<string, string>;
  body?: string;
  /** Answered with a 304 where the request's If-None-Match names it. */
  etag?: string;
  /** Answered with a 304 where the request's If-Modified-Since is it. */
  lastModified?: string;
  /** What a 304 adds beside the validators. */
  notModified?: Record<string, string>;
}

/** What each /r/<name> answers, and the requests each got. */
const resources = new Map<string, Resource>();
const seen = new Map<string, IncomingHttpHeaders[]>();
let policy: string | null = null;
let port = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  if (url.pathname === "/crossdomain.xml") {
    if (policy === null) {
      response.writeHead(404).end();
    } else {
      response.writeHead(200, { "content-type": "text/x-cross-domain-policy" }).end(policy);
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

before(async () => {
  await new Promise<void>((done) => server.listen(0, PUBLIC, done));
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
  server.closeAllConnections();
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

function cache(at = directory(), budget?: number): HttpCache {
  return new HttpCache(at, { now: clock, ...(budget === undefined ? {} : { budget }) });
}

const swf = () => `http://swf.test:${port}`;
const other = () => `http://other.test:${port}`;

/** A network playing a remote SWF from swf.test, answered from `store`. */
async function playing(store: HttpCache | null, limits = {}): Promise<Network> {
  const net = new Network({
    resolve: async (host) => {
      if (host === "swf.test" || host === "other.test") {
        return [PUBLIC];
      }

      throw new Error("no such host");
    },
    classify: () => "public",
    limits,
  });
  net.cache = store;
  net.play({ kind: "remote", url: `${swf()}/movie.swf` });
  await get(net, `${swf()}/movie.swf`, "movie");
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
  const request = (coding: string) => ({
    method: "GET",
    url,
    headers: [["Accept-Encoding", coding]] as [string, string][],
  });
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
  const authorized = {
    method: "GET",
    url,
    headers: [["Authorization", "Basic eDp5"]] as [string, string][],
  };
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
  const conditional = {
    method: "GET",
    url,
    headers: [["If-None-Match", '"x"']] as [string, string][],
  };
  assert.equal(store.lookup(conditional), null);
  await store.store({ ...conditional, url: `${url}2` }, answer("max-age=60"));
  assert.equal(store.usage().entries, 1);
  store.close();
});

test("past its budget the least recently served go first", async () => {
  offset = 0;
  // 2000 bytes, so 250 at most a body: eight of 240 fit, the ninth and tenth do not.
  const at = directory();
  const store = cache(at, 2000);
  const request = (n: number) => ({ method: "GET", url: `http://example.test/${n}`, headers: [] });
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
  await store.store(request(99), { ...response, bytes: new Uint8Array(251) });
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
  assert.equal(store.usage().bytes, 1920);
  // Their files went with them.
  assert.equal(readdirSync(join(at, "bodies")).length, 8);
  store.close();
});

test("a start sweeps away files with no row, temporary files and rows whose file is gone", async () => {
  offset = 0;
  const at = directory();
  let store = cache(at);
  const request = (n: number) => ({ method: "GET", url: `http://example.test/${n}`, headers: [] });
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
    method: "GET",
    url: `${swf()}/r/vanish`,
    headers: requestHeaders(),
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
  const request = { method: "GET", url: "http://example.test/partial", headers: [] };
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
  policy =
    '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="swf.test"/></cross-domain-policy>';
  const granted = await playing(store);
  const data = await get(granted, `${other()}/r/elsewhere`, "data");
  assert.equal(data.cache, "hit");
  assert.equal(seen.get("elsewhere")?.length, 1);
  policy = null;
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
  const request = (n: number) => ({ method: "GET", url: `http://example.test/${n}`, headers: [] });
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
  assert.deepEqual(store.usage(), { entries: 0, bytes: 0 });
  await store.store(
    { method: "GET", url: "http://example.test/", headers: [] },
    { status: 200, headers: [["Cache-Control", "max-age=60"]], bytes: new Uint8Array(1) },
  );
  assert.equal(store.usage().entries, 1);
  store.close();
});
