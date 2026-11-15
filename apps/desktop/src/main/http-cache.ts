// The desktop app's HTTP cache: a private cache, as RFC 9111 has one, of
// the GET responses network.ts receives for a SWF, its policy files among
// them. What may be stored, whether a stored response is fresh, what a
// revalidation asks and what its 304 changes are http-cache-semantics'
// (its CachePolicy, a private cache's); where they are kept is this file's.
//
// - The index is SQLite (node:sqlite), metadata only, a row a response:
//   its key, the hash of its method, URL and the request headers its Vary
//   names; its status, headers and policy; when it expires; its size; when
//   it was last served, by which the least recently served go first once
//   the bodies pass the budget.
// - Every body is a file of its own in one flat directory, named by its
//   key. A body is written to a temporary file, synced and renamed into
//   place before its row is written; a row goes before its file. So a
//   crash leaves at worst a file without a row, or a row whose file is
//   gone or of another size: each serve checks the file against its row,
//   dropping the row where they differ, and each start sweeps away what
//   has no row and what is no longer revalidated.
//
// The cache only answers for the network: network.ts judges each request
// by Flash's rules first, hit or miss.
//
// Without Electron, so that node tests it (tests/desktop/http-cache.test.ts).
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import CachePolicy from "http-cache-semantics";

/** What a request is, as the cache sees it: its headers as they are sent. */
export interface CacheRequest {
  method: string;
  url: string;
  headers: [string, string][];
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
  headers: [string, string][];
  size: number;
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
}

const CACHE_BUDGET = 512 * 1024 * 1024;

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
]);

const SCHEMA_VERSION = 1;
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

