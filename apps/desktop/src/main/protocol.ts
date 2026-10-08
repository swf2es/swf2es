// swf2es://, the one scheme the window loads anything from. swf2es://app/
// is the page, its modules and the libraries; swf2es://file/ is the local
// files the SWF playing may read, by its sandbox (sandbox.ts). They are
// two origins, so a SWF's files never share the page's, and the file host
// answers the page's fetches with CORS headers naming it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { protocol, type Session } from "electron";
import type { LibraryName, LibraryState } from "../shared/api.js";
import { FILE_ORIGIN, type Sandbox } from "./sandbox.ts";

export const SCHEME = "swf2es";
export const APP_ORIGIN = `${SCHEME}://app`;

const appRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Before the app is ready: a standard, secure scheme, which fetch, CORS and storage treat as https.
 */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
  ]);
}

/** The directory a package's `specifier` resolves into, from `from`, and the package's root. */
function packageRoot(specifier: string, from: string): string {
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  let dir = dirname(createRequire(from).resolve(specifier));
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === name) {
        return dir;
      }
    } catch {
      // No package.json here; look further up.
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no package root for ${specifier}`);
    }

    dir = parent;
  }
}

/**
 * What /modules/<name>/ serves: the packages' builds and their libraries, as static/index.html's
 * import map names them.
 */
function moduleMounts(): Map<string, string> {
  const here = join(appRoot, "package.json");
  const dist = (specifier: string, from = here) => join(packageRoot(specifier, from), "dist");
  const player = join(dist("@swf2es/player"), "index.js");
  const format = join(dist("@swf2es/format"), "index.js");
  return new Map([
    ["format", dist("@swf2es/format")],
    ["codegen", dist("@swf2es/codegen")],
    ["runtime", dist("@swf2es/runtime", player)],
    ["player", dist("@swf2es/player")],
    ["player-hosts", dist("@swf2es/player-hosts/indexeddb")],
    ["web", dist("@swf2es/web")],
    ["pixi", dist("pixi.js", player)],
    ["pako", dist("pako", format)],
    ["lzma1", join(packageRoot("lzma1", format), "lib")],
  ]);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".swf": "application/x-shockwave-flash",
};

const typeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/**
 * The page's Content-Security-Policy. 'unsafe-eval' is the player's: it
 * evaluates the modules it compiles with `new Function`; codegen is
 * WebAssembly; the import map is allowed by its hash and no other inline
 * script runs. The page reaches its own files and the SWF's, never the
 * network: a SWF's http and https loads go through the main process
 * (network.ts). Nothing is framed, embedded or posted to the page.
 */
function contentSecurityPolicy(page: string): string {
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
  const hash = createHash("sha256").update(map).digest("base64");
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'sha256-${hash}'`,
    // The element's shadow root has <style>s of its own.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' ${FILE_ORIGIN} data: blob:`,
    `media-src 'self' ${FILE_ORIGIN} data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${FILE_ORIGIN} data: blob:`,
    "base-uri 'none'",
    "form-action https:",
    "frame-ancestors 'none'",
  ].join("; ");
}

const notFound = () => new Response(null, { status: 404 });

/**
 * Serve swf2es:// in `session`: the app, its modules, the libraries `libraries` finds, and what
 * `sandbox` lets the SWF read.
 */
export function serve(session: Session, sandbox: Sandbox, libraries: () => LibraryState): void {
  const mounts = moduleMounts();
  const staticDir = join(appRoot, "static");
  const rendererDir = join(appRoot, "dist", "renderer");
  const pageFile = join(staticDir, "index.html");

  /** `path` under `dir`, or null if it would leave it. */
  const under = (dir: string, path: string): string | null => {
    const file = normalize(join(dir, path));
    return file.startsWith(dir + sep) ? file : null;
  };

  const app = async (path: string): Promise<Response> => {
    if (path === "/" || path === "/index.html") {
      const page = await readFile(pageFile, "utf8");
      return new Response(page, {
        headers: {
          "content-type": TYPES[".html"],
          "content-security-policy": contentSecurityPolicy(page),
        },
      });
    }

    const [, top, ...rest] = path.split("/");
    let file: string | null = null;
    switch (top) {
      case "renderer":
        file = under(rendererDir, rest.join("/"));
        break;
      case "modules": {
        const dir = mounts.get(rest[0]);
        file = dir ? under(dir, rest.slice(1).join("/")) : null;
        break;
      }
      case "libraries": {
        const name = /^(builtin|playerglobal)\.abc$/.exec(rest.join("/"))?.[1];
        file = name ? libraries()[name as LibraryName] : null;
        break;
      }
      default:
        file = under(staticDir, path.slice(1));
    }

    return file ? fileResponse(file, {}) : notFound();
  };

  session.protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 });
    }

    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      // Malformed %-escapes name no file.
      return new Response(null, { status: 400 });
    }

    if (url.host === "app") {
      return app(path);
    }

    if (url.host === "file") {
      const file = await sandbox.resolve(path);
      return file ? fileResponse(file, { "access-control-allow-origin": APP_ORIGIN }) : notFound();
    }

    return notFound();
  });
}

async function fileResponse(file: string, headers: Record<string, string>): Promise<Response> {
  try {
    if (!(await stat(file)).isFile()) {
      return notFound();
    }

    return new Response(await readFile(file), {
      headers: { "content-type": typeOf(file), ...headers },
    });
  } catch {
    return notFound();
  }
}
