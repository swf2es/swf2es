// What the site is built from, for build.ts and the Astro pages alike: the
// commit, the avmplus commit, and the files under the MPL and from Ruffle.
// Each is read once, at build time.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = "https://github.com/swf2es/swf2es/blob/";
export const AVMPLUS = "https://github.com/swf2es/avmplus";
/** as3pb, whose benchmark is a demo, at the commit its submodule is at. */
export const AS3PB = "https://github.com/33TU/as3pb";

const trimmed = (process.env.SITE_BASE ?? "/swf2es/").replace(/^\/+|\/+$/g, "");
/**
 * The path the site is served under: SITE_BASE, by default /swf2es/, where
 * GitHub Pages serves it and the tests do. Always with its slashes, "/" at a root.
 */
export const BASE = trimmed ? `/${trimmed}/` : "/";

function head(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    // Not a checkout.
    return "";
  }
}

const commit = head(root) || "unknown";
export const build = commit === "unknown" ? commit : commit.slice(0, 12);
/** A file of the repository at the commit the site is built from. */
export const sourceUrl = (path: string) =>
  `${SOURCE}${commit === "unknown" ? "main" : commit}/${path}`;
/** The prefix of a file's URL on GitHub at that commit. */
export const blob = sourceUrl("");

// The avmplus commit builtin.abc and the translated files come from: the
// MPL asks that recipients be told where its source form is.
export const avmplus = head(join(root, "oracle/avmplus"));
export const as3pbCommit = head(join(root, "tests/programs/as3pb"));

/** The files under `dirs` whose names `extensions` takes and that say `marker`, relative to the repository. */
function filesSaying(dirs: string[], marker: RegExp, extensions: RegExp): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") {
          walk(path);
        }
      } else if (extensions.test(entry.name) && marker.test(readFileSync(path, "utf8"))) {
        found.push(relative(root, path));
      }
    }
  };

  for (const dir of dirs) {
    walk(join(root, dir));
  }

  return found.sort();
}

// Headers wrap where they will: the MPL's URL and Ruffle's name are on one line, or across two.
export const mplFiles = () => filesSaying(["packages"], /mozilla\.org\/MPL\/2\.0/, /\.(ts|as)$/);
export const ruffleFiles = () => filesSaying(["packages", "as3"], /Ruffle[\s/*]*LLC/, /\.(ts|as)$/);