/** The key of a response to `method` `url` whose Vary names `names`, asked with `headers`. */
function keyOf(
  method: string,
  url: string,
  names: string[],
  headers: Record<string, string>,
): string {
  const hash = createHash("sha256").update(`${method} ${url}\n`);
  for (const name of names) {
    // A header the request lacks differs from one it sends empty.
    hash.update(Object.hasOwn(headers, name) ? `${name}: ${headers[name]}\n` : `${name}\n`);
  }

  return hash.digest("hex");
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

export class HttpCache {
  private readonly db: DatabaseSync;
  private readonly bodies: string;
  private readonly budget: number;
  /** The largest body kept, an eighth of the budget, as Chromium keeps: no one response empties it. */
  private readonly largest: number;
  private readonly now: () => number;
  private readonly Policy: typeof CachePolicy;
  private readonly statements: {
    candidates: StatementSync;
    upsert: StatementSync;
    touch: StatementSync;
    refresh: StatementSync;
    remove: StatementSync;
    removeIf: StatementSync;
    total: StatementSync;
    oldest: StatementSync;
    useless: StatementSync;
    all: StatementSync;
  };
  /** Writes go one at a time, so that two of one key never cross between their renames and rows. */
  private writing: Promise<void>;
  /** The bytes waiting to be written, which a burst of responses may not grow without bound. */
  private pending = 0;
  /** Counts clears: a write begun before one is dropped rather than stored after it. */
  private generation = 0;
  private closed = false;

  /**
   * The cache in `directory`, made where it is not; one that cannot be
   * opened is started again empty. Throws where even that fails.
   */
  constructor(directory: string, options: CacheOptions = {}) {
    this.bodies = join(directory, BODIES);
    this.budget = options.budget ?? CACHE_BUDGET;
    this.largest = Math.floor(this.budget / 8);
    const clock = options.now ?? Date.now;
    this.now = clock;
    // http-cache-semantics reads the time from its policies' now(); the test's clock is theirs too.
    this.Policy = class extends CachePolicy {
      now(): number {
        return clock();
      }
    };
    mkdirSync(this.bodies, { recursive: true });
    let db: DatabaseSync;
    try {
      db = this.openIndex(join(directory, INDEX));
    } catch {
      // A damaged index, or one of a later version: what it indexed goes with it.
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(join(directory, INDEX + suffix), { force: true });
      }

      rmSync(this.bodies, { recursive: true, force: true });
      mkdirSync(this.bodies, { recursive: true });
      db = this.openIndex(join(directory, INDEX));
    }

    this.db = db;
    const prepare = (sql: string) => db.prepare(sql);
    this.statements = {
      candidates: prepare(
        "SELECT key, file, vary, status, headers, policy, stored, size FROM entries WHERE url = ? AND method = ?",
      ),
      upsert: prepare(
        `INSERT INTO entries (key, file, method, url, vary, status, headers, policy, stored, expires, etag, last_modified, size, last_access)
         VALUES ($key, $file, $method, $url, $vary, $status, $headers, $policy, $stored, $expires, $etag, $lastModified, $size, $stored)
         ON CONFLICT (key) DO UPDATE SET file = excluded.file, method = excluded.method, url = excluded.url,
           vary = excluded.vary, status = excluded.status, headers = excluded.headers, policy = excluded.policy,
           stored = excluded.stored, expires = excluded.expires, etag = excluded.etag,
           last_modified = excluded.last_modified, size = excluded.size, last_access = excluded.last_access`,
      ),
      touch: prepare("UPDATE entries SET last_access = ? WHERE key = ?"),
      refresh: prepare(
        `UPDATE entries SET headers = $headers, policy = $policy, stored = $stored, expires = $expires,
           etag = $etag, last_modified = $lastModified, last_access = $stored WHERE key = $key AND stored = $was`,
      ),
      remove: prepare("DELETE FROM entries WHERE key = ? RETURNING file"),
      removeIf: prepare("DELETE FROM entries WHERE key = ? AND stored = ? RETURNING file"),
      total: prepare("SELECT COALESCE(SUM(size), 0) AS total FROM entries"),
      oldest: prepare("SELECT key, size FROM entries ORDER BY last_access LIMIT 64"),
      useless: prepare(
        "DELETE FROM entries WHERE expires <= ? AND etag IS NULL AND last_modified IS NULL RETURNING file",
      ),
      all: prepare("SELECT key, file, size FROM entries"),
    };
    // A sweep that fails leaves what it found; writes go on after it all the same.
    this.writing = this.sweep().catch(() => {});
  }

  private openIndex(path: string): DatabaseSync {
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
        CREATE INDEX IF NOT EXISTS entries_expires ON entries (expires);
        CREATE INDEX IF NOT EXISTS entries_url ON entries (url, method);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      return db;
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

    const headers = record(request.headers);
    const rows = this.statements.candidates.all(request.url, request.method) as unknown as Row[];
    for (const row of rows) {
      const names = (JSON.parse(row.vary) as [string, string][]).map(([name]) => name);
      if (keyOf(request.method, request.url, names, headers) !== row.key) {
        continue;
      }

      let policy: CachePolicy;
      try {
        policy = this.Policy.fromObject(JSON.parse(row.policy));
      } catch {
        this.remove(row.key);
        return null;
      }

      const asked = { method: request.method, url: request.url, headers };
      const { response, revalidation } = policy.evaluateRequest(asked);
      // Stale-while-revalidate is revalidated at once, not after serving the stale response.
      const fresh = !!response && !revalidation;
      const conditional: [string, string][] = [];
      if (!fresh) {
        const again = policy.revalidationHeaders(asked);
        for (const name of ["if-none-match", "if-modified-since"]) {
          if (again[name]) {
            conditional.push([
              name === "if-none-match" ? "If-None-Match" : "If-Modified-Since",
              again[name],
            ]);
          }
        }
      }

      return {
        key: row.key,
        status: row.status,
        headers: JSON.parse(row.headers),
        size: row.size,
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

    if (!bytes) {
      // Only the row read: one a write has since put in its place stays.
      const gone = this.statements.removeIf.all(entry.key, entry.stored) as { file: string }[];
      for (const { file } of gone) {
        rmSync(join(this.bodies, file), { force: true });
      }

      return null;
    }

    this.statements.touch.run(this.now(), entry.key);
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

    const asked = { method: request.method, url: request.url, headers: record(request.headers) };
    const answered = { status: response.status, headers: record(response.headers) };
    const { policy, modified } = entry.policy.revalidatedPolicy(asked, answered);
    if (modified || !policy.storable()) {
      this.remove(entry.key);
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
      $expires: stored + policy.timeToLive(),
      $etag: merged.etag ?? null,
      $lastModified: merged["last-modified"] ?? null,
    });
    return { ...entry, headers, fresh: true, conditional: [], stored, policy };
  }

  /**
   * Keep `response` to `request` where RFC 9111 lets a private cache: a
   * 200 to a GET, with its body, neither no-store nor Vary: *, nor
   * answering an Authorization the response does not make public, nor
   * larger than an eighth of the budget. Written in the background, one
   * write at a time; the promise is for tests.
   */
  store(request: CacheRequest, response: CacheResponse): Promise<void> {
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
    const key = keyOf(request.method, request.url, names, requestHeaders);
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
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        return;
      }

      if (this.closed) {
        return;
      }

      if (generation !== this.generation) {
        rmSync(path, { force: true });
        return;
      }

      const stored = this.now();
      this.statements.upsert.run({
        $key: key,
        $file: key,
        $method: request.method,
        $url: request.url,
        $vary: JSON.stringify(vary),
        $status: response.status,
        $headers: JSON.stringify(kept),
        $policy: JSON.stringify(policy.toObject()),
        $stored: stored,
        $expires: stored + policy.timeToLive(),
        $etag: etag,
        $lastModified: lastModified,
        $size: bytes.length,
      });
      this.evict();
    };
    const done = this.writing.then(write).finally(() => {
      this.pending -= bytes.length;
    });
    this.writing = done.catch(() => {});
    return this.writing;
  }

  /** What is stored now and how much: for tests and the menu. */
  usage(): { entries: number; bytes: number } {
    const rows = this.statements.all.all() as unknown as Row[];
    return { entries: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) };
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
    const wipe = this.writing.then(async () => {
      for (const name of await readdir(this.bodies)) {
        await rm(join(this.bodies, name), { force: true, recursive: true });
      }
    });
    this.writing = wipe.catch(() => {});
    await wipe;
  }

  /** Once every write begun has ended. */
  settled(): Promise<void> {
    return this.writing;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  /** A row dropped, then its file. */
  private remove(key: string): void {
    const gone = this.statements.remove.all(key) as { file: string }[];
    for (const { file } of gone) {
      rmSync(join(this.bodies, file), { force: true });
    }
  }

  /**
   * Responses that can no longer be used dropped, stale without a
   * validator; then, past the budget, the least recently served.
   */
  private evict(): void {
    const files: string[] = [];
    this.db.exec("BEGIN");
    try {
      for (const { file } of this.statements.useless.all(this.now()) as { file: string }[]) {
        files.push(file);
      }

      let total = (this.statements.total.get() as { total: number }).total;
      while (total > this.budget) {
        const oldest = this.statements.oldest.all() as { key: string; size: number }[];
        if (oldest.length === 0) {
          break;
        }

        for (const { key, size } of oldest) {
          if (total <= this.budget) {
            break;
          }

          for (const { file } of this.statements.remove.all(key) as { file: string }[]) {
            files.push(file);
          }

          total -= size;
        }
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    for (const file of files) {
      try {
        unlinkSync(join(this.bodies, file));
      } catch {
        // Gone already.
      }
    }
  }

  /**
   * What a crash or another version left: temporary files and files with
   * no row removed, rows whose file is gone or of another size dropped,
   * and what can no longer be used. Before any write, which waits on it.
   */
  private async sweep(): Promise<void> {
    const names = new Set(readdirSync(this.bodies));
    const rows = this.statements.all.all() as unknown as Row[];
    const known = new Map(rows.map((row) => [row.file, row]));
    for (const name of names) {
      if (TEMPORARY.test(name) || !known.has(name)) {
        await rm(join(this.bodies, name), { force: true, recursive: true });
      }
    }

    for (const row of rows) {
      let size = -1;
      if (names.has(row.file)) {
        try {
          const handle = await open(join(this.bodies, row.file), "r");
          try {
            size = (await handle.stat()).size;
          } finally {
            await handle.close();
          }
        } catch {
          size = -1;
        }
      }

      if (this.closed) {
        return;
      }

      if (size !== row.size) {
        this.remove(row.key);
      }
    }

    this.evict();
  }
}
