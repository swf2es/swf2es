import assert from "node:assert/strict";

interface Page {
  value<T>(expression: string): Promise<T>;
  send<T>(method: string, params?: object): Promise<T>;
  navigate(path: string): Promise<void>;
}

export function isolationChecks(page: Page): [string, () => Promise<void>][] {
  const { value, send, navigate } = page;
  const wait = async (expression: string) => {
    for (const start = Date.now(); ; ) {
      if (await value<boolean>(expression).catch(() => false)) {
        return;
      }

      if (Date.now() - start >= 60_000) {
        const state = await value(`({ isolated: crossOriginIsolated,
          controlled: !!navigator.serviceWorker.controller, ready: document.readyState,
          attempts: new URL(location.href).searchParams.get('__swf2es_isolation'),
          registrations: globalThis.blockedRegistrationCalls,
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

  return [
    [
      "an active worker recovers a bypass reload without waiting for registration",
      async () => {
        await recover();
        const previous = await value<number>("performance.timeOrigin");
        const { identifier } = await send<{ identifier: string }>(
          "Page.addScriptToEvaluateOnNewDocument",
          {
            source: `globalThis.blockedRegistrationCalls = 0;
              navigator.serviceWorker.register = () => {
                globalThis.blockedRegistrationCalls++;
                return new Promise(() => {});
              };`,
          },
        );
        try {
          await send("Page.reload", { ignoreCache: true });
          await wait(`performance.timeOrigin !== ${previous} && crossOriginIsolated && ${ready}`);
          assert.equal(await value("blockedRegistrationCalls"), 0);
        } finally {
          await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        }
      },
    ],
    [
      "isolation recovers when one automatic replacement bypasses the worker",
      async () => {
        await recover();
        const url = await value<string>(`(() => {
          const url = new URL(location.href);
          url.searchParams.set('isolation-test', 'kept');
          url.hash = 'isolation-test';
          return url.href;
        })()`);

        const { identifier } = await send<{ identifier: string }>(
          "Page.addScriptToEvaluateOnNewDocument",
          {
            source: `{
              sessionStorage.setItem('swf2es-isolation-reload', String(Date.now()));
              const lookup = navigator.serviceWorker.getRegistration.bind(navigator.serviceWorker);
              navigator.serviceWorker.getRegistration = async (...args) => {
                const registration = await lookup(...args);
                if (new URL(location.href).searchParams.get('__swf2es_isolation') === '1') {
                  await new Promise(resolve => { globalThis.releaseLookupTest = resolve; });
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
          await wait("typeof releaseLookupTest === 'function'");
          assert.equal(await value("crossOriginIsolated"), false);
          assert.equal(await value("!!navigator.serviceWorker.controller"), false);
          // The first automatic replacement missed the worker; its next one can use it.
          await send("Network.setBypassServiceWorker", { bypass: false });
          await value("releaseLookupTest()");
          await wait(`crossOriginIsolated && ${ready}`);
          assert.equal(await value("location.href"), url);
        } finally {
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
        const url = await value<string>(`(() => {
          const url = new URL(location.href);
          url.searchParams.set('isolation-test', 'kept');
          url.hash = 'isolation-test';
          return url.href;
        })()`);
        await value("sessionStorage.removeItem('isolation-test-documents')");
        const { identifier } = await send<{ identifier: string }>(
          "Page.addScriptToEvaluateOnNewDocument",
          {
            source: `sessionStorage.setItem('swf2es-isolation-reload', String(Date.now()));
              sessionStorage.setItem('isolation-test-documents',
                String(Number(sessionStorage.getItem('isolation-test-documents')) + 1))`,
          },
        );
        try {
          await send("Network.enable");
          await send("Network.setCacheDisabled", { cacheDisabled: true });
          await send("Network.setBypassServiceWorker", { bypass: true });
          await send("Page.navigate", { url });
          for (const start = Date.now(); ; ) {
            const state = await value<{ count: number; ready: boolean }>(`({
              count: Number(sessionStorage.getItem('isolation-test-documents')),
              ready: ${ready}
            })`).catch(() => null);
            assert.ok(!state || state.count <= 3, "isolation keeps replacing the document");
            if (state && state.count >= 2 && state.ready) {
              break;
            }

            assert.ok(Date.now() - start < 60_000, "the unisolated fallback did not load");
            await new Promise((done) => setTimeout(done, 50));
          }

          assert.equal(await value("crossOriginIsolated"), false);
          assert.equal(await value("location.href"), url);
          await value("document.querySelector('#demos button').click()");
          await wait("document.getElementById('status').textContent.startsWith('Playing ')");
        } finally {
          await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
          await send("Network.setBypassServiceWorker", { bypass: false });
          await send("Network.setCacheDisabled", { cacheDisabled: false });
          await value(`sessionStorage.removeItem('isolation-test-documents');
            sessionStorage.removeItem('swf2es-isolation-reload')`).catch(() => {});
        }

        await recover();
      },
    ],
  ];
}
