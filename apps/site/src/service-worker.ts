// The site's service worker: what makes the page cross-origin isolated on
// GitHub Pages, which sends no headers of a site's choosing. It adds
// COOP same-origin and COEP credentialless to the site's own responses,
// as a server would send them, so that a shareable ByteArray can share
// memory with a worker (docs/workers.md). Other origins' responses pass
// as they are: credentialless loads them without cookies. isolation.ts
// registers it. It lives at the site's root, the scope it serves.

interface FetchEventLike {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

interface WaitUntilLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface ServiceWorkerScopeLike {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (e: WaitUntilLike) => void): void;
  addEventListener(type: "fetch", listener: (e: FetchEventLike) => void): void;
}

const scope = self as unknown as ServiceWorkerScopeLike;
/** The site's root, where this script lies. */
const ROOT = new URL(".", scope.location.href).pathname;

scope.addEventListener("install", () => {
  void scope.skipWaiting();
});

// The page that registered it is served by it at once, so that one reload isolates it.
scope.addEventListener("activate", (e) => {
  e.waitUntil(scope.clients.claim());
});

/**
 * The page and the files of the player's that keep their names from one
 * deploy to the next: asked of the server each time, which answers 304
 * where they have not changed, rather than taken from the browser's cache
 * for Pages' ten minutes, where an old swf2es.js would ask for a chunk the
 * deploy removed, or play with another deploy's codegen.wasm or worker.js.
 * The chunks are named by their content, and keep for as long as the cache does.
 */
function fresh(request: Request): boolean {
  // A request that names its own cache mode keeps it; one with a body is not asked twice.
  if (request.cache !== "default" || request.method !== "GET") {
    return false;
  }

  if (request.mode === "navigate") {
    return true;
  }

  const path = new URL(request.url).pathname;
  return path.startsWith(ROOT) && /^(app|player)\/[^/]+$/.test(path.slice(ROOT.length));
}

scope.addEventListener("fetch", (e) => {
  const request = e.request;
  if (new URL(request.url).origin !== scope.location.origin) {
    return;
  }

  // A request only the cache may answer, which fetch refuses outside same-origin mode.
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
    return;
  }

  // Offline, or where the server does not answer, what the browser's cache has is better
  // than nothing, as it was before the revalidation.
  const fetched = fresh(request)
    ? fetch(new Request(request, { cache: "no-cache" })).catch(() => fetch(request))
    : fetch(request);
  e.respondWith(
    fetched.then((response) => {
      // An opaque or error response has no headers to add to.
      if (response.status === 0) {
        return response;
      }

      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "credentialless");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
