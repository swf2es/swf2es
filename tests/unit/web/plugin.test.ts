import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { platformCapabilities } from "../../../packages/player/dist/hosts.js";
import { installFlashPlugin } from "../../../packages/web/dist/plugin.js";

interface Entry {
  name?: string;
  type?: string;
}

/** A browser's listing, as Chrome's PluginArray and MimeTypeArray: by index, by name, item and namedItem. */
class Listing {
  declare readonly entries: Entry[];
  refreshed = 0;
  [key: string]: unknown;

  constructor(entries: Entry[]) {
    Object.defineProperty(this, "entries", { value: entries });
    entries.forEach((entry, i) => {
      this[i] = entry;
      Object.defineProperty(this, (entry.name ?? entry.type) as string, { value: entry });
    });
  }

  get length() {
    return this.entries.length;
  }

  item(index: number) {
    return this.entries[index] ?? null;
  }

  namedItem(name: string) {
    return this.entries.find((entry) => (entry.name ?? entry.type) === name) ?? null;
  }

  refresh() {
    this.refreshed++;
  }

  [Symbol.iterator]() {
    return this.entries.values();
  }
}

/** `listing` refusing an index past its own, as Chrome's and Firefox's do. */
const refusingIndices = (listing: Listing): Listing =>
  new Proxy(listing, {
    defineProperty: (target, key, descriptor) =>
      typeof key === "string" && /^\d+$/.test(key)
        ? false
        : Reflect.defineProperty(target, key, descriptor),
  });

type Listed = Listing & { [index: number]: Entry & Record<string, unknown> };

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  if (original) {
    Object.defineProperty(globalThis, "navigator", original);
  }
});

/**
 * A navigator listing a PDF viewer, as Chrome's, its listings pinned as a browser's may be, and
 * refusing indices past their own as a browser's do.
 */
function fakeNavigator(pinned = false, refusing = false) {
  const pdf: Entry = { name: "PDF Viewer" };
  const navigator = {} as { plugins: Listed; mimeTypes: Listed };
  for (const [key, listing] of [
    ["plugins", new Listing([pdf])],
    ["mimeTypes", new Listing([{ type: "application/pdf" }])],
  ] as const) {
    Object.defineProperty(navigator, key, {
      value: refusing ? refusingIndices(listing) : listing,
      configurable: !pinned,
    });
  }

  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true });
  return { navigator, pdf };
}

test("Flash's plug-in is listed after the browser's, of the version Capabilities reports", () => {
  const { navigator, pdf } = fakeNavigator();
  const plugins = navigator.plugins;
  installFlashPlugin();

  const listed = navigator.plugins;
  assert.notEqual(listed, plugins);
  assert.equal(listed.length, 2);
  assert.equal(listed[0], pdf);
  assert.equal(listed["PDF Viewer"], pdf);
  const flash = listed.namedItem("Shockwave Flash") as unknown as Listed & Record<string, unknown>;
  assert.equal(listed[1], flash);
  assert.equal(listed.item(1), flash);
  assert.equal(listed.item(2 ** 32 + 1), flash);
  assert.equal(listed.item(2), null);
  assert.equal(listed.namedItem("Java"), null);
  assert.equal(listed["Shockwave Flash"], flash);
  assert.deepEqual(
    [...(listed as unknown as Iterable<Entry>)].map((p) => p.name),
    ["PDF Viewer", "Shockwave Flash"],
  );
  assert.deepEqual(Object.keys(listed), ["0", "1"]);
  listed.refresh();
  assert.equal(plugins.refreshed, 1);

  // "LNX 32,0,0,465": 32.0, revision 0.
  const [major, minor, revision] = platformCapabilities().version.split(" ")[1].split(",");
  assert.equal(flash.description, `Shockwave Flash ${major}.${minor} r${revision}`);
  assert.equal(flash.name, "Shockwave Flash");
  assert.deepEqual(
    [...(flash as unknown as Iterable<Record<string, unknown>>)].map((m) => [
      m.type,
      m.suffixes,
      m.enabledPlugin === flash,
    ]),
    [
      ["application/x-shockwave-flash", "swf", true],
      ["application/futuresplash", "spl", true],
    ],
  );
  const mimeTypes = navigator.mimeTypes;
  assert.equal(mimeTypes.length, 3);
  assert.equal(mimeTypes[0].type, "application/pdf");
  assert.equal(mimeTypes["application/x-shockwave-flash"], flash[0]);
  assert.equal(mimeTypes.namedItem("application/futuresplash"), flash[1]);

  installFlashPlugin();
  assert.equal(navigator.plugins, listed, "installed twice");
});

test("where navigator's listings cannot be replaced, Flash is listed on them by index too", () => {
  const { navigator, pdf } = fakeNavigator(true);
  const plugins = navigator.plugins;
  installFlashPlugin();

  assert.equal(navigator.plugins, plugins);
  assert.equal(plugins.length, 2);
  const flash = plugins.namedItem("Shockwave Flash");
  assert.equal(plugins["Shockwave Flash"], flash);
  assert.equal(plugins.item(0), pdf);
  assert.equal(plugins.item(1), flash);
  assert.equal(plugins.namedItem("PDF Viewer"), pdf);
  assert.deepEqual(
    [...(plugins as unknown as Iterable<Entry>)].map((p) => p.name),
    ["PDF Viewer", "Shockwave Flash"],
  );
  assert.equal(navigator.mimeTypes.length, 3);
  assert.equal(
    (navigator.mimeTypes["application/x-shockwave-flash"] as Record<string, unknown>).enabledPlugin,
    flash,
  );
});

test("on a browser's listings that take no index past their own, Flash is listed by name", () => {
  const { navigator, pdf } = fakeNavigator(true, true);
  const plugins = navigator.plugins;
  installFlashPlugin();

  assert.equal(navigator.plugins, plugins);
  // A loop to length reads only what is there.
  assert.equal(plugins.length, 1);
  assert.equal(plugins[plugins.length - 1], pdf);
  assert.equal(plugins.item(1), null);
  assert.deepEqual(
    [...(plugins as unknown as Iterable<Entry>)].map((p) => p.name),
    ["PDF Viewer"],
  );
  const flash = plugins.namedItem("Shockwave Flash") as Entry & Record<string, unknown>;
  assert.equal(flash.description, "Shockwave Flash 32.0 r0");
  assert.equal(plugins["Shockwave Flash"], flash);
  assert.equal(plugins.namedItem("PDF Viewer"), pdf);
  const mimeTypes = navigator.mimeTypes;
  assert.equal(mimeTypes.length, 1);
  assert.equal(
    (mimeTypes.namedItem("application/x-shockwave-flash") as Record<string, unknown>).enabledPlugin,
    flash,
  );
  assert.equal(
    mimeTypes["application/futuresplash"],
    mimeTypes.namedItem("application/futuresplash"),
  );
});

test("without a browser's navigator, nothing is listed and nothing throws", () => {
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  installFlashPlugin();
  assert.deepEqual(Object.keys(globalThis.navigator), []);

  // A test DOM's listings, without namedItem or item.
  const shim = { plugins: { length: 0 }, mimeTypes: { length: 0 } };
  Object.defineProperty(globalThis, "navigator", { value: shim, configurable: true });
  installFlashPlugin();
  assert.deepEqual(shim, { plugins: { length: 0 }, mimeTypes: { length: 0 } });
});
