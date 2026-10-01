// Serves the player to a browser for the tests: the built packages, the
// libraries they import, and page.ts with its types stripped, under an
// import map that gives the page's bare specifiers their files. Nothing is
// bundled; the browser loads the modules as tsc wrote them.
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

/** URL prefixes and the directories they serve. */
const mounts: [string, string][] = [
  ["/format/", join(root, "packages/format/dist/")],
  ["/codegen/", join(root, "packages/codegen/dist/")],
  ["/runtime/", join(root, "packages/runtime/dist/")],
  ["/player/", join(root, "packages/player/dist/")],
  // The ABCs a SWF's code links against, copied out of the oracle's image by the tests.
  ["/libraries/", join(root, "tests/libraries/out/")],
  ["/pixi/", join(root, "packages/player/node_modules/pixi.js/dist/")],
  ["/pako/", join(root, "packages/format/node_modules/pako/dist/")],
  ["/lzma1/", join(root, "packages/format/node_modules/lzma1/lib/")],
  ["/page/", here],
];

export const importMap = {
  imports: {
    "@swf2es/format": "/format/index.js",
    "@swf2es/codegen": "/codegen/index.js",
    "@swf2es/runtime": "/runtime/index.js",
    "@swf2es/player": "/player/index.js",
    "pixi.js": "/pixi/pixi.mjs",
    pako: "/pako/pako.esm.mjs",
    lzma1: "/lzma1/index.js",
  },
};

const types: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/javascript",
  ".html": "text/html",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

function page(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8">
<script type="importmap">${JSON.stringify(importMap)}</script>
<style>body { margin: 0 } canvas { display: block }</style>
</head>
<body><script type="module" src="/page/page.ts"></script></body>
</html>`;
}

/** Start serving on a free port of the loopback interface. */
export async function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(page());
      return;
    }

    for (const [prefix, dir] of mounts) {
      if (!path.startsWith(prefix)) {
        continue;
      }

      const file = normalize(join(dir, path.slice(prefix.length)));
      if (!file.startsWith(dir)) {
        break;
      }

      try {
        if (!statSync(file).isFile()) {
          break;
        }

        let body: string | Buffer = readFileSync(file);
        if (file.endsWith(".ts")) {
          body = stripTypeScriptTypes(body.toString("utf8"));
        }

        response.writeHead(200, {
          "content-type": types[extname(file)] ?? "application/octet-stream",
        });
        response.end(body);
        return;
      } catch {
        break;
      }
    }

    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}/` };
}
