// What File and FileStream change on the host's file system, with the
// errors adl (AIR 51.3, Windows) gives for them: a File of the app: URL
// is never written (a SecurityError, by its URL alone: the same directory
// through a file: URL or a native path is written), and the IOErrors say
// what is in the way. A host without writing (FileSystemHost.write) is a
// disk that refuses every write, IOError 3001.
import { avm2 } from "@swf2es/runtime";
import type { FileSystemHost } from "../../../hosts.js";
import type { Scripting } from "../../../scripting.js";
import type { FileLocation } from "./File.js";
import { NativePaths } from "./paths.js";

type AsObject = avm2.AsObject;

/** "Error #id: message", as an IOErrorEvent's text begins. */
function errorText(id: number): string {
  return `Error #${id}: ${avm2.errorMessages[id]}`;
}

/** Throws adl's SecurityError where `at` is in the application's directory by its app: URL. */
export function refuseApp(s: Scripting, at: FileLocation): void {
  if (at.root === "app") {
    throw s.rt.construct(s.rt.classNamed("SecurityError"), "fileWriteResource");
  }
}

/** The host that writes: null for one that cannot. */
function writer(s: Scripting): Required<FileSystemHost> | null {
  const host = s.fileSystem;
  return host?.write && host.createDirectory && host.remove
    ? (host as Required<FileSystemHost>)
    : null;
}

/**
 * Why the file at `path` cannot be opened to write: 3006 for a directory,
 * 3003 where a directory it is in is a file, 3001 for a host that does not
 * write; 0 where it can be.
 */
export function openRefusal(s: Scripting, path: string): number {
  const host = s.fileSystem;
  if (host?.stat(path)?.directory) {
    return 3006;
  }

  const paths = new NativePaths(host?.separator ?? "/");
  for (let up = paths.parent(path); up !== null; up = paths.parent(up)) {
    const stat = host?.stat(up);
    if (stat) {
      if (!stat.directory) {
        return 3003;
      }

      break;
    }
  }

  return writer(s) ? 0 : 3001;
}

/** Writes `bytes` at `offset` of `path`, which is then `length` long; false where the host cannot. */
export function writeFile(
  s: Scripting,
  path: string,
  bytes: Uint8Array,
  offset: number,
  length: number,
): boolean {
  return writer(s)?.write(path, bytes, offset, length) ?? false;
}

/** File's createDirectory: 3002 for a file there; 0 once the directory is there. */
export function createDirectory(s: Scripting, path: string): number {
  const stat = s.fileSystem?.stat(path);
  if (stat) {
    return stat.directory ? 0 : 3002;
  }

  return writer(s)?.createDirectory(path) ? 0 : 3001;
}

/** File's deleteFile: 3003 for nothing there, 3001 for a directory; 0 once it is gone. */
export function deleteFile(s: Scripting, path: string): number {
  const stat = s.fileSystem?.stat(path);
  if (!stat) {
    return 3003;
  }

  if (stat.directory) {
    return 3001;
  }

  return writer(s)?.remove(path) ? 0 : 3001;
}

/**
 * File's deleteDirectory: 3003 for nothing there, 3007 for a file, 3010
 * for one with something in it unless `contents` go too; 0 once it is gone.
 */
export function deleteDirectory(s: Scripting, path: string, contents: boolean): number {
  const host = s.fileSystem;
  const stat = host?.stat(path);
  if (!stat) {
    return 3003;
  }

  if (!stat.directory) {
    return 3007;
  }

  if (!contents && (host?.list(path)?.length ?? 0) > 0) {
    return 3010;
  }

  return writer(s)?.remove(path) ? 0 : 3001;
}

/**
 * File's copyTo, and moveTo where `move`: 3003 for nothing at `from`, 3014
 * where `to` is it or a directory it is in or under it, 3012 for something
 * at `to` that may not be replaced (or cannot be removed); a directory is
 * copied with all in it, and `to`'s directories are made. 0 once done.
 */
export function copyOrMove(
  s: Scripting,
  from: string,
  to: string,
  overwrite: boolean,
  move: boolean,
): number {
  const host = s.fileSystem;
  const paths = new NativePaths(host?.separator ?? "/");
  if (!host?.stat(from)) {
    return 3003;
  }

  if (paths.under(to, from) || paths.under(from, to)) {
    return 3014;
  }

  const write = writer(s);
  if (host.stat(to)) {
    if (!overwrite || !write?.remove(to)) {
      return 3012;
    }
  }

  if (!write) {
    return 3001;
  }

  if (move && host.move) {
    return host.move(from, to) ? 0 : 3001;
  }

  if (!copy(host, write, paths, from, to)) {
    return 3001;
  }

  return !move || write.remove(from) ? 0 : 3001;
}

function copy(
  host: FileSystemHost,
  write: Required<FileSystemHost>,
  paths: NativePaths,
  from: string,
  to: string,
): boolean {
  const stat = host.stat(from);
  if (!stat) {
    return false;
  }

  if (!stat.directory) {
    const bytes = host.read?.(from);
    return !!bytes && write.write(to, bytes, 0, bytes.length);
  }

  if (!write.createDirectory(to)) {
    return false;
  }

  for (const name of host.list(from) ?? []) {
    if (!copy(host, write, paths, paths.resolve(from, name, null), paths.resolve(to, name, null))) {
      return false;
    }
  }

  return true;
}

/** How many names there are for createTemporary to try, as GetTempFileName's numbers, 1 to ffff. */
const TEMPORARY_NAMES = 0xffff;

/**
 * File's createTempFile, and createTempDirectory where `directory`: an
 * empty file or directory of a name not yet taken in the host's temporary
 * directory, which is its cache directory, as adl's (the system's, both).
 * It is named as adl names one, by Windows' GetTempFileName: "fla", a
 * number in hexadecimal, ".tmp" ("fla281f.tmp"; lowercase under Wine, where
 * it was measured). adl counts up from the clock; this from a number
 * picked at random, passing by those taken. Its path, and whether it was
 * made: a host that cannot make it, as a temporary directory adl may not
 * write, leaves the name free. Null where the host has no temporary
 * directory, or every name is taken.
 */
export function createTemporary(
  s: Scripting,
  directory: boolean,
): { path: string; made: boolean } | null {
  const host = s.fileSystem;
  const base = host?.directories.cache;
  if (!host || !base) {
    return null;
  }

  const write = writer(s);
  const paths = new NativePaths(host.separator);
  const start = Math.floor(Math.random() * TEMPORARY_NAMES);
  for (let i = 0; i < TEMPORARY_NAMES; i++) {
    const unique = ((start + i) % TEMPORARY_NAMES) + 1;
    const path = paths.resolve(base, `fla${unique.toString(16)}.tmp`, null);
    if (host.stat(path)) {
      continue;
    }

    const made = directory
      ? !!write?.createDirectory(path)
      : !!write?.write(path, new Uint8Array(0), 0, 0);
    return { path, made };
  }

  return null;
}

/** An IOErrorEvent of `id`, its text adl's: "Error #id: message", and `suffix`. */
export function ioErrorEvent(s: Scripting, id: number, suffix = ""): AsObject {
  return s.rt.construct(
    s.rt.classNamed("flash.events::IOErrorEvent"),
    "ioError",
    false,
    false,
    `${errorText(id)}${suffix}`,
    id,
  ) as AsObject;
}
