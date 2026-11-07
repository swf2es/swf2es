// An AIR application a page plays: its files held in memory, from an AIR
// package (`.air`), a ZIP of its folder, or the files of one the page was
// given. Its descriptor names the content SWF the element plays, as adl
// does, under AIR's API and its application sandbox. File sees the files
// under the application's directory, with the user's directories empty and
// nothing outside; app: and file: URLs into the application load from
// memory, and any other goes to the network as the page's would.
import { type AirDescriptor, readAirDescriptor, readZip } from "@swf2es/format";
import type {
  AirApplication,
  AirWindow,
  FetchRequest,
  FetchResult,
  FileStat,
  FileSystemHost,
} from "@swf2es/player";

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

/** Where an AIR package keeps its descriptor; its root is the application's directory. */
const PACKAGE_DESCRIPTOR = "META-INF/AIR/application.xml";

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

  constructor(xml: string, files: Map<string, Entry>) {
    this.xml = xml;
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

  /** The file system File sees: the application's files under its directory, AIR's others empty. */
  fileSystem(): FileSystemHost {
    return {
      separator: "/",
      directories: DIRECTORIES,
      stat: (path) => this.#stat(path),
      list: (path) => this.#list(path),
      read: (native) => {
        const path = normalize(native);
        const inApp = path === null ? null : under(path, DIRECTORIES.application);
        return inApp === null ? null : this.read(inApp);
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
   * under its directory, from memory, a missing one as a 404 is; an
   * app-storage: one fails, as its storage starts empty. Null for any
   * other URL, which the page's fetch loads.
   */
  fetch(request: FetchRequest): FetchResult | null {
    const path = this.#pathOf(request.url);
    if (path === undefined) {
      return null;
    }

    const bytes = path === null ? null : this.read(path);
    return { bytes, status: bytes ? 200 : 404, headers: [] };
  }

  /** The path under the application's directory `url` names; null for a local URL outside it; undefined for a URL that is not local. */
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
        return normalize(rest);
      case "file": {
        const path = normalize(rest.replace(/^\/\/[^/]*/, ""));
        const root = `${DIRECTORIES.application.slice(1)}/`;
        return path?.startsWith(root) ? path.slice(root.length) : null;
      }
      default:
        return null;
    }
  }

  #stat(native: string): FileStat | null {
    const path = normalize(native);
    if (path === null) {
      return null;
    }

    const inApp = under(path, DIRECTORIES.application);
    if (inApp !== null) {
      const file = this.#files.get(inApp);
      if (file) {
        return {
          directory: false,
          size: file.size,
          modified: file.modified,
          created: file.modified,
        };
      }

      return this.#directories.has(inApp) ? this.#directory() : null;
    }

    // "/" and AIR's other directories, and the directories they are in, are there and empty.
    const isDirectory =
      path === "" ||
      Object.values(DIRECTORIES).some((d) => d.slice(1) === path || d.startsWith(`/${path}/`));
    return isDirectory ? this.#directory() : null;
  }

  #list(native: string): string[] | null {
    const path = normalize(native);
    if (path === null || this.#stat(native)?.directory !== true) {
      return null;
    }

    const names = new Set<string>();
    const inApp = under(path, DIRECTORIES.application);
    if (inApp !== null) {
      const prefix = inApp === "" ? "" : `${inApp}/`;
      for (const name of [...this.#files.keys(), ...this.#directories]) {
        if (name.startsWith(prefix) && name.length > prefix.length) {
          names.add(name.slice(prefix.length).split("/")[0]);
        }
      }
    } else {
      const prefix = path === "" ? "/" : `/${path}/`;
      for (const directory of Object.values(DIRECTORIES)) {
        if (directory.startsWith(prefix)) {
          names.add(directory.slice(prefix.length).split("/")[0]);
        }
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
