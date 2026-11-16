// What the desktop app's main process spends on many small loads from one
// server: network.ts's requests, as a SWF's URLLoaders make them, over
// http and over https, one after another and all at once, against servers
// in a process of their own that count the connections they take. Without
// a pool every request opens a connection, and TLS's handshake for https;
// with one (http-pool.ts) they reuse what is kept.
//
//   node tests/desktop/keepalive-bench.ts [runs, 5]                             this checkout
//   node tests/desktop/keepalive-bench.ts <checkout A> <checkout B> [runs, 6]   two, interleaved
//   [--loads N]   the loads of each kind, 200 by default
//
// A checkout is a directory with apps/desktop/src/main; each run is a
// process of its own, A, B, B, A, ..., and the medians are shown.
import { fork, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, get, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const BODY = Buffer.alloc(1024, 0x61);

interface Ports {
  http: number;
  https: number | null;
  cert: string | null;
}

interface Result {
  [kind: string]: { ms: number; connections: number };
}

/** The servers: a 1 KB answer to anything, and the connections each took since last asked. */
async function serve(): Promise<void> {
  const counts = { http: 0, https: 0 };
  const listen = (server: Server, kind: "http" | "https") => {
    server.on("connection", () => counts[kind]++);
    server.on("request", (request, response) => {
      if (request.url === "/counts") {
        // Its own connection is not the checkout's.
        counts.http--;
        response.end(JSON.stringify(counts));
        counts.http = 0;
        counts.https = 0;
        return;
      }

      response.setHeader("Content-Type", "application/octet-stream");
      response.end(BODY);
    });
    return new Promise<number>((done) =>
      server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port)),
    );
  };

  const http = await listen(createHttpServer(), "http");
  const dir = mkdtempSync(join(tmpdir(), "swf2es-keepalive-"));
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=bench.test",
      "-addext",
      "subjectAltName=DNS:bench.test",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { encoding: "utf8" },
  );
  let https: number | null = null;
  let cert: string | null = null;
  if (made.status === 0) {
    cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const key = readFileSync(join(dir, "key.pem"));
    https = await listen(createHttpsServer({ key, cert }), "https");
  }

  rmSync(dir, { recursive: true, force: true });
  process.send?.({ http, https, cert } satisfies Ports);
}

function counts(port: number): Promise<{ http: number; https: number }> {
  return new Promise((done, fail) => {
    get({ host: "127.0.0.1", port, path: "/counts", agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done(JSON.parse(Buffer.concat(chunks).toString())));
    }).on("error", fail);
  });
}

/** One checkout's run, against the servers at `ports`. */
async function measure(checkout: string, ports: Ports, loads: number): Promise<Result> {
  const { Network } = await import(
    pathToFileURL(`${checkout}/apps/desktop/src/main/network.ts`).href
  );
  const net = new Network({
    resolve: async () => ["127.0.0.1"],
    classify: () => "public",
    ...(ports.cert ? { ca: ports.cert } : {}),
  });
  net.play({ kind: "application" });
  const signal = new AbortController().signal;
  const load = async (url: string) => {
    const response = await net.fetch(
      { url, method: "GET", headers: [], body: null, purpose: "data" },
      signal,
    );
    if (response.bytes?.length !== BODY.length) {
      throw new Error(`${url}: ${response.status}`);
    }
  };

  const result: Result = {};
  const schemes: ["http" | "https", number][] = [["http", ports.http]];
  if (ports.https !== null) {
    schemes.push(["https", ports.https]);
  }

  for (const [scheme, port] of schemes) {
    const base = `${scheme}://bench.test:${port}`;
    // Warm: the modules' code, and TLS's.
    await load(`${base}/warm`);
    net.play({ kind: "application" });
    await counts(ports.http);

    let start = performance.now();
    for (let i = 0; i < loads; i++) {
      await load(`${base}/one/${i}`);
    }
    result[`${scheme} one by one`] = {
      ms: performance.now() - start,
      connections: (await counts(ports.http))[scheme],
    };
    net.play({ kind: "application" });

    start = performance.now();
    await Promise.all(Array.from({ length: loads }, (_, i) => load(`${base}/all/${i}`)));
    result[`${scheme} all at once`] = {
      ms: performance.now() - start,
      connections: (await counts(ports.http))[scheme],
    };
    net.play({ kind: "application" });
  }

  net.play(null);
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--serve") {
    await serve();
    return;
  }

  let loads = 200;
  const loadsAt = args.indexOf("--loads");
  if (loadsAt >= 0) {
    loads = Number(args[loadsAt + 1]);
    args.splice(loadsAt, 2);
  }

  if (args[0] === "--run") {
    const ports = JSON.parse(args[2]) as Ports;
    process.send?.(await measure(resolve(args[1]), ports, loads));
    return;
  }

  const numbers = args.filter((a) => /^\d+$/.test(a));
  const checkouts = args.filter((a) => !/^\d+$/.test(a)).map((a) => resolve(a));
  if (checkouts.length === 0) {
    checkouts.push(root);
  }

  const runs = Number(numbers[0] ?? (checkouts.length > 1 ? 6 : 5));
  const server = fork(fileURLToPath(import.meta.url), ["--serve"], { stdio: "inherit" });
  const ports = await new Promise<Ports>((done) => server.once("message", (m) => done(m as Ports)));
  if (ports.https === null) {
    process.stderr.write("no openssl to make a certificate: http alone\n");
  }

  const results = new Map<string, Result[]>(checkouts.map((c) => [c, []]));
  try {
    for (let run = 0; run < runs; run++) {
      // A, B, B, A, ...: neither always first.
      const order = run % 2 ? [...checkouts].reverse() : checkouts;
      for (const checkout of order) {
        const child = fork(
          fileURLToPath(import.meta.url),
          ["--run", checkout, JSON.stringify(ports), "--loads", String(loads)],
          { stdio: "inherit" },
        );
        const result = await new Promise<Result>((done, fail) => {
          child.once("message", (m) => done(m as Result));
          child.once("exit", (code) => code && fail(new Error(`${checkout}: exit ${code}`)));
        });
        results.get(checkout)?.push(result);
      }
    }
  } finally {
    server.kill();
  }

  process.stdout.write(`${loads} loads of 1 KB each kind, medians of ${runs}\n`);
  for (const [checkout, list] of results) {
    process.stdout.write(`${checkout}\n`);
    for (const kind of Object.keys(list[0])) {
      const ms = median(list.map((r) => r[kind].ms));
      const connections = median(list.map((r) => r[kind].connections));
      process.stdout.write(
        `  ${kind.padEnd(20)} ${ms.toFixed(1).padStart(8)} ms ${String(connections).padStart(5)} connections\n`,
      );
    }
  }
}

await main();
