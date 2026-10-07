// A ModuleCache in the browser's IndexedDB: the modules the compiler wrote
// for a page's SWFs, kept for its next load. A large application's module
// took 250 ms to compile and 10 ms to read back (see docs/architecture.md,
// Caching modules). Anything that fails, a database that will not open, a
// quota, a store that is gone, makes a miss, and the player compiles.
import { type ModuleCache, sha256 } from "@swf2es/player";

export interface IndexedDbModuleCacheOptions {
  /** The compiler's identity, as compilerIdentity gives it for codegen.wasm's bytes. */
  compiler: string;
  /** The database's name. */
  name?: string;
  /** About how many bytes the modules may take, as UTF-16; the least recently used go first. */
  maxBytes?: number;
  /** The IndexedDB to use: the global one by default. */
  indexedDB?: IDBFactory;
  /** How long to wait for the database to open, in ms, before doing without it. */
  openTimeout?: number;
}

/** The identity of the compiler whose codegen.wasm has these bytes, for IndexedDbModuleCacheOptions. */
export function compilerIdentity(wasm: Uint8Array): Promise<string> {
  return sha256(wasm);
}

const MODULES = "modules";
/** Each module's size and last use, apart from it, so that evicting reads no module. */
const ENTRIES = "entries";
const USED = "used";

interface Entry {
  key: string;
  bytes: number;
  used: number;
}

/**
 * A ModuleCache kept in IndexedDB, opened on its first use. A get marks its
 * module used; a put evicts the least recently used until the modules fit
 * in `maxBytes`, and stores nothing larger than that, once the page is
 * idle: a large module's write that a load's next get waited behind took
 * that get from 4 to 45 ms.
 */
export function indexedDbModuleCache(options: IndexedDbModuleCacheOptions): ModuleCache {
  const {
    compiler,
    name = "swf2es-modules",
    maxBytes = 256 * 1024 * 1024,
    openTimeout = 2000,
  } = options;
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => {
    opened ??= open(options.indexedDB ?? globalThis.indexedDB, name, openTimeout);
    return opened;
  };

  return {
    compiler,
    async get(key) {
      const db = await database();
      const module = await request<unknown>(db.transaction(MODULES).objectStore(MODULES).get(key));
      if (typeof module !== "string") {
        return undefined;
      }

      // Marked used apart, in a store no get reads, so that gets need not wait.
      const entries = db.transaction(ENTRIES, "readwrite").objectStore(ENTRIES);
      const entry = await request<Entry | undefined>(entries.get(key));
      if (entry) {
        entries.put({ ...entry, used: Date.now() });
      }

      return module;
    },
    async put(key, module) {
      const bytes = module.length * 2;
      if (bytes > maxBytes) {
        return;
      }

      const db = await database();
      await new Promise<void>((resolve) => idle(resolve));
      const tx = db.transaction([MODULES, ENTRIES], "readwrite");
      const modules = tx.objectStore(MODULES);
      const entries = tx.objectStore(ENTRIES);
      modules.put(module, key);
      entries.put({ key, bytes, used: Date.now() } as Entry);
      // Oldest first, the one just put among them.
      const all = await request<Entry[]>(entries.index(USED).getAll());
      let total = 0;
      for (const entry of all) {
        total += entry.bytes;
      }

      for (const entry of all) {
        if (total <= maxBytes) {
          break;
        }

        if (entry.key !== key) {
          modules.delete(entry.key);
          entries.delete(entry.key);
          total -= entry.bytes;
        }
      }

      await done(tx);
    },
  };
}

/** Run `f` when the page is next idle, or within a second; soon, where there is no requestIdleCallback. */
function idle(f: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => f(), { timeout: 1000 });
  } else {
    setTimeout(f, 0);
  }
}

/** The database, made if new; rejected if it does not open within `timeout` ms, as when another tab blocks an upgrade. */
function open(factory: IDBFactory, name: string, timeout: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`IndexedDB ${name} did not open`)), timeout);
    const opening = factory.open(name, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore(MODULES);
      db.createObjectStore(ENTRIES, { keyPath: "key" }).createIndex(USED, USED);
    };
    opening.onsuccess = () => {
      clearTimeout(timer);
      const db = opening.result;
      // A later version elsewhere, as a newer player's in another tab, waits for none of ours.
      db.onversionchange = () => db.close();
      resolve(db);
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

/** Resolves once `tx` has committed; rejects if it aborts, a quota exceeded say. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
