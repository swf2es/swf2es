// flash.filesystem.File over the host's FileSystemHost (hosts.ts), as adl
// (AIR 51.3) has it: a native path and the URL that names it, under the
// file system's root, the application's directory (app:/) or its storage's
// (app-storage:/), which a File keeps as it resolves paths and goes up,
// never climbing out of app:/. Relative paths are refused (ArgumentError
// 2004), a File of no path is unusable (Error 2037), and what reads a file
// that is not there fails (Error 3003). Reading what is there is
// synchronous, as File's properties are; FileStream reads a file's bytes
// (FileStream.ts). Writing, dialogs and File's asynchronous methods are
// not supported yet. Without a host, nothing is there.
import { avm2 } from "@swf2es/runtime";
import type { FileStat } from "../../../hosts.js";
import type { Scripting } from "../../../scripting.js";
import { NativePaths, type Root } from "./paths.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** Where a File is: its URL's root and its native path. */
export interface FileLocation {
  root: Root;
  path: string;
}

/** The location of `o`, a File given a path; null for one of none, or a FileReference. */
export function fileLocation(o: AsObject): FileLocation | null {
  return o.$fileLocation ?? null;
}

/** What `name`, `size` and the dates of a File read: its name and what is there, null where nothing is. */
export function fileEntry(
  s: Scripting,
  o: AsObject,
): { name: string; stat: FileStat | null } | null {
  const at = fileLocation(o);
  if (!at) {
    return null;
  }

  const paths = new NativePaths(s.fileSystem?.separator ?? "/");
  return { name: paths.name(at.path), stat: s.fileSystem?.stat(at.path) ?? null };
}

/** A new File at the native path `path`, under the file system's root. */
export function fileAt(s: Scripting, path: string): AsObject {
  const file = s.rt.construct(s.rt.classNamed("flash.filesystem::File")) as AsObject;
  file.$fileLocation = { root: "file", path } satisfies FileLocation;
  return file;
}

