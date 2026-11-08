// An AIR application a page plays: its files held in memory, from an AIR
// package (`.air`), a ZIP of its folder, or the files of one the page was
// given. Its descriptor names the content SWF the element plays, as adl
// does, under AIR's API and its application sandbox. File sees the files
// under the application's directory, which it does not write, as an
// installed application's; the rest of the file system, its storage and
// the user's directories among them, is what it writes (air-files.ts).
// app:, app-storage: and file: URLs load from memory, and any other goes
// to the network as the page's would.
import {
  type AirDescriptor,
  abcReferences,
  readAirDescriptor,
  readDoAbc,
  readZip,
  type Swf,
  tags,
} from "@swf2es/format";
import {
  AIR_DEFINITIONS,
  type AirApplication,
  type AirWindow,
  type FetchRequest,
  type FetchResult,
  type FileStat,
  type FileSystemHost,
} from "@swf2es/player";
import { AirFiles } from "./air-files.js";

/** One of an application's files, its path relative to the folder it came in, "/"-separated. */
export interface AirAppFile {
  path: string;
  bytes: Uint8Array;
  /** When it was last changed, in ms since 1970; when it was opened if not given. */
  modified?: number;
}

/** Where AIR's directories are on the file system File sees. */
const DIRECTORIES = {
  application: "/app",
  applicationStorage: "/app-storage",
  user: "/user",
  documents: "/user/Documents",
  desktop: "/user/Desktop",
  cache: "/cache",
};

/** AIR's directories but the application's, there before it writes, as paths from the root. */
export const AIR_DIRECTORIES: readonly string[] = [
  DIRECTORIES.applicationStorage,
  DIRECTORIES.documents,
  DIRECTORIES.desktop,
  DIRECTORIES.cache,
].map((d) => d.slice(1));

/** Where an AIR package keeps its descriptor; its root is the application's directory. */
const PACKAGE_DESCRIPTOR = "META-INF/AIR/application.xml";

/** Where the application's directory and its storage are, as paths from the root. */
const ROOT_APP = DIRECTORIES.application.slice(1);
const ROOT_STORAGE = DIRECTORIES.applicationStorage.slice(1);

interface Entry {
  size: number;
  modified: number;
  bytes(): Uint8Array;
}

/** An AIR application opened from its files; `Swf2esPlayerElement.loadAir` plays it. */
export class AirApp {
  /** The descriptor as written, which NativeApplication.applicationDescriptor gives. */
  readonly xml: string;
  readonly descriptor: AirDescriptor;
  /** The application's files, by their path under its directory. */
  readonly #files: Map<string, Entry>;
  /** Every directory the files are in, the application's own ("") among them. */
  readonly #directories: Set<string>;
  readonly #opened = Date.now();
  /**
   * Where the files not in memory are on the network, the directory a SWF
   * played alone came from (`airAppForSwf`): an app: URL loads from there
   * what the application does not hold, as its folder on a server is.
   */
  readonly base: string | null;

  constructor(xml: string, files: Map<string, Entry>, base: string | null = null) {
    this.xml = xml;
    this.base = base;
    this.descriptor = readAirDescriptor(xml);
    this.#files = files;
    this.#directories = new Set([""]);
    for (const path of files.keys()) {
      for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
        this.#directories.add(path.slice(0, at));
      }
    }

