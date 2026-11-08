// The files an AIR application in a page writes: all of its file system
// but its own directory, which its package holds (air.ts). They are held
// in memory, kept in the browser's IndexedDB by the application's id where
// the page can keep them, and read back from there when it plays again, as
// an installed application finds its storage. The elements that play one
// application at once share its files.
import type { FileStat } from "@swf2es/player";

interface Node {
  directory: boolean;
  bytes: Uint8Array;
  modified: number;
  created: number;
}

/** A node as IndexedDB keeps it, by its application's id and its path. */
interface Stored extends Node {
  id: string;
  path: string;
}

const DATABASE = "swf2es-air";
const VERSION = 1;
const FILES = "files";
const BY_ID = "id";
const EMPTY = new Uint8Array(0);

/**
 * The file system an application writes, its paths "/"-separated with no
 * leading separator, "" its root. A directory is there once made or once
 * a file is in it.
 */
export class AirFiles {
  readonly #nodes = new Map<string, Node>();
  /** The paths changed since IndexedDB last had them. */
  readonly #dirty = new Set<string>();
  readonly #database: Promise<IDBDatabase | null>;
  readonly #id: string;
  /** The last save, which the next one follows. */
  #saving: Promise<void> = Promise.resolve();
  #scheduled = false;
  /** Resolves once what IndexedDB kept is read, or there is nothing to read. */
  readonly ready: Promise<void>;

