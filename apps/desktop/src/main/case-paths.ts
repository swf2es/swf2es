// Local paths as a case-insensitive file system finds them. AIR runs on
// Windows and macOS, whose file systems ignore case, so an AIR application
// or a SWF made there may name a file in any case: maps/Town.swf for
// maps/town.swf. On Linux such a path finds nothing, so where the exact
// path is missing each missing segment is taken as the one entry of its
// directory equal to it ignoring case. Names are compared as NFC,
// lowercased by toLowerCase(): close enough to how NTFS and APFS fold
// case, and APFS keeps a name's normalization, as NFC compares it.
// Apart from Electron, so that node tests it (tests/desktop/case-paths.test.ts).
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";

/** Whether this system's file system tells names apart by case: Linux's do; Windows' and macOS's do not. */
const CASE_SENSITIVE = process.platform === "linux";

/** The directories already said, on stderr, to hold names that differ only in case. */
const told = new Set<string>();

const fold = (name: string) => name.normalize("NFC").toLowerCase();

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `path`, absolute, as Windows would find it: unchanged where it is there
 * exactly; otherwise from the deepest ancestor that is there, each missing
 * segment taken as the entry of its directory equal to it ignoring case,
 * until one has none, which is kept as given with all after it (a file to
 * be made keeps its name). Where two entries or more are equal ignoring
 * case, which one is meant is not guessed: `path` comes back unchanged.
 * Each call lists the directories it needs afresh, as they change; one
 * whose path is there costs one lstat.
 */
export function resolveCase(path: string, caseSensitive = CASE_SENSITIVE): string {
  if (!caseSensitive || !isAbsolute(path) || exists(path)) {
    return path;
  }

  const root = parse(path).root;
  const segments = path.slice(root.length).split(sep);
  // Joined as given, not normalized: ".." is the file system's to follow, through links as today.
  const at = (count: number, from: string[]) => root + from.slice(0, count).join(sep);
  let found = segments.length - 1;
  while (found > 0 && !exists(at(found, segments))) {
    found--;
  }

  const resolved = segments.slice();
  for (let i = found; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment === "." || segment === "..") {
      continue;
    }

    const directory = at(i, resolved);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      break;
    }

    // In a directory resolved by case, a segment after it may be there exactly.
    if (names.includes(segment)) {
      continue;
    }

    const wanted = fold(segment);
    const matches = names.filter((name) => fold(name) === wanted);
    if (matches.length === 0) {
      break;
    }

    if (matches.length > 1) {
      const key = `${directory}${sep}${wanted}`;
      if (!told.has(key)) {
        told.add(key);
        console.error(
          `swf2es: ${directory} holds ${matches.join(", ")}, which differ only in case; ` +
            `${segment} is taken as named, not as any of them.`,
        );
      }

      return path;
    }

    resolved[i] = matches[0];
  }

  return root + resolved.join(sep);
}
