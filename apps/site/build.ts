// Assembles the demo site into apps/site/dist/site/, a static directory
// GitHub Pages serves as it is: the page, the built packages as tsc wrote
// them under an import map, the Pixi fork's bundle, codegen.wasm,
// builtin.abc, the demo SWFs and the licences. Every URL in it is
// relative, so it plays at https://swf2es.github.io/swf2es/ as at a local
// server's root. Run after `pnpm build`:
//
//   pnpm --filter @swf2es/site build      (or node apps/site/build.ts)
//
// The ActionScript 3 demo compiles with ASC in the oracle's image, so
// podman or docker is needed, as for `pnpm test`.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDemos } from "./demos.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = join(here, "dist/site/");
const SOURCE = "https://github.com/swf2es/swf2es/blob/";

/** The packages the page loads, by the name the import map gives each directory. */
const PACKAGES = [
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

const importMap = {
  imports: {
    "@swf2es/native/compress": "./modules/native/compress/index.js",
    "@swf2es/format": "./modules/format/index.js",
    "@swf2es/native/mp3": "./modules/native/mp3/index.js",
    "@swf2es/native/tessellate": "./modules/native/tessellate/index.js",
    "@swf2es/native/bitmap": "./modules/native/bitmap/index.js",
    "@swf2es/codegen": "./modules/codegen/index.js",
    "@swf2es/context3d": "./modules/context3d/index.js",
    "@swf2es/context3d/webgl": "./modules/context3d/webgl/index.js",
    "@swf2es/render": "./modules/render/index.js",
    "@swf2es/runtime": "./modules/runtime/index.js",
    "@swf2es/player": "./modules/player/index.js",
    "@swf2es/player/context3d": "./modules/player/playerglobal/context3d.js",
    "@swf2es/player-hosts/indexeddb": "./modules/player-hosts/indexeddb.js",
    "@swf2es/player-hosts/precompiled": "./modules/player-hosts/precompiled.js",
    "@swf2es/player-hosts/stage3d": "./modules/player-hosts/stage3d.js",
    "@swf2es/player-hosts/websocket": "./modules/player-hosts/websocket.js",
    "@swf2es/player-hosts/workers": "./modules/player-hosts/workers.js",
    "@swf2es/web": "./modules/web/index.js",
    "@swf2es/codegen/codegen.wasm": "./modules/codegen/codegen.wasm",
    "pixi.js": "./modules/pixi/pixi.mjs",
  },
};

/** Copy the files of `from` whose names `keep` takes, keeping the directories. */
function copyTree(from: string, to: string, keep: (name: string) => boolean): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, join(to, entry.name), keep);
    } else if (keep(entry.name)) {
      mkdirSync(to, { recursive: true });
      copyFileSync(source, join(to, entry.name));
    }
  }
}

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

function sizeOf(path: string): number {
  if (!statSync(path).isDirectory()) {
    return statSync(path).size;
  }

  return readdirSync(path).reduce((n, name) => n + sizeOf(join(path, name)), 0);
}

const html = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

for (const name of PACKAGES) {
  if (!existsSync(join(root, `packages/${name}/dist`))) {
    throw new Error(`packages/${name} is not built: run pnpm build first`);
  }
}

if (!existsSync(join(here, "dist/js/main.js"))) {
  throw new Error("apps/site is not built: run pnpm build first");
}

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  // Not a checkout: the page says unknown.
}

const build = commit === "unknown" ? commit : commit.slice(0, 12);

