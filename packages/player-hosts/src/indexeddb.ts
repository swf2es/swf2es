// A ModuleCache in the browser's IndexedDB: the modules the compiler wrote
// for a page's SWFs, kept for its next load. A large application's module
// took 250 ms to compile and 10 ms to read back (see docs/architecture.md,
// Caching modules). Anything that fails, a database that will not open, a
// quota, a store that is gone, makes a miss, and the player compiles.
import type { CachedModule, ModuleCache } from "@swf2es/player";

export interface IndexedDbModuleCacheOptions {
  /** The database's name. */
  name?: string;
  /** About how many bytes the modules may take, as UTF-16; the least recently used go first. */
  maxBytes?: number;
  /** The IndexedDB to use: the global one by default. */
  indexedDB?: IDBFactory;
  /** How long to wait for the database to open, in ms, before doing without it. */
  openTimeout?: number;
  /** How long, in ms, to do without a database that did not open before trying again. */
  retryAfter?: number;
}

/** A ModuleCache that a host can close, letting go of its database. */
export interface IndexedDbModuleCache extends ModuleCache {
  /** Close the database; a later get or put opens it again. */
  close(): void;
}

/** The database's version: 2 kept each module with its compile's log, 3 with their lengths too. */
const VERSION = 3;
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
export function indexedDbModuleCache(
  options: IndexedDbModuleCacheOptions = {},
): IndexedDbModuleCache {
  const {
    name = "swf2es-modules",
    maxBytes = 256 * 1024 * 1024,
    openTimeout = 2000,
    retryAfter = 30_000,
  } = options;
  let opened: Promise<IDBDatabase> | null = null;
  // When a database that did not open may be tried again.
  let retryAt = 0;
  const database = () => {
    if (opened === null || (retryAt !== 0 && Date.now() >= retryAt)) {
      retryAt = 0;
      const attempt = open(options.indexedDB ?? globalThis.indexedDB, name, openTimeout);
      opened = attempt;
      attempt.then(
        (db) => {
          // Another tab opening a later version: let go, and open again
          // next time, unless this was let go of already for another.
          db.onversionchange = () => {
            db.close();
            if (opened === attempt) {
              opened = null;
            }
          };
        },
        () => {
          if (opened === attempt) {
            retryAt = Date.now() + retryAfter;
          }
        },
      );
    }

    return opened;
  };

  return {
    async get(key) {
      const db = await database();
      const stored = await request<unknown>(db.transaction(MODULES).objectStore(MODULES).get(key));
      const module = stored as CachedModule | undefined;
      if (
        typeof module?.module !== "string" ||
        typeof module.log !== "string" ||
        !Array.isArray(module.lengths)
      ) {
        return undefined;
      }

      // Marked used apart, in a store no get reads, so that gets need not
      // wait; a mark that fails leaves the module as read.
      try {
        const entries = db.transaction(ENTRIES, "readwrite").objectStore(ENTRIES);
        const entry = await request<Entry | undefined>(entries.get(key));
        if (entry) {
          entries.put({ ...entry, used: Date.now() });
        }
      } catch {
        // Its last use stays as it was.
      }

      return {
        module: module.module,
        log: module.log,
        lengths: [...module.lengths] as [number, number],
      };
    },
    async put(key, module) {
      const bytes = (module.module.length + module.log.length) * 2;
      if (bytes > maxBytes) {
        return;
      }

      const db = await database();
      await new Promise<void>((resolve) => idle(resolve));
      const tx = db.transaction([MODULES, ENTRIES], "readwrite");
      const modules = tx.objectStore(MODULES);
      const entries = tx.objectStore(ENTRIES);
      modules.put({ module: module.module, log: module.log, lengths: module.lengths }, key);
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
    async delete(key) {
      const tx = (await database()).transaction([MODULES, ENTRIES], "readwrite");
      tx.objectStore(MODULES).delete(key);
      tx.objectStore(ENTRIES).delete(key);
      await done(tx);
    },
    close() {
      const was = opened;
      opened = null;
      was?.then((db) => db.close()).catch(() => {});
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
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new Error(`IndexedDB ${name} did not open`));
    }, timeout);
    const opening = factory.open(name, VERSION);
    opening.onupgradeneeded = () => {
      // An older version's modules are another format's: dropped.
      const db = opening.result;
      for (const store of [...db.objectStoreNames]) {
        db.deleteObjectStore(store);
      }

      db.createObjectStore(MODULES);
      db.createObjectStore(ENTRIES, { keyPath: "key" }).createIndex(USED, USED);
    };
    opening.onsuccess = () => {
      clearTimeout(timer);
      // Given up on already, it is closed.
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

/** Resolves once `tx` has committed; rejects if it aborts, a quota exceeded say. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
