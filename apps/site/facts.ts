// What the site is built from, for build.ts and the Astro pages alike: the
// commit, the avmplus commit, the files under the MPL and from Ruffle, and
// the import map of the built packages. Each is read once, at build time.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const SOURCE = "https://github.com/swf2es/swf2es/blob/";
export const AVMPLUS = "https://github.com/swf2es/avmplus";

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

export const commit = head(root) || "unknown";
export const build = commit === "unknown" ? commit : commit.slice(0, 12);
/** A file of the repository at the commit the site is built from. */
export const sourceUrl = (path: string) =>
  `${SOURCE}${commit === "unknown" ? "main" : commit}/${path}`;
/** The prefix of a file's URL on GitHub at that commit. */
export const blob = sourceUrl("");

// The avmplus commit builtin.abc and the translated files come from: the
// MPL asks that recipients be told where its source form is.
export const avmplus = head(join(root, "oracle/avmplus"));

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

/** The packages the player page loads, by the name the import map gives each directory. */
export const PACKAGES = [
  "native",
  "format",
  "codegen",
  "context3d",
  "render",
  "runtime",
  "player",
  "player-hosts",
  "web",
];

/** The player page's import map, its paths under the site's root. */
export const importMap = {
  imports: Object.fromEntries(
    Object.entries({
      "@swf2es/native/compress": "modules/native/compress/index.js",
      "@swf2es/format": "modules/format/index.js",
      "@swf2es/native/mp3": "modules/native/mp3/index.js",
      "@swf2es/native/render": "modules/native/render/index.js",
      "@swf2es/codegen": "modules/codegen/index.js",
      "@swf2es/context3d": "modules/context3d/index.js",
      "@swf2es/context3d/webgl": "modules/context3d/webgl/index.js",
      "@swf2es/render": "modules/render/index.js",
      "@swf2es/render/webgl": "modules/render/webgl/index.js",
      "@swf2es/context3d/device": "modules/context3d/device/index.js",
      "@swf2es/runtime": "modules/runtime/index.js",
      "@swf2es/player": "modules/player/index.js",
      "@swf2es/player/context3d": "modules/player/playerglobal/context3d.js",
      "@swf2es/player/scene": "modules/player/scene/view.js",
      "@swf2es/player-hosts/indexeddb": "modules/player-hosts/indexeddb.js",
      "@swf2es/player-hosts/precompiled": "modules/player-hosts/precompiled.js",
      "@swf2es/player-hosts/stage3d": "modules/player-hosts/stage3d.js",
      "@swf2es/player-hosts/websocket": "modules/player-hosts/websocket.js",
      "@swf2es/player-hosts/workers": "modules/player-hosts/workers.js",
      "@swf2es/web": "modules/web/index.js",
      "@swf2es/codegen/codegen.wasm": "modules/codegen/codegen.wasm",
    }).map(([name, path]) => [name, `${BASE}${path}`]),
  ),
};
