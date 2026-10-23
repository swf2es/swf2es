// Cross-origin isolation for the page on GitHub Pages: on the first visit
// the service worker (service-worker.ts) is registered and the page loaded
// again once it serves it, now with the headers that isolate it. A browser
// that has the worker and is still not isolated, as Safari without
// credentialless, is not reloaded again: its workers pass messages, and
// sharing memory says why it cannot.

/** How long the first visit waits for the service worker before it plays without it. */
const WAIT = 4000;

/** Whether the page goes on: false while it is about to load again, isolated. */
export async function isolate(): Promise<boolean> {
  const container = navigator.serviceWorker;
  if (crossOriginIsolated || !isSecureContext || !container) {
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
    await container.register(new URL("service-worker.js", document.baseURI), { scope: "./" });
    if (await served) {
      location.reload();
      return false;
    }
  } catch {
    // No service worker here, as in a private window that refuses one.
  }

  return true;
}
