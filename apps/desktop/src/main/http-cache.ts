// The desktop app's HTTP cache: a private cache, as RFC 9111 has one, of
// the GET responses network.ts receives for a SWF, its policy files among
// them. What may be stored, whether a stored response is fresh, what a
// revalidation asks and what its 304 changes are http-cache-semantics'
// (its CachePolicy, a private cache's); where they are kept is this file's.
//
// - Each response is kept for the address it came from and the movie that
//   asked: its key is the hash of the playing movie's origin (its
//   partition, as a browser partitions its cache by site), the address the
//   request's host was pinned to, its method, URL and the request headers
//   its Vary names. So a response from one address never answers a request
//   judged against another, the policy file that granted it included, as
//   DNS that changes its answer would have it; and one movie neither reads
//   nor probes what another origin's loaded.
// - The index is SQLite (node:sqlite), metadata only, a row a response:
//   its key, status, headers and policy; when it expires; its size; when
//   it was last served, by which the least recently served go first once
//   the bodies pass the budget, whose running total is kept in memory.
// - Every body is a file of its own in one flat directory, named by its
//   key. A body is written to a temporary file, synced and renamed into
//   place before its row is written; a row goes before its file. So a
//   crash leaves at worst a file without a row, or a row whose file is
//   gone or of another size: each serve checks the file against its row,
//   dropping the row where they differ, and each start sweeps away what
//   has no row.
// - A cache that fails, its disk full, read only or gone, its index
//   damaged, is left out where it fails, said once on stderr: a request
//   never fails for it, but goes to the network.
//
// The cache only answers for the network: network.ts judges each request
// by Flash's rules first, hit or miss.
//
// Without Electron, so that node tests it (tests/desktop/http-cache.test.ts).
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import CachePolicy from "http-cache-semantics";

/** What a request is, as the cache sees it: its headers as they are sent, and what keeps it apart. */
export interface CacheRequest {
  method: string;
  url: string;
  headers: [string, string][];
  /** The address its host was pinned to, which it was judged against. */
  address: string;
  /** The playing movie's origin, or "local" or "application": whose cache it is. */
  partition: string;
  /**
   * Whether a freshness of the cache's own guessing, from Last-Modified,
   * may serve it: not a policy file's, which is fresh only as long as its
   * server says, else revalidated.
   */
  heuristic?: boolean;
}

/** A response as network.ts has it: its body read, for a status that has one. */
export interface CacheResponse {
  status: number;
  headers: [string, string][];
  bytes: Uint8Array | null;
}

/** A stored response that matches a request. */
export interface CacheEntry {
  key: string;
  status: number;
  /** Its headers as stored. */
  headers: [string, string][];
  size: number;
  /** Its age in seconds, for the Age a response from the cache carries. */
  age: number;
  /** Servable as it is; otherwise it is revalidated first. */
  fresh: boolean;
  /** What a revalidation adds to the request: If-None-Match, If-Modified-Since; none without a validator. */
  conditional: [string, string][];
  /** When its row was written, which a serve that finds its file wrong drops it by. */
  stored: number;
  policy: CachePolicy;
}

export interface CacheOptions {
  /** The bytes all bodies may hold together: 512 MB. */
  budget?: number;
  /** The clock, in milliseconds: Date.now. */
  now?: () => number;
  /** What says, once, that the cache failed: a line on stderr. */
  warn?: (message: string) => void;
}

const CACHE_BUDGET = 512 * 1024 * 1024;

/** The longest a freshness the cache guesses from Last-Modified holds, as Chromium's does not: a day. */
const HEURISTIC_LIMIT = 24 * 60 * 60;

/** Request headers that make a request its own: the cache neither answers nor keeps it. */
const CONDITIONAL = new Set([
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range",
  "range",
]);

/** Headers a 304 does not replace (RFC 9111, 3.2), and what is never kept. */
const NOT_REPLACED = new Set([
  "content-length",
  "content-encoding",
  "content-md5",
  "content-range",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "set-cookie2",
  "age",
]);

const SCHEMA_VERSION = 2;
const INDEX = "index.sqlite";
const BODIES = "bodies";
const TEMPORARY = /\.tmp$/;

