// Serves the player to a browser for the tests: the built packages, the
// libraries they import, and page.ts with its types stripped, under an
// import map that gives the page's bare specifiers their files. Nothing is
// bundled; the browser loads the modules as tsc wrote them. A worker sees
// no import map, so under /worker/ the same files are served with their
// bare specifiers resolved by it, for the Web Workers flash.system.Worker
// runs on. The page is cross-origin isolated, as a shareable ByteArray
// needs (docs/workers.md), unless a test asks for one that is not.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

/** URL prefixes and the directories they serve. */
const mounts: [string, string][] = [
  ["/native/", join(root, "packages/native/dist/")],
  ["/format/", join(root, "packages/format/dist/")],
  ["/codegen/", join(root, "packages/codegen/dist/")],
  ["/context3d-backend/", join(root, "packages/context3d/dist/")],
  ["/runtime/", join(root, "packages/runtime/dist/")],
  ["/render/", join(root, "packages/render/dist/")],
  ["/player/", join(root, "packages/player/dist/")],
  ["/player-hosts/", join(root, "packages/player-hosts/dist/")],
  ["/web/", join(root, "packages/web/dist/")],
  // The ABCs a SWF's code links against, the player tests' own copies (libraries.ts).
  ["/libraries/", join(here, "out/libraries/")],
  ["/page/", here],
];

export const importMap = {
  imports: {
    "@swf2es/native/tessellate": "/native/tessellate/index.js",
    "@swf2es/native/bitmap": "/native/bitmap/index.js",
    "@swf2es/native/compress": "/native/compress/index.js",
    "@swf2es/format": "/format/index.js",
    "@swf2es/native/mp3": "/native/mp3/index.js",
    "@swf2es/codegen": "/codegen/index.js",
    "@swf2es/context3d": "/context3d-backend/index.js",
    "@swf2es/context3d/device": "/context3d-backend/device/index.js",
    "@swf2es/context3d/webgl": "/context3d-backend/webgl/index.js",
    "@swf2es/render": "/render/index.js",
    "@swf2es/render/webgl": "/render/webgl/index.js",
    "@swf2es/runtime": "/runtime/index.js",
    "@swf2es/player": "/player/index.js",
    "@swf2es/player/context3d": "/player/playerglobal/context3d.js",
    "@swf2es/player/scene": "/player/scene/view.js",
    "@swf2es/player-hosts/stage3d": "/player-hosts/stage3d.js",
    "@swf2es/player/worker": "/player/workers/thread.js",
    "@swf2es/player-hosts/indexeddb": "/player-hosts/indexeddb.js",
    "@swf2es/player-hosts/precompiled": "/player-hosts/precompiled.js",
    "@swf2es/player-hosts/websocket": "/player-hosts/websocket.js",
    "@swf2es/player-hosts/workers": "/player-hosts/workers.js",
    "@swf2es/web": "/web/index.js",
    "@swf2es/codegen/codegen.wasm": "/codegen/codegen.wasm",
  },
};

const types: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

const importMapText = JSON.stringify(importMap);

/** Where a worker finds what the import map names: under /worker/, as its files' imports are. */
const WORKER = "/worker";

/** A module's bare specifiers resolved by the import map, to their files under /worker/. */
function resolveBare(source: string): string {
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(?\s*)"([^"./][^"]*)"/g,
    (all, before: string, specifier: string) => {
      const file = (importMap.imports as Record<string, string>)[specifier];
      return file ? `${before}"${WORKER}${file}"` : all;
    },
  );
}

/** The page's inline import map as a Content-Security-Policy source, for a policy that allows no other inline script. */
export const importMapSource = `'sha256-${createHash("sha256").update(importMapText).digest("base64")}'`;

function page(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8">
<script type="importmap">${importMapText}</script>
<style>body { margin: 0 } canvas { display: block }</style>
</head>
<body><script type="module" src="/page/page.ts"></script></body>
</html>`;
}

/**
 * What makes a page cross-origin isolated, sent with every response so
 * that its workers' scripts are too. credentialless, not require-corp: a
 * SWF's cross-origin loads go on, without cookies.
 */
export const ISOLATION_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "credentialless",
};

/**
 * Start serving on a free port of the loopback interface; `extra` mounts
 * more directories, as the corpus runner's SWFs, `csp` is the page's
 * Content-Security-Policy, if it has one, and its workers' scripts', and `isolated` false serves a
 * page that is not cross-origin isolated.
 */
export async function serve(
  extra: [string, string][] = [],
  csp?: string,
  isolated = true,
): Promise<{ server: Server; url: string }> {
  const served = [...extra, ...mounts];
  const isolation = isolated ? ISOLATION_HEADERS : {};
  const server = createServer((request, response) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      // A malformed escape, which a page may well ask for: not the server's end.
      response.writeHead(400);
      response.end();
      return;
    }

    if (path === "/") {
      response.writeHead(200, {
        "content-type": "text/html",
        ...isolation,
        ...(csp ? { "content-security-policy": csp } : {}),
      });
      response.end(page());
      return;
    }

    const inWorker = path.startsWith(`${WORKER}/`);
    if (inWorker) {
      path = path.slice(WORKER.length);
    }

    for (const [prefix, dir] of served) {
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

        if (inWorker && /\.(js|mjs|ts)$/.test(file)) {
          body = resolveBare(body.toString());
        }

        response.writeHead(200, {
          "content-type": types[extname(file)] ?? "application/octet-stream",
          ...isolation,
          // The worker script with CORS, as a CDN serves it, for a page of another origin.
          ...(prefix === "/player-hosts/" ? { "access-control-allow-origin": "*" } : {}),
          // A worker keeps the policy its script came with, not the page's.
          ...(csp && inWorker ? { "content-security-policy": csp } : {}),
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
