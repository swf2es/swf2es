// Flash Player's plug-in as navigator lists it, for old pages' scripts
// that look for one before they write a Flash tag (swfobject, Adobe's
// detection kit): without it they write "Flash Player required" in the
// tag's place, and replaceFlash finds nothing to swap. One plug-in,
// "Shockwave Flash" of the version Capabilities.version reports, with its
// two MIME types; the browser's own entries stay listed as they were.
//
// No ActiveXObject, though some scripts try it: old scripts take a page
// that has one for Internet Explorer, and use its XML and DOM paths for
// everything else too. Every detection script asks navigator first.
//
// This file imports nothing, so that the browser build's classic script
// (packages/swf2es/src/plugin.ts) installs it alone, before a page's
// scripts run.

const NAME = "Shockwave Flash";
/** Capabilities.version's numbers (platformCapabilities in @swf2es/player): 32,0,0,465. */
const VERSION = [32, 0, 0, 465];
/** As Flash's plug-in described itself: major.minor and the revision, not the build. */
const DESCRIPTION = `${NAME} ${VERSION[0]}.${VERSION[1]} r${VERSION[2]}`;
/** Flash's plug-in's MIME types, in its order. */
const MIME_TYPES = [
  ["application/x-shockwave-flash", "Shockwave Flash", "swf"],
  ["application/futuresplash", "FutureSplash Player", "spl"],
];

interface Listing<T> {
  readonly length: number;
  item(index: number): T | null;
  namedItem(name: string): T | null;
  [index: number]: T;
}

/** Read-only and left out of enumeration, as the browser's names and members. */
const hidden = (value: unknown): PropertyDescriptor => ({ value, configurable: true });

/**
 * An object of `proto`'s class listing `entries` as the browser's
 * PluginArray, MimeTypeArray and Plugin do: by index, enumerable, and by
 * name, not, with `length`, `item`, `namedItem` and iteration of its own,
 * as the class's own would throw on an object the browser did not make.
 */
function listing<T extends object>(
  proto: object | null,
  entries: T[],
  nameOf: (entry: T) => string,
  more: PropertyDescriptorMap = {},
): Listing<T> {
  const list = Object.create(proto);
  for (let i = 0; i < entries.length; i++) {
    Object.defineProperty(list, i, { value: entries[i], enumerable: true, configurable: true });
  }

  for (const entry of entries) {
    const name = nameOf(entry);
    if (!Object.hasOwn(list, name)) {
      Object.defineProperty(list, name, hidden(entry));
    }
  }

  Object.defineProperties(list, {
    length: { get: () => entries.length, configurable: true },
    // The index as the browser's, an unsigned 32-bit integer.
    item: hidden((index: number) => entries[index >>> 0] ?? null),
    namedItem: hidden(
      (name: string) => entries.find((entry) => nameOf(entry) === String(name)) ?? null,
    ),
    [Symbol.iterator]: hidden(() => entries.values()),
    ...more,
  });
  return list;
}

/** A listing's entries, by `item`, which every browser's has. */
function entriesOf<T>(list: Listing<T>): T[] {
  const entries: T[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list.item(i);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

const prototypeOf = (name: string): object =>
  (globalThis as unknown as Record<string, { prototype?: object } | undefined>)[name]?.prototype ??
  Object.prototype;

/**
 * Lists `added` after the entries of navigator's `key`: a listing of both
 * in its place, or, where navigator will not take one, `added` defined on
 * the browser's listing itself by name, and in its `length`, `item` and
 * iteration only where it takes them by index too, which Chrome's and
 * Firefox's do not: a loop to `length` would read past what it indexes.
 */
function extend<T extends object>(
  navigator: Navigator,
  key: "plugins" | "mimeTypes",
  added: T[],
  nameOf: (entry: T) => string,
  more: (own: Listing<T>) => PropertyDescriptorMap,
) {
  const own = navigator[key] as unknown as Listing<T>;
  const entries = [...entriesOf(own), ...added];

  try {
    Object.defineProperty(navigator, key, {
      value: listing(Object.getPrototypeOf(own), entries, nameOf, more(own)),
      configurable: true,
      enumerable: true,
    });
    return;
  } catch {
    // Not configurable, or navigator not extensible: the listing it has, then.
  }

  try {
    const first = own.length;
    let indexed = true;
    for (let i = 0; i < added.length; i++) {
      try {
        Object.defineProperty(own, first + i, { value: added[i], configurable: true });
      } catch {
        indexed = false;
      }

      Object.defineProperty(own, nameOf(added[i] as T), hidden(added[i]));
    }

    const { item, namedItem } = own;
    Object.defineProperty(
      own,
      "namedItem",
      hidden(
        (name: string) =>
          namedItem.call(own, name) ??
          added.find((entry) => nameOf(entry) === String(name)) ??
          null,
      ),
    );
    if (indexed) {
      Object.defineProperties(own, {
        length: { get: () => entries.length, configurable: true },
        item: hidden((index: number) =>
          index >>> 0 < first ? item.call(own, index) : (entries[index >>> 0] ?? null),
        ),
        [Symbol.iterator]: hidden(() => entries.values()),
      });
    }
  } catch {
    // A frozen listing: nothing to be done.
  }
}

/**
 * Lists Flash Player's plug-in, "Shockwave Flash 32.0 r0", in
 * `navigator.plugins` and its MIME types in `navigator.mimeTypes`, after
 * the browser's own, for scripts that look for Flash before they embed a
 * SWF. watchFlash calls it, and replaceFlash when asked; the browser
 * build's `dist/plugin.js` does as it loads, for a page's scripts that run
 * before a module. Once a page: where a Flash plug-in is listed already,
 * this does nothing, and where navigator is not a browser's, it throws
 * nothing.
 */
export function installFlashPlugin(): void {
  try {
    install();
  } catch {
    // A navigator of a test's or a server's DOM, without the browser's listings' members.
  }
}

function install(): void {
  const navigator = globalThis.navigator as Navigator | undefined;
  if (!navigator?.plugins || !navigator.mimeTypes || navigator.plugins.namedItem(NAME)) {
    return;
  }

  const mimePrototype = prototypeOf("MimeType");
  const mimeTypes: MimeType[] = MIME_TYPES.map(([type, description, suffixes]) =>
    Object.create(mimePrototype, {
      type: hidden(type),
      description: hidden(description),
      suffixes: hidden(suffixes),
      enabledPlugin: { get: () => plugin, configurable: true },
    }),
  );
  const plugin = listing(prototypeOf("Plugin"), mimeTypes, (mime) => mime.type, {
    name: hidden(NAME),
    description: hidden(DESCRIPTION),
    filename: hidden("swf2es.js"),
  }) as unknown as Plugin;

  extend(
    navigator,
    "plugins",
    [plugin],
    (entry) => entry.name,
    (own): PropertyDescriptorMap => {
      // The browser's own, as it was.
      const refresh = (own as unknown as PluginArray).refresh;
      return typeof refresh === "function" ? { refresh: hidden(refresh.bind(own)) } : {};
    },
  );
  extend(
    navigator,
    "mimeTypes",
    mimeTypes,
    (entry) => entry.type,
    () => ({}),
  );
}