/** Headers as http-cache-semantics reads them: names in lower case, repeats joined. */
function record(headers: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    out[lower] = Object.hasOwn(out, lower) ? `${out[lower]}, ${value}` : value;
  }

  return out;
}

/** The request headers a response's Vary names, in lower case and sorted, "*" where it is. */
function varyNames(headers: Record<string, string>): string[] {
  const names = (headers.vary ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== "");
  return [...new Set(names)].sort();
}

/** The key of a response whose Vary names `names` to `request`. */
function keyOf(request: CacheRequest, names: string[], headers: Record<string, string>): string {
  const hash = createHash("sha256").update(
    `${request.partition}\n${request.address}\n${request.method} ${request.url}\n`,
  );
  for (const name of names) {
    // A header the request lacks differs from one it sends empty.
    hash.update(Object.hasOwn(headers, name) ? `${name}: ${headers[name]}\n` : `${name}\n`);
  }

  return hash.digest("hex");
}

/** Whether a response's freshness is its server's word, max-age or Expires, not the cache's guess. */
function explicit(headers: Record<string, string>): boolean {
  return (
    /(^|[\s,])max-age\s*=/i.test(headers["cache-control"] ?? "") || headers.expires !== undefined
  );
}

/** A response from the cache's headers: the stored ones, with its Age now (RFC 9111, 4). */
export function servedHeaders(entry: CacheEntry): [string, string][] {
  return [
    ...entry.headers.filter(([name]) => name.toLowerCase() !== "age"),
    ["Age", String(entry.age)],
  ];
}

interface Row {
  key: string;
  file: string;
  vary: string;
  status: number;
  headers: string;
  policy: string;
  stored: number;
  size: number;
}

interface Statements {
  candidates: StatementSync;
  sizeOf: StatementSync;
  upsert: StatementSync;
  touch: StatementSync;
  refresh: StatementSync;
  remove: StatementSync;
  removeIf: StatementSync;
  invalidate: StatementSync;
  usage: StatementSync;
  oldest: StatementSync;
  useless: StatementSync;
  all: StatementSync;
}

export class HttpCache {
  private readonly db: DatabaseSync;
  private readonly statements: Statements;
  private readonly bodies: string;
  private readonly budget: number;
  /** The largest body kept, an eighth of the budget, as Chromium keeps: no one response empties it. */
  private readonly largest: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly Policy: typeof CachePolicy;
  /** The bodies' bytes all told, as the rows say: read once, then kept as they change. */
  private total: number;
  /** Writes go one at a time, so that two of one key never cross between their renames and rows. */
  private writing: Promise<void> = Promise.resolve();
  /** The start's sweep, which runs beside the writes. */
  private readonly sweeping: Promise<void>;
  /** The bytes waiting to be written, which a burst of responses may not grow without bound. */
  private pending = 0;
  /** Counts clears: a write begun before one is dropped rather than stored after it. */
  private generation = 0;
  private warned = false;
  private closed = false;

  /**
   * The cache in `directory`, made where it is not; one that cannot be
   * opened is started again empty. Throws where even that fails.
   */
  constructor(directory: string, options: CacheOptions = {}) {
    this.bodies = join(directory, BODIES);
    this.budget = options.budget ?? CACHE_BUDGET;
    this.largest = Math.floor(this.budget / 8);
    this.warn = options.warn ?? ((message) => process.stderr.write(`swf2es: ${message}\n`));
    const clock = options.now ?? Date.now;
    this.now = clock;
    // http-cache-semantics reads the time from its policies' now(); the test's clock is theirs too.
    this.Policy = class extends CachePolicy {
      now(): number {
        return clock();
      }
    };
    mkdirSync(this.bodies, { recursive: true });
    let opened: [DatabaseSync, Statements];
    try {
      opened = this.openIndex(join(directory, INDEX));
    } catch {
      // A damaged index, or one of another version: what it indexed goes with it.
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(join(directory, INDEX + suffix), { force: true });
      }

      rmSync(this.bodies, { recursive: true, force: true });
      mkdirSync(this.bodies, { recursive: true });
      opened = this.openIndex(join(directory, INDEX));
    }

