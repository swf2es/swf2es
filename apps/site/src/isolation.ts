// Cross-origin isolation for the page on GitHub Pages: on the first visit
// the service worker (service-worker.ts) is registered and the page loaded
// again once it serves it, now with the headers that isolate it. A browser
// that has the worker and is still not isolated, as Safari without
// credentialless, is not reloaded again: its workers pass messages, and
// sharing memory says why it cannot.

/** How long the first visit waits for the service worker before it plays without it. */
const WAIT = 4000;

/** Set while a reload for isolation is under way, so that one that does not isolate the page is the last. */
const RELOADING = "swf2es-isolation-reload";

function session(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Load the page again, once: false if this tab already did so to no end. */
function reloadOnce(): boolean {
  const storage = session();
  if (!storage || storage.getItem(RELOADING)) {
    return false;
  }

  storage.setItem(RELOADING, "1");
  location.reload();
  return true;
}

/** Whether the page goes on: false while it is about to load again, isolated. */
export async function isolate(): Promise<boolean> {
  const container = navigator.serviceWorker;
  if (crossOriginIsolated) {
    session()?.removeItem(RELOADING);
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
