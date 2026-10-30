// Assembles the site into apps/site/dist/site/, a static directory GitHub Pages serves as it is,
// at /swf2es/: Astro builds the pages (astro/: the home page, the player, the guide from
// docs/guide.md and the licences) around what this stages in dist/public/ first: the built
// packages as tsc wrote them, under the player's import map, codegen.wasm, builtin.abc, the
// demo SWFs, the licence texts and the service worker. Run after `pnpm build`:
//
//   pnpm --filter @swf2es/site build      (or node apps/site/build.ts)
//
// The ActionScript 3 demo compiles with ASC in the oracle's image, so
// podman or docker is needed, as for `pnpm test`.
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
import { build as astro } from "astro";
import { buildDemos } from "./demos.ts";
import { build, PACKAGES, root, sourceUrl } from "./facts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = join(here, "dist/site/");
const pub = join(here, "dist/public/");

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

function sizeOf(path: string): number {
  if (!statSync(path).isDirectory()) {
    return statSync(path).size;
  }

  return readdirSync(path).reduce((n, name) => n + sizeOf(join(path, name)), 0);
}

for (const name of PACKAGES) {
  if (!existsSync(join(root, `packages/${name}/dist`))) {
    throw new Error(`packages/${name} is not built: run pnpm build first`);
  }
}

if (!existsSync(join(here, "dist/js/main.js"))) {
  throw new Error("apps/site is not built: run pnpm build first");
}

rmSync(pub, { recursive: true, force: true });
mkdirSync(pub, { recursive: true });

// The packages as tsc wrote them, without their types and maps.
for (const name of PACKAGES) {
  copyTree(join(root, `packages/${name}/dist`), join(pub, `modules/${name}`), (file) =>
    file.endsWith(".js"),
  );
}

copyFileSync(
  join(root, "packages/codegen/dist/codegen.wasm"),
  join(pub, "modules/codegen/codegen.wasm"),
);
copyTree(
  join(here, "dist/js"),
  join(pub, "app"),
  (file) => file.endsWith(".js") && file !== "service-worker.js",
);
// At the root, the scope it serves: Pages sends no Service-Worker-Allowed for a wider one. A
// classic script, which every browser registers, without the export that makes tsc's a module.
writeFileSync(
  join(pub, "service-worker.js"),
  readFileSync(join(here, "dist/js/service-worker.js"), "utf8").replace(/^export \{\};\n/m, ""),
);

mkdirSync(join(pub, "libraries"), { recursive: true });
copyFileSync(
  join(root, "oracle/avmplus/generated/builtin.abc"),
  join(pub, "libraries/builtin.abc"),
);

// The demos, built from the repository's sources, and their list for the player.
const demos = buildDemos(join(here, "dist/demos-build/"));
mkdirSync(join(pub, "demos"), { recursive: true });
for (const demo of demos) {
  writeFileSync(join(pub, `demos/${demo.file}`), demo.bytes);
}

writeFileSync(
  join(pub, "demos/demos.json"),
  `${JSON.stringify(
    demos.map(({ file, title, description, source, bytes }) => ({
      file,
      title,
      description,
      // At the commit the site is built from, which is what it plays.
      source: sourceUrl(source),
      bytes: bytes.length,
    })),
    null,
    2,
  )}\n`,
);

// The licence texts, which the licences page links to.
const licenses = join(pub, "licenses");
mkdirSync(licenses, { recursive: true });
copyFileSync(join(root, "LICENSE"), join(licenses, "swf2es-Apache-2.0.txt"));
copyFileSync(join(root, "oracle/avmplus/LICENSE"), join(licenses, "MPL-2.0.txt"));
copyFileSync(join(root, "vendor/minimp3/LICENSE"), join(licenses, "minimp3-CC0.txt"));
copyFileSync(join(root, "vendor/zlib/LICENSE"), join(licenses, "zlib.txt"));
copyFileSync(join(root, "vendor/libtess2/LICENSE.txt"), join(licenses, "libtess2-SGI.txt"));
copyFileSync(join(root, "vendor/jxrlib/LICENSE"), join(licenses, "jxrlib-BSD-2-Clause.txt"));
// Every notice of the C in @swf2es/native's binaries, the LZMA SDK's among them.
copyFileSync(
  join(root, "packages/native/LICENSE.third-party"),
  join(licenses, "native-third-party.txt"),
);
// Ruffle's MIT terms are the MIT licence's, under Ruffle's copyright, as its files give it.
writeFileSync(
  join(licenses, "ruffle-MIT.txt"),
  `The MIT License (MIT)

Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
);

// The icon as an SVG, and as the bitmaps browsers and home screens ask for by name.
for (const icon of [
  "icon.svg",
  "favicon.ico",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
]) {
  cpSync(join(here, `static/${icon}`), join(pub, icon));
}
// Pages serves an artifact as it is; this keeps Jekyll away were it ever built from a branch.
writeFileSync(join(pub, ".nojekyll"), "");
// The licences were notices.html, which links shared before point at: to notices/, as Pages
// sends no redirect of a site's choosing. The home page sends the player's ?swf= on itself.
writeFileSync(
  join(pub, "notices.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>Licences</title>
<link rel="canonical" href="notices/">
<meta http-equiv="refresh" content="0; url=notices/">
<script>location.replace("notices/" + location.hash);</script>
<p><a href="notices/">The licences</a> have moved.</p>
`,
);

// Astro asks to send anonymous usage data unless told not to.
process.env.ASTRO_TELEMETRY_DISABLED ??= "1";
await astro({ root: here, logLevel: "warn" });

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(`site: ${relative(process.cwd(), out) || "."}, ${kb(sizeOf(out))} at ${build}`);
for (const part of [
  "modules",
  "app",
  "libraries",
  "demos",
  "licenses",
  "docs",
  "_astro",
  "pagefind",
]) {
  if (existsSync(join(out, part))) {
    console.log(`  ${part}/ ${kb(sizeOf(join(out, part)))}`);
  }
}