    [this.db, this.statements] = opened;
    this.total = (this.statements.usage.get() as { bytes: number }).bytes;
    this.sweeping = this.sweep().catch((error) => this.failed(error));
  }

  private openIndex(path: string): [DatabaseSync, Statements] {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      if (version !== 0 && version !== SCHEMA_VERSION) {
        throw new Error(`an index of version ${version}`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          key TEXT PRIMARY KEY,
          file TEXT NOT NULL,
          partition TEXT NOT NULL,
          address TEXT NOT NULL,
          method TEXT NOT NULL,
          url TEXT NOT NULL,
          vary TEXT NOT NULL,
          status INTEGER NOT NULL,
          headers TEXT NOT NULL,
          policy TEXT NOT NULL,
          stored INTEGER NOT NULL,
          expires INTEGER NOT NULL,
          etag TEXT,
          last_modified TEXT,
          size INTEGER NOT NULL,
          last_access INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS entries_last_access ON entries (last_access);
        CREATE INDEX IF NOT EXISTS entries_unvalidated ON entries (expires)
          WHERE etag IS NULL AND last_modified IS NULL;
        CREATE INDEX IF NOT EXISTS entries_url ON entries (url, partition);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      const prepare = (sql: string) => db.prepare(sql);
      return [
        db,
        {
          candidates: prepare(
            `SELECT key, file, vary, status, headers, policy, stored, size FROM entries
             WHERE url = ? AND partition = ? AND address = ? AND method = ?`,
          ),
          sizeOf: prepare("SELECT size FROM entries WHERE key = ?"),
          upsert: prepare(
            `INSERT INTO entries (key, file, partition, address, method, url, vary, status, headers,
               policy, stored, expires, etag, last_modified, size, last_access)
             VALUES ($key, $file, $partition, $address, $method, $url, $vary, $status, $headers,
               $policy, $stored, $expires, $etag, $lastModified, $size, $stored)
             ON CONFLICT (key) DO UPDATE SET file = excluded.file, vary = excluded.vary,
               status = excluded.status, headers = excluded.headers, policy = excluded.policy,
               stored = excluded.stored, expires = excluded.expires, etag = excluded.etag,
               last_modified = excluded.last_modified, size = excluded.size,
               last_access = excluded.last_access`,
          ),
          touch: prepare("UPDATE entries SET last_access = ? WHERE key = ?"),
          refresh: prepare(
            `UPDATE entries SET headers = $headers, policy = $policy, stored = $stored,
               expires = $expires, etag = $etag, last_modified = $lastModified,
               last_access = $stored
             WHERE key = $key AND stored = $was`,
          ),
          remove: prepare("DELETE FROM entries WHERE key = ? RETURNING file, size"),
          removeIf: prepare(
            "DELETE FROM entries WHERE key = ? AND stored = ? RETURNING file, size",
          ),
          invalidate: prepare(
            "DELETE FROM entries WHERE url = ? AND partition = ? RETURNING file, size",
          ),
          usage: prepare(
            "SELECT COUNT(*) AS entries, COALESCE(SUM(size), 0) AS bytes FROM entries",
          ),
          oldest: prepare("SELECT key FROM entries ORDER BY last_access LIMIT 64"),
          useless: prepare(
            `DELETE FROM entries WHERE expires <= ? AND etag IS NULL AND last_modified IS NULL
             RETURNING file, size`,
          ),
          all: prepare("SELECT key, file, size, stored FROM entries"),
        },
      ];
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Whether the cache answers `request` at all: a GET that asks nothing conditional of its own. */
  handles(request: CacheRequest): boolean {
    return (
      !this.closed &&
      request.method === "GET" &&
      !request.headers.some(([name]) => CONDITIONAL.has(name.toLowerCase()))
    );
  }

  /** The stored response that matches `request`, fresh or to revalidate; null where none does. */
  lookup(request: CacheRequest): CacheEntry | null {
    if (!this.handles(request)) {
      return null;
    }

    try {
      return this.find(request);
    } catch (error) {
      this.failed(error);
      return null;
    }
  }

  private find(request: CacheRequest): CacheEntry | null {
    const headers = record(request.headers);
    const rows = this.statements.candidates.all(
      request.url,
      request.partition,
      request.address,
      request.method,
    ) as unknown as Row[];
    for (const row of rows) {
      const names = (JSON.parse(row.vary) as [string, string][]).map(([name]) => name);
      if (keyOf(request, names, headers) !== row.key) {
        continue;
      }

      const policy = this.Policy.fromObject(JSON.parse(row.policy));
      const stored = JSON.parse(row.headers) as [string, string][];
      const asked = { method: request.method, url: request.url, headers };
      const { response, revalidation } = policy.evaluateRequest(asked);
      // Stale-while-revalidate is revalidated at once, not after serving the stale response.
      let fresh = !!response && !revalidation;
      // A freshness guessed from Last-Modified serves a day at most, and no policy file.
      if (fresh && !explicit(record(stored))) {
        fresh = request.heuristic !== false && policy.age() < HEURISTIC_LIMIT;
      }

      const conditional: [string, string][] = [];
      if (!fresh) {
        const again = policy.revalidationHeaders(asked);
        if (again["if-none-match"]) {
          conditional.push(["If-None-Match", again["if-none-match"]]);
        }

        if (again["if-modified-since"]) {
          conditional.push(["If-Modified-Since", again["if-modified-since"]]);
        }
      }

      return {
        key: row.key,
        status: row.status,
        headers: stored,
        size: row.size,
        age: Math.max(0, Math.round(policy.age())),
        fresh,
        conditional,
        stored: row.stored,
        policy,
      };
    }

    return null;
  }

  /**
   * `entry`'s body, if its file is there and its size: otherwise its row is
   * dropped, and null. Served, it is the most recently used.
   */
  async body(entry: CacheEntry): Promise<Uint8Array | null> {
    let bytes: Uint8Array | null = null;
    try {
      const handle = await open(join(this.bodies, entry.key), "r");
      try {
        // The size of the file opened, which a write renaming another into place changes not.
        const { size } = await handle.stat();
        if (size === entry.size) {
          const into = new Uint8Array(size);
          let at = 0;
          while (at < size) {
            const { bytesRead } = await handle.read(into, at, size - at, at);
            if (bytesRead === 0) {
              break;
            }

            at += bytesRead;
          }

          bytes = at === size ? into : null;
        }
      } finally {
        await handle.close();
      }
    } catch {
      bytes = null;
    }

    if (this.closed) {
      return bytes;
    }

    try {
      if (!bytes) {
        // Only the row read: one a write has since put in its place stays.
        this.drop(this.statements.removeIf.all(entry.key, entry.stored));
        return null;
      }

      this.statements.touch.run(this.now(), entry.key);
    } catch (error) {
      this.failed(error);
    }

    return bytes;
  }

  /**
   * What a 304 to `entry`'s revalidation makes of it: its headers updated
   * with the 304's, and fresh again, as RFC 9111 has it; null where the
   * 304 does not match it, which drops it.
   */
  revalidated(
    entry: CacheEntry,
    request: CacheRequest,
    response: CacheResponse,
  ): CacheEntry | null {
    if (this.closed) {
      return null;
    }

    try {
      const asked = { method: request.method, url: request.url, headers: record(request.headers) };
      const answered = { status: response.status, headers: record(response.headers) };
      const { policy, modified } = entry.policy.revalidatedPolicy(asked, answered);
      if (modified || !policy.storable()) {
        this.drop(this.statements.remove.all(entry.key));
        return null;
      }

      const replaced = new Set(
        response.headers
          .map(([name]) => name.toLowerCase())
          .filter((name) => !NOT_REPLACED.has(name)),
      );
      const headers: [string, string][] = [
        ...entry.headers.filter(([name]) => !replaced.has(name.toLowerCase())),
        ...response.headers.filter(([name]) => replaced.has(name.toLowerCase())),
      ];
      const stored = this.now();
      const merged = record(headers);
      this.statements.refresh.run({
        $key: entry.key,
        $was: entry.stored,
        $headers: JSON.stringify(headers),
        $policy: JSON.stringify(policy.toObject()),
        $stored: stored,
        $expires: stored + this.lifetime(policy, merged),
        $etag: merged.etag ?? null,
        $lastModified: merged["last-modified"] ?? null,
      });
      return { ...entry, headers, age: 0, fresh: true, conditional: [], stored, policy };
    } catch (error) {
      this.failed(error);
      return null;
    }
  }

  /**
   * What an unsafe request answered with success does (RFC 9111, 4.4): the
   * responses its URL has in `partition` forgotten, and those of the URLs
   * its Location and Content-Location name on its origin.
   */
  invalidate(url: URL, response: CacheResponse, partition: string): void {
    if (this.closed || response.status < 200 || response.status >= 400) {
      return;
    }

    try {
      const urls = new Set([url.href]);
      for (const [name, value] of response.headers) {
        if (/^(content-)?location$/i.test(name)) {
          try {
            const named = new URL(value, url);
            named.hash = "";
            if (named.origin === url.origin) {
              urls.add(named.href);
            }
          } catch {
            // No URL: nothing of it is stored.
          }
        }
      }

      for (const each of urls) {
        this.drop(this.statements.invalidate.all(each, partition));
      }
    } catch (error) {
      this.failed(error);
    }
  }

  /**
   * Keep `response` to `request` where RFC 9111 lets a private cache: a
   * 200 to a GET, with its body, neither no-store nor Vary: *, nor
   * answering an Authorization the response does not make public, nor
   * larger than an eighth of the budget. Written in the background, one
   * write at a time; the promise is for tests.
   */
  store(request: CacheRequest, response: CacheResponse): Promise<void> {
    try {
      return this.keep(request, response);
    } catch (error) {
      this.failed(error);
      return Promise.resolve();
    }
  }

  private keep(request: CacheRequest, response: CacheResponse): Promise<void> {
    const bytes = response.bytes;
    if (
      !this.handles(request) ||
      response.status !== 200 ||
      !bytes ||
      bytes.length > this.largest ||
      this.pending + bytes.length > this.largest * 2
    ) {
      return Promise.resolve();
    }

    const requestHeaders = record(request.headers);
    const kept = response.headers.filter(([name]) => !/^set-cookie2?$/i.test(name));
    const responseHeaders = record(kept);
    const names = varyNames(responseHeaders);
    if (names.includes("*")) {
      return Promise.resolve();
    }

    const asked = { method: request.method, url: request.url, headers: requestHeaders };
    const policy = new this.Policy(
      asked,
      { status: response.status, headers: responseHeaders },
      { shared: false },
    );
    if (!policy.storable()) {
      return Promise.resolve();
    }

    // A private cache may keep what answered an Authorization; this one keeps it only
    // where a shared cache could (RFC 9111, 3.5): the response says so.
    const control = (responseHeaders["cache-control"] ?? "").toLowerCase();
    if (
      Object.hasOwn(requestHeaders, "authorization") &&
      !/(^|[\s,])(public|must-revalidate|s-maxage)([\s,=]|$)/.test(control)
    ) {
      return Promise.resolve();
    }

    const etag = responseHeaders.etag ?? null;
    const lastModified = responseHeaders["last-modified"] ?? null;
    // Never served fresh and never revalidated: no use kept.
    if (policy.timeToLive() <= 0 && !etag && !lastModified) {
      return Promise.resolve();
    }

    const vary = names.map((name) => [name, requestHeaders[name] ?? null]);
    const key = keyOf(request, names, requestHeaders);
    const generation = this.generation;
    this.pending += bytes.length;
    const write = async () => {
      if (this.closed || generation !== this.generation) {
        return;
      }

      const path = join(this.bodies, key);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "w");
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }

        if (this.closed || generation !== this.generation) {
          await rm(temporary, { force: true });
          return;
        }

        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        this.failed(error);
        return;
      }

      if (this.closed) {
        return;
      }

      if (generation !== this.generation) {
        rmSync(path, { force: true });
        return;
      }

      // What the URL's responses varied by before, where it now varies otherwise: no longer
      // what the server serves, as a Vary-less one that would answer whatever the request.
      const others = this.statements.candidates.all(
        request.url,
        request.partition,
        request.address,
        request.method,
      ) as unknown as Row[];
      for (const other of others) {
        const otherNames = (JSON.parse(other.vary) as [string, string][]).map(([n]) => n);
        if (other.key !== key && otherNames.join() !== names.join()) {
          this.drop(this.statements.remove.all(other.key));
        }
      }

      const before = this.statements.sizeOf.get(key) as { size: number } | undefined;
      const stored = this.now();
      this.statements.upsert.run({
        $key: key,
        $file: key,
        $partition: request.partition,
        $address: request.address,
        $method: request.method,
        $url: request.url,
        $vary: JSON.stringify(vary),
        $status: response.status,
        $headers: JSON.stringify(kept),
        $policy: JSON.stringify(policy.toObject()),
        $stored: stored,
        $expires: stored + this.lifetime(policy, responseHeaders),
        $etag: etag,
        $lastModified: lastModified,
        $size: bytes.length,
      });
      this.total += bytes.length - (before?.size ?? 0);
      this.evict();
    };
    const done = this.writing
      .then(write)
      .catch((error) => this.failed(error))
      .finally(() => {
        this.pending -= bytes.length;
      });
    this.writing = done;
    return done;
  }

  /** What is stored now and how much: for tests and the menu. */
  usage(): { entries: number; bytes: number } {
    return { ...(this.statements.usage.get() as { entries: number; bytes: number }) };
  }

  /**
   * Everything stored forgotten, and what is being written dropped: the
   * rows at once, the files in their turn among the writes, after those
   * begun before and before those begun after.
   */
  async clear(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.generation++;
    this.db.exec("DELETE FROM entries");
    this.total = 0;
    const wipe = this.writing.then(async () => {
      for (const name of await readdir(this.bodies)) {
        await rm(join(this.bodies, name), { force: true, recursive: true });
      }
    });
    this.writing = wipe.catch(() => {});
    await wipe;
  }

  /** Once every write begun, and the start's sweep, have ended. */
  async settled(): Promise<void> {
    await this.sweeping;
    await this.writing;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  /** The first failure said, and what follows left unsaid: one line, not one a request. */
  private failed(error: unknown): void {
    if (!this.warned && !this.closed) {
      this.warned = true;
      this.warn(`the HTTP cache failed, and is left out where it fails: ${error}`);
    }
  }

  /** How long a response stays fresh, its guessed freshness a day at most, in milliseconds. */
  private lifetime(policy: CachePolicy, headers: Record<string, string>): number {
    const ttl = policy.timeToLive();
    return explicit(headers) ? ttl : Math.min(ttl, HEURISTIC_LIMIT * 1000);
  }

  /** Rows a statement deleted, their files after them and their bytes off the total. */
  private drop(rows: unknown[]): void {
    for (const { file, size } of rows as { file: string; size: number }[]) {
      this.total -= size;
      rmSync(join(this.bodies, file), { force: true });
    }
  }

  /**
   * Responses that can no longer be used dropped, stale without a
   * validator; then, past the budget, the least recently served. Each by
   * an index: the total is kept, not summed.
   */
  private evict(): void {
    const rows: unknown[] = [];
    this.db.exec("BEGIN");
    try {
      const useless = this.statements.useless.all(this.now()) as { size: number }[];
      let total = this.total - useless.reduce((sum, row) => sum + row.size, 0);
      rows.push(...useless);
      while (total > this.budget) {
        const oldest = this.statements.oldest.all() as { key: string }[];
        if (oldest.length === 0) {
          break;
        }

        for (const { key } of oldest) {
          if (total <= this.budget) {
            break;
          }

          for (const row of this.statements.remove.all(key) as { size: number }[]) {
            rows.push(row);
            total -= row.size;
          }
        }
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.drop(rows);
  }

  /**
   * What a crash or another version left: temporary files and files with
   * no row removed, rows whose file is gone or of another size dropped.
   * Beside the writes, so it judges only what it found as it began, and
   * drops a row only as it found it.
   */
  private async sweep(): Promise<void> {
    const names = readdirSync(this.bodies);
    const rows = this.statements.all.all() as unknown as (Row & { stored: number })[];
    const known = new Set(rows.map((row) => row.file));
    for (const name of names) {
      // Not one a write has since given a row, its file renamed over the one found.
      if (TEMPORARY.test(name) || (!known.has(name) && !this.statements.sizeOf.get(name))) {
        await rm(join(this.bodies, name), { force: true, recursive: true });
      }

      if (this.closed) {
        return;
      }
    }

    const listed = new Set(names);
    for (const row of rows) {
      let size = -1;
      if (listed.has(row.file)) {
        try {
          size = (await stat(join(this.bodies, row.file))).size;
        } catch {
          size = -1;
        }
      }

      if (this.closed) {
        return;
      }

      if (size !== row.size) {
        this.drop(this.statements.removeIf.all(row.key, row.stored));
      }
    }
  }
}
