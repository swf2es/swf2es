// An AIR application's EncryptedLocalStore in a page: its items held in
// memory and kept in the browser's IndexedDB by the application's id, read
// back before it plays again, as an installed application finds its items.
// A page has no keychain to encrypt them by: the browser keeps them as it
// keeps the origin's other data, apart from other sites'. The elements that
// play one application share its items.
import type { EncryptedStoreHost } from "@swf2es/player";

const DATABASE = "swf2es-air-items";
const VERSION = 1;
const ITEMS = "items";
const BY_ID = "id";

/** An item as IndexedDB keeps it, by its application's id and its name. */
interface Stored {
  id: string;
  name: string;
  bytes: Uint8Array;
}

/** The items of one application; `ready` once what IndexedDB kept is read. */
export class AirItems implements EncryptedStoreHost {
  readonly #items = new Map<string, Uint8Array>();
  /** The names changed since IndexedDB last had them. */
  readonly #dirty = new Set<string>();
  readonly #database: Promise<IDBDatabase | null>;
  readonly #id: string;
  #saving: Promise<void> = Promise.resolve();
  #scheduled = false;
  readonly ready: Promise<void>;

  /**
   * The items of the application `id`, kept in `indexedDB` where given, in
   * memory alone otherwise, read from it once `after` settles.
   */
  constructor(id: string, indexedDB: IDBFactory | null, after: Promise<void> = Promise.resolve()) {
    this.#id = id;
    this.#database = indexedDB
      ? after.then(() => open(indexedDB)).catch(() => null)
      : Promise.resolve(null);
    this.ready = this.#database.then(async (db) => {
      if (!db) {
        return;
      }

      try {
        const index = db.transaction(ITEMS).objectStore(ITEMS).index(BY_ID);
        for (const stored of await request<Stored[]>(index.getAll(id))) {
          this.#items.set(stored.name, stored.bytes);
        }
      } catch {
        // What could not be read is not there.
      }
    });
  }

  getItem(name: string): Uint8Array | null {
    return this.#items.get(name) ?? null;
  }

  setItem(name: string, bytes: Uint8Array): void {
    this.#items.set(name, bytes.slice());
    this.#changed(name);
  }

  removeItem(name: string): void {
    if (this.#items.delete(name)) {
      this.#changed(name);
    }
  }

  reset(): void {
    for (const name of this.#items.keys()) {
      this.#changed(name);
    }

    this.#items.clear();
  }

  /** Lets go of the database once what was changed is saved: resolves then. */
  close(): Promise<void> {
    // After the turn's changes join the saves.
    return new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => this.#saving)
      .then(() => this.#database)
      .then((db) => db?.close());
  }

  /** Marks `name` for IndexedDB, which gets the changes of a turn together. */
  #changed(name: string): void {
    this.#dirty.add(name);
    if (this.#scheduled) {
      return;
    }

    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      const names = [...this.#dirty];
      this.#dirty.clear();
      this.#saving = this.#saving.then(() => this.#save(names));
    }, 0);
  }

  async #save(names: string[]): Promise<void> {
    const db = await this.#database;
    if (!db) {
      return;
    }

    try {
      const tx = db.transaction(ITEMS, "readwrite");
      const store = tx.objectStore(ITEMS);
      for (const name of names) {
        const bytes = this.#items.get(name);
        if (bytes) {
          store.put({ id: this.#id, name, bytes } satisfies Stored);
        } else {
          store.delete([this.#id, name]);
        }
      }

      await done(tx);
    } catch (e) {
      // A quota, say: the items are still in memory while the page plays.
      console.warn(`swf2es: the AIR application's EncryptedLocalStore could not be kept: ${e}`);
    }
  }
}

/** Each application's items, by its id, with how many elements play it. */
const shared = new Map<string, { items: AirItems; users: number }>();
/** By application id, the last items let go of, until what they changed is saved. */
const closing = new Map<string, Promise<void>>();

/**
 * The items of the application `id` for an element to play it with,
 * shared with other elements playing it, kept in IndexedDB where the page
 * has it; `release` when the element is done with them. One that plays it
 * next waits for the last to save.
 */
export function airItems(id: string): { items: AirItems; release(): void } {
  let entry = shared.get(id);
  if (!entry) {
    entry = { items: new AirItems(id, globalThis.indexedDB ?? null, closing.get(id)), users: 0 };
    shared.set(id, entry);
  }

  entry.users++;
  const held = entry;
  let released = false;
  return {
    items: held.items,
    release: () => {
      if (released) {
        return;
      }

      released = true;
      held.users--;
      if (held.users === 0 && shared.get(id) === held) {
        shared.delete(id);
        const closed = held.items.close();
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
        .createObjectStore(ITEMS, { keyPath: ["id", "name"] })
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