export function fileNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const host = s.fileSystem;
  const paths = new NativePaths(host?.separator ?? "/");
  const fileClass = () => s.rt.classNamed("flash.filesystem::File");

  /** The directory a root's URLs start from; null for the file system's. */
  const floor = (root: Root): string | null => {
    switch (root) {
      case "app":
        return host?.directories.application ?? null;
      case "app-storage":
        return host?.directories.applicationStorage ?? null;
      default:
        return null;
    }
  };
  /** A new File at `at`. */
  const make = (at: FileLocation): AsObject => {
    const file = s.rt.construct(fileClass()) as AsObject;
    file.$fileLocation = at;
    return file;
  };
  /** A directory AIR names, as a File; one the host does not have is refused. */
  const named = (root: Root, path: string | undefined): Value => {
    if (!path) {
      throw s.rt.error("Error", 2014);
    }

    return make({ root, path: paths.normalize(path) ?? path });
  };
  /** Where `o` is; Error 2037 for a File of no path. */
  const locationOf = (o: unknown): FileLocation => {
    const at = fileLocation(o as AsObject);
    if (!at) {
      throw s.rt.error("Error", 2037);
    }

    return at;
  };
  const refuse = (): never => {
    throw s.rt.error("ArgumentError", 2004);
  };

  /** The location a native path or a file:, app: or app-storage: URL names; null for neither. */
  const parse = (given: string): FileLocation | null => {
    const app = /^(app|app-storage):(.*)$/i.exec(given);
    if (app) {
      const root = app[1].toLowerCase() as Root;
      const base = floor(root);
      const segments = paths.urlSegments(app[2]);
      if (!base || !segments) {
        return null;
      }

      return { root, path: paths.resolve(base, segments.join(paths.separator), base) };
    }

    if (/^file:/i.test(given)) {
      const path = paths.fromFileUrl(given);
      return path ? { root: "file", path } : null;
    }

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given)) {
      return null;
    }

    const path = paths.normalize(given);
    return path ? { root: "file", path } : null;
  };

  /** What is at `at`; Error 3003 where nothing is. */
  const there = (at: FileLocation): FileStat => {
    const stat = host?.stat(at.path);
    if (!stat) {
      throw s.rt.error("Error", 3003);
    }

    return stat;
  };

  class FileNatives {
    static get systemCharset(): string {
      return "utf-8";
    }

    static get separator(): string {
      return paths.separator;
    }

    static get lineEnding(): string {
      return paths.separator === "\\" ? "\r\n" : "\n";
    }

    static get applicationDirectory(): Value {
      return named("app", host?.directories.application);
    }

    static get applicationStorageDirectory(): Value {
      return named("app-storage", host?.directories.applicationStorage);
    }

    static get userDirectory(): Value {
      return named("file", host?.directories.user);
    }

    static get documentsDirectory(): Value {
      return named("file", host?.directories.documents);
    }

    static get desktopDirectory(): Value {
      return named("file", host?.directories.desktop);
    }

    static get cacheDirectory(): Value {
      return named("file", host?.directories.cache);
    }

    static getRootDirectories(): Value {
      const roots = new Set<string>();
      for (const dir of Object.values(host?.directories ?? {})) {
        let at = dir ? paths.normalize(dir) : null;
        while (at && paths.parent(at) !== null) {
          at = paths.parent(at);
        }

        if (at) {
          roots.add(at);
        }
      }

      return s.rt.array([...roots].map((path) => make({ root: "file", path })));
    }

    static createTempFile(): Value {
      throw s.rt.unsupported("File.createTempFile");
    }

    static createTempDirectory(): Value {
      throw s.rt.unsupported("File.createTempDirectory");
    }

    "flash.filesystem:File::_init"(given: Value): void {
      (this as AsObject).$fileLocation = parse(String(given)) ?? refuse();
    }

    toString(): string {
      return "[object File]";
    }

    get exists(): boolean {
      return !!host?.stat(locationOf(this).path);
    }

    get isDirectory(): boolean {
      return host?.stat(locationOf(this).path)?.directory ?? false;
    }

    get isHidden(): boolean {
      return host?.stat(locationOf(this).path)?.hidden ?? false;
    }

    get isSymbolicLink(): boolean {
      return host?.stat(locationOf(this).path)?.symbolicLink ?? false;
    }

    get isPackage(): boolean {
      locationOf(this);
      return false;
    }

    resolvePath(given: Value): Value {
      const at = locationOf(this);
      const text = String(given ?? "");
      // A File's URL or an absolute path names its own place, whatever this File's is; "a:b" is
      // a name, as on a system that allows a colon in one.
      if (/^(file|app|app-storage):/i.test(text) && !paths.isAbsolute(text)) {
        return make(parse(text) ?? refuse());
      }

      if (paths.isAbsolute(text)) {
        return make({ root: "file", path: paths.normalize(text) as string });
      }

      return make({ root: at.root, path: paths.resolve(at.path, text, floor(at.root)) });
    }

    getRelativePath(ref: Value, useDotDot: Value): Value {
      const from = locationOf(this).path;
      const to = locationOf(ref).path;
      const below = paths.under(to, from);
      if (below) {
        return below.join("/");
      }

      if (!useDotDot) {
        return null;
      }

      // Up to the nearest directory both are in, then down.
      let common: string | null = from;
      let ups = 0;
      while (common !== null && !paths.under(to, common)) {
        common = paths.parent(common);
        ups++;
      }

      if (common === null) {
        return null;
      }

      return [...Array(ups).fill(".."), ...(paths.under(to, common) as string[])].join("/");
    }

    get parent(): Value {
      const at = locationOf(this);
      const base = floor(at.root);
      // The application's directory and its storage's have none, as adl's.
      if (base !== null && paths.under(base, at.path)) {
        return null;
      }

      const up = paths.parent(at.path);
      return up === null ? null : make({ root: at.root, path: up });
    }

    get nativePath(): string {
      return locationOf(this).path;
    }

    set nativePath(v: Value) {
      const path = paths.normalize(String(v ?? ""));
      (this as AsObject).$fileLocation = path ? { root: "file", path } : refuse();
    }

    canonicalize(): void {
      locationOf(this);
    }

    get url(): string {
      const at = locationOf(this);
      const base = floor(at.root);
      if (base !== null) {
        const below = paths.under(at.path, base) ?? [];
        return `${at.root}:/${below.map(encodeURIComponent).join("/")}`;
      }

      return paths.fileUrl(at.path);
    }

    set url(v: Value) {
      const text = String(v ?? "");
      const at = /^(file|app|app-storage):/i.test(text) ? parse(text) : null;
      (this as AsObject).$fileLocation = at ?? refuse();
    }

    getDirectoryListing(): Value {
      const at = locationOf(this);
      const stat = there(at);
      if (!stat.directory) {
        throw s.rt.error("Error", 3007);
      }

      const names = host?.list(at.path) ?? [];
      return s.rt.array(
        names.map((name) => make({ root: at.root, path: paths.resolve(at.path, name, null) })),
      );
    }

    clone(): Value {
      return make({ ...locationOf(this) });
    }

    cancel(): void {}

    get icon(): Value {
      return null;
    }

    get downloaded(): boolean {
      return false;
    }

    set downloaded(_v: Value) {}

    get preventBackup(): boolean {
      return false;
    }

    set preventBackup(_v: Value) {}
  }

  avm2.registerNativeClass(natives, "flash.filesystem::File", FileNatives);
  return natives;
}