// The avmplus commit builtin.abc and the translated files come from: the
// MPL asks that recipients be told where its source form is.
let avmplus = "";
try {
  avmplus = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: join(root, "oracle/avmplus"),
    encoding: "utf8",
  }).trim();
} catch {
  // Not a checkout: the notices link to the fork's default branch.
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The packages as tsc wrote them, without their types and maps.
for (const name of PACKAGES) {
  copyTree(join(root, `packages/${name}/dist`), join(out, `modules/${name}`), (file) =>
    file.endsWith(".js"),
  );
}

copyFileSync(
  join(root, "packages/codegen/dist/codegen.wasm"),
  join(out, "modules/codegen/codegen.wasm"),
);
// The Pixi fork's bundle, its chunks and packages with it, if it has them.
copyTree(join(root, "vendor/pixijs/dist"), join(out, "modules/pixi"), (file) =>
  /\.(m?js)$/.test(file),
);
copyTree(
  join(here, "dist/js"),
  join(out, "app"),
  (file) => file.endsWith(".js") && file !== "service-worker.js",
);
// At the root, the scope it serves: Pages sends no Service-Worker-Allowed for a wider one. A
// classic script, which every browser registers, without the export that makes tsc's a module.
writeFileSync(
  join(out, "service-worker.js"),
  readFileSync(join(here, "dist/js/service-worker.js"), "utf8").replace(/^export \{\};\n/m, ""),
);

mkdirSync(join(out, "libraries"), { recursive: true });
copyFileSync(
  join(root, "oracle/avmplus/generated/builtin.abc"),
  join(out, "libraries/builtin.abc"),
);

// The demos, built from the repository's sources, and their list for the page.
const demos = buildDemos(join(here, "dist/demos-build/"));
mkdirSync(join(out, "demos"), { recursive: true });
for (const demo of demos) {
  writeFileSync(join(out, `demos/${demo.file}`), demo.bytes);
}

writeFileSync(
  join(out, "demos/demos.json"),
  `${JSON.stringify(
    demos.map(({ file, title, description, source, bytes }) => ({
      file,
      title,
      description,
      // At the commit the site is built from, which is what it plays.
      source: `${SOURCE}${commit === "unknown" ? "main" : commit}/${source}`,
      bytes: bytes.length,
    })),
    null,
    2,
  )}\n`,
);

// The licences, and the notices page listing the files each covers.
const licenses = join(out, "licenses");
mkdirSync(licenses, { recursive: true });
copyFileSync(join(root, "LICENSE"), join(licenses, "swf2es-Apache-2.0.txt"));
copyFileSync(join(root, "oracle/avmplus/LICENSE"), join(licenses, "MPL-2.0.txt"));
copyFileSync(join(root, "vendor/pixijs/LICENSE"), join(licenses, "pixijs-MIT.txt"));
copyFileSync(join(root, "vendor/minimp3/LICENSE"), join(licenses, "minimp3-CC0.txt"));
copyFileSync(join(root, "vendor/zlib/LICENSE"), join(licenses, "zlib.txt"));
copyFileSync(join(root, "vendor/libtess2/LICENSE.txt"), join(licenses, "libtess2-SGI.txt"));
// Every notice of the C in @swf2es/native's binaries, the LZMA SDK's among them.
copyFileSync(
  join(root, "packages/native/LICENSE.third-party"),
  join(licenses, "native-third-party.txt"),
);
// What Pixi's bundle takes in of its dependencies, each under its own
// licence, whose notice goes with it; a package with no licence file of its
// own is under the MIT licence its package.json names, as its author.
const mitText = readFileSync(join(root, "vendor/pixijs/LICENSE"), "utf8");
const PIXI_DEPENDENCIES = [
  "earcut",
  "eventemitter3",
  "tiny-lru",
  "ismobilejs",
  "@pixi/colord",
  "parse-svg-path",
];
const pixiDependencies = PIXI_DEPENDENCIES.map((name) => {
  const dir = join(root, "vendor/pixijs/node_modules", name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    version: string;
    license: string;
    author?: string | { name: string };
  };
  const file = `pixi-${name.replace("@pixi/", "")}.txt`;
  const own = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (own) {
    copyFileSync(join(dir, own), join(licenses, file));
  } else if (manifest.license === "MIT" && manifest.author) {
    const author = typeof manifest.author === "string" ? manifest.author : manifest.author.name;
    writeFileSync(
      join(licenses, file),
      mitText.replace(/Copyright \(c\) .*/, `Copyright (c) ${author}`),
    );
  } else {
    throw new Error(`${name}: no licence file to copy`);
  }

  return `<li><code>${html(name)}</code> ${html(manifest.version)}, ${html(manifest.license)}: <a href="licenses/${file}">licence text</a></li>`;
});

// Ruffle's MIT terms are the MIT licence's, under Ruffle's copyright, as its files give it.
writeFileSync(
  join(licenses, "ruffle-MIT.txt"),
  mitText.replace(
    /Copyright \(c\) .*/,
    "Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors",
  ),
);

const list = (files: string[]) =>
  files
    .map((f) => `<li><a href="${SOURCE}${commit}/${html(f)}"><code>${html(f)}</code></a></li>`)
    .join("");
// Headers wrap where they will: the MPL's URL and Ruffle's name are on one line, or across two.
const mpl = filesSaying(["packages"], /mozilla\.org\/MPL\/2\.0/, /\.(ts|as)$/);
const ruffle = filesSaying(["packages", "as3"], /Ruffle[\s/*]*LLC/, /\.(ts|as)$/);
// The page's import map is an empty one in the template, for it to parse as one.
const fill = (template: string, values: Record<string, string>) =>
  template
    .replace(
      '<script type="importmap">{}</script>',
      () => `<script type="importmap">${JSON.stringify(importMap)}</script>`,
    )
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
const AVMPLUS = "https://github.com/swf2es/avmplus";
const values = {
  BUILD: build,
  AVMPLUS_SOURCE: html(avmplus ? `${AVMPLUS}/tree/${avmplus}` : AVMPLUS),
  AVMPLUS_COMMIT: html(avmplus ? avmplus.slice(0, 12) : "its default branch"),
  PIXI_DEPENDENCIES: pixiDependencies.join(""),
  MPL_COUNT: String(mpl.length),
  MPL_FILES: list(mpl),
  RUFFLE_COUNT: String(ruffle.length),
  RUFFLE_FILES: list(ruffle),
};

for (const page of ["index.html", "notices.html"]) {
  writeFileSync(join(out, page), fill(readFileSync(join(here, `static/${page}`), "utf8"), values));
}

cpSync(join(here, "static/style.css"), join(out, "style.css"));
// The icon as an SVG, and as the bitmaps browsers and home screens ask for by name.
for (const icon of [
  "icon.svg",
  "favicon.ico",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
]) {
  cpSync(join(here, `static/${icon}`), join(out, icon));
}
// Pages serves an artifact as it is; this keeps Jekyll away were it ever built from a branch.
writeFileSync(join(out, ".nojekyll"), "");

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(`site: ${relative(process.cwd(), out) || "."}, ${kb(sizeOf(out))} at ${build}`);
for (const part of ["modules", "app", "libraries", "demos", "licenses"]) {
  console.log(`  ${part}/ ${kb(sizeOf(join(out, part)))}`);
}
