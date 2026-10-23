// Cross-origin isolation for the page on GitHub Pages: on the first visit
// the service worker (service-worker.ts) is registered and the page loaded
// again once it serves it, now with the headers that isolate it. A browser
// that has the worker and is still not isolated, as Safari without
// credentialless, is not reloaded again: its workers pass messages, and
// sharing memory says why it cannot.

/** How long the first visit waits for the service worker before it plays without it. */
const WAIT = 4000;

/** When the tab last loaded the page again for isolation. */
const RELOADING = "swf2es-isolation-reload";

function session(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** How soon after a reload for isolation a page counts as the one it loaded. */
const HOLD = 10_000;

/**
 * Load the page again, isolated, unless this page is what such a reload
 * just loaded, which it did not isolate: then false, and the page plays
 * as it is. A reload the user asked for, even at once, may try again.
 */
function reloadOnce(): boolean {
  const storage = session();
  if (!storage) {
    return false;
  }

  const last = Number(storage.getItem(RELOADING) ?? Number.NaN);
  const entry = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const since = performance.timeOrigin - last;
  if (entry?.type === "navigate" && since >= 0 && since < HOLD) {
    return false;
  }

  storage.setItem(RELOADING, String(Date.now()));
  // A navigation, not a reload: a reload into the isolated page's group of
  // browsing contexts leaves this page in the back/forward cache, and
  // Chrome gives it back, unisolated, for a later reload that bypasses the
  // worker. Replacing it leaves nothing to give back.
  location.replace(location.href);
  return true;
}

// A page unisolated that comes back from the back/forward cache, its code
// long past its own reload, is loaded again.
addEventListener("pageshow", (e) => {
  if (e.persisted && !crossOriginIsolated && isSecureContext && navigator.serviceWorker) {
    reloadOnce();
  }
});

/** Whether the page goes on: false while it is about to load again, isolated. */
export async function isolate(): Promise<boolean> {
  const container = navigator.serviceWorker;
  if (crossOriginIsolated) {
    return true;
  }

  if (!isSecureContext || !container) {
    return true;
  }

  // Served by the worker already, and still not isolated: this browser cannot be.
  if (container.controller) {
    return true;
  }

  try {
    const served = new Promise<boolean>((done) => {
      container.addEventListener("controllerchange", () => done(true), { once: true });
      setTimeout(() => done(false), WAIT);
    });
    const registration = await container.register(new URL("service-worker.js", document.baseURI), {
      scope: "./",
    });
    // Active already, but not serving this page, as after a reload that
    // bypassed it (Shift-reload): it claims no client again, but serves
    // the page loaded again.
    if (registration.active && !container.controller) {
      return !reloadOnce();
    }

    if (await served) {
      return !reloadOnce();
    }
  } catch {
    // No service worker here, as in a private window that refuses one.
  }

  return true;
}