    if (!files.has(this.descriptor.content)) {
      throw new Error(
        `the application has no ${this.descriptor.content}, its descriptor's content`,
      );
    }
  }

  /** The bytes of the file at `path` under the application's directory; null where none is. */
  read(path: string): Uint8Array | null {
    return this.#files.get(path)?.bytes() ?? null;
  }

  /**
   * The file system File sees: the application's files under its
   * directory, which it does not write, and `files` for the rest, by
   * default its own, in memory.
   */
  fileSystem(files = new AirFiles(this.descriptor.id, AIR_DIRECTORIES, null)): FileSystemHost {
    // A native path's place: under the application's directory, or else in `files`; null for neither.
    const place = (native: string): { app: string } | { files: string } | null => {
      const path = normalize(native);
      if (path === null) {
        return null;
      }

      const inApp = under(path, DIRECTORIES.application);
      return inApp === null ? { files: path } : { app: inApp };
    };
    const writable = (native: string): string | null => {
      const at = place(native);
      return at && "files" in at ? at.files : null;
    };
    return {
      separator: "/",
      directories: DIRECTORIES,
      stat: (native) => {
        const at = place(native);
        if (!at) {
          return null;
        }

        return "app" in at ? this.#stat(at.app) : files.stat(at.files);
      },
      list: (native) => {
        const at = place(native);
        if (!at) {
          return null;
        }

        if ("app" in at) {
          return this.#list(at.app);
        }

        const names = files.list(at.files);
        // The root holds the application's directory too.
        return names && at.files === "" ? [...new Set([...names, ROOT_APP])].sort() : names;
      },
      read: (native) => {
        const at = place(native);
        if (!at) {
          return null;
        }

        return "app" in at ? this.read(at.app) : files.read(at.files);
      },
      write: (native, bytes, offset, length) => {
        const path = writable(native);
        return path !== null && files.write(path, bytes, offset, length);
      },
      createDirectory: (native) => {
        const path = writable(native);
        return path !== null && files.createDirectory(path);
      },
      remove: (native) => {
        const path = writable(native);
        return path !== null && files.remove(path);
      },
      move: (from, to) => {
        const a = writable(from);
        const b = writable(to);
        return a !== null && b !== null && files.move(a, b);
      },
    };
  }

  /**
   * NativeApplication's view: the descriptor, `args` as the launch's
   * arguments, and `window`, the element playing it. Its exit is `exit`.
   */
  application(
    window: AirWindow,
    args: readonly string[],
    exit: (code: number) => void,
  ): AirApplication {
    return {
      descriptor: this.xml,
      id: this.descriptor.id,
      arguments: args,
      currentDirectory: DIRECTORIES.application,
      window,
      exit,
    };
  }

  /**
   * What the application's SWFs load from it: an app: URL, or a file: URL
   * under its directory, from memory, and an app-storage: URL or a file:
   * URL elsewhere from `files`, if given, a missing one as a 404 is. Null
   * for any other URL, which the page's fetch loads.
   */
  fetch(request: FetchRequest, files?: AirFiles): FetchResult | null {
    const path = this.#pathOf(request.url);
    if (path === undefined) {
      return null;
    }

    const inApp = path === null ? null : under(path, DIRECTORIES.application);
    const bytes =
      path === null ? null : inApp !== null ? this.read(inApp) : (files?.read(path) ?? null);
    return { bytes, status: bytes ? 200 : 404, headers: [] };
  }

  /** Where on the network `url`, an app: URL of a file not in memory, is under `base`; null for none. */
  remote(url: string): string | null {
    const path = this.#pathOf(url);
    const inApp = path ? under(path, DIRECTORIES.application) : null;
    if (this.base === null || inApp === null || this.#files.has(inApp)) {
      return null;
    }

    return /^app:/i.test(url)
      ? new URL(inApp.split("/").map(encodeURIComponent).join("/"), this.base).href
      : null;
  }

  /**
   * The path `url` names on the file system File sees, "/"-separated with
   * no leading separator; null for a local URL that names none; undefined
   * for a URL that is not local.
   */
  #pathOf(url: string): string | null | undefined {
    const m = /^(app|app-storage|file):(.*)$/i.exec(url);
    if (!m) {
      return undefined;
    }

    let rest: string;
    try {
      // A query or a fragment is no part of the file's name.
      rest = decodeURIComponent(m[2].replace(/[?#].*$/, ""));
    } catch {
      return null;
    }

    switch (m[1].toLowerCase()) {
      case "app":
      case "app-storage": {
        // Never above the directory the URL starts from.
        const path = normalize(rest);
        const root = m[1].toLowerCase() === "app" ? ROOT_APP : ROOT_STORAGE;
        return path === null ? null : path === "" ? root : `${root}/${path}`;
      }
      default:
        return normalize(rest.replace(/^\/\/[^/]*/, ""));
    }
  }

  /** What is at `path` under the application's directory. */
  #stat(path: string): FileStat | null {
    const file = this.#files.get(path);
    if (file) {
      return {
        directory: false,
        size: file.size,
        modified: file.modified,
        created: file.modified,
      };
    }

    return this.#directories.has(path) ? this.#directory() : null;
  }

  /** The names in the directory at `path` under the application's directory. */
  #list(path: string): string[] | null {
    if (this.#stat(path)?.directory !== true) {
      return null;
    }

    const names = new Set<string>();
    const prefix = path === "" ? "" : `${path}/`;
    for (const name of [...this.#files.keys(), ...this.#directories]) {
      if (name.startsWith(prefix) && name.length > prefix.length) {
        names.add(name.slice(prefix.length).split("/")[0]);
      }
    }

    return [...names].sort();
  }

  #directory(): FileStat {
    return { directory: true, size: 0, modified: this.#opened, created: this.#opened };
  }
}

/**
 * The application in `source`: an AIR package's or a ZIP's bytes, or the
 * files of its folder. Its descriptor is the package's, or else the
 * shallowest `*-app.xml` or `application.xml`, whose folder is the
 * application's directory. An Error says what it lacks.
 */
