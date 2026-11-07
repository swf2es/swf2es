// An AIR application opened by its descriptor, as adl runs one
// (`adl app.xml [root-dir] [-- arguments...]`): its launch, which the page
// plays it with, and the file system its File reads and writes, while it
// plays.
// Apart from Electron, so that node tests it (tests/desktop/air.test.ts).
import {
  closeSync,
  cpSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { readAirDescriptor } from "@swf2es/format";
import type { AirFileStat, AirLaunch } from "../shared/api.js";

/** What the command line asks adl's way: the descriptor, the application's directory, the arguments. */
export interface AirCommand {
  descriptor: string;
  root: string | null;
  arguments: string[];
}

/**
 * The AIR application `argv` names, from `cwd`: a descriptor (`.xml`), the
 * directory its content is under if one follows, and what follows `--`.
 */
export function airCommand(argv: string[], cwd: string): AirCommand | null {
  const end = argv.indexOf("--");
  const own = (end < 0 ? argv : argv.slice(0, end)).filter((a) => !a.startsWith("-"));
  const at = own.findIndex((a) => /\.xml$/i.test(a));
  if (at < 0) {
    return null;
  }

  const next = own[at + 1];
  const root = next && statSync(resolve(cwd, next), { throwIfNoEntry: false })?.isDirectory();
  return {
    descriptor: resolve(cwd, own[at]),
    root: root ? resolve(cwd, next) : null,
    arguments: end < 0 ? [] : argv.slice(end + 1),
  };
}

/** What opening `command` plays: the content SWF's path, its launch, and its window's title and size. */
export function airLaunch(
  command: AirCommand,
  currentDirectory: string,
  userData: string,
  directories: { documents: string; desktop: string; cache: string },
): {
  content: string;
  /** The content's path under the application's directory, "/"-separated, as its app:/ URL has it. */
  relative: string;
  launch: AirLaunch;
  title: string;
  width: number | null;
  height: number | null;
} {
  const xml = readFileSync(command.descriptor, "utf8");
  const descriptor = readAirDescriptor(xml);
  const application = command.root ?? dirname(command.descriptor);
  // Each application's own, as AIR keeps one under the user's data by its id.
  const applicationStorage = join(
    userData,
    "air",
    descriptor.id.replace(/[^\w.-]/g, "_"),
    "Local Store",
  );
  mkdirSync(applicationStorage, { recursive: true });
  return {
    content: resolve(application, ...descriptor.content.split("/")),
    relative: descriptor.content,
    launch: {
      descriptor: xml,
      id: descriptor.id,
      arguments: command.arguments,
      currentDirectory,
      separator: sep,
      directories: { application, applicationStorage, user: homedir(), ...directories },
    },
    title: descriptor.title ?? basename(descriptor.content),
    width: descriptor.width,
    height: descriptor.height,
  };
}

/** What is at `path`, as File reads it; null where nothing is. */
export function statOf(path: string): AirFileStat | null {
  try {
    const s = statSync(path);
    const link = lstatSync(path).isSymbolicLink();
    return {
      directory: s.isDirectory(),
      size: s.isDirectory() ? 0 : s.size,
      modified: s.mtimeMs,
      created: s.birthtimeMs || s.ctimeMs,
      // A dot file is hidden where Windows' attribute is not at hand, as on macOS and Linux.
      hidden: basename(path).startsWith("."),
      symbolicLink: link,
    };
  } catch {
    return null;
  }
}

/** The names in the directory at `path`; null where it is none. */
export function listOf(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

/** The bytes of the file at `path`, as FileStream's open reads them at once; null where none can be read. */
export function readOf(path: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Writes `bytes` into the file at `path` from `offset`, which is then
 * `length` long, made with its directories where it is not: FileStream's
 * writes. False where it cannot be written.
 */
export function writeOf(path: string, bytes: Uint8Array, offset: number, length: number): boolean {
  return attempt(() => {
    mkdirSync(dirname(path), { recursive: true });
    // "a+" would only append; "r+" needs the file there, which "a" makes without emptying it.
    closeSync(openSync(path, "a"));
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, bytes, 0, bytes.length, offset);
      ftruncateSync(fd, length);
    } finally {
      closeSync(fd);
    }
  });
}

/** Makes the directory at `path` and those it is in; false where it cannot. */
export function createDirectoryOf(path: string): boolean {
  return attempt(() => mkdirSync(path, { recursive: true }));
}

/** Removes the file or directory at `path`, with all in it; false where it cannot. */
export function removeOf(path: string): boolean {
  return attempt(() => rmSync(path, { recursive: true }));
}

/** Moves what is at `from` to `to`, its directories made; false where it cannot. */
export function moveOf(from: string, to: string): boolean {
  return attempt(() => {
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch (e) {
      // Onto another disk, which a rename cannot reach.
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") {
        throw e;
      }

      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true });
    }
  });
}

function attempt(change: () => void): boolean {
  try {
    change();
    return true;
  } catch {
    return false;
  }
}
