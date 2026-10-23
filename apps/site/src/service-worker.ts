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

scope.addEventListener("install", () => {
  void scope.skipWaiting();
});

// The page that registered it is served by it at once, so that one reload isolates it.
scope.addEventListener("activate", (e) => {
  e.waitUntil(scope.clients.claim());
});

scope.addEventListener("fetch", (e) => {
  const request = e.request;
  if (new URL(request.url).origin !== scope.location.origin) {
    return;
  }

  // A request only the cache may answer, which fetch refuses outside same-origin mode.
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
    return;
  }

  e.respondWith(
    fetch(request).then((response) => {
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
