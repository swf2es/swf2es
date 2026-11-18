// Cross-origin isolation for the page on GitHub Pages: on the first visit
// the service worker (service-worker.ts) is registered and the page loaded
// again once it serves it, now with the headers that isolate it, twice at
// most, so that one load the worker missed is tried again. A browser that
// has the worker and is still not isolated, as Safari without
// credentialless, is not reloaded again: its workers pass messages, and
// sharing memory says why it cannot.

/** How long the first visit waits for the service worker before it plays without it. */
const WAIT = 4000;

/**
 * How many times the page is loaded again for isolation, and the query
 * parameter that counts them: one load the worker missed recovers, one it
 * always misses plays unisolated rather than load forever.
 */
const RETRIES = 2;
const RETRY = "__swf2es_isolation";
const stored = Number(new URL(location.href).searchParams.get(RETRY));
// Keep this document's count after cleanup, including if it returns from the back/forward cache.
const attempts = Number.isInteger(stored) && stored >= 0 && stored <= RETRIES ? stored : 0;
let replacing = false;

/** Leave only the caller's URL before the player reads it or reaches its fallback. */
function clearRetry(): void {
  const url = new URL(location.href);
  if (url.searchParams.has(RETRY)) {
    url.searchParams.delete(RETRY);
    history.replaceState(history.state, "", url);
  }
}

/** Load the page again for isolation, unless it has been RETRIES times: then false. */
function replaceForIsolation(): boolean {
  if (replacing) {
    return true;
  }

  if (attempts === RETRIES) {
    clearRetry();
    return false;
  }

  // Session storage can return stale state across the browser's isolation boundary.
  // The URL carries the budget with the navigation it belongs to.
  const url = new URL(location.href);
  url.searchParams.set(RETRY, String(attempts + 1));
  replacing = true;
  // A navigation, not a reload: a reload into the isolated page's group of
  // browsing contexts leaves this page in the back/forward cache, and
  // Chrome gives it back, unisolated, for a later reload that bypasses the
  // worker. Replacing it leaves nothing to give back.
  location.replace(url.href);
  return true;
}

// A page unisolated that comes back from the back/forward cache, its code
// long past its own reload, is loaded again.
addEventListener("pageshow", (e) => {
  if (e.persisted && !crossOriginIsolated && isSecureContext && navigator.serviceWorker) {
    replacing = false;
    replaceForIsolation();
  }
});

/** Whether the page goes on: false while it is about to load again, isolated. */
export async function isolate(): Promise<boolean> {
  const container = navigator.serviceWorker;
  if (crossOriginIsolated) {
    clearRetry();
    return true;
  }

  if (!isSecureContext || !container) {
    clearRetry();
    return true;
  }

  // Served by the worker already, and still not isolated: this browser cannot be.
  if (container.controller) {
    clearRetry();
    return true;
  }

  try {
    const served = new Promise<boolean>((done) => {
      container.addEventListener("controllerchange", () => done(true), { once: true });
      setTimeout(() => done(false), WAIT);
    });
    // At the site's root, above app/, serving every page of the site.
    const site = new URL("../", import.meta.url);
    const registration = await container.register(new URL("service-worker.js", site), {
      scope: site.href,
    });
    // Active already, but not serving this page, as after a reload that
    // bypassed it (Shift-reload): it claims no client again, but serves
    // the page loaded again.
    if (registration.active && !container.controller) {
      return !replaceForIsolation();
    }

    if (await served) {
      return !replaceForIsolation();
    }
  } catch {
    // No service worker here, as in a private window that refuses one.
  }

  clearRetry();
  return true;
}