  /**
   * The files of the application `id`, with `directories` made: kept in
   * `indexedDB` where given, in memory alone otherwise, read from it once
   * `after` settles.
   */
  constructor(
    id: string,
    directories: readonly string[],
    indexedDB: IDBFactory | null,
    after: Promise<void> = Promise.resolve(),
  ) {
    this.#id = id;
    const now = Date.now();
    for (const directory of directories) {
      for (const path of ancestors(directory)) {
        this.#nodes.set(path, { directory: true, bytes: EMPTY, modified: now, created: now });
      }
    }

    this.#database = indexedDB
      ? after.then(() => open(indexedDB)).catch(() => null)
      : Promise.resolve(null);
    this.ready = this.#database.then(async (db) => {
      if (!db) {
        return;
      }

      try {
        const index = db.transaction(FILES).objectStore(FILES).index(BY_ID);
        for (const stored of await request<Stored[]>(index.getAll(id))) {
          const { directory, bytes, modified, created } = stored;
          this.#nodes.set(stored.path, { directory, bytes, modified, created });
        }
      } catch {
        // What could not be read is not there.
      }
    });
  }

  stat(path: string): FileStat | null {
    if (path === "") {
      return { directory: true, size: 0, modified: 0, created: 0 };
    }

    const node = this.#nodes.get(path);
    return node
      ? {
          directory: node.directory,
          size: node.directory ? 0 : node.bytes.length,
          modified: node.modified,
          created: node.created,
        }
      : null;
  }

  list(path: string): string[] | null {
    if (path !== "" && !this.#nodes.get(path)?.directory) {
      return null;
    }

    const prefix = path === "" ? "" : `${path}/`;
    const names: string[] = [];
    for (const key of this.#nodes.keys()) {
      if (key.startsWith(prefix) && !key.includes("/", prefix.length)) {
        names.push(key.slice(prefix.length));
      }
    }

    return names.sort();
  }

  read(path: string): Uint8Array | null {
    const node = this.#nodes.get(path);
    return node && !node.directory ? node.bytes : null;
  }

  /** FileSystemHost's write: `bytes` at `offset` of the file at `path`, which is then `length` long. */
  write(path: string, bytes: Uint8Array, offset: number, length: number): boolean {
    const node = this.#nodes.get(path);
    if (node?.directory || !this.#makeDirectories(parent(path))) {
      return false;
    }

    // A new array each time: what read gave out, and what IndexedDB is yet to copy, stay as they were.
    const now = Date.now();
    const old = node?.bytes ?? EMPTY;
    const next = new Uint8Array(length);
    next.set(old.subarray(0, Math.min(old.length, length)));
    next.set(bytes.subarray(0, Math.max(0, Math.min(bytes.length, length - offset))), offset);
    this.#nodes.set(path, {
      directory: false,
      bytes: next,
      modified: now,
      created: node?.created ?? now,
    });
    this.#changed(path);
    return true;
  }

  createDirectory(path: string): boolean {
    return this.#makeDirectories(path);
  }

  /** Removes what is at `path`, with all in it. */
  remove(path: string): boolean {
    if (path === "" || !this.#nodes.has(path)) {
      return false;
    }

    for (const key of this.#under(path)) {
      this.#nodes.delete(key);
      this.#changed(key);
    }

    return true;
  }

  /** Moves what is at `from`, with all in it, to `to`, where nothing is. */
  move(from: string, to: string): boolean {
    if (
      from === "" ||
      !this.#nodes.has(from) ||
      this.#nodes.has(to) ||
      to.startsWith(`${from}/`) ||
      !this.#makeDirectories(parent(to))
    ) {
      return false;
    }

    for (const key of this.#under(from)) {
      const moved = to + key.slice(from.length);
      this.#nodes.set(moved, this.#nodes.get(key) as Node);
      this.#nodes.delete(key);
      this.#changed(key);
      this.#changed(moved);
    }

    return true;
  }

  /** Lets go of the database once what was written is saved: resolves then. */
  close(): Promise<void> {
    // After the turn's changes join the saves.
    return new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => this.#saving)
      .then(() => this.#database)
      .then((db) => db?.close());
  }

  /** `path` and what is under it. */
  #under(path: string): string[] {
    const prefix = `${path}/`;
    return [...this.#nodes.keys()].filter((key) => key === path || key.startsWith(prefix));
  }

  /** Makes the directory at `path` and those it is in; false where a file is in the way. */
  #makeDirectories(path: string): boolean {
    const chain = ancestors(path);
    if (chain.some((p) => this.#nodes.get(p)?.directory === false)) {
      return false;
    }

    const now = Date.now();
    for (const p of chain) {
      if (!this.#nodes.has(p)) {
        this.#nodes.set(p, { directory: true, bytes: EMPTY, modified: now, created: now });
        this.#changed(p);
      }
    }

    return true;
  }

  /** Marks `path` for IndexedDB, which gets the changes of a turn together. */
  #changed(path: string): void {
    this.#dirty.add(path);
    if (this.#scheduled) {
      return;
    }

    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      const paths = [...this.#dirty];
      this.#dirty.clear();
      this.#saving = this.#saving.then(() => this.#save(paths));
    }, 0);
  }

  async #save(paths: string[]): Promise<void> {
    const db = await this.#database;
    if (!db) {
      return;
    }

    try {
      const tx = db.transaction(FILES, "readwrite");
      const store = tx.objectStore(FILES);
      for (const path of paths) {
        const node = this.#nodes.get(path);
        if (node) {
          store.put({ id: this.#id, path, ...node } satisfies Stored);
        } else {
          store.delete([this.#id, path]);
        }
      }

      await done(tx);
    } catch (e) {
      // A quota, say: the files are still in memory while the page plays.
      console.warn(`swf2es: the AIR application's files could not be kept: ${e}`);
    }
  }
}

/** Shared files by application id, with how many elements play each. */
const shared = new Map<string, { files: AirFiles; users: number }>();
/** By application id, the last files let go of, until what they wrote is saved. */
const closing = new Map<string, Promise<void>>();

/**
 * The files of the application `id` for an element to play it with, with
 * `directories` made: shared with other elements playing it, and kept in
 * IndexedDB, unless `keep` is false, when they are the element's own, in
 * memory alone. `release` when the element is done with them.
 */
export function airFiles(
  id: string,
  directories: readonly string[],
  keep: boolean,
): { files: AirFiles; release(): void } {
  const indexedDB = keep ? (globalThis.indexedDB ?? null) : null;
  if (!indexedDB) {
    return { files: new AirFiles(id, directories, null), release: () => {} };
  }

  let entry = shared.get(id);
  if (!entry) {
    entry = { files: new AirFiles(id, directories, indexedDB, closing.get(id)), users: 0 };
    shared.set(id, entry);
  }

  entry.users++;
  const held = entry;
  let released = false;
  return {
    files: held.files,
    release: () => {
      if (released) {
        return;
      }

      released = true;
      held.users--;
      if (held.users === 0 && shared.get(id) === held) {
        shared.delete(id);
        const closed = held.files.close();
        closing.set(id, closed);
        void closed.then(() => {
          if (closing.get(id) === closed) {
            closing.delete(id);
          }
        });
      }
    },
  };
}

/** `path` and the directories it is in, outermost first; none for the root. */
function ancestors(path: string): string[] {
  if (path === "") {
    return [];
  }

  const segments = path.split("/");
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/** The directory `path` is in; "" for one in the root. */
function parent(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Another tab holding an older version open blocks it: done without.
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new Error(`IndexedDB ${DATABASE} did not open`));
    }, 2000);
    const opening = factory.open(DATABASE, VERSION);
    opening.onupgradeneeded = () => {
      opening.result
        .createObjectStore(FILES, { keyPath: ["id", "path"] })
        .createIndex(BY_ID, BY_ID);
    };
    opening.onsuccess = () => {
      clearTimeout(timer);
      if (late) {
        opening.result.close();
      } else {
        resolve(opening.result);
      }
    };
    opening.onerror = () => {
      clearTimeout(timer);
      reject(opening.error);
    };
  });
}

function request<T>(r: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
