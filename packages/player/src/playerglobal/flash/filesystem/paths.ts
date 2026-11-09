// flash.filesystem.File's paths as AIR has them: native paths of the
// host's system, POSIX or Windows by its separator, absolute alone, and
// the URLs that name them: file: for any, app: and app-storage: for those
// under the application's directory and its storage. A URL encodes each
// segment of the path as UTF-8, as adl does (a space as %20, "#" as %23).

/** Where a File's URL starts: the file system's root, the application's directory or its storage's. */
export type Root = "file" | "app" | "app-storage";

export class NativePaths {
  constructor(
    /** The host's separator: "/", or "\\" on Windows. */
    readonly separator: string,
  ) {}

  private get windows(): boolean {
    return this.separator === "\\";
  }

  /** A path's root and the segments under it; null where it is not absolute. */
  private split(path: string): { root: string; segments: string[] } | null {
    if (this.windows) {
      const drive = /^([A-Za-z]:)[\\/]?/.exec(path);
      if (drive) {
        return {
          root: `${drive[1].toUpperCase()}\\`,
          segments: this.segments(path.slice(drive[0].length)),
        };
      }

      const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)[\\/]?/.exec(path);
      return unc
        ? { root: `\\\\${unc[1]}\\${unc[2]}\\`, segments: this.segments(path.slice(unc[0].length)) }
        : null;
    }

    return path.startsWith("/") ? { root: "/", segments: this.segments(path.slice(1)) } : null;
  }

  /**
   * `rest`'s segments after `under`'s, its "." left out and each ".."
   * taking the one before, but none of the first `floor`.
   */
  private segments(rest: string, under: string[] = [], floor = 0): string[] {
    const out = [...under];
    for (const segment of rest.split(this.windows ? /[\\/]/ : "/")) {
      if (segment === "" || segment === ".") {
        continue;
      }

      if (segment === "..") {
        if (out.length > floor) {
          out.pop();
        }
      } else {
        out.push(segment);
      }
    }

    return out;
  }

  isAbsolute(path: string): boolean {
    return this.split(path) !== null;
  }

  /** An absolute path in its plain form: one separator between segments, no "." or "..". */
  normalize(path: string): string | null {
    const parts = this.split(path);
    return parts ? parts.root + parts.segments.join(this.separator) : null;
  }

  /**
   * `relative` resolved against `base`, an absolute path: an absolute
   * `relative` stands alone; a relative one never goes above `floor`,
   * where the File's URL starts, as adl keeps app:/'s ".." at app:/.
   */
  resolve(base: string, relative: string, floor: string | null): string {
    if (this.isAbsolute(relative)) {
      return this.normalize(relative) as string;
    }

    const parts = this.split(base) as { root: string; segments: string[] };
    // A path never climbs out of app:/ or app-storage:/.
    const depth = floor ? (this.split(floor)?.segments.length ?? 0) : 0;
    return parts.root + this.segments(relative, parts.segments, depth).join(this.separator);
  }

  /** The directory `path` is in; null for a root. */
  parent(path: string): string | null {
    const parts = this.split(path);
    if (!parts || parts.segments.length === 0) {
      return null;
    }

    return parts.root + parts.segments.slice(0, -1).join(this.separator);
  }

  /** Its last segment, or for a root the root. */
  name(path: string): string {
    const parts = this.split(path);
    return parts && parts.segments.length > 0 ? (parts.segments.at(-1) as string) : path;
  }

  /** `path`'s segments under `under`, an ancestor or itself; null where it is not under it. */
  under(path: string, under: string): string[] | null {
    const a = this.split(path);
    const b = this.split(under);
    if (!a || !b || !this.same(a.root, b.root) || a.segments.length < b.segments.length) {
      return null;
    }

    for (let i = 0; i < b.segments.length; i++) {
      if (!this.same(a.segments[i], b.segments[i])) {
        return null;
      }
    }

    return a.segments.slice(b.segments.length);
  }

  /** Whether two names are one, as Windows' file system takes letters' case as one. */
  private same(a: string, b: string): boolean {
    return this.windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** `path`'s file: URL, its segments encoded. */
  fileUrl(path: string): string {
    const parts = this.split(path) as { root: string; segments: string[] };
    const encoded = parts.segments.map(encodeSegment).join("/");
    if (this.windows) {
      // file:///Z:/... for a drive, file://server/share/... for a share.
      const unc = /^\\\\([^\\]+)\\([^\\]+)\\$/.exec(parts.root);
      const head = unc
        ? `file://${unc[1]}/${encodeSegment(unc[2])}/`
        : `file:///${parts.root.slice(0, 2)}/`;
      return head + encoded;
    }

    return `file:///${encoded}`;
  }

  /** The native path of a file: URL; null where it names none. */
  fromFileUrl(url: string): string | null {
    const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(url);
    if (!m) {
      return null;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(m[2] ?? "/");
    } catch {
      return null;
    }

    if (this.windows) {
      const path = m[1] ? `\\\\${m[1]}${decoded}` : decoded.replace(/^\/([A-Za-z]:)/, "$1");
      return this.normalize(path.replaceAll("/", "\\"));
    }

    return m[1] ? null : this.normalize(decoded);
  }

  /** The segments of a URL's path under its root, decoded; null where one does not decode. */
  urlSegments(rest: string): string[] | null {
    try {
      return rest
        .split("/")
        .filter((s) => s !== "" && s !== ".")
        .map(decodeURIComponent);
    } catch {
      return null;
    }
  }
}

/** A path segment in a URL: UTF-8, percent-encoded as adl writes them ("#?%" and spaces among them). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}
