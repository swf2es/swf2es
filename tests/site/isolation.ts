import assert from "node:assert/strict";

/** The query parameter that counts the page's loads for isolation (apps/site/src/isolation.ts). */
const RETRY = "__swf2es_isolation";

interface Page {
  value<T>(expression: string): Promise<T>;
  send<T>(method: string, params?: object): Promise<T>;
  navigate(path: string): Promise<void>;
  listen(method: string, listener: (params: Record<string, unknown>) => void): void;
}

export function isolationChecks(page: Page): [string, () => Promise<void>][] {
  const { value, send, navigate, listen } = page;
  /**
   * Count the tab's documents from now: CDP's, as the tab's session storage
   * may answer a document across the isolation boundary with stale state.
   */
  const countDocuments = () => {
    const counted = { documents: 0 };
    listen("Page.frameNavigated", (params) => {
      if (!(params.frame as { parentId?: string }).parentId) {
        counted.documents++;
      }
    });
    return counted;
  };
  const stopCounting = () => listen("Page.frameNavigated", () => {});
  const wait = async (expression: string) => {
    for (const start = Date.now(); ; ) {
      if (await value<boolean>(expression).catch(() => false)) {
        return;
      }

      if (Date.now() - start >= 60_000) {
        const state = await value(`({ isolated: crossOriginIsolated,
          controlled: !!navigator.serviceWorker.controller, ready: document.readyState,
          attempts: new URL(location.href).searchParams.get('__swf2es_isolation'),
          status: document.getElementById('status')?.textContent,
          loading: document.getElementById('loading')?.hidden })`).catch(() => null);
        assert.fail(`${expression} did not become true: ${JSON.stringify(state)}`);
      }

      await new Promise((done) => setTimeout(done, 50));
    }
  };
  const ready = "document.readyState === 'complete' && document.getElementById('loading')?.hidden";
  const recover = async () => {
    await wait(ready);
    await navigate("play/");
    await wait(`crossOriginIsolated && ${ready}`);
  };
  /** The page's URL with a query and a fragment of the test's own, which isolation keeps. */
  const testUrl = () =>
    value<string>(`(() => {
      const url = new URL(location.href);
      url.searchParams.set('isolation-test', 'kept');
      url.hash = 'isolation-test';
      return url.href;
    })()`);
  /**
   * How many documents `url` loads, with every request bypassing the service
   * worker, before the player runs unisolated: the first and its replacements.
   */
  const bypassed = async (url: string): Promise<number> => {
    const counted = countDocuments();
    const { identifier } = await send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: "sessionStorage.setItem('swf2es-isolation-reload', String(Date.now()))" },
    );
    try {
      await send("Network.enable");
      await send("Network.setCacheDisabled", { cacheDisabled: true });
      await send("Network.setBypassServiceWorker", { bypass: true });
      await send("Page.navigate", { url });
      for (const start = Date.now(); ; ) {
        assert.ok(counted.documents <= 3, "isolation keeps replacing the document");
        if (await value<boolean>(ready).catch(() => false)) {
          // Long enough for another replacement to have begun, were one coming.
          await new Promise((done) => setTimeout(done, 500));
          assert.equal(await value<boolean>(ready), true);
          return counted.documents;
        }

        assert.ok(Date.now() - start < 60_000, "the unisolated fallback did not load");
        await new Promise((done) => setTimeout(done, 50));
      }
    } finally {
      stopCounting();
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      await send("Network.setBypassServiceWorker", { bypass: false });
      await send("Network.setCacheDisabled", { cacheDisabled: false });
      await value("sessionStorage.removeItem('swf2es-isolation-reload')").catch(() => {});
    }
  };

  return [
    [
      "isolation recovers when one automatic replacement bypasses the worker",
      async () => {
        await recover();
        const url = await testUrl();
        const counted = countDocuments();

        const { identifier } = await send<{ identifier: string }>(
          "Page.addScriptToEvaluateOnNewDocument",
          {
            source: `{
              sessionStorage.setItem('swf2es-isolation-reload', String(Date.now()));
              const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
              navigator.serviceWorker.register = async (...args) => {
                const registration = await register(...args);
                if (new URL(location.href).searchParams.get('__swf2es_isolation') === '1') {
                  await new Promise(resolve => { globalThis.releaseRegistrationTest = resolve; });
                }
                return registration;
              };
            }`,
          },
        );
        try {
          await send("Network.enable");
          await send("Network.setCacheDisabled", { cacheDisabled: true });
          await send("Network.setBypassServiceWorker", { bypass: true });
          await send("Page.navigate", { url });
          await wait("typeof releaseRegistrationTest === 'function'");
          assert.equal(await value("crossOriginIsolated"), false);
          assert.equal(await value("!!navigator.serviceWorker.controller"), false);
          // The first automatic replacement missed the worker; its next one can use it.
          await send("Network.setBypassServiceWorker", { bypass: false });
          await value("releaseRegistrationTest()");
          await wait(`crossOriginIsolated && ${ready}`);
          assert.equal(await value("location.href"), url);
          // The first load, the replacement the worker missed, and the one it served.
          assert.equal(counted.documents, 3);
        } finally {
          stopCounting();
          await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
          await send("Network.setBypassServiceWorker", { bypass: false });
          await send("Network.setCacheDisabled", { cacheDisabled: false });
          await value("sessionStorage.removeItem('swf2es-isolation-reload')").catch(() => {});
        }
      },
    ],
    [
      "persistent worker bypass reaches a usable fallback after bounded replacements",
      async () => {
        await recover();
        const url = await testUrl();
        // The first load and the two replacements, then the unisolated player.
        assert.equal(await bypassed(url), 3);
        assert.equal(await value("crossOriginIsolated"), false);
        assert.equal(await value("location.href"), url);
        await value("document.querySelector('#demos button').click()");
        await wait("document.getElementById('status').textContent.startsWith('Playing ')");
        assert.equal(await value(`location.search.includes(${JSON.stringify(RETRY)})`), false);
        await recover();
      },
    ],
    [
      "a link that names the last replacement plays without any, its count left out of the URL",
      async () => {
        await recover();
        const url = await testUrl();
        const counted = new URL(url);
        counted.searchParams.set(RETRY, "2");
        assert.equal(await bypassed(counted.href), 1);
        assert.equal(await value("location.href"), url);
        await recover();
      },
    ],
    [
      "a count that is not one starts from none",
      async () => {
        await recover();
        const url = await testUrl();
        for (const garbage of ["x", "9", "-1", "1.5"]) {
          const counted = new URL(url);
          counted.searchParams.set(RETRY, garbage);
          assert.equal(await bypassed(counted.href), 3, `with ${RETRY}=${garbage}`);
          assert.equal(await value("location.href"), url);
        }

        await recover();
      },
    ],
  ];
}
