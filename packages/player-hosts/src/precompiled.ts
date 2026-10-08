// A ModuleCache of the modules the swf2es command compiled ahead of time,
// read-only: each found by the key the command wrote beside it, which is
// the one the player asks for when the SWF loads in the position the
// command compiled it for, with its log, which the player replays as it
// does a cached module's. A key the manifest lacks, as one taken by
// another compiler, whose identity keys name, is a miss, and the player
// compiles (see docs/architecture.md, Caching modules).
import type { CachedModule, ModuleCache } from "@swf2es/player";

export interface PrecompiledModulesOptions {
  /** A file the manifest names, or the manifest, read by its URL: fetched by default. */
  read?: (url: URL) => Promise<string>;
  /**
   * Have the player import each module from its URL, as an ES module, not
   * evaluate its text: for a page whose Content-Security-Policy refuses
   * 'unsafe-eval'. The document then keeps the modules for as long as it
   * lives.
   */
  importModules?: boolean;
}

/** The manifest's format this reads, the command's MANIFEST_VERSION: any other names no module. */
const MANIFEST_VERSION = 2;

interface Entry {
  module: URL;
  log: URL;
  lengths: [number, number];
}

/**
 * The modules of the manifest.json at `manifest` (a URL, resolved against
 * the page's), and the logs beside them. The manifest is read at the first
 * get, and again at the next if that failed. Asks for every module however
 * small, so that with each precompiled none compiles.
 */
export function precompiledModules(
  manifest: string | URL,
  options: PrecompiledModulesOptions = {},
): ModuleCache {
  const base = new URL(manifest, globalThis.location?.href);
  const read = options.read ?? fetchText;
  let entries: Promise<Map<string, Entry>> | null = null;
  const rejected = new Set<string>();
  const load = async () => {
    const parsed = JSON.parse(await read(base));
    const map = new Map<string, Entry>();
    if (parsed?.manifestVersion !== MANIFEST_VERSION) {
      return map;
    }

    for (const e of [parsed.libraries, parsed.abcs].flat()) {
      const { key, module, log, lengths } = e ?? {};
      if (
        typeof key === "string" &&
        typeof module === "string" &&
        typeof log === "string" &&
        Array.isArray(lengths) &&
        lengths.length === 2
      ) {
        map.set(key, {
          module: new URL(module, base),
          log: new URL(log, base),
          lengths: [...lengths] as [number, number],
        });
      }
    }

    return map;
  };

  return {
    minBytes: 0,
    async get(key: string): Promise<CachedModule | undefined> {
      if (rejected.has(key)) {
        return undefined;
      }

      entries ??= load();
      let found: Entry | undefined;
      try {
        found = (await entries).get(key);
      } catch (e) {
        entries = null;
        throw e;
      }

      if (!found) {
        return undefined;
      }

      // Each file by a URL of its key: a module or log of another build,
      // which an HTTP cache may hold under the same name, is never this
      // key's, and an imported module's length is not checked.
      const { lengths } = found;
      const [module, log] = [found.module, found.log].map((url) => {
        const keyed = new URL(url);
        keyed.search = key;
        return keyed;
      });
      if (options.importModules) {
        return { module: "", log: await read(log), lengths, url: module.href };
      }

      const [text, logText] = await Promise.all([read(module), read(log)]);
      return { module: text, log: logText, lengths };
    },
    async put() {},
    // Its files cannot be deleted; the key is not answered again on this page.
    async delete(key) {
      rejected.add(key);
    },
  };
}

async function fetchText(url: URL): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }

  return response.text();
}

/**
 * Caches asked in order, the first that holds a module answering, as the
 * modules compiled ahead of time and then an IndexedDB cache: a module
 * compiled goes to each. A deletion naming the entry the player could not
 * use goes only to the member that gave that entry, which then answers
 * the key no more, so that the player, which asks again once, reads the
 * next one's; one naming none goes to each. One that fails is passed
 * over. Asks for the ABCs the member that asks for the smallest does,
 * every member then asked for them.
 */
export function chainCaches(...caches: ModuleCache[]): ModuleCache {
  const sizes = caches.flatMap((c) => (c.minBytes === undefined ? [] : [c.minBytes]));
  // By the entry, not the key: two reads of one key may have been answered by two members.
  const answered = new WeakMap<CachedModule, ModuleCache>();
  // A member that throws at the call skips none of the others.
  const each = async (members: ModuleCache[], f: (cache: ModuleCache) => Promise<void>) => {
    await Promise.allSettled(members.map((c) => Promise.resolve().then(() => f(c))));
  };
  return {
    ...(sizes.length ? { minBytes: Math.min(...sizes) } : {}),
    async get(key) {
      for (const cache of caches) {
        try {
          const entry = await cache.get(key);
          if (entry !== undefined) {
            answered.set(entry, cache);
            return entry;
          }
        } catch {
          // The next may hold it.
        }
      }

      return undefined;
    },
    put: (key, entry) => each(caches, (c) => c.put(key, entry)),
    delete: (key, entry) => {
      const from = entry && answered.get(entry);
      return each(from ? [from] : caches, (c) => c.delete(key, entry));
    },
  };
}