export function openAirApp(source: Uint8Array | ArrayBuffer | Iterable<AirAppFile>): AirApp {
  const opened = Date.now();
  const all = new Map<string, Entry>();
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    for (const entry of readZip(source instanceof Uint8Array ? source : new Uint8Array(source))) {
      const path = normalize(entry.name);
      if (path && !entry.name.endsWith("/")) {
        all.set(path, entry);
      }
    }
  } else {
    for (const file of source) {
      const path = normalize(file.path);
      if (path) {
        const bytes = file.bytes;
        all.set(path, {
          size: bytes.length,
          modified: file.modified ?? opened,
          bytes: () => bytes,
        });
      }
    }
  }

  const descriptor = all.has(PACKAGE_DESCRIPTOR) ? PACKAGE_DESCRIPTOR : descriptorIn(all);
  if (descriptor === null) {
    throw new Error("no AIR application descriptor (META-INF/AIR/application.xml or *-app.xml)");
  }

  const root =
    descriptor === PACKAGE_DESCRIPTOR ? "" : descriptor.slice(0, descriptor.lastIndexOf("/") + 1);
  const files = new Map<string, Entry>();
  for (const [path, entry] of all) {
    if (path.startsWith(root)) {
      files.set(path.slice(root.length), entry);
    }
  }

  const xml = new TextDecoder().decode(all.get(descriptor)?.bytes());
  return new AirApp(xml, files);
}

/**
 * Whether `swf` is an AIR application's, though it came alone: its
 * ActionScript names a definition only AIR has (AIR_DEFINITIONS), which a
 * browser's Flash Player would refuse it for.
 */
export function namesAir(swf: Swf): boolean {
  for (const tag of swf.tags) {
    if (tag.code === tags.DoABC || tag.code === tags.DoABC2) {
      for (const name of abcReferences(readDoAbc(swf.bytes, tag).abc)) {
        if (AIR_DEFINITIONS.has(name)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * The AIR application of `bytes`, a SWF played alone from `url`, as adl
 * runs one from a descriptor that names only it: its id and title from
 * its file's name, its directory holding it alone, and the directory it
 * came from, if from a server, where its app: URLs load what else it has.
 */
export function airAppForSwf(bytes: Uint8Array, url: string): AirApp {
  let name = "Main.swf";
  let base: string | null = null;
  try {
    const at = new URL(url);
    const last = decodeURIComponent(at.pathname.slice(at.pathname.lastIndexOf("/") + 1));
    if (last) {
      name = last;
    }

    if (at.protocol === "http:" || at.protocol === "https:") {
      base = new URL(".", at).href;
    }
  } catch {
    // A page's own bytes, of no URL: the defaults.
  }

  const stem = name.replace(/\.[^.]*$/, "") || "Main";
  const xmlText = (text: string) =>
    text.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
    );
  const id = `swf2es.${stem.replace(/[^A-Za-z0-9.-]/g, "-")}`;
  const xml = `<?xml version="1.0" encoding="utf-8" ?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>${xmlText(id)}</id>
  <filename>${xmlText(stem)}</filename>
  <versionNumber>1.0</versionNumber>
  <initialWindow><content>${xmlText(name)}</content><title>${xmlText(stem)}</title></initialWindow>
</application>`;
  const files = new Map<string, Entry>([
    [name, { size: bytes.length, modified: Date.now(), bytes: () => bytes }],
  ]);
  return new AirApp(xml, files, base);
}

/** The shallowest `*-app.xml` or `application.xml` among `files`, outside META-INF; null for none. */
function descriptorIn(files: Map<string, Entry>): string | null {
  let best: string | null = null;
  for (const path of files.keys()) {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    if (
      (name.endsWith("-app.xml") || name === "application.xml") &&
      !path.startsWith("META-INF/") &&
      (best === null || depth(path) < depth(best))
    ) {
      best = path;
    }
  }

  return best;
}

function depth(path: string): number {
  return path.split("/").length;
}

/**
 * `path`'s segments, "/"-joined, without its leading separator, "." and
 * empty segments, each ".." taking the one before it; null where one
 * climbs above the start.
 */
function normalize(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

/** `path` relative to the directory `directory` ("/"-rooted) if it is in it or is it; null otherwise. */
function under(path: string, directory: string): string | null {
  const root = directory.slice(1);
  if (path === root) {
    return "";
  }

  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/**
 * The window an application sees, the element playing it: where it is on
 * the page, the descriptor's title until the application sets another, in
 * the normal state and shown, active while it has the focus.
 */
export function elementWindow(element: HTMLElement, title: string | null): AirWindow {
  let current = title ?? "";
  return {
    bounds: () => {
      const r = element.getBoundingClientRect();
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    },
    title: () => current,
    setTitle: (value) => {
      current = value;
    },
    displayState: () => "normal",
    active: () => document.hasFocus() && document.activeElement === element,
    activate: () => element.focus(),
    visible: () => true,
    stageOffset: () => ({ x: 0, y: 0 }),
  };
}
