// Writes dist/thread/: the modules a Web Worker running web-worker.js
// loads, from this package and those it imports, with every bare
// specifier made a relative path into the same tree. A worker sees no
// import map, so a page that loads the packages unbundled, under an
// import map or from a CDN, gives its workers this tree, which resolves
// wherever it is served (workers.ts's default script). Run by `pnpm
// build` after tsc:
//
//   node packages/player-hosts/build-thread.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = join(here, "dist/thread");
const entry = join(here, "dist/web-worker.js");

/** An import's or export's specifier, static or dynamic, as tsc writes them. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)"([^"]+)"/g;

/** The package a file is in: its name without the scope, and its dist directory. */
function packageOf(file: string): { name: string; dist: string } {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const { name } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name: string;
      };
      return { name: name.replace(/^@[^/]+\//, ""), dist: join(dir, "dist") };
    } catch {
      // No package.json here; look further up.
    }
  }

  throw new Error(`${file} is in no package`);
}

/** Where `file` goes in the tree: its package's name, then its path in the package's dist. */
function treePath(file: string): string {
  const { name, dist } = packageOf(file);
  const path = relative(dist, file);
  if (path.startsWith("..")) {
    throw new Error(`${file} is not in its package's dist`);
  }

  return join(out, name, path);
}

/** `specifier` from `file` as node resolves it, or null where it names no module, as in a comment's quote. */
function resolveBare(specifier: string, file: string): string | null {
  try {
    return createRequire(file).resolve(specifier);
  } catch {
    return null;
  }
}

rmSync(out, { recursive: true, force: true });
const done = new Set<string>();
const queue = [entry];
while (queue.length > 0) {
  const file = queue.pop() as string;
  if (done.has(file)) {
    continue;
  }

  done.add(file);
  const target = treePath(file);
  // Without the source map comments: the maps are not copied, and their sources lie elsewhere.
  const source = readFileSync(file, "utf8")
    .replace(/^\/\/# sourceMappingURL=.*$/m, "")
    .replace(SPECIFIER, (all, before: string, specifier: string) => {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const path = resolve(dirname(file), specifier);
        if (existsSync(path)) {
          queue.push(path);
        }

        return all;
      }

      const resolved = resolveBare(specifier, file);
      if (resolved === null || !/\.m?js$/.test(resolved)) {
        return all;
      }

      queue.push(resolved);
      const path = relative(dirname(target), treePath(resolved)).split(sep).join("/");
      return `${before}"${path.startsWith(".") ? path : `./${path}`}"`;
    });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

console.log(`player-hosts: wrote dist/thread/, ${done.size} modules`);
